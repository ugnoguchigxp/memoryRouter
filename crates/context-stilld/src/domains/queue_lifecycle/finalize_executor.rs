use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    domains::mcp_lifecycle::project_identity::{
        resolve_compile_project_identity, CompileProjectIdentityInput, CompileProjectIdentityTrust,
    },
    shared::errors::CliError,
};

use super::events::append_queue_event_for_connection;

const FINALIZE_SOURCE_PREFIX: &str = "cover-evidence-result://";
const REDACTION_PLACEHOLDER: &str = "[REMOVED SENSITIVE DATA]";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum FinalizeExecutionStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
}

#[derive(Debug, Clone)]
pub(crate) struct FinalizeEmbeddingConfig {
    pub(crate) provider: String,
    pub(crate) daemon_url: String,
    pub(crate) access_token: Option<String>,
    pub(crate) timeout_seconds: u64,
    pub(crate) expected_dimension: Option<usize>,
    pub(crate) openai_api_base_url: Option<String>,
    pub(crate) openai_api_version: Option<String>,
    pub(crate) openai_model: Option<String>,
    pub(crate) openai_api_key: Option<String>,
    pub(crate) cli_python: PathBuf,
    pub(crate) cli_root: PathBuf,
    pub(crate) cli_model_dir: PathBuf,
}

#[derive(Debug)]
struct FinalizeJob {
    id: String,
    evidence_result_id: String,
    attempt_count: i64,
    max_attempts: i64,
    evidence_status: String,
    _evidence_stage: String,
    candidate_type: Option<String>,
    title: Option<String>,
    body: Option<String>,
    importance: Option<f64>,
    confidence: Option<f64>,
    applies_to: Value,
    references: Value,
    duplicate_refs: Value,
    tool_events: Value,
    evidence_reason: Option<String>,
    found_candidate_id: String,
    source_kind: String,
    source_key: String,
    source_uri: String,
}

#[derive(Debug)]
struct PreparedFinalize {
    candidate_type: String,
    title: String,
    body: String,
    importance: f64,
    confidence: f64,
    applies_to: Value,
    references: Value,
    duplicate_refs: Value,
    tool_events: Value,
    project_ref: Option<String>,
    repo_key: Option<String>,
    repo_path: Option<String>,
    polarity: String,
    intent_tags: Value,
    anonymization: Value,
}

