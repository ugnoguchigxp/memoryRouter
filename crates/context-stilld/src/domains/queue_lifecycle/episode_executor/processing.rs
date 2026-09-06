use std::collections::HashSet;

use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::distillation::distill_segment_with_retry;
use super::helpers::{
    estimate_token_count, is_nonworking_local_llm_error, is_provider_terminal_failure,
    json_array_at, now_timestamp, truncate,
};
use super::identity::{metadata_string_at, resolve_episode_write_identity};
use super::progress::{
    completed_segment_indexes, counters_from_metadata, episode_progress_metadata,
    episode_source_fragment_key, push_unique_string, record_segment_result,
};
use super::quality::{
    calibrate_episode, normalize_generation_kind, review_episode_value, value_review_json,
};
use super::source::{build_deterministic_segments, read_source_document};
use super::types::{
    EpisodeDistillerJobRow, EpisodeExecutionStatus, EpisodePersistOutcome, EpisodeStore,
    LocalLlmTargetConfig, PendingEpisode,
};

pub(super) fn process_episode_distiller_job(
    store: &EpisodeStore<'_>,
    job: &EpisodeDistillerJobRow,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<EpisodeExecutionStatus, CliError> {
    if job.source_kind != "vibe_memory" {
        return Err(CliError::io(format!(
            "unsupported episode source kind: {}",
            job.source_kind
        )));
    }
    let document = read_source_document(store.reader(), &job.source_key)?;
    let write_identity = match resolve_episode_write_identity(&document.metadata) {
        Ok(identity) => identity,
        Err(error) => {
            let error_text = error.to_string();
            store.record_identity_event(
                "PROJECT_IDENTITY_PRODUCER_REJECTED",
                json!({
                    "producer": "episode-distiller.rust",
                    "entityKind": "episode",
                    "rejectionCode": error_text.split(':').next().unwrap_or(&error_text)
                }),
            )?;
            return Err(error);
        }
    };
    let segments = build_deterministic_segments(&document);
    let mut counters = counters_from_metadata(&job.metadata);
    let mut segment_errors = Vec::new();
    let mut skipped_duplicate_generation_kinds = json_array_at(
        &job.metadata,
        "/episodeDistiller/skippedDuplicateGenerationKinds",
    );
    let mut skipped_value_reviews =
        json_array_at(&job.metadata, "/episodeDistiller/skippedValueReviews");
    let mut near_duplicate_reviews =
        json_array_at(&job.metadata, "/episodeDistiller/nearDuplicateReviews");
    let mut segment_results = json_array_at(&job.metadata, "/episodeDistiller/segmentResults");
    let completed_segments = completed_segment_indexes(&segment_results);
    let mut terminal_skip_error: Option<String> = None;
    let mut terminal_failed_error: Option<String> = None;
    let mut current_segment: Option<usize> = None;
    let mut last_segment_started_at =
        metadata_string_at(&job.metadata, "/episodeDistiller/lastSegmentStartedAt");
    let mut last_segment_completed_at =
        metadata_string_at(&job.metadata, "/episodeDistiller/lastSegmentCompletedAt");
    let mut last_episode_created_at =
        metadata_string_at(&job.metadata, "/episodeDistiller/lastEpisodeCreatedAt");

    store.patch_progress(
        job,
        &episode_progress_metadata(
            &counters,
            segments.len(),
            current_segment,
            last_segment_started_at.as_deref(),
            last_segment_completed_at.as_deref(),
            last_episode_created_at.as_deref(),
            &segment_results,
            &segment_errors,
            &skipped_duplicate_generation_kinds,
            &skipped_value_reviews,
            &near_duplicate_reviews,
            None,
        ),
    )?;

    for (segment_index, segment) in segments.iter().enumerate() {
        if completed_segments.contains(&segment_index) {
            continue;
        }
        current_segment = Some(segment_index);
        last_segment_started_at = Some(now_timestamp());
        store.patch_progress(
            job,
            &episode_progress_metadata(
                &counters,
                segments.len(),
                current_segment,
                last_segment_started_at.as_deref(),
                last_segment_completed_at.as_deref(),
                last_episode_created_at.as_deref(),
                &segment_results,
                &segment_errors,
                &skipped_duplicate_generation_kinds,
                &skipped_value_reviews,
                &near_duplicate_reviews,
                None,
            ),
        )?;

        if estimate_token_count(&segment.text) <= 10 {
            counters.skipped += 1;
            last_segment_completed_at = Some(now_timestamp());
            record_segment_result(
                &mut segment_results,
                json!({
                    "segment": segment_index,
                    "status": "skipped",
                    "reason": "low_token_count",
                    "completedAt": last_segment_completed_at
                }),
            );
            store.patch_progress(
                job,
                &episode_progress_metadata(
                    &counters,
                    segments.len(),
                    current_segment,
                    last_segment_started_at.as_deref(),
                    last_segment_completed_at.as_deref(),
                    last_episode_created_at.as_deref(),
                    &segment_results,
                    &segment_errors,
                    &skipped_duplicate_generation_kinds,
                    &skipped_value_reviews,
                    &near_duplicate_reviews,
                    None,
                ),
            )?;
            continue;
        }
        let canonical_episodes = match distill_segment_with_retry(
            segment,
            &document,
            target,
            api_key,
            timeout_seconds,
        ) {
            Ok(items) => items,
            Err(error) => {
                let error_text = error.to_string();
                counters.failed_segments += 1;
                last_segment_completed_at = Some(now_timestamp());
                segment_errors.push(json!({
                    "segment": segment_index,
                    "error": truncate(&error_text, 500)
                }));
                record_segment_result(
                    &mut segment_results,
                    json!({
                        "segment": segment_index,
                        "status": "failed",
                        "error": truncate(&error_text, 500),
                        "completedAt": last_segment_completed_at
                    }),
                );
                store.patch_progress(
                    job,
                    &episode_progress_metadata(
                        &counters,
                        segments.len(),
                        current_segment,
                        last_segment_started_at.as_deref(),
                        last_segment_completed_at.as_deref(),
                        last_episode_created_at.as_deref(),
                        &segment_results,
                        &segment_errors,
                        &skipped_duplicate_generation_kinds,
                        &skipped_value_reviews,
                        &near_duplicate_reviews,
                        None,
                    ),
                )?;
                if is_provider_terminal_failure(&error_text) {
                    terminal_failed_error = Some(error_text);
                    break;
                }
                if is_nonworking_local_llm_error(&error_text) {
                    terminal_skip_error = Some(error_text);
                    break;
                }
                continue;
            }
        };
        if canonical_episodes.is_empty() {
            counters.skipped += 1;
            last_segment_completed_at = Some(now_timestamp());
            record_segment_result(
                &mut segment_results,
                json!({
                    "segment": segment_index,
                    "status": "empty",
                    "completedAt": last_segment_completed_at
                }),
            );
            store.patch_progress(
                job,
                &episode_progress_metadata(
                    &counters,
                    segments.len(),
                    current_segment,
                    last_segment_started_at.as_deref(),
                    last_segment_completed_at.as_deref(),
                    last_episode_created_at.as_deref(),
                    &segment_results,
                    &segment_errors,
                    &skipped_duplicate_generation_kinds,
                    &skipped_value_reviews,
                    &near_duplicate_reviews,
                    None,
                ),
            )?;
            continue;
        }
        let mut seen_generation_kinds = HashSet::new();
        let mut segment_pending = Vec::new();
        let mut segment_value_skipped = 0;
        let mut segment_duplicate_skipped = 0;
        for raw in canonical_episodes {
            let canonical = calibrate_episode(raw);
            let generation_kind = normalize_generation_kind(&canonical.generation_kind);
            if !seen_generation_kinds.insert(generation_kind.clone()) {
                counters.skipped += 1;
                counters.duplicate_generation_kind_skipped += 1;
                segment_duplicate_skipped += 1;
                skipped_duplicate_generation_kinds.push(json!({
                    "segment": segment_index,
                    "generationKind": generation_kind
                }));
                continue;
            }
            let value_review = review_episode_value(&canonical);
            if !value_review.publish {
                counters.skipped += 1;
                counters.value_skipped += 1;
                segment_value_skipped += 1;
                skipped_value_reviews.push(json!({
                    "segment": segment_index,
                    "generationKind": generation_kind,
                    "title": canonical.title,
                    "valueReview": value_review_json(&value_review)
                }));
                continue;
            }
            let source_key = episode_source_fragment_key(
                &job.source_key,
                segment.start_offset,
                segment.end_offset,
                &generation_kind,
            );
            segment_pending.push(PendingEpisode {
                canonical,
                source_key,
                source_start_offset: segment.start_offset,
                source_end_offset: segment.end_offset,
                event_start: segment.event_start.clone(),
                event_end: segment.event_end.clone(),
            });
        }

        if segment_pending.is_empty() {
            last_segment_completed_at = Some(now_timestamp());
            let status = if segment_value_skipped > 0 {
                "low_value_skipped"
            } else if segment_duplicate_skipped > 0 {
                "duplicate_generation_kind_skipped"
            } else {
                "no_episode"
            };
            record_segment_result(
                &mut segment_results,
                json!({
                    "segment": segment_index,
                    "status": status,
                    "valueSkipped": segment_value_skipped,
                    "duplicateGenerationKindSkipped": segment_duplicate_skipped,
                    "completedAt": last_segment_completed_at
                }),
            );
            store.patch_progress(
                job,
                &episode_progress_metadata(
                    &counters,
                    segments.len(),
                    current_segment,
                    last_segment_started_at.as_deref(),
                    last_segment_completed_at.as_deref(),
                    last_episode_created_at.as_deref(),
                    &segment_results,
                    &segment_errors,
                    &skipped_duplicate_generation_kinds,
                    &skipped_value_reviews,
                    &near_duplicate_reviews,
                    None,
                ),
            )?;
            continue;
        }

        counters.accepted_candidate_count += segment_pending.len() as i64;
        let mut segment_episode_ids = Vec::new();
        let mut segment_source_keys = Vec::new();
        let mut segment_generated = 0;
        let mut segment_deduped = 0;
        let mut segment_near_duplicate_skipped = 0;
        for item in segment_pending.iter() {
            let persist_outcome = store.create_episode(
                item,
                &document,
                &write_identity,
                target,
                api_key,
                timeout_seconds,
            )?;
            match persist_outcome {
                EpisodePersistOutcome::Created(episode_id) => {
                    push_unique_string(&mut counters.episode_ids, episode_id.clone());
                    push_unique_string(&mut counters.saved_source_keys, item.source_key.clone());
                    segment_episode_ids.push(episode_id);
                    segment_source_keys.push(item.source_key.clone());
                    counters.generated += 1;
                    segment_generated += 1;
                    last_episode_created_at = Some(now_timestamp());
                }
                EpisodePersistOutcome::SourceDeduped(episode_id) => {
                    push_unique_string(&mut counters.episode_ids, episode_id.clone());
                    push_unique_string(&mut counters.saved_source_keys, item.source_key.clone());
                    segment_episode_ids.push(episode_id);
                    segment_source_keys.push(item.source_key.clone());
                    counters.deduped += 1;
                    segment_deduped += 1;
                    last_episode_created_at = Some(now_timestamp());
                }
                EpisodePersistOutcome::NearDuplicateSkipped(review) => {
                    counters.skipped += 1;
                    counters.near_duplicate_skipped += 1;
                    segment_near_duplicate_skipped += 1;
                    near_duplicate_reviews.push(json!({
                        "segment": segment_index,
                        "title": item.canonical.title,
                        "sourceKey": item.source_key,
                        "publish": false,
                        "duplicateOfEpisodeId": review.duplicate_of_episode_id,
                        "confidence": review.confidence,
                        "reason": review.reason
                    }));
                }
            }
            store.patch_progress(
                job,
                &episode_progress_metadata(
                    &counters,
                    segments.len(),
                    current_segment,
                    last_segment_started_at.as_deref(),
                    last_segment_completed_at.as_deref(),
                    last_episode_created_at.as_deref(),
                    &segment_results,
                    &segment_errors,
                    &skipped_duplicate_generation_kinds,
                    &skipped_value_reviews,
                    &near_duplicate_reviews,
                    None,
                ),
            )?;
        }
        last_segment_completed_at = Some(now_timestamp());
        record_segment_result(
            &mut segment_results,
            json!({
                "segment": segment_index,
                "status": if segment_generated > 0 {
                    "saved"
                } else if segment_deduped > 0 {
                    "deduped"
                } else {
                    "near_duplicate_skipped"
                },
                "episodeIds": segment_episode_ids,
                "sourceKeys": segment_source_keys,
                "acceptedCandidateCount": segment_pending.len(),
                "generated": segment_generated,
                "deduped": segment_deduped,
                "nearDuplicateSkipped": segment_near_duplicate_skipped,
                "completedAt": last_segment_completed_at
            }),
        );
        store.patch_progress(
            job,
            &episode_progress_metadata(
                &counters,
                segments.len(),
                current_segment,
                last_segment_started_at.as_deref(),
                last_segment_completed_at.as_deref(),
                last_episode_created_at.as_deref(),
                &segment_results,
                &segment_errors,
                &skipped_duplicate_generation_kinds,
                &skipped_value_reviews,
                &near_duplicate_reviews,
                None,
            ),
        )?;
    }

    if counters.generated == 0
        && counters.deduped == 0
        && counters.failed_segments > 0
        && counters.failed_segments as usize == segments.len()
        && terminal_skip_error.is_none()
        && terminal_failed_error.is_none()
    {
        let sample_errors = segment_errors
            .iter()
            .take(3)
            .map(|item| {
                let segment = item
                    .get("segment")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".to_string());
                let error = item
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error");
                format!("segment {segment}: {error}")
            })
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(CliError::io(format!(
            "episode distiller failed all segments ({}/{}){}",
            counters.failed_segments,
            segments.len(),
            if sample_errors.is_empty() {
                String::new()
            } else {
                format!(": {sample_errors}")
            }
        )));
    }

    if let Some(error) = terminal_failed_error {
        return Err(CliError::io(format!(
            "episode distiller provider failed: {}",
            truncate(&error, 1000)
        )));
    }

    if let Some(error) = terminal_skip_error {
        return Err(CliError::io(format!(
            "episode distiller provider unavailable: {}",
            truncate(&error, 1000)
        )));
    }

    let outcome = if counters.generated > 0 || counters.deduped > 0 {
        "episodes_distilled"
    } else if counters.value_skipped > 0 {
        "low_value_skipped"
    } else {
        "no_episode"
    };
    let status = if outcome == "episodes_distilled" {
        "completed"
    } else {
        "skipped"
    };
    let completed_at = now_timestamp();
    let metadata = episode_progress_metadata(
        &counters,
        segments.len(),
        current_segment,
        last_segment_started_at.as_deref(),
        last_segment_completed_at.as_deref(),
        last_episode_created_at.as_deref(),
        &segment_results,
        &segment_errors,
        &skipped_duplicate_generation_kinds,
        &skipped_value_reviews,
        &near_duplicate_reviews,
        Some(completed_at.as_str()),
    );
    store.persist_completed(
        job,
        status,
        outcome,
        &metadata,
        &json!({
            "generated": counters.generated,
            "deduped": counters.deduped,
            "skipped": counters.skipped,
            "valueSkipped": counters.value_skipped,
            "duplicateGenerationKindSkipped": counters.duplicate_generation_kind_skipped,
            "nearDuplicateSkipped": counters.near_duplicate_skipped,
            "failedSegments": counters.failed_segments,
            "episodeIds": counters.episode_ids,
            "acceptedCandidateCount": counters.accepted_candidate_count,
            "executor": "rust"
        }),
    )?;

    if status == "completed" {
        Ok(EpisodeExecutionStatus::Completed)
    } else {
        Ok(EpisodeExecutionStatus::Skipped)
    }
}
