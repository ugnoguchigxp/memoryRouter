use std::path::Path;

use rusqlite::Connection;
use serde_json::json;
use zeroize::Zeroizing;

use crate::shared::errors::CliError;

use super::super::events::append_queue_event_for_connection;
use super::super::provider_execution::open_query_only_connection;
use super::super::types::ClaimedProviderLeaseJob;

use super::helpers::{is_provider_unavailable, pseudo_uuid, truncate};
use super::lease::HeartbeatGuard;
use super::processing::process_episode_distiller_job;
use super::progress::{mark_failed, mark_provider_unavailable_retry};
use super::source::load_job;
use super::types::{
    EpisodeExecutionStatus, EpisodeSplitStatus, EpisodeStore, LocalLlmTargetConfig,
    EPISODE_EXECUTION_SUPERSEDED,
};

pub(crate) fn run_episode_distiller_job_for_connection(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<EpisodeExecutionStatus, CliError> {
    let job = load_job(connection, job_id)?;
    let _heartbeat = HeartbeatGuard::start(connection, &job.id, worker_id)?;
    let store = EpisodeStore::Legacy(connection);
    let result = process_episode_distiller_job(&store, &job, target, api_key, timeout_seconds);
    match result {
        Ok(status) => Ok(status),
        Err(error) if is_provider_unavailable(&error.to_string()) => {
            mark_provider_unavailable_retry(connection, &job, &error.to_string())?;
            append_queue_event_for_connection(
                connection,
                &pseudo_uuid(),
                "episodeDistiller",
                &job.id,
                "retried",
                Some("episode distiller provider unavailable; job returned to queue"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "reason": "provider_unavailable_retry",
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            )?;
            Ok(EpisodeExecutionStatus::Retrying)
        }
        Err(error) => {
            mark_failed(connection, &job, &error.to_string())?;
            append_queue_event_for_connection(
                connection,
                &pseudo_uuid(),
                "episodeDistiller",
                &job.id,
                "failed",
                Some("episode distiller failed"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            )?;
            Ok(EpisodeExecutionStatus::Failed)
        }
    }
}

pub(crate) fn run_episode_distiller_job_for_path(
    sqlite_path: &Path,
    claimed: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    api_key: Option<Zeroizing<String>>,
    timeout_seconds: u64,
) -> Result<EpisodeSplitStatus, CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let job = load_job(&reader, &claimed.id)?;
    let store = EpisodeStore::Split {
        sqlite_path,
        reader: Box::new(reader),
        provider_lease: claimed.provider_lease,
    };
    match process_episode_distiller_job(
        &store,
        &job,
        &target,
        api_key.as_ref().map(|key| key.as_str()),
        timeout_seconds,
    ) {
        Ok(EpisodeExecutionStatus::Completed) => Ok(EpisodeSplitStatus::Completed),
        Ok(EpisodeExecutionStatus::Skipped) => Ok(EpisodeSplitStatus::Skipped),
        Ok(EpisodeExecutionStatus::Failed) => Ok(EpisodeSplitStatus::Failed),
        Ok(EpisodeExecutionStatus::Retrying) => Ok(EpisodeSplitStatus::Retrying),
        Err(error) if error.to_string().contains(EPISODE_EXECUTION_SUPERSEDED) => {
            store.record_superseded(&job)?;
            Ok(EpisodeSplitStatus::Superseded)
        }
        Err(error) => store.persist_error(&job, &target, &error.to_string()),
    }
}