pub(crate) fn backfill_finalize_project_identity_for_connection(
    connection: &Connection,
    limit: usize,
) -> Result<u64, CliError> {
    for table in [
        "finalize_distille_queue",
        "evidence_coverage_results",
        "found_candidates",
        "finding_candidate_queue",
        "vibe_memories",
    ] {
        if !table_exists(connection, table)? {
            return Ok(0);
        }
    }
    let mut statement = connection
        .prepare(
            r#"
            select q.id, e.id, f.id, c.id,
                   coalesce(e.applies_to, '{}'),
                   coalesce(f.metadata, '{}'),
                   coalesce(c.metadata, '{}'),
                   coalesce(v.metadata, '{}')
            from finalize_distille_queue q
            join evidence_coverage_results e on e.id = q.evidence_result_id
            join found_candidates c on c.id = e.found_candidate_id
            join finding_candidate_queue f on f.id = c.finding_job_id
            join vibe_memories v on v.id = f.source_key
            where q.status in ('pending', 'paused')
              and f.source_kind = 'vibe_memory'
              and json_extract(case when json_valid(q.metadata) then q.metadata else '{}' end, '$.projectIdentityBackfill') is null
            order by q.priority desc, q.created_at asc, q.id asc
            limit ?1
            "#,
        )
        .map_err(|error| CliError::io(format!("failed to prepare finalize identity backfill: {error}")))?;
    let rows = statement
        .query_map([limit.clamp(1, 500) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| {
            CliError::io(format!(
                "failed to query finalize identity backfill: {error}"
            ))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            CliError::io(format!(
                "failed to read finalize identity backfill: {error}"
            ))
        })?;
    drop(statement);

    let transaction = connection.unchecked_transaction().map_err(|error| {
        CliError::io(format!(
            "failed to start finalize identity backfill: {error}"
        ))
    })?;
    let mut updated = 0_u64;
    for (
        queue_id,
        evidence_id,
        finding_id,
        candidate_id,
        applies_to_raw,
        finding_metadata_raw,
        candidate_metadata_raw,
        memory_metadata_raw,
    ) in rows
    {
        let still_eligible = transaction
            .query_row(
                "select exists(select 1 from finalize_distille_queue where id = ?1 and status in ('pending','paused') and json_extract(case when json_valid(metadata) then metadata else '{}' end, '$.projectIdentityBackfill') is null)",
                [&queue_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| {
                CliError::io(format!(
                    "failed to recheck finalize identity backfill eligibility: {error}"
                ))
            })?
            != 0;
        if !still_eligible {
            continue;
        }
        let mut applies_to = parse_json(applies_to_raw, json!({}));
        let mut finding_metadata = parse_json(finding_metadata_raw, json!({}));
        let mut candidate_metadata = parse_json(candidate_metadata_raw, json!({}));
        let memory_metadata = parse_json(memory_metadata_raw, json!({}));
        let Some(input) =
            trusted_identity_input(&finding_metadata, &candidate_metadata, &memory_metadata)
        else {
            continue;
        };
        let resolved = match resolve_compile_project_identity(
            &input,
            CompileProjectIdentityTrust::TrustedAdapter,
            None,
        ) {
            Ok(resolved) if resolved.match_value.is_some() => resolved,
            _ => continue,
        };
        let mut snapshot = serde_json::to_value(&resolved).map_err(|error| {
            CliError::io(format!(
                "failed to serialize finalize project identity: {error}"
            ))
        })?;
        if let Some(object) = snapshot.as_object_mut() {
            object.insert("classificationStatus".to_string(), json!("classified"));
            object.insert("scope".to_string(), json!("repo"));
        }
        let applies_to_object = applies_to.as_object_mut().ok_or_else(|| {
            CliError::io(format!(
                "finalize applicability is not an object: {evidence_id}"
            ))
        })?;
        for (key, value) in [
            ("projectRef", resolved.project_ref.as_ref()),
            ("repoKey", resolved.repo_key.as_ref()),
            ("repoPath", resolved.repo_path.as_ref()),
        ] {
            if let Some(value) = value {
                applies_to_object.insert(key.to_string(), json!(value));
            } else {
                applies_to_object.remove(key);
            }
        }
        if let Some(object) = finding_metadata.as_object_mut() {
            object.insert("projectIdentity".to_string(), snapshot.clone());
        }
        if let Some(object) = candidate_metadata.as_object_mut() {
            object.insert("projectIdentity".to_string(), snapshot.clone());
        }

        transaction
            .execute(
                "update evidence_coverage_results set applies_to = ?1, updated_at = CURRENT_TIMESTAMP where id = ?2",
                params![applies_to.to_string(), evidence_id],
            )
            .map_err(|error| CliError::io(format!("failed to backfill finalize evidence identity: {error}")))?;
        transaction
            .execute(
                "update finding_candidate_queue set metadata = ?1, updated_at = CURRENT_TIMESTAMP where id = ?2",
                params![finding_metadata.to_string(), finding_id],
            )
            .map_err(|error| CliError::io(format!("failed to backfill finding identity: {error}")))?;
        transaction
            .execute(
                "update found_candidates set metadata = ?1, updated_at = CURRENT_TIMESTAMP where id = ?2",
                params![candidate_metadata.to_string(), candidate_id],
            )
            .map_err(|error| CliError::io(format!("failed to backfill candidate identity: {error}")))?;
        transaction
            .execute(
                "update finalize_distille_queue set metadata = json_set(case when json_valid(metadata) then metadata else '{}' end, '$.projectIdentityBackfill', 'applied', '$.projectIdentityFingerprint', ?1), updated_at = CURRENT_TIMESTAMP where id = ?2",
                params![resolved.identity_fingerprint, queue_id],
            )
            .map_err(|error| CliError::io(format!("failed to mark finalize identity backfill: {error}")))?;
        if table_exists(&transaction, "audit_logs")? {
            let digest = format!(
                "{:x}",
                Sha256::digest(format!("finalize-identity-backfill:{evidence_id}").as_bytes())
            );
            transaction
                .execute(
                    "insert or ignore into audit_logs (id, event_type, actor, payload, created_at) values (?1, 'PROJECT_IDENTITY_BACKFILL_APPLIED', 'system', ?2, CURRENT_TIMESTAMP)",
                    params![format!("finalize-identity-backfill-{}", &digest[..24]), json!({
                        "producer":"finalize-distille.rust",
                        "queueJobId":queue_id,
                        "evidenceResultId":evidence_id,
                        "identityFingerprint":resolved.identity_fingerprint,
                        "matchBasis":resolved.match_basis.as_str()
                    }).to_string()],
                )
                .map_err(|error| CliError::io(format!("failed to audit finalize identity backfill: {error}")))?;
        }
        updated += 1;
    }
    transaction.commit().map_err(|error| {
        CliError::io(format!(
            "failed to commit finalize identity backfill: {error}"
        ))
    })?;
    Ok(updated)
}

fn trusted_identity_input(
    finding_metadata: &Value,
    candidate_metadata: &Value,
    memory_metadata: &Value,
) -> Option<CompileProjectIdentityInput> {
    let identity = finding_metadata
        .get("projectIdentity")
        .or_else(|| candidate_metadata.get("projectIdentity"))
        .or_else(|| candidate_metadata.pointer("/sourceMetadata/projectIdentity"))
        .or_else(|| memory_metadata.get("projectIdentity"));
    if let Some(identity) = identity {
        let input = CompileProjectIdentityInput {
            project_ref: string_property(identity, &["projectRef", "project_ref"]),
            repo_key: string_property(identity, &["repoKey", "repo_key"]),
            repo_path: string_property(identity, &["repoPath", "repo_path"]),
        };
        if input.project_ref.is_some() || input.repo_key.is_some() || input.repo_path.is_some() {
            return Some(input);
        }
    }
    if memory_metadata
        .get("rustAgentLogSync")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some(CompileProjectIdentityInput {
            project_ref: None,
            repo_key: None,
            repo_path: string_property(memory_metadata, &["projectRoot"]),
        });
    }
    None
}

pub(crate) fn run_finalize_distille_job_for_connection(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
    embedding_config: &FinalizeEmbeddingConfig,
    low_importance_reject_threshold: f64,
) -> Result<FinalizeExecutionStatus, CliError> {
    let job = match load_job(connection, job_id, worker_id) {
        Ok(job) => job,
        Err(error) => {
            mark_failed(connection, job_id, worker_id, &error.to_string())?;
            return Ok(FinalizeExecutionStatus::Failed);
        }
    };

    append_event_best_effort(
        connection,
        &event_id("finalize-event-claimed", &job.id),
        &job.id,
        "claimed",
        "finalize claimed by Rust resident executor",
        json!({
            "workerId":worker_id,
            "executor":"rust",
            "executionLane":"local_embedding"
        }),
    );

    let prepared = match prepare_job(connection, &job, low_importance_reject_threshold) {
        Ok(prepared) => prepared,
        Err(reason) if reason.starts_with("worker_failed:") => {
            let error = reason.trim_start_matches("worker_failed:");
            mark_failed(connection, &job.id, worker_id, error)?;
            append_event_best_effort(
                connection,
                &event_id("finalize-event-failed", &job.id),
                &job.id,
                "failed",
                "finalize validation failed",
                json!({"executor":"rust","error":truncate(error,500)}),
            );
            return Ok(FinalizeExecutionStatus::Failed);
        }
        Err(reason) => {
            mark_skipped(connection, &job, worker_id, &reason)?;
            append_event_best_effort(
                connection,
                &event_id("finalize-event-skipped", &job.id),
                &job.id,
                "skipped",
                "finalize rejected candidate",
                json!({"executor":"rust","reason":reason}),
            );
            return Ok(FinalizeExecutionStatus::Skipped);
        }
    };

    record_audit_best_effort(
        connection,
        "FINALIZE_DISTILLE_STARTED",
        json!({
            "coverEvidenceResultId":job.evidence_result_id,
            "targetKind":target_kind(&job.source_kind),
            "targetKey":"the source target",
            "sourceDocumentUri":"the source document",
            "executor":"rust"
        }),
    );
    let source_uri = format!("{FINALIZE_SOURCE_PREFIX}{}", job.evidence_result_id);
    let existing_knowledge_id = find_existing_knowledge(connection, &source_uri, &prepared)?;
    let reusable_embedding = existing_knowledge_id
        .as_deref()
        .map(|knowledge_id| {
            load_current_knowledge_embedding(
                connection,
                knowledge_id,
                &prepared.title,
                &prepared.body,
                embedding_config.expected_dimension,
            )
        })
        .transpose()?
        .flatten();
    let embedding = if let Some(embedding) = reusable_embedding {
        embedding
    } else {
        match embed_one(
            embedding_config,
            &format!("{}\n{}", prepared.title, prepared.body),
        ) {
            Ok(embedding) => embedding,
            Err(error) => {
                record_audit_best_effort(
                    connection,
                    "FINALIZE_DISTILLE_EMBEDDING_FAILED",
                    json!({
                        "coverEvidenceResultId":job.evidence_result_id,
                        "embeddingStatus":"failed",
                        "error":truncate(&error.to_string(), 500),
                        "executor":"rust"
                    }),
                );
                let error = error.to_string();
                if is_retryable_embedding_error(&error)
                    && job.attempt_count + 1 < job.max_attempts.max(1)
                {
                    mark_retrying(connection, &job, worker_id, &error)?;
                    append_event_best_effort(
                        connection,
                        &event_id(
                            "finalize-event-retried",
                            &format!("{}-{}", job.id, job.attempt_count + 1),
                        ),
                        &job.id,
                        "retried",
                        "finalize waiting for embedding readiness",
                        json!({
                            "executor":"rust",
                            "error":truncate(&error,500),
                            "attemptCount":job.attempt_count + 1,
                            "retryReason":"embedding_unavailable"
                        }),
                    );
                    return Ok(FinalizeExecutionStatus::Retrying);
                }
                mark_failed(connection, &job.id, worker_id, &error)?;
                append_event_best_effort(
                    connection,
                    &event_id("finalize-event-failed", &job.id),
                    &job.id,
                    "failed",
                    "finalize embedding failed",
                    json!({"executor":"rust","error":truncate(&error,500)}),
                );
                return Ok(FinalizeExecutionStatus::Failed);
            }
        }
    };

    match persist_finalized(
        connection,
        &job,
        &prepared,
        &source_uri,
        worker_id,
        existing_knowledge_id,
        &embedding,
    ) {
        Ok(knowledge_id) => {
            append_event_best_effort(
                connection,
                &event_id("finalize-event-completed", &job.id),
                &job.id,
                "completed",
                "finalize completed",
                json!({"executor":"rust","finalizeStatus":"stored","knowledgeId":knowledge_id}),
            );
            Ok(FinalizeExecutionStatus::Completed)
        }
        Err(error) => {
            mark_failed(connection, &job.id, worker_id, &error.to_string())?;
            append_event_best_effort(
                connection,
                &event_id("finalize-event-failed", &job.id),
                &job.id,
                "failed",
                "finalize persistence failed",
                json!({"executor":"rust","error":truncate(&error.to_string(),500)}),
            );
            Ok(FinalizeExecutionStatus::Failed)
        }
    }
}

fn load_job(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
) -> Result<FinalizeJob, CliError> {
    connection
        .query_row(
            r#"
            select q.id,
                   coalesce(q.evidence_result_id, ''),
                   q.attempt_count,
                   q.max_attempts,
                   e.status,
                   e.stage,
                   e.type,
                   e.title,
                   e.body,
                   e.importance,
                   e.confidence,
                   coalesce(e.applies_to, '{}'),
                   coalesce(e."references", '[]'),
                   coalesce(e.duplicate_refs, '[]'),
                   coalesce(e.tool_events, '[]'),
                   e.reason,
                   e.found_candidate_id,
                   f.source_kind,
                   f.source_key,
                   f.source_uri
            from finalize_distille_queue q
            join evidence_coverage_results e on e.id = q.evidence_result_id
            join found_candidates c on c.id = e.found_candidate_id
            join finding_candidate_queue f on f.id = c.finding_job_id
            where q.id = ?1
              and q.status = 'running'
              and q.locked_by = ?2
            limit 1
            "#,
            params![job_id, worker_id],
            |row| {
                Ok(FinalizeJob {
                    id: row.get(0)?,
                    evidence_result_id: row.get(1)?,
                    attempt_count: row.get(2)?,
                    max_attempts: row.get(3)?,
                    evidence_status: row.get(4)?,
                    _evidence_stage: row.get(5)?,
                    candidate_type: row.get(6)?,
                    title: row.get(7)?,
                    body: row.get(8)?,
                    importance: row.get(9)?,
                    confidence: row.get(10)?,
                    applies_to: parse_json(row.get::<_, String>(11)?, json!({})),
                    references: parse_json(row.get::<_, String>(12)?, json!([])),
                    duplicate_refs: parse_json(row.get::<_, String>(13)?, json!([])),
                    tool_events: parse_json(row.get::<_, String>(14)?, json!([])),
                    evidence_reason: row.get(15)?,
                    found_candidate_id: row.get(16)?,
                    source_kind: row.get(17)?,
                    source_key: row.get(18)?,
                    source_uri: row.get(19)?,
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load finalize job: {error}")))?
        .ok_or_else(|| CliError::io(format!("finalize job or input rows not found: {job_id}")))
}

fn prepare_job(
    connection: &Connection,
    job: &FinalizeJob,
    low_importance_reject_threshold: f64,
) -> Result<PreparedFinalize, String> {
    if job.evidence_status != "knowledge_ready" {
        return Err(job
            .evidence_reason
            .clone()
            .unwrap_or_else(|| format!("cover evidence status is {}", job.evidence_status)));
    }
    let candidate_type = job
        .candidate_type
        .as_deref()
        .map(str::trim)
        .filter(|kind| matches!(*kind, "rule" | "procedure"))
        .ok_or_else(|| "candidate_type_invalid".to_string())?
        .to_string();
    let title = job
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "candidate_title_required".to_string())?;
    let body = job
        .body
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "candidate_body_required".to_string())?;
    let importance = job.importance.unwrap_or(70.0);
    if !importance.is_finite() || importance <= low_importance_reject_threshold {
        return Err("low_importance".to_string());
    }
    if candidate_type == "procedure" && !has_skill_like_procedure_body(body) {
        return Err("procedure_body_not_actionable".to_string());
    }
    if !has_required_applicability(&job.applies_to) {
        return Err("applies_to_categories_required".to_string());
    }

    if target_kind(&job.source_kind) == "knowledge_candidate" {
        if let Some((link_id, status)) = connection
            .query_row(
                "select id, status from landscape_review_item_candidate_links where found_candidate_id = ?1 order by created_at desc limit 1",
                [&job.found_candidate_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| format!("worker_failed:failed to inspect landscape approval: {error}"))?
        {
            if status != "approved" && status != "finalized" {
                if status == "draft_created" {
                    connection
                        .execute(
                            "update landscape_review_item_candidate_links set status = 'review_required', updated_at = CURRENT_TIMESTAMP where id = ?1 and status = 'draft_created'",
                            [&link_id],
                        )
                        .map_err(|error| format!("worker_failed:failed to request landscape review: {error}"))?;
                }
                return Err("landscape_manual_approval_required".to_string());
            }
        }
    }

    let resolved_identity = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: string_property(&job.applies_to, &["projectRef", "project_ref"]),
            repo_key: string_property(&job.applies_to, &["repoKey", "repo_key"]),
            repo_path: string_property(&job.applies_to, &["repoPath", "repo_path"]),
        },
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .map_err(|error| format!("worker_failed:{}", error.code.as_str()))?;
    let project_ref = resolved_identity.project_ref;
    let repo_key = resolved_identity.repo_key;
    let repo_path = resolved_identity.repo_path;
    if project_ref.is_none() && repo_path.is_none() && repo_key.is_none() {
        return Err("worker_failed:PROJECT_IDENTITY_REQUIRED".to_string());
    }

    let identifiers = project_identifiers(
        repo_path.as_deref(),
        repo_key.as_deref(),
        &job.source_key,
        &job.source_uri,
        &job.references,
    );
    let (title, title_counts) = anonymize_text(title, &identifiers);
    let (body, body_counts) = anonymize_text(body, &identifiers);
    let mut replacement_counts = json!({});
    merge_counts(&mut replacement_counts, &title_counts);
    merge_counts(&mut replacement_counts, &body_counts);
    if repo_path.is_some() || repo_key.is_some() {
        replacement_counts["repo_scope"] =
            json!(usize::from(repo_path.is_some()) + usize::from(repo_key.is_some()));
    }

    let mut applies_to = job.applies_to.clone();
    if let Some(object) = applies_to.as_object_mut() {
        object.remove("repoPath");
        object.remove("repo_path");
        object.remove("repoKey");
        object.remove("repo_key");
        object.remove("projectRef");
        object.remove("project_ref");
    }
    let references = anonymize_references(&job.references, &identifiers, &mut replacement_counts);
    let duplicate_refs =
        anonymize_value_strings(&job.duplicate_refs, &identifiers, &mut replacement_counts);
    let replacement_kinds = replacement_counts
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter_map(|(kind, count)| (count.as_u64().unwrap_or(0) > 0).then_some(json!(kind)))
        .collect::<Vec<_>>();
    let removed_scopes = [
        project_ref.as_ref().map(|_| json!("projectRef")),
        repo_path.as_ref().map(|_| json!("repoPath")),
        repo_key.as_ref().map(|_| json!("repoKey")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let anonymization = json!({
        "applied":!replacement_kinds.is_empty(),
        "version":1,
        "replacementKinds":replacement_kinds,
        "replacementCounts":replacement_counts,
        "removedApplicabilityScopes":removed_scopes
    });
    let (polarity, intent_tags) = negative_knowledge_fields(&job.tool_events);

    Ok(PreparedFinalize {
        candidate_type,
        title: normalize_body(&title),
        body: normalize_body(&body),
        importance,
        confidence: job.confidence.unwrap_or(70.0).clamp(0.0, 100.0),
        applies_to,
        references,
        duplicate_refs,
        tool_events: job.tool_events.clone(),
        project_ref,
        repo_key,
        repo_path,
        polarity,
        intent_tags,
        anonymization,
    })
}

fn persist_finalized(
    connection: &Connection,
    job: &FinalizeJob,
    prepared: &PreparedFinalize,
    source_uri: &str,
    worker_id: &str,
    existing_knowledge_id: Option<String>,
    embedding: &[f64],
) -> Result<String, CliError> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| CliError::io(format!("failed to start finalize transaction: {error}")))?;
    let knowledge_id = existing_knowledge_id.unwrap_or_else(|| stable_knowledge_id(source_uri));
    let target_kind = target_kind(&job.source_kind);
    let finalized_at = now_marker();
    let finalize_summary = json!({
        "decision":"stored",
        "reason":"source-supported reusable knowledge passed finalize quality gates",
        "anonymization":prepared.anonymization,
        "qualityGates":["importance","candidate_quality","applicability","embedding"],
        "llmAssist":{"enabled":false,"applied":false}
    });
    let metadata = json!({
        "sourceUri":source_uri,
        "coverEvidenceResultId":job.evidence_result_id,
        "findCandidateResultId":Value::Null,
        "foundCandidateId":job.found_candidate_id,
        "targetStateId":Value::Null,
        "targetKind":target_kind,
        "targetKey":"the source target",
        "sourceDocumentUri":"the source document",
        "references":prepared.references,
        "duplicateRefs":prepared.duplicate_refs,
        "toolEvents":prepared.tool_events,
        "finalizeSummary":finalize_summary,
        "anonymization":prepared.anonymization,
        "origin":{
            "coverEvidenceResultId":job.evidence_result_id,
            "findCandidateResultId":Value::Null,
            "foundCandidateId":job.found_candidate_id,
            "targetStateId":Value::Null,
            "targetKind":target_kind,
            "rawOriginStored":false
        },
        "finalizedBy":"finalizeDistille",
        "finalizedAt":finalized_at,
        "identityProducer":"finalize-distille"
    });

    transaction
        .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, project_ref, repo_key, repo_path,
                  polarity, intent_tags, title, body, applies_to, confidence, importance, metadata,
                  created_at, updated_at
                ) values (?1, ?2, 'draft', 'repo', 'classified', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                on conflict(id) do update set
                  type = excluded.type,
                  status = excluded.status,
                  scope = excluded.scope,
                  classification_status = excluded.classification_status,
                  project_ref = excluded.project_ref,
                  repo_key = excluded.repo_key,
                  repo_path = excluded.repo_path,
                  polarity = excluded.polarity,
                  intent_tags = excluded.intent_tags,
                  title = excluded.title,
                  body = excluded.body,
                  applies_to = excluded.applies_to,
                  confidence = excluded.confidence,
                  importance = excluded.importance,
                  metadata = excluded.metadata,
                  updated_at = CURRENT_TIMESTAMP
                "#,
                params![
                    knowledge_id,
                    prepared.candidate_type,
                    prepared.project_ref,
                    prepared.repo_key,
                    prepared.repo_path,
                    prepared.polarity,
                    prepared.intent_tags.to_string(),
                    prepared.title,
                    prepared.body,
                    prepared.applies_to.to_string(),
                    prepared.confidence,
                    prepared.importance,
                    metadata.to_string(),
                ],
        )
        .map_err(|error| CliError::io(format!("failed to upsert finalized knowledge: {error}")))?;
    refresh_fts(&transaction, &knowledge_id)?;
    upsert_embedding(
        &transaction,
        &knowledge_id,
        &prepared.title,
        &prepared.body,
        embedding,
    )?;

    let source_link_count = link_source_references(
        &transaction,
        &knowledge_id,
        &job.references,
        &prepared.references,
        prepared.confidence,
        &job.evidence_result_id,
    )?;
    if prepared.polarity == "negative" {
        link_negative_origin(&transaction, &knowledge_id, job, prepared.confidence)?;
    }
    if target_kind == "knowledge_candidate" {
        transaction
            .execute(
                "update landscape_review_item_candidate_links set status = 'finalized', updated_at = CURRENT_TIMESTAMP where found_candidate_id = ?1 and status = 'approved'",
                [&job.found_candidate_id],
            )
            .map_err(|error| CliError::io(format!("failed to finalize landscape approval: {error}")))?;
    }

    let completed = transaction
        .execute(
            "update finalize_distille_queue set status = 'completed', attempt_count = ?1, knowledge_id = ?2, next_run_at = null, completed_at = CURRENT_TIMESTAMP, locked_by = null, locked_at = null, heartbeat_at = null, last_error = null, last_outcome_kind = 'stored', updated_at = CURRENT_TIMESTAMP where id = ?3 and status = 'running' and locked_by = ?4",
            params![job.attempt_count + 1, knowledge_id, job.id, worker_id],
        )
        .map_err(|error| CliError::io(format!("failed to complete finalize queue job: {error}")))?;
    ensure_claim_transition(completed, &job.id, "complete")?;
    insert_audit(
        &transaction,
        "FINALIZE_DISTILLE_COMPLETED",
        json!({
            "coverEvidenceResultId":job.evidence_result_id,
            "knowledgeId":knowledge_id,
            "embeddingStatus":"stored",
            "sourceReferenceCount":job.references.as_array().map_or(0,Vec::len),
            "sourceLinkCount":source_link_count,
            "executor":"rust"
        }),
    )?;
    transaction
        .commit()
        .map_err(|error| CliError::io(format!("failed to commit finalize transaction: {error}")))?;
    Ok(knowledge_id)
}

fn find_existing_knowledge(
    connection: &Connection,
    source_uri: &str,
    prepared: &PreparedFinalize,
) -> Result<Option<String>, CliError> {
    connection
        .query_row(
            "select id from knowledge_items where json_extract(metadata, '$.sourceUri') = ?1 and coalesce(project_ref, '') = coalesce(?2, '') and coalesce(repo_key, '') = coalesce(?3, '') and coalesce(repo_path, '') = coalesce(?4, '') limit 1",
            params![source_uri, prepared.project_ref, prepared.repo_key, prepared.repo_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to find existing finalized knowledge: {error}")))
}

fn load_current_knowledge_embedding(
    connection: &Connection,
    knowledge_id: &str,
    title: &str,
    body: &str,
    expected_dimension: Option<usize>,
) -> Result<Option<Vec<f64>>, CliError> {
    if !table_exists(connection, "knowledge_items_vec_fallback")? {
        return Ok(None);
    }
    let content_hash = format!(
        "{:x}",
        Sha256::digest(format!("{title}\n{body}").as_bytes())
    );
    let serialized = connection
        .query_row(
            "select embedding_json from knowledge_items_vec_fallback where knowledge_id = ?1 and content_hash = ?2 and embedding_dimension > 0 and (?3 is null or embedding_dimension = ?3)",
            params![
                knowledge_id,
                content_hash,
                expected_dimension.map(|value| value as i64)
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            CliError::io(format!(
                "failed to verify existing knowledge embedding: {error}"
            ))
        })?;
    let Some(serialized) = serialized else {
        return Ok(None);
    };
    let Ok(values) = serde_json::from_str::<Vec<Value>>(&serialized) else {
        return Ok(None);
    };
    Ok(validate_vector(&values, expected_dimension).ok())
}

fn mark_skipped(
    connection: &Connection,
    job: &FinalizeJob,
    worker_id: &str,
    reason: &str,
) -> Result<(), CliError> {
    let changed = connection
        .execute(
            "update finalize_distille_queue set status = 'skipped', attempt_count = ?1, knowledge_id = null, next_run_at = null, completed_at = CURRENT_TIMESTAMP, locked_by = null, locked_at = null, heartbeat_at = null, last_error = ?2, last_outcome_kind = 'rejected', updated_at = CURRENT_TIMESTAMP where id = ?3 and status = 'running' and locked_by = ?4",
            params![job.attempt_count + 1, reason, job.id, worker_id],
        )
        .map_err(|error| CliError::io(format!("failed to skip finalize job: {error}")))?;
    ensure_claim_transition(changed, &job.id, "skip")
}

fn mark_failed(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
    error: &str,
) -> Result<(), CliError> {
    let changed = connection
        .execute(
            "update finalize_distille_queue set status = 'failed', attempt_count = attempt_count + 1, next_run_at = null, completed_at = null, locked_by = null, locked_at = null, heartbeat_at = null, last_error = ?1, last_outcome_kind = 'worker_failed', updated_at = CURRENT_TIMESTAMP where id = ?2 and status = 'running' and locked_by = ?3",
            params![truncate(error, 1000), job_id, worker_id],
        )
        .map_err(|db_error| CliError::io(format!("failed to mark finalize job failed: {db_error}")))?;
    ensure_claim_transition(changed, job_id, "fail")
}

fn mark_retrying(
    connection: &Connection,
    job: &FinalizeJob,
    worker_id: &str,
    error: &str,
) -> Result<(), CliError> {
    let next_attempt = job.attempt_count + 1;
    let retry_seconds = 30_i64.saturating_mul(2_i64.saturating_pow(next_attempt.min(5) as u32));
    let changed = connection
        .execute(
            "update finalize_distille_queue set status = 'pending', attempt_count = ?1, next_run_at = datetime(CURRENT_TIMESTAMP, '+' || ?2 || ' seconds'), completed_at = null, locked_by = null, locked_at = null, heartbeat_at = null, last_error = ?3, last_outcome_kind = 'embedding_unavailable_retry', updated_at = CURRENT_TIMESTAMP where id = ?4 and status = 'running' and locked_by = ?5",
            params![next_attempt, retry_seconds.min(900), truncate(error, 1000), job.id, worker_id],
        )
        .map_err(|db_error| CliError::io(format!("failed to retry finalize job: {db_error}")))?;
    ensure_claim_transition(changed, &job.id, "retry")
}

fn ensure_claim_transition(changed: usize, job_id: &str, action: &str) -> Result<(), CliError> {
    if changed == 1 {
        return Ok(());
    }
    Err(CliError::io(format!(
        "finalize claim ownership lost before {action}: {job_id}"
    )))
}

fn is_retryable_embedding_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "embedding daemon request failed",
        "embedding daemon http 5",
        "embedding daemon http 408",
        "embedding daemon http 425",
        "embedding daemon http 429",
        "openai embedding request failed",
        "openai embedding http 5",
        "openai embedding http 408",
        "openai embedding http 425",
        "openai embedding http 429",
        "failed to parse openai embedding response",
        "failed to parse embedding response",
        "failed to start embedding cli",
        "embedding cli timed out",
        "embedding cli failed",
        "failed to wait for embedding cli",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

fn embed_one(config: &FinalizeEmbeddingConfig, text: &str) -> Result<Vec<f64>, CliError> {
    let provider = config.provider.trim().to_ascii_lowercase();
    if provider == "disabled" {
        return Err(CliError::io("embedding provider is disabled"));
    }
    let mut errors = Vec::new();
    if provider == "auto" || provider == "daemon" {
        match embed_via_daemon(config, text) {
            Ok(vector) => return Ok(vector),
            Err(error) if provider == "daemon" => return Err(error),
            Err(error) => errors.push(format!("daemon: {error}")),
        }
    }
    if provider == "openai" {
        return embed_via_openai(config, text);
    }
    if provider == "auto" || provider == "cli" {
        match embed_via_cli(config, text) {
            Ok(vector) => return Ok(vector),
            Err(error) => errors.push(format!("cli: {error}")),
        }
    }
    Err(CliError::io(if errors.is_empty() {
        format!("unsupported embedding provider: {provider}")
    } else {
        errors.join("; ")
    }))
}

fn embed_via_daemon(config: &FinalizeEmbeddingConfig, text: &str) -> Result<Vec<f64>, CliError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.max(1)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build embedding client: {error}")))?;
    let url = format!("{}/embed", config.daemon_url.trim_end_matches('/'));
    let mut request = client.post(url).json(&json!({
        "texts":[text],
        "type":"passage",
        "normalize":true,
        "priority":"normal"
    }));
    if let Some(token) = config
        .access_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        request = request.bearer_auth(token.trim());
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("embedding daemon request failed: {error}")))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .map_err(|error| CliError::io(format!("failed to parse embedding response: {error}")))?;
    if !status.is_success() {
        return Err(CliError::io(format!(
            "embedding daemon HTTP {status}: {}",
            truncate(&payload.to_string(), 500)
        )));
    }
    let vector = payload
        .pointer("/embeddings/0")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::io("embedding daemon response did not include embeddings[0]"))?;
    validate_vector(vector, config.expected_dimension)
}

