use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::shared::errors::CliError;

use super::episode_executor::LocalLlmTargetConfig;
use super::events::append_queue_event_for_connection;
use super::types::{ClaimedProviderLeaseJob, ProviderLeaseAssignment};

const NEGATIVE_SYSTEM_PROMPT: &str =
    include_str!("../../../../../shared/prompts/cover-negative-evidence-rust-v1.txt");
const INTENT_TAGS: &[&str] = &[
    "guidance",
    "guardrail",
    "prohibition",
    "warning",
    "failure_pattern",
    "review_finding",
    "regression",
    "test_gap",
    "verification",
    "preference",
    "boundary_violation",
    "architecture_risk",
    "security_risk",
    "performance_risk",
    "operational_risk",
    "data_integrity",
];

#[derive(Debug, Clone)]
pub(crate) struct NegativeCoveringExecution {
    pub(crate) job_id: String,
    pub(crate) found_candidate_id: String,
    pub(crate) distillation_version: String,
    pub(crate) attempt_count: i64,
    pub(crate) max_attempts: i64,
    pub(crate) provider_policy: String,
    pub(crate) candidate_title: String,
    pub(crate) candidate_content: String,
    pub(crate) candidate_origin: Value,
    pub(crate) candidate_metadata: Value,
    pub(crate) source_uri: String,
    pub(crate) source_kind: String,
    pub(crate) provider_lease: ProviderLeaseAssignment,
    pub(crate) target: LocalLlmTargetConfig,
    pub(crate) api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum NegativeCoveringPersistStatus {
    Completed,
    Failed,
    Retrying,
}

pub(crate) struct NegativeCoveringHeartbeatGuard {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl NegativeCoveringHeartbeatGuard {
    pub(crate) fn start(
        sqlite_path: &Path,
        execution: &NegativeCoveringExecution,
    ) -> Result<Self, CliError> {
        let stop = Arc::new(AtomicBool::new(false));
        let Ok(writer) = crate::domains::sqlite_writer::global_writer_for_path(sqlite_path) else {
            // One-shot test execution uses a short-lived writer per operation. There is no
            // concurrent resident maintenance loop in that mode, so a heartbeat is unnecessary.
            return Ok(Self { stop, handle: None });
        };
        let thread_stop = Arc::clone(&stop);
        let job_id = execution.job_id.clone();
        let lease_id = execution.provider_lease.id.clone();
        let handle = thread::Builder::new()
            .name("context-still-covering-heartbeat".to_string())
            .spawn(move || {
                while !thread_stop.load(Ordering::SeqCst) {
                    for _ in 0..80 {
                        if thread_stop.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(250));
                    }
                    if thread_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let queue_job_id = job_id.clone();
                    let provider_lease_id = lease_id.clone();
                    let _ = writer.execute("queue.covering_negative_heartbeat", move |connection| {
                        connection
                            .execute(
                                "update covering_evidence_queue set heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP where id = ?1 and status = 'running'",
                                [&queue_job_id],
                            )
                            .map_err(|error| format!("failed to heartbeat covering job: {error}"))?;
                        connection
                            .execute(
                                "update llm_provider_leases set heartbeat_at = CURRENT_TIMESTAMP, expires_at = datetime(CURRENT_TIMESTAMP, '+120 seconds'), updated_at = CURRENT_TIMESTAMP where id = ?1 and status = 'active'",
                                [&provider_lease_id],
                            )
                            .map_err(|error| format!("failed to heartbeat covering lease: {error}"))?;
                        Ok(())
                    });
                }
            })
            .map_err(|error| CliError::io(format!("failed to start covering heartbeat: {error}")))?;
        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for NegativeCoveringHeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct NegativeCoveringResult {
    status: String,
    stage: &'static str,
    candidate: Option<Value>,
    references: Vec<Value>,
    tool_events: Vec<Value>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NegativeEvidenceResponse {
    status: String,
    polarity: String,
    #[serde(default)]
    intent_tags: Vec<String>,
    #[serde(default, alias = "applicability")]
    applies_to: Value,
    distilled: NegativeDistilled,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    origin_refs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NegativeDistilled {
    failure: String,
    impact: Option<String>,
    trigger: Option<String>,
    fix: Option<String>,
    verification: Option<String>,
    decision_signal: Option<String>,
}

#[derive(Debug, Clone)]
struct NegativeQuality {
    ready: bool,
    reason: Option<String>,
    evidence_count: usize,
    confidence: i64,
    importance: i64,
}

pub(crate) fn load_claimed_negative_execution(
    connection: &Connection,
    claimed: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    api_key: Option<String>,
) -> Result<NegativeCoveringExecution, CliError> {
    let provider_lease = claimed.provider_lease;
    connection
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
              coalesce(fc.origin, '{}'),
              coalesce(fc.metadata, '{}'),
              coalesce(fq.source_uri, ''),
              coalesce(fq.source_kind, '')
            from covering_evidence_queue cq
            join found_candidates fc on fc.id = cq.found_candidate_id
            join finding_candidate_queue fq on fq.id = fc.finding_job_id
            where cq.id = ?1
              and cq.status = 'running'
            limit 1
            ",
            [&claimed.id],
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
                    candidate_origin: parse_json(row.get::<_, String>(8)?),
                    candidate_metadata: parse_json(row.get::<_, String>(9)?),
                    source_uri: row.get(10)?,
                    source_kind: row.get(11)?,
                    provider_lease,
                    target,
                    api_key,
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load claimed covering job: {error}")))?
        .ok_or_else(|| {
            CliError::io(format!(
                "claimed covering job was not available for execution: {}",
                claimed.id
            ))
        })
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

pub(crate) fn persist_negative_covering_result(
    connection: &mut Connection,
    execution: &NegativeCoveringExecution,
    result: &NegativeCoveringResult,
) -> Result<NegativeCoveringPersistStatus, CliError> {
    let existing_evidence_id = connection
        .query_row(
            "select id from evidence_coverage_results where found_candidate_id = ?1 and producer_queue = 'coveringEvidence' limit 1",
            [&execution.found_candidate_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to inspect covering result: {error}")))?;
    let evidence_id = existing_evidence_id
        .clone()
        .unwrap_or_else(|| stable_id("covering-evidence", &execution.found_candidate_id));

    let candidate = result.candidate.as_ref();
    let candidate_type = candidate
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str);
    let title = candidate
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str);
    let body = candidate
        .and_then(|value| value.get("body"))
        .and_then(Value::as_str);
    let importance = candidate
        .and_then(|value| value.get("importance"))
        .and_then(Value::as_i64);
    let confidence = candidate
        .and_then(|value| value.get("confidence"))
        .and_then(Value::as_i64);
    let applies_to = candidate
        .and_then(|value| value.get("appliesTo"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let metadata = json!({
        "queueVersion": "v2",
        "executor": "rust",
        "coveringMode": "negative"
    });
    let next_attempt_count = execution.attempt_count + 1;
    let retryable = matches!(
        result.status.as_str(),
        "provider_failed" | "parse_failed" | "tool_failed" | "reprocess_requested"
    );
    let exhausted = next_attempt_count >= execution.max_attempts.max(1);
    let persist_status = if retryable && !exhausted {
        NegativeCoveringPersistStatus::Retrying
    } else if retryable {
        NegativeCoveringPersistStatus::Failed
    } else {
        NegativeCoveringPersistStatus::Completed
    };

    let tx = connection
        .transaction()
        .map_err(|error| CliError::io(format!("failed to begin covering persistence: {error}")))?;
    let applies_to_text = applies_to.to_string();
    let references_text = Value::Array(result.references.clone()).to_string();
    let tool_events_text = Value::Array(result.tool_events.clone()).to_string();
    let metadata_text = metadata.to_string();
    if existing_evidence_id.is_some() {
        tx.execute(
            "
            update evidence_coverage_results
            set producer_job_id = ?2,
                distillation_version = ?3,
                status = ?4,
                stage = ?5,
                type = ?6,
                title = ?7,
                body = ?8,
                importance = ?9,
                confidence = ?10,
                applies_to = ?11,
                \"references\" = ?12,
                duplicate_refs = '[]',
                tool_events = ?13,
                reason = ?14,
                metadata = ?15,
                updated_at = CURRENT_TIMESTAMP
            where id = ?1
            ",
            params![
                evidence_id,
                execution.job_id,
                execution.distillation_version,
                result.status,
                result.stage,
                candidate_type,
                title,
                body,
                importance,
                confidence,
                applies_to_text,
                references_text,
                tool_events_text,
                result.reason,
                metadata_text,
            ],
        )
        .map_err(|error| CliError::io(format!("failed to update covering result: {error}")))?;
    } else {
        tx.execute(
            "
            insert into evidence_coverage_results (
              id, found_candidate_id, producer_queue, producer_job_id,
              distillation_version, status, stage, type, title, body,
              importance, confidence, applies_to, \"references\", duplicate_refs,
              tool_events, reason, metadata, created_at, updated_at
            ) values (
              ?1, ?2, 'coveringEvidence', ?3, ?4, ?5, ?6, ?7, ?8, ?9,
              ?10, ?11, ?12, ?13, '[]', ?14, ?15, ?16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            ",
            params![
                evidence_id,
                execution.found_candidate_id,
                execution.job_id,
                execution.distillation_version,
                result.status,
                result.stage,
                candidate_type,
                title,
                body,
                importance,
                confidence,
                applies_to_text,
                references_text,
                tool_events_text,
                result.reason,
                metadata_text,
            ],
        )
        .map_err(|error| CliError::io(format!("failed to insert covering result: {error}")))?;
    }

    if result.status == "knowledge_ready" {
        let finalize_id = stable_id("finalize-distille", &evidence_id);
        let finalize_priority = priority_for_source_kind(&execution.source_kind);
        tx.execute(
            "
            insert into finalize_distille_queue (
              id, evidence_result_id, distillation_version, status, priority,
              provider_policy, metadata, created_at, updated_at
            ) select
              ?1, ?2, ?3, 'pending', ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            where not exists (
              select 1 from finalize_distille_queue where evidence_result_id = ?2
            )
            ",
            params![
                finalize_id,
                evidence_id,
                execution.distillation_version,
                finalize_priority,
                execution.provider_policy,
                json!({
                    "queueVersion": "v2",
                    "sourceQueue": "coveringEvidence",
                    "sourceQueueJobId": execution.job_id,
                    "executor": "rust"
                })
                .to_string(),
            ],
        )
        .map_err(|error| CliError::io(format!("failed to enqueue finalize job: {error}")))?;
    }

    let (job_status, completed_at, next_run_seconds) = match persist_status {
        NegativeCoveringPersistStatus::Completed => ("completed", Some("CURRENT_TIMESTAMP"), None),
        NegativeCoveringPersistStatus::Failed => ("failed", None, None),
        NegativeCoveringPersistStatus::Retrying => (
            "pending",
            None,
            Some(retry_backoff_seconds(next_attempt_count)),
        ),
    };
    let release_reason = match persist_status {
        NegativeCoveringPersistStatus::Completed => "worker_finished",
        NegativeCoveringPersistStatus::Failed => "worker_failed",
        NegativeCoveringPersistStatus::Retrying if result.status == "provider_failed" => {
            "provider_unavailable_retry"
        }
        NegativeCoveringPersistStatus::Retrying => "worker_finished",
    };
    let completed_expression = completed_at.unwrap_or("null");
    let next_run_expression = next_run_seconds
        .map(|seconds| format!("datetime(CURRENT_TIMESTAMP, '+{seconds} seconds')"))
        .unwrap_or_else(|| "null".to_string());
    tx.execute(
        &format!(
            "
            update covering_evidence_queue
            set status = ?1,
                attempt_count = ?2,
                next_run_at = {next_run_expression},
                completed_at = {completed_expression},
                locked_by = null,
                locked_at = null,
                heartbeat_at = null,
                last_error = ?3,
                last_outcome_kind = ?4,
                updated_at = CURRENT_TIMESTAMP
            where id = ?5 and status = 'running'
            "
        ),
        params![
            job_status,
            next_attempt_count,
            result.reason,
            result.status,
            execution.job_id,
        ],
    )
    .map_err(|error| CliError::io(format!("failed to update covering queue job: {error}")))?;
    tx.execute(
        "
        update llm_provider_leases
        set status = 'released',
            released_at = CURRENT_TIMESTAMP,
            release_reason = ?2,
            updated_at = CURRENT_TIMESTAMP
        where id = ?1 and status = 'active'
        ",
        (&execution.provider_lease.id, release_reason),
    )
    .map_err(|error| {
        CliError::io(format!(
            "failed to release covering provider lease: {error}"
        ))
    })?;
    tx.commit()
        .map_err(|error| CliError::io(format!("failed to commit covering result: {error}")))?;

    let event_type = match persist_status {
        NegativeCoveringPersistStatus::Completed => "completed",
        NegativeCoveringPersistStatus::Failed => "failed",
        NegativeCoveringPersistStatus::Retrying => "retried",
    };
    let _ = append_queue_event_for_connection(
        connection,
        &stable_id(
            "covering-event",
            &format!("{}-{next_attempt_count}-{event_type}", execution.job_id),
        ),
        "coveringEvidence",
        &execution.job_id,
        event_type,
        Some("negative covering evidence processed by Rust resident executor"),
        Some(
            &json!({
                "executor": "rust",
                "coveringMode": "negative",
                "targetId": execution.target.target_id,
                "status": result.status,
                "attemptCount": next_attempt_count
            })
            .to_string(),
        ),
    );
    Ok(persist_status)
}

fn request_negative_evidence(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> Result<String, CliError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build covering LLM client: {error}")))?;
    let url = chat_url(&execution.target.api_base_url, &execution.target.api_path);
    let request_body = json!({
        "model": execution.target.model,
        "messages": [
            {"role": "system", "content": NEGATIVE_SYSTEM_PROMPT},
            {"role": "user", "content": json!({
                "candidate": {
                    "title": execution.candidate_title,
                    "content": execution.candidate_content
                }
            }).to_string()}
        ],
        "max_tokens": 2048,
        "temperature": 0
    });
    let mut request = client.post(url).json(&request_body);
    if let Some(api_key) = execution
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("covering LLM request failed: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| CliError::io(format!("failed to read covering LLM response: {error}")))?;
    if !status.is_success() {
        return Err(CliError::io(format!(
            "covering LLM HTTP {}: {}",
            status.as_u16(),
            truncate(&body, 1_000)
        )));
    }
    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| CliError::io(format!("invalid covering LLM response JSON: {error}")))?;
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| CliError::io("covering LLM response omitted message content"))
}

fn parse_negative_response(
    execution: &NegativeCoveringExecution,
    content: &str,
) -> Result<NegativeCoveringResult, CliError> {
    let cleaned = content
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();
    let parsed: NegativeEvidenceResponse = serde_json::from_str(&cleaned).map_err(|error| {
        CliError::io(format!(
            "failed to parse negative evidence result JSON: {error}"
        ))
    })?;
    if parsed.distilled.failure.trim().is_empty() {
        return Err(CliError::io(
            "negative evidence response omitted distilled.failure",
        ));
    }
    let intent_tags = parsed
        .intent_tags
        .iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| INTENT_TAGS.contains(&tag.as_str()))
        .collect::<Vec<_>>();
    let applies_to = merge_applicability(
        &execution.candidate_origin,
        &execution.candidate_metadata,
        &parsed.applies_to,
    );
    let quality = assess_negative_quality(&parsed, &intent_tags, &applies_to);
    let has_required_applicability = required_applicability_present(&applies_to);
    let ready = quality.ready && has_required_applicability;
    let status = if ready {
        "knowledge_ready".to_string()
    } else {
        "insufficient".to_string()
    };
    let reason = if quality.ready && !has_required_applicability {
        Some("applies_to_categories_required".to_string())
    } else {
        quality.reason.clone()
    };
    let candidate = ready.then(|| {
        json!({
            "type": "rule",
            "title": execution.candidate_title,
            "body": build_negative_body(&parsed.distilled),
            "confidence": quality.confidence,
            "importance": quality.importance,
            "appliesTo": applies_to
        })
    });
    let references = parsed
        .evidence
        .iter()
        .map(|evidence| {
            json!({
                "kind": "source",
                "uri": if execution.source_uri.trim().is_empty() {
                    format!("agent://candidate/{}", execution.found_candidate_id)
                } else {
                    execution.source_uri.clone()
                },
                "note": evidence.trim(),
                "evidenceRole": "supports_candidate"
            })
        })
        .collect::<Vec<_>>();
    let tool_events = vec![json!({
        "name": "negative_coverage",
        "ok": true,
        "metadata": {
            "polarity": parsed.polarity,
            "intentTags": intent_tags,
            "appliesTo": applies_to,
            "originRefs": parsed.origin_refs,
            "distilled": parsed.distilled,
            "quality": {
                "ready": quality.ready,
                "reason": quality.reason,
                "evidenceCount": quality.evidence_count,
                "confidence": quality.confidence,
                "importance": quality.importance
            }
        }
    })];
    Ok(NegativeCoveringResult {
        status,
        stage: "final",
        candidate,
        references,
        tool_events,
        reason,
    })
}

fn assess_negative_quality(
    parsed: &NegativeEvidenceResponse,
    intent_tags: &[String],
    applies_to: &Value,
) -> NegativeQuality {
    let evidence_count = parsed
        .evidence
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect::<BTreeSet<_>>()
        .len();
    let has_trigger = non_empty(parsed.distilled.trigger.as_deref());
    let has_fix = non_empty(parsed.distilled.fix.as_deref());
    let has_verification = non_empty(parsed.distilled.verification.as_deref());
    let has_decision_signal = non_empty(parsed.distilled.decision_signal.as_deref());
    let has_high_risk_tag = intent_tags.iter().any(|tag| {
        matches!(
            tag.as_str(),
            "regression" | "security_risk" | "data_integrity"
        )
    });
    let general = applies_to
        .get("general")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut confidence = 62 + (evidence_count.min(3) as i64 * 6);
    let mut importance = 58;
    if has_trigger {
        confidence += 6;
    }
    if has_fix {
        confidence += 6;
    }
    if has_verification {
        confidence += 4;
    }
    if has_decision_signal {
        confidence += 2;
    }
    if general {
        confidence -= 8;
    }
    if has_high_risk_tag {
        importance += 14;
    }
    if has_trigger && has_fix {
        importance += 8;
    }
    if evidence_count >= 2 {
        importance += 6;
    }
    if general && !has_high_risk_tag {
        importance -= 6;
    }
    let confidence = confidence.clamp(45, 90);
    let importance = importance.clamp(45, 90);
    let reason = if parsed.status != "ready" {
        Some(parsed.status.clone())
    } else if parsed.polarity != "negative" {
        Some("negative_polarity_required".to_string())
    } else if parsed.distilled.failure.trim().is_empty() {
        Some("negative_failure_required".to_string())
    } else if !has_trigger {
        Some("negative_trigger_required".to_string())
    } else if !has_fix {
        Some("negative_fix_required".to_string())
    } else if evidence_count < 2 && !has_high_risk_tag {
        Some("negative_evidence_too_thin".to_string())
    } else if general && !has_high_risk_tag && evidence_count < 3 {
        Some("negative_general_scope_requires_stronger_evidence".to_string())
    } else {
        None
    };
    NegativeQuality {
        ready: reason.is_none(),
        reason,
        evidence_count,
        confidence,
        importance,
    }
}

fn merge_applicability(origin: &Value, metadata: &Value, parsed: &Value) -> Value {
    let mut merged = serde_json::Map::new();
    for value in [origin, metadata, parsed] {
        let source = value
            .get("appliesTo")
            .or_else(|| value.get("applicability"))
            .unwrap_or(value);
        for key in ["technologies", "changeTypes", "domains"] {
            if let Some(items) = normalized_string_array(source.get(key)) {
                if !items.is_empty() {
                    merged.insert(key.to_string(), json!(items));
                }
            }
        }
        for key in ["repoPath", "repoKey"] {
            if let Some(text) = source
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                merged.insert(key.to_string(), json!(text));
            }
        }
        if let Some(general) = source.get("general").and_then(Value::as_bool) {
            merged.insert("general".to_string(), json!(general));
        }
    }
    Value::Object(merged)
}

fn normalized_string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let values = match value? {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        Value::String(text) => text
            .split([',', '、', '，'])
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        _ => return None,
    };
    Some(
        values
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    )
}

fn required_applicability_present(value: &Value) -> bool {
    ["technologies", "changeTypes", "domains"]
        .iter()
        .all(|key| {
            value
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| non_empty(item.as_str())))
        })
}

fn build_negative_body(distilled: &NegativeDistilled) -> String {
    [
        Some(format!("避けること: {}", distilled.failure.trim())),
        labeled("影響", distilled.impact.as_deref()),
        labeled("発生条件", distilled.trigger.as_deref()),
        labeled("推奨対応", distilled.fix.as_deref()),
        labeled("確認方法", distilled.verification.as_deref()),
        labeled("判断シグナル", distilled.decision_signal.as_deref()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

fn labeled(label: &str, value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("{label}: {value}"))
}

fn non_empty(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

fn failure_result(status: &str, reason: &str) -> NegativeCoveringResult {
    NegativeCoveringResult {
        status: status.to_string(),
        stage: "final",
        candidate: None,
        references: Vec::new(),
        tool_events: vec![json!({
            "name": "negative_coverage",
            "ok": false,
            "error": truncate(reason, 500)
        })],
        reason: Some(truncate(reason, 500)),
    }
}

fn retry_backoff_seconds(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 4) as u32;
    (30_i64.saturating_mul(2_i64.pow(exponent))).min(300)
}

fn priority_for_source_kind(source_kind: &str) -> i64 {
    match source_kind {
        "knowledge_candidate" => 90,
        "web_ingest" => 80,
        "wiki_file" => 70,
        _ => 50,
    }
}

fn chat_url(api_base_url: &str, api_path: &str) -> String {
    let base = api_base_url.trim_end_matches('/');
    let path = if api_path.trim().is_empty() {
        "/v1/chat/completions"
    } else {
        api_path.trim()
    };
    let normalized_path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    if base.ends_with("/v1") && normalized_path.starts_with("/v1/") {
        format!("{}{}", base, &normalized_path[3..])
    } else {
        format!("{base}{normalized_path}")
    }
}

fn stable_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}:{value}").as_bytes());
    format!("rust-{namespace}-{:x}", digest)
}

fn parse_json(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_persistence_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table covering_evidence_queue (
                  id text primary key,
                  status text not null,
                  attempt_count integer not null,
                  max_attempts integer not null,
                  next_run_at text,
                  completed_at text,
                  locked_by text,
                  locked_at text,
                  heartbeat_at text,
                  last_error text,
                  last_outcome_kind text,
                  updated_at text not null
                );
                create table evidence_coverage_results (
                  id text primary key,
                  found_candidate_id text not null,
                  producer_queue text not null,
                  producer_job_id text not null,
                  distillation_version text not null,
                  status text not null,
                  stage text not null,
                  type text,
                  title text,
                  body text,
                  importance integer,
                  confidence integer,
                  applies_to text not null default '{}',
                  "references" text not null default '[]',
                  duplicate_refs text not null default '[]',
                  tool_events text not null default '[]',
                  reason text,
                  metadata text not null default '{}',
                  created_at text not null,
                  updated_at text not null
                );
                create trigger evidence_coverage_results_producer_no_duplicate_insert
                before insert on evidence_coverage_results
                when exists (
                  select 1 from evidence_coverage_results
                  where found_candidate_id = new.found_candidate_id
                    and producer_queue = new.producer_queue
                )
                begin
                  select raise(abort, 'duplicate evidence_coverage_results producer');
                end;
                create table finalize_distille_queue (
                  id text primary key,
                  evidence_result_id text not null,
                  distillation_version text not null,
                  status text not null,
                  priority integer not null,
                  provider_policy text,
                  metadata text not null,
                  created_at text not null,
                  updated_at text not null
                );
                create table llm_provider_leases (
                  id text primary key,
                  status text not null,
                  released_at text,
                  release_reason text,
                  updated_at text not null
                );
                create table distillation_queue_events (
                  id text primary key,
                  queue_name text not null,
                  queue_job_id text not null,
                  event_type text not null,
                  message text,
                  metadata text not null,
                  created_at text not null
                );
                insert into covering_evidence_queue (
                  id, status, attempt_count, max_attempts, locked_by, locked_at,
                  heartbeat_at, updated_at
                ) values (
                  'cover-1', 'running', 0, 2, 'worker-1', CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                insert into llm_provider_leases (id, status, updated_at)
                values ('lease-1', 'active', CURRENT_TIMESTAMP);
                "#,
            )
            .unwrap();
    }

