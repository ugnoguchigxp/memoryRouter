use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::super::events::append_queue_event_for_connection;

use super::helpers::{priority_for_source_kind, retry_backoff_seconds, stable_id};
use super::types::{
    NegativeCoveringExecution, NegativeCoveringPersistStatus, NegativeCoveringResult,
};

pub(crate) fn persist_negative_covering_result(
    connection: &mut Connection,
    execution: &NegativeCoveringExecution,
    result: &NegativeCoveringResult,
) -> Result<NegativeCoveringPersistStatus, CliError> {
    let tx = connection
        .transaction()
        .map_err(|error| CliError::io(format!("failed to begin covering persistence: {error}")))?;
    let owns_claim = tx
        .query_row(
            "select exists(
               select 1
               from covering_evidence_queue queue_job
               join llm_provider_leases lease
                 on lease.id = ?3
                and lease.queue_name = 'coveringEvidence'
                and lease.queue_job_id = queue_job.id
                and lease.worker_id = ?2
               where queue_job.id = ?1
                 and queue_job.status = 'running'
                 and queue_job.locked_by = ?2
                 and lease.status = 'active'
             )",
            params![
                execution.job_id,
                execution.provider_lease.worker_id,
                execution.provider_lease.id
            ],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to verify covering claim ownership: {error}"
            ))
        })?;
    if !owns_claim {
        let event_id = stable_id(
            "covering-event",
            &format!(
                "{}-superseded-{}",
                execution.job_id, execution.provider_lease.id
            ),
        );
        let event_exists = tx
            .query_row(
                "select exists(select 1 from distillation_queue_events where id = ?1)",
                [&event_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value != 0)
            .map_err(|error| {
                CliError::io(format!(
                    "failed to inspect discarded covering event: {error}"
                ))
            })?;
        if !event_exists {
            append_queue_event_for_connection(
                &tx,
                &event_id,
                "coveringEvidence",
                &execution.job_id,
                "discarded",
                Some("stale Rust Covering result discarded after claim ownership changed"),
                Some(
                    &json!({
                        "executor": "rust",
                        "reason": "claim_ownership_changed",
                        "workerId": execution.provider_lease.worker_id,
                        "providerLeaseId": execution.provider_lease.id
                    })
                    .to_string(),
                ),
            )?;
        }
        tx.commit().map_err(|error| {
            CliError::io(format!(
                "failed to commit discarded covering result: {error}"
            ))
        })?;
        return Ok(NegativeCoveringPersistStatus::Superseded);
    }
    let existing_evidence_id = tx
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
        "coveringMode": execution.covering_mode()
    });
    let next_attempt_count = execution.attempt_count + 1;
    let retryable = matches!(
        result.status.as_str(),
        "provider_failed" | "parse_failed" | "tool_failed" | "reprocess_requested"
    );
    let exhausted = next_attempt_count >= execution.max_attempts.max(1);
    let (persist_status, job_status, completed_at, next_run_seconds, release_reason, event_type) =
        if retryable && !exhausted {
            (
                NegativeCoveringPersistStatus::Retrying,
                "pending",
                None,
                Some(retry_backoff_seconds(next_attempt_count)),
                if result.status == "provider_failed" {
                    "provider_unavailable_retry"
                } else {
                    "worker_finished"
                },
                "retried",
            )
        } else if retryable {
            (
                NegativeCoveringPersistStatus::Failed,
                "failed",
                None,
                None,
                "worker_failed",
                "failed",
            )
        } else {
            (
                NegativeCoveringPersistStatus::Completed,
                "completed",
                Some("CURRENT_TIMESTAMP"),
                None,
                "worker_finished",
                "completed",
            )
        };

    let applies_to_text = applies_to.to_string();
    let references_text = Value::Array(result.references.clone()).to_string();
    let duplicate_refs_text = Value::Array(result.duplicate_refs.clone()).to_string();
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
                duplicate_refs = ?13,
                tool_events = ?14,
                reason = ?15,
                metadata = ?16,
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
                duplicate_refs_text,
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
              ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
                duplicate_refs_text,
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

    let completed_expression = completed_at.unwrap_or("null");
    let next_run_expression = next_run_seconds
        .map(|seconds| format!("datetime(CURRENT_TIMESTAMP, '+{seconds} seconds')"))
        .unwrap_or_else(|| "null".to_string());
    let queue_changed = tx
        .execute(
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
            where id = ?5
              and status = 'running'
              and locked_by = ?6
            "
            ),
            params![
                job_status,
                next_attempt_count,
                result.reason,
                result.status,
                execution.job_id,
                execution.provider_lease.worker_id,
            ],
        )
        .map_err(|error| CliError::io(format!("failed to update covering queue job: {error}")))?;
    if queue_changed != 1 {
        return Err(CliError::io(
            "covering claim ownership changed before queue transition",
        ));
    }
    let lease_changed = tx
        .execute(
            "
        update llm_provider_leases
        set status = 'released',
            released_at = CURRENT_TIMESTAMP,
            release_reason = ?2,
            updated_at = CURRENT_TIMESTAMP
        where id = ?1
          and status = 'active'
          and queue_name = 'coveringEvidence'
          and queue_job_id = ?3
          and worker_id = ?4
        ",
            params![
                execution.provider_lease.id,
                release_reason,
                execution.job_id,
                execution.provider_lease.worker_id
            ],
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to release covering provider lease: {error}"
            ))
        })?;
    if lease_changed != 1 {
        return Err(CliError::io(
            "covering claim ownership changed before provider lease release",
        ));
    }
    append_queue_event_for_connection(
        &tx,
        &stable_id(
            "covering-event",
            &format!(
                "{}-{next_attempt_count}-{event_type}-{}",
                execution.job_id, execution.provider_lease.id
            ),
        ),
        "coveringEvidence",
        &execution.job_id,
        event_type,
        Some("covering evidence processed by Rust resident executor"),
        Some(
            &json!({
                "executor": "rust",
                "coveringMode": execution.covering_mode(),
                "targetId": execution.target.target_id,
                "status": result.status,
                "attemptCount": next_attempt_count
            })
            .to_string(),
        ),
    )?;
    tx.commit()
        .map_err(|error| CliError::io(format!("failed to commit covering result: {error}")))?;
    Ok(persist_status)
}