fn embed_via_openai(config: &FinalizeEmbeddingConfig, text: &str) -> Result<Vec<f64>, CliError> {
    let base = config
        .openai_api_base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::io("OpenAI embedding API base URL is not configured"))?;
    let model = config
        .openai_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::io("OpenAI embedding model is not configured"))?;
    let key = config
        .openai_api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| CliError::io("OpenAI embedding API key is not configured"))?;
    let is_azure = base.contains(".azure.com") || base.contains("openai/deployments");
    let url = if is_azure {
        format!(
            "{}/openai/deployments/{}/embeddings?api-version={}",
            base.trim_end_matches('/'),
            percent_encoding::utf8_percent_encode(model, percent_encoding::NON_ALPHANUMERIC),
            config.openai_api_version.as_deref().unwrap_or("2024-10-21")
        )
    } else {
        format!("{}/embeddings", base.trim_end_matches('/'))
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_seconds.max(1)))
        .build()
        .map_err(|error| {
            CliError::io(format!("failed to build OpenAI embedding client: {error}"))
        })?;
    let mut request = client.post(url).json(&json!({
        "input":[text],
        "model":if is_azure { Value::Null } else { json!(model) },
        "dimensions":config.expected_dimension
    }));
    request = if is_azure {
        request.header("api-key", key)
    } else {
        request.bearer_auth(key)
    };
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("OpenAI embedding request failed: {error}")))?;
    let status = response.status();
    let payload: Value = response.json().map_err(|error| {
        CliError::io(format!(
            "failed to parse OpenAI embedding response: {error}"
        ))
    })?;
    if !status.is_success() {
        return Err(CliError::io(format!(
            "OpenAI embedding HTTP {status}: {}",
            truncate(&payload.to_string(), 500)
        )));
    }
    let vector = payload
        .pointer("/data/0/embedding")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CliError::io("OpenAI embedding response did not include data[0].embedding")
        })?;
    validate_vector(vector, config.expected_dimension)
}