    fn execution() -> NegativeCoveringExecution {
        NegativeCoveringExecution {
            job_id: "cover-1".to_string(),
            found_candidate_id: "candidate-1".to_string(),
            distillation_version: "v-test".to_string(),
            attempt_count: 0,
            max_attempts: 2,
            provider_policy: "default".to_string(),
            candidate_title: "SQLite writer ownership regression".to_string(),
            candidate_content: "SQLite writer を複数プロセスから開くと更新が競合する。resident writer 経由に統一し、queue smoke test で確認する。".to_string(),
            candidate_origin: json!({"polarity":"negative"}),
            candidate_metadata: json!({}),
            source_uri: "vibe_memory:memory-1".to_string(),
            source_kind: "vibe_memory".to_string(),
            provider_lease: ProviderLeaseAssignment {
                id: "lease-1".to_string(),
                pool_id: "pool-1".to_string(),
                target_id: "local-1".to_string(),
                queue_name: "coveringEvidence".to_string(),
                queue_job_id: "cover-1".to_string(),
                worker_id: "worker-1".to_string(),
            },
            target: LocalLlmTargetConfig {
                target_id: "local-1".to_string(),
                api_base_url: "http://localhost:1".to_string(),
                api_path: "/v1/chat/completions".to_string(),
                model: "qwen".to_string(),
            },
            api_key: None,
        }
    }

