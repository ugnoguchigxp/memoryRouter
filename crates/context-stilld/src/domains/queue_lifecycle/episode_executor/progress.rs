use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::shared::errors::CliError;

use super::helpers::{
    metadata_i64_at, metadata_string_array_at, now_timestamp, provider_retry_after_seconds,
    truncate,
};
use super::lease::episode_provider_backoff_seconds;
use super::types::{EpisodeDistillerJobRow, ProcessCounters, EPISODE_DISTILLATION_VERSION};

pub(super) fn counters_from_metadata(metadata: &Value) -> ProcessCounters {
    let episode_ids = metadata_string_array_at(metadata, "/episodeDistiller/savedEpisodeIds")
        .or_else(|| metadata_string_array_at(metadata, "/episodeDistiller/episodeIds"))
        .unwrap_or_default();
    ProcessCounters {
        generated: metadata_i64_at(metadata, "/episodeDistiller/generated"),
        deduped: metadata_i64_at(metadata, "/episodeDistiller/deduped"),
        skipped: metadata_i64_at(metadata, "/episodeDistiller/skipped"),
        value_skipped: metadata_i64_at(metadata, "/episodeDistiller/valueSkipped"),
        duplicate_generation_kind_skipped: metadata_i64_at(
            metadata,
            "/episodeDistiller/duplicateGenerationKindSkipped",
        ),
        near_duplicate_skipped: metadata_i64_at(metadata, "/episodeDistiller/nearDuplicateSkipped"),
        failed_segments: 0,
        accepted_candidate_count: metadata_i64_at(
            metadata,
            "/episodeDistiller/acceptedCandidateCount",
        ),
        episode_ids,
        saved_source_keys: metadata_string_array_at(metadata, "/episodeDistiller/savedSourceKeys")
            .unwrap_or_default(),
    }
}

pub(super) fn patch_episode_progress(
    connection: &Connection,
    job: &EpisodeDistillerJobRow,
    metadata: &Value,
) -> Result<(), CliError> {
    connection
        .execute(
            "
            update episode_distiller_queue
            set metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?1),
                updated_at = CURRENT_TIMESTAMP
            where id = ?2
            ",
            params![metadata.to_string(), job.id],
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to update episode distiller progress metadata: {error}"
            ))
        })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn episode_progress_metadata(
    counters: &ProcessCounters,
    segment_count: usize,
    current_segment: Option<usize>,
    last_segment_started_at: Option<&str>,
    last_segment_completed_at: Option<&str>,
    last_episode_created_at: Option<&str>,
    segment_results: &[Value],
    segment_errors: &[Value],
    skipped_duplicate_generation_kinds: &[Value],
    skipped_value_reviews: &[Value],
    near_duplicate_reviews: &[Value],
    completed_at: Option<&str>,
) -> Value {
    let internal_chunked = internal_chunked_distillation_enabled();
    let mut metadata = json!({
        "episodeDistiller": {
            "executor": "rust",
            "pipelineVersion": if internal_chunked { "internal-chunked-v1" } else { "deterministic-segment-v1" },
            "chunkStage": if internal_chunked { "deterministic_window_fallback" } else { "deterministic_segment" },
            "sourceWindowCount": if internal_chunked { segment_count } else { 0 },
            "semanticChunkCount": if internal_chunked { segment_count } else { 0 },
            "generated": counters.generated,
            "deduped": counters.deduped,
            "skipped": counters.skipped,
            "valueSkipped": counters.value_skipped,
            "duplicateGenerationKindSkipped": counters.duplicate_generation_kind_skipped,
            "nearDuplicateSkipped": counters.near_duplicate_skipped,
            "failedSegments": counters.failed_segments,
            "segmentCount": segment_count,
            "currentSegment": current_segment,
            "episodeIds": counters.episode_ids,
            "savedEpisodeIds": counters.episode_ids,
            "savedSourceKeys": counters.saved_source_keys,
            "acceptedCandidateCount": counters.accepted_candidate_count,
            "lastSegmentStartedAt": last_segment_started_at,
            "lastSegmentCompletedAt": last_segment_completed_at,
            "lastEpisodeCreatedAt": last_episode_created_at,
            "segmentResults": segment_results,
            "segmentErrors": segment_errors,
            "skippedDuplicateGenerationKinds": skipped_duplicate_generation_kinds,
            "skippedValueReviews": skipped_value_reviews,
            "nearDuplicateReviews": near_duplicate_reviews
        }
    });
    if let Some(completed_at) = completed_at {
        metadata["episodeDistiller"]["completedAt"] = json!(completed_at);
    }
    metadata
}