fn embed_via_cli(config: &FinalizeEmbeddingConfig, text: &str) -> Result<Vec<f64>, CliError> {
    let mut child = Command::new(&config.cli_python)
        .args(["-m", "e5embed.cli", "--model-dir"])
        .arg(&config.cli_model_dir)
        .args(["--type", "passage", "--text", text])
        .current_dir(&config.cli_root)
        .env(
            "PYTHONPATH",
            format!(
                "{}:{}",
                config.cli_root.to_string_lossy(),
                config
                    .cli_root
                    .parent()
                    .unwrap_or(&config.cli_root)
                    .to_string_lossy()
            ),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CliError::io(format!("failed to start embedding CLI: {error}")))?;
    let started = Instant::now();
    let timeout = Duration::from_secs(config.timeout_seconds.max(1));
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CliError::io(format!(
                    "embedding CLI timed out after {} seconds",
                    config.timeout_seconds.max(1)
                )));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(CliError::io(format!(
                    "failed to wait for embedding CLI: {error}"
                )));
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| CliError::io(format!("failed to read embedding CLI output: {error}")))?;
    if !output.status.success() {
        return Err(CliError::io(format!(
            "embedding CLI failed: {}",
            truncate(&String::from_utf8_lossy(&output.stderr), 500)
        )));
    }
    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| CliError::io(format!("failed to parse embedding CLI output: {error}")))?;
    let vector = payload
        .pointer("/0/embedding")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::io("embedding CLI output did not include [0].embedding"))?;
    validate_vector(vector, config.expected_dimension)
}