    #[test]
    fn negative_response_maps_to_knowledge_ready_with_applicability() {
        let response = json!({
            "status": "ready",
            "polarity": "negative",
            "intentTags": ["data_integrity", "not-allowed"],
            "appliesTo": {
                "technologies": ["sqlite"],
                "changeTypes": ["implementation", "testing"],
                "domains": ["queue"],
                "general": false
            },
            "distilled": {
                "failure": "複数writerによって更新が競合する",
                "impact": "キュー状態を失う",
                "trigger": "resident以外がSQLiteへ直接書き込む",
                "fix": "resident writerへ統一する",
                "verification": "queue smoke testを実行する",
                "decisionSignal": null
            },
            "evidence": ["競合を再現した", "単一writerで解消した"],
            "originRefs": ["vibe_memory:memory-1"]
        });

        let result = parse_negative_response(&execution(), &response.to_string()).unwrap();

        assert_eq!(result.status, "knowledge_ready");
        let candidate = result.candidate.unwrap();
        assert_eq!(candidate["type"], "rule");
        assert_eq!(candidate["appliesTo"]["technologies"], json!(["sqlite"]));
        assert!(candidate["body"]
            .as_str()
            .unwrap()
            .contains("推奨対応: resident writerへ統一する"));
        assert_eq!(result.references.len(), 2);
        assert_eq!(
            result.tool_events[0]["metadata"]["intentTags"],
            json!(["data_integrity"])
        );
    }

