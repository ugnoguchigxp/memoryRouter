use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::super::episode_executor::LocalLlmTargetConfig;
use super::super::types::ClaimedProviderLeaseJob;

use super::deduplication::inspect_knowledge_duplicates;
use super::external_evidence::run_positive_external_evidence;
use super::helpers::{failure_result, parse_json};
use super::negative_response::parse_negative_response;
use super::positive_response::{
    candidate_has_project_identity, candidate_has_required_applicability,
    has_skill_like_procedure_body, merge_json_references, parse_positive_response,
    positive_failure_result, positive_rule_body_actionable, positive_terminal_result,
    positive_value_user_prompt, prepend_positive_tool_events, refine_positive_applicability,
    render_catalog_prompt, repair_positive_procedure,
};
use super::provider::{request_covering_completion, request_negative_evidence};
use super::source::{
    base_positive_candidate, evaluate_positive_source_support, normalized_character_count,
    positive_source_content, requires_external_evidence, source_reference,
};
use super::types::{
    CoveringExternalSearchConfig, NegativeCoveringExecution, NegativeCoveringResult,
};

pub(crate) fn load_claimed_negative_execution(
    connection: &Connection,
    claimed: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    api_key: Option<String>,
    low_importance_reject_threshold: i64,
    source_read_root: PathBuf,
    external_search: CoveringExternalSearchConfig,
) -> Result<NegativeCoveringExecution, CliError> {
    let claimed_id = claimed.id.clone();
    let provider_lease = claimed.provider_lease;
    let mut execution = connection
        .query_row(
            "
            select
              cq.id,
              cq.found_candidate_id,
              cq.distillation_version,
              cq.attempt_count,
              cq.max_attempts,
              coalesce(cq.provider_policy, 'default'),
              fc.title,
              fc.content,
              coalesce(fc.type, 'rule'),
              coalesce(fc.origin, '{}'),
              coalesce(fc.metadata, '{}'),
              coalesce(fq.source_key, ''),
              coalesce(fq.source_uri, ''),
              coalesce(fq.source_kind, ''),
              case
                when fq.source_kind = 'vibe_memory' then coalesce((select content from vibe_memories where id = fq.source_key limit 1), '')
                when fq.source_kind = 'knowledge_candidate' then fc.content
                else ''
              end,
              case
                when fq.source_kind = 'vibe_memory' then coalesce((select metadata from vibe_memories where id = fq.source_key limit 1), '{}')
                else '{}'
              end
            from covering_evidence_queue cq
            join found_candidates fc on fc.id = cq.found_candidate_id
            join finding_candidate_queue fq on fq.id = fc.finding_job_id
            where cq.id = ?1
              and cq.status = 'running'
            limit 1
            ",
            [&claimed_id],
            |row| {
                Ok(NegativeCoveringExecution {
                    job_id: row.get(0)?,
                    found_candidate_id: row.get(1)?,
                    distillation_version: row.get(2)?,
                    attempt_count: row.get(3)?,
                    max_attempts: row.get(4)?,
                    provider_policy: row.get(5)?,
                    candidate_title: row.get(6)?,
                    candidate_content: row.get(7)?,
                    candidate_type: row.get(8)?,
                    candidate_origin: parse_json(row.get::<_, String>(9)?),
                    candidate_metadata: parse_json(row.get::<_, String>(10)?),
                    source_key: row.get(11)?,
                    source_uri: row.get(12)?,
                    source_kind: row.get(13)?,
                    source_content: row.get(14)?,
                    source_metadata: parse_json(row.get::<_, String>(15)?),
                    provider_lease,
                    target,
                    api_key,
                    source_read_root: source_read_root.clone(),
                    source_read_ranges: None,
                    low_importance_reject_threshold,
                    duplicate_status: None,
                    duplicate_refs: Vec::new(),
                    external_search: external_search.clone(),
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load claimed covering job: {error}")))?
        .ok_or_else(|| {
            CliError::io(format!(
                "claimed covering job was not available for execution: {}",
                claimed_id
            ))
        })?;
    if execution.source_kind == "vibe_memory"
        && connection
            .query_row(
                "select exists(select 1 from sqlite_master where type = 'table' and name = 'agent_diff_entries')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            != 0
    {
        let mut statement = connection
            .prepare(
                "select diff_hunk from agent_diff_entries where vibe_memory_id = ?1 order by created_at asc, file_path asc, id asc",
            )
            .map_err(|error| CliError::io(format!("failed to prepare covering source diff read: {error}")))?;
        let diffs = statement
            .query_map([&execution.source_key], |row| row.get::<_, String>(0))
            .map_err(|error| CliError::io(format!("failed to query covering source diffs: {error}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CliError::io(format!("failed to read covering source diffs: {error}")))?;
        for diff in diffs {
            if !diff.trim().is_empty() {
                execution.source_content.push('\n');
                execution.source_content.push_str(&diff);
            }
        }
    }
    let (duplicate_status, duplicate_refs) = inspect_knowledge_duplicates(
        connection,
        &execution.candidate_title,
        &execution.candidate_content,
    )?;
    execution.duplicate_status = duplicate_status;
    execution.duplicate_refs = duplicate_refs;
    Ok(execution)
}

pub(crate) fn execute_negative_covering(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    if execution.provider_policy != "default" {
        return failure_result(
            "provider_failed",
            "rust_negative_covering_supports_default_policy_only",
        );
    }
    if execution.source_kind != "vibe_memory" {
        return failure_result(
            "tool_failed",
            &format!(
                "rust_negative_covering_unsupported_source_kind:{}",
                execution.source_kind
            ),
        );
    }
    let response = match request_negative_evidence(execution, timeout_seconds) {
        Ok(response) => response,
        Err(error) => return failure_result("provider_failed", &error.to_string()),
    };
    match parse_negative_response(execution, &response) {
        Ok(result) => result,
        Err(error) => failure_result("parse_failed", &error.to_string()),
    }
}

pub(crate) fn execute_covering(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    if execution.is_negative() {
        execute_negative_covering(execution, timeout_seconds)
    } else {
        execute_positive_covering(execution, timeout_seconds)
    }
}

pub(super) fn execute_positive_covering(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    if execution.provider_policy != "default" {
        return positive_failure_result(
            "provider_failed",
            "final",
            "cloud_api_provider_unavailable",
            Vec::new(),
        );
    }
    let source_read = match positive_source_content(execution, timeout_seconds) {
        Ok(source_read) if !source_read.content.trim().is_empty() => source_read,
        Ok(_) => {
            return positive_terminal_result(
                "insufficient",
                "source_support",
                "unsupported_by_source",
                source_reference(execution),
            )
        }
        Err(error) => {
            return positive_failure_result("tool_failed", "source_support", &error, Vec::new())
        }
    };
    let mut execution = execution.clone();
    execution.source_read_ranges = Some(source_read.read_ranges);
    let execution = &execution;
    let source_content = source_read.content;
    if normalized_character_count(&execution.candidate_title) < 3
        || normalized_character_count(&execution.candidate_content) < 24
    {
        return positive_terminal_result(
            "insufficient",
            "source_support",
            "not_actionable",
            source_reference(execution),
        );
    }
    if let Some(status) = execution.duplicate_status.as_deref() {
        let mut references = source_reference(execution);
        references.extend(execution.duplicate_refs.iter().filter_map(|duplicate| {
            let knowledge_id = duplicate.get("knowledgeId")?.as_str()?;
            Some(json!({
                "kind": "knowledge",
                "uri": format!("knowledge://{knowledge_id}"),
                "title": duplicate.get("title").and_then(Value::as_str),
                "note": duplicate.get("reason").and_then(Value::as_str).unwrap_or(status),
                "evidenceRole": "dedupe_match"
            }))
        }));
        return NegativeCoveringResult {
            status: status.to_string(),
            stage: "dedupe",
            candidate: None,
            references,
            duplicate_refs: execution.duplicate_refs.clone(),
            tool_events: Vec::new(),
            reason: Some(status.to_string()),
        };
    }

    let (source_supported, confidence, overlap) =
        evaluate_positive_source_support(&execution.candidate_content, &source_content);
    let candidate = base_positive_candidate(execution, confidence);
    if !candidate_has_project_identity(&candidate) {
        let mut result = positive_terminal_result(
            "insufficient",
            "source_support",
            "project_identity_required",
            source_reference(execution),
        );
        result.tool_events.push(json!({
            "name": "project_identity_required",
            "ok": false,
            "metadata": {
                "reason": "project_identity_required",
                "boundary": "finalize_distille",
                "preflight": true
            }
        }));
        return result;
    }
    let needs_external =
        requires_external_evidence(&execution.candidate_title, &execution.candidate_content);
    let mut diagnostics = Vec::new();
    if !source_supported {
        diagnostics.push(json!({
            "name": "source_support",
            "ok": false,
            "metadata": {
                "reason": "unsupported_by_source",
                "confidence": confidence,
                "overlapRatio": overlap,
                "mode": "llm_verification"
            }
        }));
    }
    diagnostics.push(json!({
        "name": "source_first_route",
        "ok": true,
        "metadata": {
            "route": if needs_external { "needs_external" } else { "source_only" },
            "reason": if needs_external { "requires_external_evidence" } else { "no_external_evidence_signal" }
        }
    }));

    let result = if needs_external {
        run_positive_external_evidence(execution, &candidate, &source_content, timeout_seconds)
    } else {
        run_positive_value_assessment(execution, &candidate, &source_content, timeout_seconds)
    };
    prepend_positive_tool_events(result, diagnostics)
}

pub(super) fn run_positive_value_assessment(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    let system_prompt = match render_catalog_prompt(
        "coverEvidence.valueAssessment",
        &json!({
            "lowImportanceRejectThreshold": execution.low_importance_reject_threshold
        }),
    ) {
        Ok(prompt) => prompt,
        Err(error) => {
            return positive_failure_result(
                "parse_failed",
                "final",
                &error.to_string(),
                source_reference(execution),
            )
        }
    };
    let user_prompt = positive_value_user_prompt(execution, candidate, source_content);
    let completion = match request_covering_completion(
        execution,
        &system_prompt,
        &user_prompt,
        4096,
        timeout_seconds,
    ) {
        Ok(completion) => completion,
        Err(error) => {
            return positive_failure_result(
                "provider_failed",
                "final",
                &format!("value_provider_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    let parsed = match parse_positive_response(&completion, candidate, "final") {
        Ok(result) => result,
        Err(error) => {
            return positive_failure_result(
                "parse_failed",
                "final",
                &format!("value_parse_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    finalize_positive_result(execution, parsed, source_content, timeout_seconds)
}

pub(super) fn finalize_positive_result(
    execution: &NegativeCoveringExecution,
    mut result: NegativeCoveringResult,
    source_content: &str,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    result.references = merge_json_references(source_reference(execution), result.references);
    if result.status != "knowledge_ready" {
        return result;
    }
    let Some(mut candidate) = result.candidate.take() else {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "candidate_missing",
            result.references,
        );
    };
    let importance = candidate
        .get("importance")
        .and_then(Value::as_i64)
        .unwrap_or(70);
    if importance <= execution.low_importance_reject_threshold {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "low_importance",
            result.references,
        );
    }

    if !candidate_has_required_applicability(&candidate) {
        let refined =
            refine_positive_applicability(execution, &candidate, source_content, timeout_seconds);
        match refined {
            Ok((refined_candidate, event)) => {
                candidate = refined_candidate;
                result.tool_events.push(event);
            }
            Err(event) => result.tool_events.push(event),
        }
    }
    if !candidate_has_required_applicability(&candidate) {
        result.tool_events.push(json!({
            "name": "applicability_required",
            "ok": false,
            "metadata": {"reason": "applies_to_categories_required"}
        }));
        return NegativeCoveringResult {
            status: "insufficient".to_string(),
            stage: result.stage,
            candidate: None,
            references: result.references,
            duplicate_refs: result.duplicate_refs,
            tool_events: result.tool_events,
            reason: Some("applies_to_categories_required".to_string()),
        };
    }

    if !candidate_has_project_identity(&candidate) {
        result.tool_events.push(json!({
            "name": "project_identity_required",
            "ok": false,
            "metadata": {
                "reason": "project_identity_required",
                "boundary": "finalize_distille"
            }
        }));
        return NegativeCoveringResult {
            status: "insufficient".to_string(),
            stage: result.stage,
            candidate: None,
            references: result.references,
            duplicate_refs: result.duplicate_refs,
            tool_events: result.tool_events,
            reason: Some("project_identity_required".to_string()),
        };
    }

    if candidate.get("type").and_then(Value::as_str) == Some("procedure")
        && !has_skill_like_procedure_body(
            candidate
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    {
        match repair_positive_procedure(execution, &candidate, source_content, timeout_seconds) {
            Ok(repaired) => {
                candidate = repaired;
                result.tool_events.push(json!({
                    "name": "procedure_repair",
                    "ok": true,
                    "metadata": {"reason": "procedure_repaired_from_source"}
                }));
            }
            Err(reason) => {
                if positive_rule_body_actionable(
                    candidate
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    candidate
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) {
                    if let Some(object) = candidate.as_object_mut() {
                        object.insert("type".to_string(), json!("rule"));
                    }
                    result.tool_events.push(json!({
                        "name": "procedure_demoted_to_rule",
                        "ok": true,
                        "metadata": {"reason": reason}
                    }));
                } else {
                    return positive_terminal_result(
                        "insufficient",
                        result.stage,
                        "procedure_repair_failed",
                        result.references,
                    );
                }
            }
        }
    }
    if candidate.get("type").and_then(Value::as_str) == Some("rule")
        && !positive_rule_body_actionable(
            candidate
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            candidate
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    {
        return positive_terminal_result(
            "insufficient",
            result.stage,
            "rule_body_not_actionable",
            result.references,
        );
    }
    result.candidate = Some(candidate);
    result.reason = None;
    result
}