fn validate_vector(
    values: &[Value],
    expected_dimension: Option<usize>,
) -> Result<Vec<f64>, CliError> {
    let vector = values
        .iter()
        .map(|value| value.as_f64().filter(|number| number.is_finite()))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| CliError::io("embedding vector includes a non-finite value"))?;
    if vector.is_empty() {
        return Err(CliError::io("embedding provider returned an empty vector"));
    }
    if let Some(expected) = expected_dimension {
        if vector.len() != expected {
            return Err(CliError::io(format!(
                "embedding dimension mismatch: expected {expected}, got {}",
                vector.len()
            )));
        }
    }
    Ok(vector)
}

fn refresh_fts(connection: &Connection, knowledge_id: &str) -> Result<(), CliError> {
    connection
        .execute(
            "delete from knowledge_items_fts where id = ?1",
            [knowledge_id],
        )
        .map_err(|error| CliError::io(format!("failed to clear knowledge FTS: {error}")))?;
    connection
        .execute(
            "insert into knowledge_items_fts(id, title, body) select id, title, body from knowledge_items where id = ?1",
            [knowledge_id],
        )
        .map_err(|error| CliError::io(format!("failed to refresh knowledge FTS: {error}")))?;
    Ok(())
}

fn upsert_embedding(
    connection: &Connection,
    knowledge_id: &str,
    title: &str,
    body: &str,
    embedding: &[f64],
) -> Result<(), CliError> {
    let vector_json = serde_json::to_string(embedding)
        .map_err(|error| CliError::io(format!("failed to serialize embedding: {error}")))?;
    let content_hash = format!(
        "{:x}",
        Sha256::digest(format!("{title}\n{body}").as_bytes())
    );
    connection
        .execute(
            "insert into knowledge_items_vec_fallback (knowledge_id, embedding_json, embedding_dimension, content_hash, updated_at) values (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP) on conflict(knowledge_id) do update set embedding_json = excluded.embedding_json, embedding_dimension = excluded.embedding_dimension, content_hash = excluded.content_hash, updated_at = CURRENT_TIMESTAMP",
            params![knowledge_id, vector_json, embedding.len() as i64, content_hash],
        )
        .map_err(|error| CliError::io(format!("failed to persist knowledge embedding: {error}")))?;
    if table_exists(connection, "knowledge_items_vec")? {
        connection
            .execute(
                "insert into knowledge_items_vec_map (knowledge_id) values (?1) on conflict(knowledge_id) do nothing",
                [knowledge_id],
            )
            .map_err(|error| CliError::io(format!("failed to map knowledge vector: {error}")))?;
        let rowid: i64 = connection
            .query_row(
                "select vec_rowid from knowledge_items_vec_map where knowledge_id = ?1",
                [knowledge_id],
                |row| row.get(0),
            )
            .map_err(|error| {
                CliError::io(format!("failed to load knowledge vector rowid: {error}"))
            })?;
        connection
            .execute("delete from knowledge_items_vec where rowid = ?1", [rowid])
            .map_err(|error| {
                CliError::io(format!("failed to replace knowledge vector: {error}"))
            })?;
        connection
            .execute(
                "insert into knowledge_items_vec(rowid, embedding) values (?1, ?2)",
                params![
                    rowid,
                    serde_json::to_string(embedding).unwrap_or_else(|_| "[]".to_string())
                ],
            )
            .map_err(|error| CliError::io(format!("failed to index knowledge vector: {error}")))?;
    }
    Ok(())
}