    #[test]
    fn negative_covering_chat_url_deduplicates_v1_prefix() {
        assert_eq!(
            chat_url("http://192.168.0.61:50043/v1", "/v1/chat/completions"),
            "http://192.168.0.61:50043/v1/chat/completions"
        );
        assert_eq!(
            chat_url("http://127.0.0.1:44448", "/v1/chat/completions"),
            "http://127.0.0.1:44448/v1/chat/completions"
        );
    }

    #[test]
    fn negative_response_without_required_applicability_is_insufficient() {
        let response = json!({
            "status": "ready",
            "polarity": "negative",
            "intentTags": ["regression"],
            "appliesTo": {"technologies": ["sqlite"]},
            "distilled": {
                "failure": "writer競合",
                "trigger": "複数writer",
                "fix": "単一writer",
                "impact": null,
                "verification": null,
                "decisionSignal": null
            },
            "evidence": ["再現した"],
            "originRefs": []
        });

        let result = parse_negative_response(&execution(), &response.to_string()).unwrap();

        assert_eq!(result.status, "insufficient");
        assert_eq!(
            result.reason.as_deref(),
            Some("applies_to_categories_required")
        );
        assert!(result.candidate.is_none());
    }

    #[test]
    fn persist_negative_knowledge_ready_completes_and_enqueues_finalize_once() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_persistence_schema(&connection);
        let response = json!({
            "status": "ready",
            "polarity": "negative",
            "intentTags": ["data_integrity"],
            "appliesTo": {
                "technologies": ["sqlite"],
                "changeTypes": ["implementation"],
                "domains": ["queue"]
            },
            "distilled": {
                "failure": "writer競合",
                "impact": "状態損失",
                "trigger": "複数writer",
                "fix": "単一writer",
                "verification": "queue smoke test",
                "decisionSignal": null
            },
            "evidence": ["競合を再現した", "単一writerで解消した"],
            "originRefs": []
        });
        let execution = execution();
        let result = parse_negative_response(&execution, &response.to_string()).unwrap();