pub(super) fn internal_chunked_distillation_enabled() -> bool {
    std::env::var("CONTEXT_STILL_INTERNAL_CHUNKED_DISTILLATION")
        .or_else(|_| std::env::var("INTERNAL_CHUNKED_DISTILLATION"))
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

pub(super) fn completed_segment_indexes(segment_results: &[Value]) -> HashSet<usize> {
    segment_results
        .iter()
        .filter_map(|item| {
            let segment = item.get("segment")?.as_u64()? as usize;
            let status = item.get("status")?.as_str()?;
            if is_completed_segment_status(status) {
                Some(segment)
            } else {
                None
            }
        })
        .collect()
}

pub(super) fn is_completed_segment_status(status: &str) -> bool {
    matches!(
        status,
        "saved"
            | "deduped"
            | "skipped"
            | "empty"
            | "low_value_skipped"
            | "duplicate_generation_kind_skipped"
            | "near_duplicate_skipped"
            | "no_episode"
    )
}

pub(super) fn record_segment_result(segment_results: &mut Vec<Value>, result: Value) {
    let segment = result.get("segment").and_then(Value::as_u64);
    if let Some(segment) = segment {
        segment_results.retain(|item| item.get("segment").and_then(Value::as_u64) != Some(segment));
    }
    segment_results.push(result);
    segment_results.sort_by_key(|item| {
        item.get("segment")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
}

pub(super) fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

pub(super) fn mark_completed(
    connection: &Connection,
    job: &EpisodeDistillerJobRow,
    status: &str,
    outcome: &str,
    metadata: &Value,
) -> Result<(), CliError> {
    connection
        .execute(
            "
            update episode_distiller_queue
            set status = ?1,
                locked_by = null,
                locked_at = null,
                heartbeat_at = null,
                completed_at = CURRENT_TIMESTAMP,
                last_error = null,
                last_outcome_kind = ?2,
                metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?3),
                updated_at = CURRENT_TIMESTAMP
            where id = ?4
            ",
            params![status, outcome, metadata.to_string(), job.id],
        )
        .map_err(|error| {
            CliError::io(format!("failed to complete episode distiller job: {error}"))
        })?;
    Ok(())
}

pub(super) fn mark_failed(
    connection: &Connection,
    job: &EpisodeDistillerJobRow,
    error: &str,
) -> Result<(), CliError> {
    let attempt_count = job.attempt_count + 1;
    let terminal = attempt_count >= job.max_attempts;
    connection
        .execute(
            "
            update episode_distiller_queue
            set status = case when ?1 then 'failed' else 'pending' end,
                attempt_count = ?2,
                next_run_at = case when ?1 then null else datetime('now', '+30 seconds') end,
                locked_by = null,
                locked_at = null,
                heartbeat_at = null,
                completed_at = case when ?1 then CURRENT_TIMESTAMP else null end,
                last_error = ?3,
                last_outcome_kind = 'failed',
                metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?4),
                updated_at = CURRENT_TIMESTAMP
            where id = ?5
            ",
            params![
                terminal,
                attempt_count,
                truncate(error, 1000),
                json!({"episodeDistiller": {"failedAt": now_timestamp(), "error": truncate(error, 1000), "executor": "rust"}}).to_string(),
                job.id
            ],
        )
        .map_err(|error| CliError::io(format!("failed to mark episode distiller failure: {error}")))?;
    Ok(())
}

pub(super) fn mark_provider_unavailable_retry(
    connection: &Connection,
    job: &EpisodeDistillerJobRow,
    error: &str,
) -> Result<(), CliError> {
    let attempt_count = job.attempt_count + 1;
    let exhausted = attempt_count >= job.max_attempts.max(1);
    let retry_after_seconds = provider_retry_after_seconds(error)
        .max(episode_provider_backoff_seconds(job.attempt_count));
    connection
        .execute(
            "
            update episode_distiller_queue
            set status = case when ?1 then 'paused' else 'pending' end,
                attempt_count = ?2,
                next_run_at = case when ?1 then null else datetime('now', '+' || ?3 || ' seconds') end,
                locked_by = null,
                locked_at = null,
                heartbeat_at = null,
                completed_at = null,
                last_error = ?4,
                last_outcome_kind = case when ?1 then 'provider_unavailable_exhausted' else 'provider_unavailable_retry' end,
                metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?5),
                updated_at = CURRENT_TIMESTAMP
            where id = ?6
            ",
            params![
                exhausted,
                attempt_count,
                retry_after_seconds,
                truncate(error, 1000),
                json!({"episodeDistiller": {"providerUnavailableRetriedAt": now_timestamp(), "providerUnavailableError": truncate(error, 1000), "providerRetryAfterSeconds": retry_after_seconds, "executor": "rust"}}).to_string(),
                job.id
            ],
        )
        .map_err(|error| CliError::io(format!("failed to return provider-unavailable episode distiller job to queue: {error}")))?;
    Ok(())
}

pub(super) fn episode_source_fragment_key(
    parent_source_key: &str,
    start_offset: usize,
    end_offset: usize,
    generation_kind: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "vibe_memory:{parent_source_key}:{start_offset}-{end_offset}:{generation_kind}:{EPISODE_DISTILLATION_VERSION}"
    ));
    let digest = format!("{:x}", hasher.finalize());
    format!(
        "vibe_memory:{parent_source_key}:episode:{}:{EPISODE_DISTILLATION_VERSION}",
        &digest[..12]
    )
}