fn link_source_references(
    connection: &Connection,
    knowledge_id: &str,
    raw_references: &Value,
    metadata_references: &Value,
    confidence: f64,
    evidence_result_id: &str,
) -> Result<usize, CliError> {
    let mut linked = 0;
    for (index, reference) in raw_references.as_array().into_iter().flatten().enumerate() {
        if reference.get("kind").and_then(Value::as_str) != Some("source")
            || reference.get("evidenceRole").and_then(Value::as_str) != Some("supports_candidate")
        {
            continue;
        }
        let Some(uri) = reference.get("uri").and_then(Value::as_str) else {
            continue;
        };
        let Some(locator) = reference.get("locator").and_then(Value::as_str) else {
            continue;
        };
        let fragment_id = connection
            .query_row(
                "select f.id from source_fragments f join sources s on s.id = f.source_id where s.uri = ?1 and f.locator = ?2 limit 1",
                params![uri, locator],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| CliError::io(format!("failed to resolve source reference: {error}")))?;
        let Some(fragment_id) = fragment_id else {
            continue;
        };
        let metadata_reference = metadata_references
            .as_array()
            .and_then(|references| references.get(index))
            .cloned()
            .unwrap_or_else(|| json!({"kind":"source","uri":"the source document"}));
        connection
            .execute(
                "insert into knowledge_source_links (id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at) select ?1, ?2, ?3, 'derived_from', ?4, ?5, CURRENT_TIMESTAMP where not exists (select 1 from knowledge_source_links where knowledge_id = ?2 and source_fragment_id = ?3)",
                params![event_id("knowledge-source-link", &format!("{knowledge_id}-{fragment_id}")), knowledge_id, fragment_id, unit_confidence(confidence), json!({"source":"finalizeDistille","coverEvidenceResultId":evidence_result_id,"reference":metadata_reference}).to_string()],
            )
            .map_err(|error| CliError::io(format!("failed to link source reference: {error}")))?;
        linked += 1;
    }
    Ok(linked)
}

fn link_negative_origin(
    connection: &Connection,
    knowledge_id: &str,
    job: &FinalizeJob,
    confidence: f64,
) -> Result<(), CliError> {
    if job.source_uri.trim().is_empty() {
        return Ok(());
    }
    let origin_kind = if job.source_kind == "vibe_memory" {
        "vibe_memory"
    } else if job.source_uri.starts_with("landscape://") {
        "landscape_review_item"
    } else if job.source_uri.starts_with("review:") || job.source_uri.starts_with("manual_review:")
    {
        "review_finding"
    } else if job.source_kind == "web_ingest" {
        "external_review_run"
    } else {
        "agent_candidate"
    };
    connection
        .execute(
            "insert into knowledge_origin_links (id, knowledge_id, origin_kind, origin_uri, origin_key, confidence, metadata, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP) on conflict(knowledge_id, origin_kind, origin_uri) do nothing",
            params![event_id("knowledge-origin-link", &format!("{knowledge_id}-{}",job.source_uri)), knowledge_id, origin_kind, job.source_uri, job.source_key, unit_confidence(confidence), json!({"source":"finalizeDistille","coverEvidenceResultId":job.evidence_result_id,"foundCandidateId":job.found_candidate_id,"targetKind":target_kind(&job.source_kind)}).to_string()],
        )
        .map_err(|error| CliError::io(format!("failed to link negative knowledge origin: {error}")))?;
    Ok(())
}

fn insert_audit(connection: &Connection, event_type: &str, payload: Value) -> Result<(), CliError> {
    connection
        .execute(
            "insert into audit_logs (id, event_type, actor, payload, created_at) values (?1, ?2, 'system', ?3, CURRENT_TIMESTAMP)",
            params![event_id("audit", event_type), event_type, payload.to_string()],
        )
        .map_err(|error| CliError::io(format!("failed to insert finalize audit log: {error}")))?;
    Ok(())
}

fn record_audit_best_effort(connection: &Connection, event_type: &str, payload: Value) {
    if let Err(error) = insert_audit(connection, event_type, payload) {
        eprintln!("failed to record {event_type} audit event: {error}");
    }
}

fn append_event_best_effort(
    connection: &Connection,
    id: &str,
    job_id: &str,
    event_type: &str,
    message: &str,
    metadata: Value,
) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        id,
        "finalizeDistille",
        job_id,
        event_type,
        Some(message),
        Some(&metadata.to_string()),
    ) {
        eprintln!("failed to append finalize queue event: {error}");
    }
}

fn has_required_applicability(value: &Value) -> bool {
    ["technologies", "changeTypes", "domains"]
        .iter()
        .all(|key| {
            value
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|item| !item.trim().is_empty())
                })
        })
}

fn has_skill_like_procedure_body(body: &str) -> bool {
    let lowered = body.to_ascii_lowercase();
    let headings = ["use when:", "workflow:", "verification:", "avoid:"];
    let mut previous = 0;
    for (index, heading) in headings.iter().enumerate() {
        let Some(position) = lowered[previous..]
            .find(heading)
            .map(|value| previous + value)
        else {
            return false;
        };
        if index > 0 && position <= previous {
            return false;
        }
        previous = position + heading.len();
    }
    body.lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ")
                || trimmed.split_once('.').is_some_and(|(number, rest)| {
                    number.parse::<usize>().is_ok() && !rest.trim().is_empty()
                })
        })
        .count()
        >= 2
}

fn negative_knowledge_fields(tool_events: &Value) -> (String, Value) {
    let negative = tool_events.as_array().into_iter().flatten().find(|event| {
        event.get("name").and_then(Value::as_str) == Some("negative_coverage")
            && event.get("ok").and_then(Value::as_bool) == Some(true)
    });
    let polarity = negative
        .and_then(|event| event.pointer("/metadata/polarity"))
        .and_then(Value::as_str)
        .filter(|value| *value == "negative")
        .unwrap_or("positive")
        .to_string();
    let intent_tags = negative
        .and_then(|event| event.pointer("/metadata/intentTags"))
        .filter(|value| value.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    (polarity, intent_tags)
}

fn anonymize_references(references: &Value, identifiers: &[String], counts: &mut Value) -> Value {
    Value::Array(
        references
            .as_array()
            .into_iter()
            .flatten()
            .map(|reference| {
                let mut next = reference.clone();
                if let Some(object) = next.as_object_mut() {
                    if object.get("kind").and_then(Value::as_str) == Some("source") {
                        object.insert("uri".to_string(), json!("the source document"));
                        if object.contains_key("locator") {
                            object.insert("locator".to_string(), json!("the source locator"));
                        }
                    }
                    for key in ["title", "note"] {
                        if let Some(value) = object.get(key).and_then(Value::as_str) {
                            let (redacted, changes) = anonymize_text(value, identifiers);
                            merge_counts(counts, &changes);
                            object.insert(key.to_string(), json!(redacted));
                        }
                    }
                }
                next
            })
            .collect(),
    )
}

fn anonymize_value_strings(value: &Value, identifiers: &[String], counts: &mut Value) -> Value {
    match value {
        Value::String(text) => {
            let (redacted, changes) = anonymize_text(text, identifiers);
            merge_counts(counts, &changes);
            json!(redacted)
        }
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| anonymize_value_strings(value, identifiers, counts))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        anonymize_value_strings(value, identifiers, counts),
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn anonymize_text(value: &str, identifiers: &[String]) -> (String, Value) {
    let patterns = [
        (
            "secret",
            r"(?i)\bBearer\s+[A-Za-z0-9\-._~+/]{4,}=*|\b(?:sk|rk|pk)-[A-Za-z0-9]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
            REDACTION_PLACEHOLDER,
        ),
        (
            "absolute_path",
            r#"(?:/Users/[^\s`'\"(),;]+|/home/[^\s`'\"(),;]+|/var/[^\s`'\"(),;]+|/opt/[^\s`'\"(),;]+|\b[A-Za-z]:\\[^\s`'\"(),;]+)"#,
            "the workspace path",
        ),
        (
            "internal_url",
            r#"(?i)\bhttps?://(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[A-Za-z0-9.-]+\.(?:internal|local))(?::\d+)?[^\s`'\"()]*"#,
            "the private endpoint",
        ),
        (
            "branch_or_ticket",
            r"(?i)\b(?:feature|bugfix|hotfix|release|codex|task|ticket|issue|jira|gh)[/_-][A-Za-z0-9._/-]{3,}\b",
            "the change request",
        ),
    ];
    let mut output = value.to_string();
    let mut counts = json!({});
    for (kind, pattern, replacement) in patterns {
        let regex = Regex::new(pattern).expect("static finalize redaction regex must compile");
        let count = regex.find_iter(&output).count();
        if count > 0 {
            output = regex.replace_all(&output, replacement).into_owned();
            counts[kind] = json!(count);
        }
    }
    for identifier in identifiers {
        if identifier.len() < 4 {
            continue;
        }
        let pattern = format!(r"\b{}\b", regex::escape(identifier));
        let regex = Regex::new(&pattern).expect("escaped identifier regex must compile");
        let count = regex.find_iter(&output).count();
        if count > 0 {
            output = regex.replace_all(&output, "the project").into_owned();
            counts["project_identifier"] =
                json!(counts["project_identifier"].as_u64().unwrap_or(0) + count as u64);
        }
    }
    (output, counts)
}

fn project_identifiers(
    repo_path: Option<&str>,
    repo_key: Option<&str>,
    target_key: &str,
    source_uri: &str,
    references: &Value,
) -> Vec<String> {
    let mut values = vec![target_key.to_string(), source_uri.to_string()];
    values.extend(repo_path.map(str::to_string));
    values.extend(repo_key.map(str::to_string));
    values.extend(
        references
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|reference| reference.get("uri").and_then(Value::as_str))
            .map(str::to_string),
    );
    let mut identifiers = Vec::new();
    for value in values {
        for part in value.split(['/', '\\']) {
            let token = part
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .unwrap_or(part)
                .trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '-' && character != '_'
                });
            let lowered = token.to_ascii_lowercase();
            if token.len() >= 4
                && token.len() <= 48
                && !matches!(
                    lowered.as_str(),
                    "src"
                        | "test"
                        | "tests"
                        | "docs"
                        | "pages"
                        | "wiki"
                        | "index"
                        | "module"
                        | "modules"
                        | "service"
                        | "domain"
                        | "repository"
                        | "typescript"
                        | "javascript"
                        | "postgres"
                        | "sqlite"
                        | "vitest"
                )
                && (token.contains('-')
                    || token.contains('_')
                    || token.chars().any(char::is_uppercase))
                && !identifiers.iter().any(|existing| existing == token)
            {
                identifiers.push(token.to_string());
            }
        }
    }
    identifiers.sort_by_key(|right| std::cmp::Reverse(right.len()));
    identifiers
}