        let status =
            persist_negative_covering_result(&mut connection, &execution, &result).unwrap();

        assert_eq!(status, NegativeCoveringPersistStatus::Completed);
        let queue = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, locked_by from covering_evidence_queue where id = 'cover-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            queue,
            (
                "completed".to_string(),
                1,
                "knowledge_ready".to_string(),
                None
            )
        );
        let evidence_count: i64 = connection
            .query_row(
                "select count(*) from evidence_coverage_results where found_candidate_id = 'candidate-1' and status = 'knowledge_ready'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let finalize_count: i64 = connection
            .query_row("select count(*) from finalize_distille_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        let lease = connection
            .query_row(
                "select status, release_reason from llm_provider_leases where id = 'lease-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(evidence_count, 1);
        assert_eq!(finalize_count, 1);
        assert_eq!(
            lease,
            ("released".to_string(), "worker_finished".to_string())
        );
    }

    #[test]
    fn persist_negative_parse_failure_returns_job_with_backoff() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_persistence_schema(&connection);
        let execution = execution();
        let result = failure_result("parse_failed", "invalid JSON");

        let status =
            persist_negative_covering_result(&mut connection, &execution, &result).unwrap();

        assert_eq!(status, NegativeCoveringPersistStatus::Retrying);
        let queue = connection
            .query_row(
                "select status, attempt_count, next_run_at is not null, completed_at, last_outcome_kind from covering_evidence_queue where id = 'cover-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            queue,
            (
                "pending".to_string(),
                1,
                1,
                None,
                "parse_failed".to_string()
            )
        );
        let finalize_count: i64 = connection
            .query_row("select count(*) from finalize_distille_queue", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(finalize_count, 0);
    }

    #[test]
    fn persist_negative_retry_updates_existing_result_under_duplicate_trigger() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_persistence_schema(&connection);
        let first_execution = execution();
        let first_result = failure_result("provider_failed", "HTTP 503");
        persist_negative_covering_result(&mut connection, &first_execution, &first_result).unwrap();
        connection
            .execute_batch(
                "
                update covering_evidence_queue
                set status = 'running', locked_by = 'worker-2', locked_at = CURRENT_TIMESTAMP,
                    heartbeat_at = CURRENT_TIMESTAMP
                where id = 'cover-1';
                update llm_provider_leases
                set status = 'active', released_at = null, release_reason = null
                where id = 'lease-1';
                ",
            )
            .unwrap();
        let mut retry_execution = execution();
        retry_execution.attempt_count = 1;
        let response = json!({
            "status": "ready",
            "polarity": "negative",
            "intentTags": ["data_integrity"],
            "appliesTo": {
                "technologies": ["sqlite"],
                "changeTypes": ["implementation"],
                "domains": ["queue"]
            },
            "distilled": {
                "failure": "writer競合",
                "trigger": "複数writer",
                "fix": "単一writer",
                "verification": "queue smoke test"
            },
            "evidence": ["競合を再現した", "単一writerで解消した"]
        });
        let retry_result =
            parse_negative_response(&retry_execution, &response.to_string()).unwrap();

        let status =
            persist_negative_covering_result(&mut connection, &retry_execution, &retry_result)
                .unwrap();

        assert_eq!(status, NegativeCoveringPersistStatus::Completed);
        let evidence = connection
            .query_row(
                "select count(*), max(status) from evidence_coverage_results",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(evidence, (1, "knowledge_ready".to_string()));
    }
}
