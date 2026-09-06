use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::super::events::append_queue_event_for_connection;
use super::super::provider_execution::owns_provider_execution;

use super::deduplication::{
    find_near_duplicate_candidates, near_duplicate_review_allows_publish,
    review_near_duplicate_episode,
};
use super::helpers::{
    is_provider_unavailable, now_timestamp, provider_retry_after_seconds, pseudo_uuid, truncate,
};
use super::identity::record_episode_identity_event;
use super::lease::{
    append_episode_superseded_event, episode_provider_backoff_seconds, release_split_episode_lease,
    stable_episode_event_id,
};
use super::persistence::{
    create_episode_idempotently, create_episode_idempotently_in_transaction, existing_episode_id,
};
use super::progress::{mark_completed, patch_episode_progress};
use super::types::{
    EpisodeDistillerJobRow, EpisodePersistOutcome, EpisodeSplitStatus, EpisodeStore,
    EpisodeWriteIdentity, LocalLlmTargetConfig, PendingEpisode, SourceDocument,
    EPISODE_EXECUTION_SUPERSEDED,
};

impl EpisodeStore<'_> {
    pub(super) fn reader(&self) -> &Connection {
        match self {
            Self::Legacy(connection) => connection,
            Self::Split { reader, .. } => reader,
        }
    }

    pub(super) fn patch_progress(
        &self,
        job: &EpisodeDistillerJobRow,
        metadata: &Value,
    ) -> Result<(), CliError> {
        match self {
            Self::Legacy(connection) => patch_episode_progress(connection, job, metadata),
            Self::Split {
                sqlite_path,
                provider_lease,
                ..
            } => {
                let provider_lease = provider_lease.clone();
                let job_id = job.id.clone();
                let metadata = metadata.to_string();
                crate::domains::sqlite_writer::execute_for_path(
                    sqlite_path,
                    "queue.episode_progress",
                    move |connection| {
                        let changed = connection
                            .execute(
                                "update episode_distiller_queue
                                 set metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?1),
                                     updated_at = CURRENT_TIMESTAMP
                                 where id = ?2
                                   and status = 'running'
                                   and locked_by = ?3
                                   and exists (
                                     select 1 from llm_provider_leases lease
                                     where lease.id = ?4
                                       and lease.status = 'active'
                                       and lease.queue_name = 'episodeDistiller'
                                       and lease.queue_job_id = ?2
                                       and lease.worker_id = ?3
                                   )",
                                params![
                                    metadata,
                                    job_id,
                                    provider_lease.worker_id,
                                    provider_lease.id
                                ],
                            )
                            .map_err(|error| {
                                format!("failed to patch split episode progress: {error}")
                            })?;
                        if changed == 1 {
                            Ok(())
                        } else {
                            Err(EPISODE_EXECUTION_SUPERSEDED.to_string())
                        }
                    },
                )
                .map_err(CliError::io)
            }
        }
    }

    pub(super) fn record_identity_event(
        &self,
        event_type: &str,
        payload: Value,
    ) -> Result<(), CliError> {
        match self {
            Self::Legacy(connection) => {
                record_episode_identity_event(connection, event_type, payload);
                Ok(())
            }
            Self::Split {
                sqlite_path,
                provider_lease,
                ..
            } => {
                let provider_lease = provider_lease.clone();
                let event_type = event_type.to_string();
                crate::domains::sqlite_writer::execute_for_path(
                    sqlite_path,
                    "queue.episode_identity_event",
                    move |connection| {
                        if !owns_provider_execution(connection, &provider_lease)
                            .map_err(|error| error.to_string())?
                        {
                            return Err(EPISODE_EXECUTION_SUPERSEDED.to_string());
                        }
                        record_episode_identity_event(connection, &event_type, payload);
                        Ok(())
                    },
                )
                .map_err(CliError::io)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn create_episode(
        &self,
        item: &PendingEpisode,
        document: &SourceDocument,
        identity: &EpisodeWriteIdentity,
        target: &LocalLlmTargetConfig,
        api_key: Option<&str>,
        timeout_seconds: u64,
    ) -> Result<EpisodePersistOutcome, CliError> {
        match self {
            Self::Legacy(connection) => create_episode_idempotently(
                connection,
                item,
                document,
                identity,
                target,
                api_key,
                timeout_seconds,
            ),
            Self::Split {
                sqlite_path,
                reader,
                provider_lease,
            } => {
                if let Some(existing) = existing_episode_id(reader, &item.source_key)? {
                    return Ok(EpisodePersistOutcome::SourceDeduped(existing));
                }
                let candidates = find_near_duplicate_candidates(reader, item, document, identity)?;
                if !candidates.is_empty() {
                    let review = review_near_duplicate_episode(
                        item,
                        &candidates,
                        target,
                        api_key,
                        timeout_seconds,
                    )?;
                    if !near_duplicate_review_allows_publish(&review, &candidates) {
                        return Ok(EpisodePersistOutcome::NearDuplicateSkipped(review));
                    }
                }
                let item = item.clone();
                let document = document.clone();
                let identity = identity.clone();
                let provider_lease = provider_lease.clone();
                crate::domains::sqlite_writer::execute_for_path(
                    sqlite_path,
                    "queue.episode_persist_item",
                    move |connection| {
                        let tx = connection.transaction().map_err(|error| {
                            format!("failed to begin split episode item transaction: {error}")
                        })?;
                        if !owns_provider_execution(&tx, &provider_lease)
                            .map_err(|error| error.to_string())?
                        {
                            return Err(EPISODE_EXECUTION_SUPERSEDED.to_string());
                        }
                        let outcome = create_episode_idempotently_in_transaction(
                            &tx, &item, &document, &identity,
                        )
                        .map_err(|error| error.to_string())?;
                        tx.commit().map_err(|error| {
                            format!("failed to commit split episode item: {error}")
                        })?;
                        Ok(outcome)
                    },
                )
                .map_err(CliError::io)
            }
        }
    }

    pub(super) fn persist_completed(
        &self,
        job: &EpisodeDistillerJobRow,
        status: &str,
        outcome: &str,
        metadata: &Value,
        event_metadata: &Value,
    ) -> Result<(), CliError> {
        match self {
            Self::Legacy(connection) => {
                mark_completed(connection, job, status, outcome, metadata)?;
                append_queue_event_for_connection(
                    connection,
                    &pseudo_uuid(),
                    "episodeDistiller",
                    &job.id,
                    "completed",
                    Some("episode distiller completed"),
                    Some(&event_metadata.to_string()),
                )
            }
            Self::Split {
                sqlite_path,
                provider_lease,
                ..
            } => {
                let job_id = job.id.clone();
                let provider_lease = provider_lease.clone();
                let status = status.to_string();
                let outcome = outcome.to_string();
                let metadata = metadata.to_string();
                let event_metadata = event_metadata.to_string();
                crate::domains::sqlite_writer::execute_for_path(
                    sqlite_path,
                    "queue.episode_persist",
                    move |connection| {
                        let tx = connection.transaction().map_err(|error| {
                            format!("failed to begin split episode completion: {error}")
                        })?;
                        if !owns_provider_execution(&tx, &provider_lease)
                            .map_err(|error| error.to_string())?
                        {
                            return Err(EPISODE_EXECUTION_SUPERSEDED.to_string());
                        }
                        let queue_changed = tx
                            .execute(
                                "update episode_distiller_queue
                                 set status = ?1,
                                     locked_by = null,
                                     locked_at = null,
                                     heartbeat_at = null,
                                     next_run_at = null,
                                     completed_at = CURRENT_TIMESTAMP,
                                     last_error = null,
                                     last_outcome_kind = ?2,
                                     metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?3),
                                     updated_at = CURRENT_TIMESTAMP
                                 where id = ?4
                                   and status = 'running'
                                   and locked_by = ?5",
                                params![
                                    status,
                                    outcome,
                                    metadata,
                                    job_id,
                                    provider_lease.worker_id
                                ],
                            )
                            .map_err(|error| {
                                format!("failed to complete split episode job: {error}")
                            })?;
                        let lease_changed = release_split_episode_lease(
                            &tx,
                            &provider_lease,
                            "worker_finished",
                        )?;
                        if queue_changed != 1 || lease_changed != 1 {
                            return Err(EPISODE_EXECUTION_SUPERSEDED.to_string());
                        }
                        append_queue_event_for_connection(
                            &tx,
                            &stable_episode_event_id(&job_id, &provider_lease.id, "completed"),
                            "episodeDistiller",
                            &job_id,
                            "completed",
                            Some("episode distiller completed outside SQLite writer"),
                            Some(&event_metadata),
                        )
                        .map_err(|error| error.to_string())?;
                        tx.commit().map_err(|error| {
                            format!("failed to commit split episode completion: {error}")
                        })
                    },
                )
                .map_err(CliError::io)
            }
        }
    }

    pub(super) fn persist_error(
        &self,
        job: &EpisodeDistillerJobRow,
        target: &LocalLlmTargetConfig,
        error: &str,
    ) -> Result<EpisodeSplitStatus, CliError> {
        let Self::Split {
            sqlite_path,
            provider_lease,
            ..
        } = self
        else {
            return Err(CliError::io(error));
        };
        let job = job.clone();
        let provider_lease = provider_lease.clone();
        let target_id = target.target_id.clone();
        let error = error.to_string();
        crate::domains::sqlite_writer::execute_for_path(
            sqlite_path,
            "queue.episode_error_persist",
            move |connection| {
                let tx = connection
                    .transaction()
                    .map_err(|cause| format!("failed to begin split episode failure: {cause}"))?;
                if !owns_provider_execution(&tx, &provider_lease)
                    .map_err(|cause| cause.to_string())?
                {
                    append_episode_superseded_event(&tx, &job.id, &provider_lease)?;
                    tx.commit().map_err(|cause| {
                        format!("failed to commit superseded split episode: {cause}")
                    })?;
                    return Ok(EpisodeSplitStatus::Superseded);
                }
                let next_attempt_count = job.attempt_count + 1;
                let provider_unavailable = is_provider_unavailable(&error);
                let exhausted = next_attempt_count >= job.max_attempts.max(1);
                let (
                    persist_status,
                    queue_status,
                    outcome,
                    next_run_seconds,
                    release_reason,
                    event_type,
                ) = if provider_unavailable && exhausted {
                    (
                        EpisodeSplitStatus::Paused,
                        "paused",
                        "provider_unavailable_exhausted",
                        None,
                        "provider_unavailable_retry",
                        "paused",
                    )
                } else if provider_unavailable {
                    (
                        EpisodeSplitStatus::Retrying,
                        "pending",
                        "provider_unavailable_retry",
                        Some(
                            provider_retry_after_seconds(&error)
                                .max(episode_provider_backoff_seconds(job.attempt_count)),
                        ),
                        "provider_unavailable_retry",
                        "retried",
                    )
                } else if exhausted {
                    (
                        EpisodeSplitStatus::Failed,
                        "failed",
                        "failed",
                        None,
                        "worker_failed",
                        "failed",
                    )
                } else {
                    (
                        EpisodeSplitStatus::Retrying,
                        "pending",
                        "failed",
                        Some(30),
                        "worker_failed",
                        "retried",
                    )
                };
                let next_run_at = next_run_seconds
                    .map(|seconds| format!("datetime(CURRENT_TIMESTAMP, '+{seconds} seconds')"))
                    .unwrap_or_else(|| "null".to_string());
                let completed_at = if queue_status == "failed" {
                    "CURRENT_TIMESTAMP"
                } else {
                    "null"
                };
                let queue_changed = tx
                    .execute(
                        &format!(
                            "update episode_distiller_queue
                             set status = ?1,
                                 attempt_count = ?2,
                                 next_run_at = {next_run_at},
                                 locked_by = null,
                                 locked_at = null,
                                 heartbeat_at = null,
                                 completed_at = {completed_at},
                                 last_error = ?3,
                                 last_outcome_kind = ?4,
                                 metadata = json_patch(
                                   coalesce(nullif(metadata, ''), '{{}}'),
                                   ?5
                                 ),
                                 updated_at = CURRENT_TIMESTAMP
                             where id = ?6
                               and status = 'running'
                               and locked_by = ?7"
                        ),
                        params![
                            queue_status,
                            next_attempt_count,
                            truncate(&error, 1000),
                            outcome,
                            json!({
                                "episodeDistiller": {
                                    "providerUnavailableRetriedAt": now_timestamp(),
                                    "providerUnavailableError": truncate(&error, 1000),
                                    "providerRetryAfterSeconds": next_run_seconds,
                                    "executor": "rust"
                                }
                            })
                            .to_string(),
                            job.id,
                            provider_lease.worker_id
                        ],
                    )
                    .map_err(|cause| format!("failed to persist split episode error: {cause}"))?;
                let lease_changed =
                    release_split_episode_lease(&tx, &provider_lease, release_reason)?;
                if queue_changed != 1 || lease_changed != 1 {
                    return Ok(EpisodeSplitStatus::Superseded);
                }
                append_queue_event_for_connection(
                    &tx,
                    &stable_episode_event_id(&job.id, &provider_lease.id, event_type),
                    "episodeDistiller",
                    &job.id,
                    event_type,
                    Some("episode distiller external execution ended"),
                    Some(
                        &json!({
                            "workerId": provider_lease.worker_id,
                            "executor": "rust",
                            "targetId": target_id,
                            "reason": outcome,
                            "attemptCount": next_attempt_count,
                            "error": truncate(&error, 500)
                        })
                        .to_string(),
                    ),
                )
                .map_err(|cause| cause.to_string())?;
                tx.commit()
                    .map_err(|cause| format!("failed to commit split episode error: {cause}"))?;
                Ok(persist_status)
            },
        )
        .map_err(CliError::io)
    }

    pub(super) fn record_superseded(&self, job: &EpisodeDistillerJobRow) -> Result<(), CliError> {
        let Self::Split {
            sqlite_path,
            provider_lease,
            ..
        } = self
        else {
            return Ok(());
        };
        let job_id = job.id.clone();
        let provider_lease = provider_lease.clone();
        crate::domains::sqlite_writer::execute_for_path(
            sqlite_path,
            "queue.episode_superseded",
            move |connection| {
                let tx = connection.transaction().map_err(|error| {
                    format!("failed to begin superseded episode event: {error}")
                })?;
                append_episode_superseded_event(&tx, &job_id, &provider_lease)?;
                tx.commit()
                    .map_err(|error| format!("failed to commit superseded episode event: {error}"))
            },
        )
        .map_err(CliError::io)
    }
}