fn merge_counts(target: &mut Value, source: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    for (kind, count) in source
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
    {
        let next = target_object.get(kind).and_then(Value::as_u64).unwrap_or(0)
            + count.as_u64().unwrap_or(0);
        target_object.insert(kind.clone(), json!(next));
    }
}

fn normalize_body(value: &str) -> String {
    let mut normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    while normalized.contains("\n\n\n") {
        normalized = normalized.replace("\n\n\n", "\n\n");
    }
    normalized
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn string_property(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn target_kind(source_kind: &str) -> &'static str {
    match source_kind {
        "wiki_file" => "wiki_file",
        "web_ingest" => "web_ingest",
        "knowledge_candidate" => "knowledge_candidate",
        _ => "vibe_memory",
    }
}

fn unit_confidence(value: f64) -> f64 {
    if value <= 1.0 {
        value.clamp(0.0, 1.0)
    } else {
        (value / 100.0).clamp(0.0, 1.0)
    }
}

fn stable_knowledge_id(source_uri: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(source_uri.as_bytes()));
    format!("finalize-{}", &digest[..24])
}

fn event_id(prefix: &str, seed: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{prefix}:{seed}:{nanos}").as_bytes())
    );
    format!("{prefix}-{}", &digest[..24])
}

fn now_marker() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("unix-ms:{millis}")
}

fn parse_json(raw: String, fallback: Value) -> Value {
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn table_exists(connection: &Connection, name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where name = ?1)",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| CliError::io(format!("failed to inspect SQLite table {name}: {error}")))
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(r#"
            create table finalize_distille_queue (
              id text primary key, evidence_result_id text, status text not null, priority integer not null default 0, attempt_count integer not null default 0,
              max_attempts integer not null default 5, next_run_at text,
              metadata text not null default '{}',
              knowledge_id text, completed_at text, locked_by text, locked_at text, heartbeat_at text,
              last_error text, last_outcome_kind text, created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP
            );
            create table evidence_coverage_results (
              id text primary key, found_candidate_id text not null, status text not null, stage text not null,
              type text, title text, body text, importance real, confidence real, applies_to text not null,
              "references" text not null, duplicate_refs text not null, tool_events text not null, reason text,
              updated_at text not null default CURRENT_TIMESTAMP
            );
            create table found_candidates (id text primary key, finding_job_id text not null, metadata text not null default '{}', updated_at text not null default CURRENT_TIMESTAMP);
            create table finding_candidate_queue (id text primary key, source_kind text not null, source_key text not null, source_uri text not null, metadata text not null default '{}', updated_at text not null default CURRENT_TIMESTAMP);
            create table vibe_memories (id text primary key, metadata text not null default '{}');
            create table landscape_review_item_candidate_links (id text primary key, found_candidate_id text, status text not null, created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP);
            create table knowledge_items (
              id text primary key, type text not null, status text not null, scope text not null, classification_status text not null,
              project_ref text, repo_key text, repo_path text, polarity text not null, intent_tags text not null, title text not null,
              body text not null, applies_to text not null, confidence real not null, importance real not null, metadata text not null,
              created_at text not null, updated_at text not null
            );
            create virtual table knowledge_items_fts using fts5(id unindexed, title, body);
            create table knowledge_items_vec_fallback (knowledge_id text primary key, embedding_json text not null, embedding_dimension integer not null, content_hash text not null, updated_at text not null);
            create table knowledge_items_vec_map (vec_rowid integer primary key autoincrement, knowledge_id text not null unique);
            create table sources (id text primary key, uri text not null);
            create table source_fragments (id text primary key, source_id text not null, locator text not null);
            create table knowledge_source_links (id text primary key, knowledge_id text not null, source_fragment_id text not null, link_type text not null, confidence real not null, metadata text not null, created_at text not null);
            create table knowledge_origin_links (id text primary key, knowledge_id text not null, origin_kind text not null, origin_uri text not null, origin_key text not null, confidence real not null, metadata text not null, created_at text not null, unique(knowledge_id, origin_kind, origin_uri));
            create table audit_logs (id text primary key, event_type text not null, actor text not null, payload text not null, created_at text not null);
            create table distillation_queue_events (id text primary key, queue_name text not null, queue_job_id text not null, event_type text not null, message text, metadata text not null, created_at text not null default CURRENT_TIMESTAMP);
        "#).unwrap();
        connection.execute_batch(r#"
            insert into finding_candidate_queue (id,source_kind,source_key,source_uri) values ('finding-1','vibe_memory','memory-1','vibe-memory://memory-1');
            insert into found_candidates (id,finding_job_id) values ('candidate-1','finding-1');
            insert into vibe_memories values ('memory-1','{"rustAgentLogSync":true,"projectRoot":"/work/project"}');
            insert into evidence_coverage_results (id,found_candidate_id,status,stage,type,title,body,importance,confidence,applies_to,"references",duplicate_refs,tool_events,reason) values (
              'evidence-1','candidate-1','knowledge_ready','final','rule','Rust Finalize','Use the resident worker after verification.',80,90,
              '{"technologies":["Rust"],"changeTypes":["bugfix"],"domains":["queue"],"repoPath":"/tmp/project"}',
              '[]','[]','[]',null
            );
            insert into finalize_distille_queue (id,evidence_result_id,status,attempt_count,locked_by) values ('finalize-1','evidence-1','running',0,'rust-worker');
        "#).unwrap();
        connection
    }

    fn serve_embedding() -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = r#"{"embeddings":[[0.1,0.2,0.3]],"dimension":3}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        (format!("http://{address}"), handle)
    }

    fn embedding_config(daemon_url: String) -> FinalizeEmbeddingConfig {
        FinalizeEmbeddingConfig {
            provider: "daemon".to_string(),
            daemon_url,
            access_token: None,
            timeout_seconds: 2,
            expected_dimension: Some(3),
            openai_api_base_url: None,
            openai_api_version: None,
            openai_model: None,
            openai_api_key: None,
            cli_python: PathBuf::new(),
            cli_root: PathBuf::new(),
            cli_model_dir: PathBuf::new(),
        }
    }

    #[test]
    fn rust_finalize_persists_knowledge_embedding_and_completed_state() {
        let connection = setup();
        let (url, server) = serve_embedding();
        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config(url),
            20.0,
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(status, FinalizeExecutionStatus::Completed);
        let queue = connection.query_row("select status, attempt_count, last_outcome_kind, knowledge_id is not null from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,i64>(3)?))).unwrap();
        assert_eq!(queue, ("completed".to_string(), 1, "stored".to_string(), 1));
        let knowledge: i64 = connection.query_row("select count(*) from knowledge_items where status = 'draft' and classification_status = 'classified' and repo_path = '/tmp/project'", [], |row| row.get(0)).unwrap();
        let vectors: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_vec_fallback where embedding_dimension = 3",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((knowledge, vectors), (1, 1));
    }

    #[test]
    fn finalize_identity_backfill_recovers_trusted_legacy_project_root_idempotently() {
        let connection = setup();
        connection
            .execute(
                "update finalize_distille_queue set status = 'pending' where id = 'finalize-1'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "update finding_candidate_queue set metadata = '{\"projectIdentity\":null}' where id = 'finding-1'",
                [],
            )
            .unwrap();
        let first = backfill_finalize_project_identity_for_connection(&connection, 100).unwrap();
        let second = backfill_finalize_project_identity_for_connection(&connection, 100).unwrap();

        assert_eq!(first, 1);
        assert_eq!(second, 0);
        let identity = connection
            .query_row(
                "select json_extract(e.applies_to, '$.repoPath'), json_extract(f.metadata, '$.projectIdentity.repoPath') from evidence_coverage_results e join found_candidates c on c.id=e.found_candidate_id join finding_candidate_queue f on f.id=c.finding_job_id where e.id='evidence-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(
            identity,
            ("/work/project".to_string(), "/work/project".to_string())
        );
        let audits: i64 = connection
            .query_row(
                "select count(*) from audit_logs where event_type='PROJECT_IDENTITY_BACKFILL_APPLIED'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audits, 1);
    }

    #[test]
    fn rust_finalize_skips_non_ready_evidence() {
        let connection = setup();
        connection.execute("update evidence_coverage_results set status = 'insufficient', reason = 'missing support' where id = 'evidence-1'", []).unwrap();
        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config("http://127.0.0.1:1".to_string()),
            20.0,
        )
        .unwrap();
        assert_eq!(status, FinalizeExecutionStatus::Skipped);
        let queue = connection.query_row("select status, last_outcome_kind, last_error from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).unwrap();
        assert_eq!(
            queue,
            (
                "skipped".to_string(),
                "rejected".to_string(),
                "missing support".to_string()
            )
        );
    }

    #[test]
    fn rust_finalize_marks_embedding_failure_without_partial_knowledge() {
        let connection = setup();
        connection
            .execute(
                "update finalize_distille_queue set max_attempts = 1 where id = 'finalize-1'",
                [],
            )
            .unwrap();
        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config("http://127.0.0.1:1".to_string()),
            20.0,
        )
        .unwrap();
        assert_eq!(status, FinalizeExecutionStatus::Failed);
        let queue = connection.query_row("select status, attempt_count, last_outcome_kind from finalize_distille_queue where id = 'finalize-1'", [], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?))).unwrap();
        let knowledge: i64 = connection
            .query_row("select count(*) from knowledge_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            queue,
            ("failed".to_string(), 1, "worker_failed".to_string())
        );
        assert_eq!(knowledge, 0);
    }

    #[test]
    fn rust_finalize_retries_transient_embedding_failure_without_partial_knowledge() {
        let connection = setup();
        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config("http://127.0.0.1:1".to_string()),
            50.0,
        )
        .unwrap();

        assert_eq!(status, FinalizeExecutionStatus::Retrying);
        let queue = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null from finalize_distille_queue where id = 'finalize-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            queue,
            (
                "pending".to_string(),
                1,
                "embedding_unavailable_retry".to_string(),
                1,
            )
        );
        let knowledge: i64 = connection
            .query_row("select count(*) from knowledge_items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(knowledge, 0);
    }

    #[test]
    fn rust_finalize_repairs_existing_knowledge_when_embedding_is_missing() {
        let connection = setup();
        connection.execute(
            "insert into knowledge_items (id,type,status,scope,classification_status,repo_path,polarity,intent_tags,title,body,applies_to,confidence,importance,metadata,created_at,updated_at) values ('existing-1','rule','draft','repo','classified','/tmp/project','positive','[]','Rust Finalize','Use the resident worker after verification.','{}',90,80,?1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
            [json!({"sourceUri":"cover-evidence-result://evidence-1"}).to_string()],
        ).unwrap();
        let (url, server) = serve_embedding();

        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config(url),
            20.0,
        )
        .unwrap();
        server.join().unwrap();

        assert_eq!(status, FinalizeExecutionStatus::Completed);
        let vector_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_vec_fallback where knowledge_id='existing-1' and embedding_dimension=3",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let knowledge_id: String = connection
            .query_row(
                "select knowledge_id from finalize_distille_queue where id='finalize-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(vector_count, 1);
        assert_eq!(knowledge_id, "existing-1");
    }

    #[test]
    fn rust_finalize_reuses_current_embedding_and_repairs_fts() {
        let connection = setup();
        connection
            .execute_batch(
                "create table knowledge_items_vec (rowid integer primary key, embedding text not null);",
            )
            .unwrap();
        connection.execute(
            "insert into knowledge_items (id,type,status,scope,classification_status,repo_path,polarity,intent_tags,title,body,applies_to,confidence,importance,metadata,created_at,updated_at) values ('existing-1','rule','draft','repo','classified','/tmp/project','positive','[]','Rust Finalize','Use the resident worker after verification.','{}',90,80,?1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
            [json!({"sourceUri":"cover-evidence-result://evidence-1"}).to_string()],
        ).unwrap();
        let content_hash = format!(
            "{:x}",
            Sha256::digest(b"Rust Finalize\nUse the resident worker after verification.")
        );
        connection.execute(
            "insert into knowledge_items_vec_fallback (knowledge_id,embedding_json,embedding_dimension,content_hash,updated_at) values ('existing-1','[0.1,0.2,0.3]',3,?1,CURRENT_TIMESTAMP)",
            [content_hash],
        ).unwrap();

        let status = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config("http://127.0.0.1:1".to_string()),
            20.0,
        )
        .unwrap();

        assert_eq!(status, FinalizeExecutionStatus::Completed);
        let fts_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_fts where id='existing-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let indexed_vector_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items_vec v join knowledge_items_vec_map m on m.vec_rowid = v.rowid where m.knowledge_id='existing-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(fts_count, 1);
        assert_eq!(indexed_vector_count, 1);
    }

    #[test]
    fn rust_finalize_does_not_overwrite_a_reclaimed_job() {
        let connection = setup();
        connection
            .execute(
                "update finalize_distille_queue set locked_by='replacement-worker' where id='finalize-1'",
                [],
            )
            .unwrap();

        let error = run_finalize_distille_job_for_connection(
            &connection,
            "finalize-1",
            "rust-worker",
            &embedding_config("http://127.0.0.1:1".to_string()),
            20.0,
        )
        .unwrap_err();

        assert!(error.to_string().contains("claim ownership lost"));
        let queue = connection
            .query_row(
                "select status, locked_by, attempt_count from finalize_distille_queue where id='finalize-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            queue,
            ("running".to_string(), "replacement-worker".to_string(), 0)
        );
    }

    #[test]
    fn finalize_retries_transient_daemon_and_openai_failures() {
        for error in [
            "embedding daemon HTTP 429 Too Many Requests",
            "OpenAI embedding request failed: connection reset",
            "OpenAI embedding HTTP 503 Service Unavailable",
            "failed to parse OpenAI embedding response: unexpected EOF",
        ] {
            assert!(is_retryable_embedding_error(error), "{error}");
        }
        assert!(!is_retryable_embedding_error(
            "OpenAI embedding API key is not configured"
        ));
    }
}
