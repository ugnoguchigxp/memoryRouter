use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(test)]
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::header::RETRY_AFTER;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domains::mcp_lifecycle::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput,
    CompileProjectIdentityMatchBasis, CompileProjectIdentityTrust, ResolvedCompileProjectIdentity,
    CONTRACT_VERSION,
};
use crate::shared::errors::CliError;

use super::events::append_queue_event_for_connection;

const EPISODE_DISTILLATION_VERSION: &str = "episode-distiller-v1";
const MIN_EPISODE_VALUE_SCORE: i64 = 60;
const MIN_EPISODE_IMPORTANCE: i64 = 55;
const MIN_EPISODE_CONFIDENCE: i64 = 55;
const MIN_EPISODE_REUSABLE_SIGNAL: i64 = 50;
const MIN_EPISODE_EVIDENCE_QUALITY: i64 = 50;
const MIN_EPISODE_COMPRESSION_QUALITY: i64 = 45;

#[derive(Debug, Clone)]
pub(crate) struct LocalLlmTargetConfig {
    pub(crate) target_id: String,
    pub(crate) api_base_url: String,
    pub(crate) api_path: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum EpisodeExecutionStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
}

#[derive(Debug, Clone)]
struct EpisodeDistillerJobRow {
    id: String,
    source_kind: String,
    source_key: String,
    attempt_count: i64,
    max_attempts: i64,
    metadata: Value,
}

#[derive(Debug, Clone)]
struct SourceDocument {
    vibe_memory_id: String,
    session_id: String,
    content: String,
    metadata: Value,
    events: Vec<SourceEvent>,
}

#[derive(Debug, Clone)]
struct SourceEvent {
    id: String,
    created_at: String,
    file_path: Option<String>,
    start_offset: usize,
    end_offset: usize,
}

#[derive(Debug, Clone)]
struct EpisodeWriteIdentity {
    scope: String,
    resolved: ResolvedCompileProjectIdentity,
}

impl EpisodeWriteIdentity {
    fn snapshot(&self) -> Value {
        let mut snapshot = serde_json::to_value(&self.resolved).unwrap_or_else(|_| json!({}));
        if let Some(object) = snapshot.as_object_mut() {
            object.insert("classificationStatus".to_string(), json!("classified"));
            object.insert("scope".to_string(), json!(self.scope));
        }
        snapshot
    }
}

#[derive(Debug, Clone)]
struct Segment {
    text: String,
    start_offset: usize,
    end_offset: usize,
    event_start: Option<String>,
    event_end: Option<String>,
    event_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CanonicalEpisode {
    title: String,
    #[serde(default, alias = "situation")]
    context: String,
    #[serde(default)]
    intent: String,
    #[serde(default, rename = "keyDecisions")]
    key_decisions: Vec<String>,
    #[serde(default, rename = "actionTaken")]
    action_taken: String,
    outcome: String,
    #[serde(default, rename = "failedApproach")]
    failed_approach: String,
    #[serde(default, rename = "reusableLesson", alias = "lesson")]
    reusable_lesson: String,
    #[serde(default, rename = "usefulFutureTriggers")]
    useful_future_triggers: Vec<String>,
    #[serde(default, rename = "openLoops")]
    open_loops: Vec<String>,
    #[serde(default = "default_generation_kind", rename = "generationKind")]
    generation_kind: String,
    #[serde(default = "default_outcome_kind", rename = "outcomeKind")]
    outcome_kind: String,
    #[serde(default)]
    domains: Vec<String>,
    #[serde(default)]
    technologies: Vec<String>,
    #[serde(default, rename = "changeTypes")]
    change_types: Vec<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    scores: EpisodeScores,
}

#[derive(Debug, Clone, Deserialize)]
struct EpisodeScores {
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    importance: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    confidence: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    reusability: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    decision_density: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    failure_value: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    causal_clarity: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    project_specificity: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    evidence_quality: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    compression_quality: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    staleness_risk: i64,
}

impl Default for EpisodeScores {
    fn default() -> Self {
        Self {
            importance: 50,
            confidence: 50,
            reusability: 50,
            decision_density: 50,
            failure_value: 50,
            causal_clarity: 50,
            project_specificity: 50,
            evidence_quality: 50,
            compression_quality: 50,
            staleness_risk: 50,
        }
    }
}

#[derive(Debug, Clone)]
struct ValueReview {
    publish: bool,
    score: i64,
    reasons: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingEpisode {
    canonical: CanonicalEpisode,
    source_key: String,
    source_start_offset: usize,
    source_end_offset: usize,
    event_start: Option<String>,
    event_end: Option<String>,
}

#[derive(Debug, Default)]
struct ProcessCounters {
    generated: i64,
    deduped: i64,
    skipped: i64,
    value_skipped: i64,
    duplicate_generation_kind_skipped: i64,
    near_duplicate_skipped: i64,
    failed_segments: i64,
    accepted_candidate_count: i64,
    episode_ids: Vec<String>,
    saved_source_keys: Vec<String>,
}

#[derive(Debug, Clone)]
struct NearDuplicateCandidate {
    id: String,
    title: String,
    situation: String,
    observations: String,
    action: String,
    outcome: String,
    lesson: String,
}

#[derive(Debug, Clone, Deserialize)]
struct NearDuplicateReview {
    publish: bool,
    #[serde(default, rename = "duplicateOfEpisodeId")]
    duplicate_of_episode_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_score")]
    confidence: i64,
    #[serde(default)]
    reason: String,
}

#[derive(Debug)]
enum EpisodePersistOutcome {
    Created(String),
    SourceDeduped(String),
    NearDuplicateSkipped(NearDuplicateReview),
}

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
    let result = process_episode_distiller_job(connection, &job, target, api_key, timeout_seconds);
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

struct HeartbeatGuard {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl HeartbeatGuard {
    fn start(connection: &Connection, job_id: &str, worker_id: &str) -> Result<Self, CliError> {
        #[cfg(not(test))]
        let _ = (job_id, worker_id);
        let Some(db_path) = main_database_path(connection)? else {
            return Ok(Self {
                stop: Arc::new(AtomicBool::new(true)),
                handle: None,
            });
        };
        // The resident executor itself runs on the single SQLite writer thread. Starting a
        // second heartbeat connection here would violate that ownership, while enqueueing a
        // heartbeat back to the same blocked writer would deadlock on guard drop. The executor
        // result transaction refreshes/releases the lease when the provider call returns.
        if crate::domains::sqlite_writer::global_writer_for_path(std::path::Path::new(&db_path))
            .is_ok()
        {
            return Ok(Self {
                stop: Arc::new(AtomicBool::new(true)),
                handle: None,
            });
        }
        #[cfg(not(test))]
        return Ok(Self {
            stop: Arc::new(AtomicBool::new(true)),
            handle: None,
        });
        #[cfg(test)]
        {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let job_id = job_id.to_string();
            let worker_id = worker_id.to_string();
            let handle = thread::spawn(move || {
                while !thread_stop.load(Ordering::SeqCst) {
                    for _ in 0..20 {
                        if thread_stop.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_secs(1));
                    }
                    if thread_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    // sqlite-writer-guard: test-only-direct-open
                    if let Ok(connection) = Connection::open(&db_path) {
                        let _ = connection.execute(
                            "
                        update episode_distiller_queue
                        set heartbeat_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        where id = ?1
                          and status = 'running'
                        ",
                            [&job_id],
                        );
                        let _ = connection.execute(
                            "
                        update llm_provider_leases
                        set heartbeat_at = CURRENT_TIMESTAMP,
                            expires_at = datetime(CURRENT_TIMESTAMP, '+120 seconds'),
                            updated_at = CURRENT_TIMESTAMP
                        where queue_name = 'episodeDistiller'
                          and queue_job_id = ?1
                          and worker_id = ?2
                          and status = 'active'
                        ",
                            (&job_id, &worker_id),
                        );
                    }
                }
            });
            Ok(Self {
                stop,
                handle: Some(handle),
            })
        }
    }
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn main_database_path(connection: &Connection) -> Result<Option<String>, CliError> {
    let mut statement = connection
        .prepare("pragma database_list")
        .map_err(|error| {
            CliError::io(format!("failed to inspect SQLite database path: {error}"))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        })
        .map_err(|error| CliError::io(format!("failed to query SQLite database path: {error}")))?;
    for row in rows {
        let (name, path) =
            row.map_err(|error| CliError::io(format!("failed to read SQLite path: {error}")))?;
        if name == "main" {
            return Ok(path.filter(|value| !value.trim().is_empty()));
        }
    }
    Ok(None)
}

fn process_episode_distiller_job(
    connection: &Connection,
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
    let document = read_source_document(connection, &job.source_key)?;
    let write_identity = match resolve_episode_write_identity(&document.metadata) {
        Ok(identity) => identity,
        Err(error) => {
            let error_text = error.to_string();
            record_episode_identity_event(
                connection,
                "PROJECT_IDENTITY_PRODUCER_REJECTED",
                json!({
                    "producer": "episode-distiller.rust",
                    "entityKind": "episode",
                    "rejectionCode": error_text.split(':').next().unwrap_or(&error_text)
                }),
            );
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

    patch_episode_progress(
        connection,
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
        patch_episode_progress(
            connection,
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
            patch_episode_progress(
                connection,
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
                patch_episode_progress(
                    connection,
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
            patch_episode_progress(
                connection,
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
            patch_episode_progress(
                connection,
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
            let persist_outcome = create_episode_idempotently(
                connection,
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
            patch_episode_progress(
                connection,
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
        patch_episode_progress(
            connection,
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
    mark_completed(connection, job, status, outcome, &metadata)?;
    append_queue_event_for_connection(
        connection,
        &pseudo_uuid(),
        "episodeDistiller",
        &job.id,
        "completed",
        Some("episode distiller completed"),
        Some(
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
            })
            .to_string(),
        ),
    )?;

    if status == "completed" {
        Ok(EpisodeExecutionStatus::Completed)
    } else {
        Ok(EpisodeExecutionStatus::Skipped)
    }
}

fn load_job(connection: &Connection, job_id: &str) -> Result<EpisodeDistillerJobRow, CliError> {
    connection
        .query_row(
            "
            select id, source_kind, source_key, attempt_count, max_attempts, coalesce(metadata, '{}')
            from episode_distiller_queue
            where id = ?1
            limit 1
            ",
            [job_id],
            |row| {
                Ok(EpisodeDistillerJobRow {
                    id: row.get(0)?,
                    source_kind: row.get(1)?,
                    source_key: row.get(2)?,
                    attempt_count: row.get(3)?,
                    max_attempts: row.get(4)?,
                    metadata: parse_json_or_empty(&row.get::<_, String>(5)?),
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load episode distiller job: {error}")))?
        .ok_or_else(|| CliError::io(format!("episode distiller queue job not found: {job_id}")))
}

fn read_source_document(
    connection: &Connection,
    vibe_memory_id: &str,
) -> Result<SourceDocument, CliError> {
    let memory = connection
        .query_row(
            "
            select id, session_id, content, coalesce(metadata, '{}'), created_at
            from vibe_memories
            where id = ?1
            limit 1
            ",
            [vibe_memory_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load vibe memory: {error}")))?
        .ok_or_else(|| CliError::io(format!("vibe memory not found: {vibe_memory_id}")))?;

    let mut parts = Vec::new();
    let mut events = Vec::new();
    append_source_block(
        &mut parts,
        &mut events,
        format!("memory:{}", memory.0),
        memory.4.clone(),
        None,
        format!(
            "[event:memory:{}]\ncreated_at: {}\nsession_id: {}\n\n{}\n",
            memory.0,
            to_isoish(&memory.4),
            memory.1,
            memory.2.trim()
        ),
    );

    if table_exists(connection, "agent_diff_entries")? {
        let mut statement = connection
            .prepare(
                "
                select id, file_path, diff_hunk, change_type, language, symbol_name,
                       symbol_kind, signature, start_line, end_line, created_at
                from agent_diff_entries
                where vibe_memory_id = ?1
                order by created_at asc, file_path asc, id asc
                ",
            )
            .map_err(|error| CliError::io(format!("failed to prepare source diffs: {error}")))?;
        let rows = statement
            .query_map([vibe_memory_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(|error| CliError::io(format!("failed to query source diffs: {error}")))?;
        for row in rows {
            let (
                id,
                file_path,
                diff_hunk,
                change_type,
                language,
                symbol_name,
                symbol_kind,
                signature,
                start_line,
                end_line,
                created_at,
            ) =
                row.map_err(|error| CliError::io(format!("failed to read source diff: {error}")))?;
            let mut lines = vec![
                format!("[event:agent_diff:{id}]"),
                format!("created_at: {}", to_isoish(&created_at)),
                format!("file_path: {file_path}"),
            ];
            push_optional_line(&mut lines, "change_type", change_type.as_deref());
            push_optional_line(&mut lines, "language", language.as_deref());
            push_optional_line(&mut lines, "symbol_name", symbol_name.as_deref());
            push_optional_line(&mut lines, "symbol_kind", symbol_kind.as_deref());
            push_optional_line(&mut lines, "signature", signature.as_deref());
            if start_line.is_some() || end_line.is_some() {
                lines.push(format!(
                    "line_range: {}-{}",
                    start_line
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "?".to_string()),
                    end_line
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "?".to_string())
                ));
            }
            lines.push(String::new());
            lines.push(diff_hunk.trim().to_string());
            lines.push(String::new());
            append_source_block(
                &mut parts,
                &mut events,
                format!("agent_diff:{id}"),
                created_at,
                Some(file_path),
                lines.join("\n"),
            );
        }
    }

    Ok(SourceDocument {
        vibe_memory_id: memory.0,
        session_id: memory.1,
        content: parts.join(""),
        metadata: parse_json_or_empty(&memory.3),
        events,
    })
}

fn append_source_block(
    parts: &mut Vec<String>,
    events: &mut Vec<SourceEvent>,
    id: String,
    created_at: String,
    file_path: Option<String>,
    body: String,
) {
    let start_offset = parts.iter().map(|part| part.len()).sum();
    parts.push(body);
    let end_offset = parts.iter().map(|part| part.len()).sum();
    events.push(SourceEvent {
        id,
        created_at,
        file_path,
        start_offset,
        end_offset,
    });
}

fn build_deterministic_segments(document: &SourceDocument) -> Vec<Segment> {
    let max_bytes = 4000 * 4;
    if document.events.is_empty() {
        return vec![Segment {
            text: document.content.clone(),
            start_offset: 0,
            end_offset: document.content.len(),
            event_start: None,
            event_end: None,
            event_ids: Vec::new(),
        }];
    }
    let mut segments = Vec::new();
    let mut current: Vec<SourceEvent> = vec![document.events[0].clone()];
    for event in document.events.iter().skip(1) {
        let first = current.first().expect("current segment has first event");
        let previous = current.last().expect("current segment has last event");
        let file_boundary = !current
            .iter()
            .filter_map(|item| item.file_path.as_deref())
            .collect::<HashSet<_>>()
            .is_empty()
            && event.file_path.as_deref().is_some_and(|path| {
                !current
                    .iter()
                    .any(|item| item.file_path.as_deref() == Some(path))
            });
        let projected_bytes = event.end_offset.saturating_sub(first.start_offset);
        let time_boundary = parse_unixish(&event.created_at)
            .zip(parse_unixish(&previous.created_at))
            .map(|(current_at, previous_at)| current_at.saturating_sub(previous_at) >= 30 * 60)
            .unwrap_or(false);
        if time_boundary || file_boundary || projected_bytes > max_bytes {
            push_segment(document, &mut segments, &current);
            current = vec![event.clone()];
        } else {
            current.push(event.clone());
        }
    }
    push_segment(document, &mut segments, &current);
    segments
        .into_iter()
        .flat_map(|segment| split_large_segment(segment, max_bytes))
        .collect()
}

fn push_segment(document: &SourceDocument, segments: &mut Vec<Segment>, events: &[SourceEvent]) {
    let Some(first) = events.first() else {
        return;
    };
    let Some(last) = events.last() else {
        return;
    };
    segments.push(Segment {
        text: slice_bytes_lossy(&document.content, first.start_offset, last.end_offset),
        start_offset: first.start_offset,
        end_offset: last.end_offset,
        event_start: Some(first.id.clone()),
        event_end: Some(last.id.clone()),
        event_ids: events.iter().map(|item| item.id.clone()).collect(),
    });
}

fn split_large_segment(segment: Segment, max_bytes: usize) -> Vec<Segment> {
    if segment.end_offset.saturating_sub(segment.start_offset) <= max_bytes {
        return vec![segment];
    }
    let mut chunks = Vec::new();
    let mut start = segment.start_offset;
    while start < segment.end_offset {
        let end = nearest_char_boundary(
            &segment.text,
            (start - segment.start_offset + max_bytes).min(segment.text.len()),
        ) + segment.start_offset;
        let end = end.max(start + 1).min(segment.end_offset);
        chunks.push(Segment {
            text: slice_bytes_lossy(
                &segment.text,
                start - segment.start_offset,
                end - segment.start_offset,
            ),
            start_offset: start,
            end_offset: end,
            event_start: segment.event_start.clone(),
            event_end: segment.event_end.clone(),
            event_ids: segment.event_ids.clone(),
        });
        start = end;
    }
    chunks
}

fn distill_segment_with_retry(
    segment: &Segment,
    document: &SourceDocument,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<Vec<CanonicalEpisode>, CliError> {
    let mut last_error = String::new();
    for _ in 0..2 {
        match distill_segment(segment, document, target, api_key, timeout_seconds) {
            Ok(items) => return Ok(items),
            Err(error)
                if is_provider_terminal_failure(&error.to_string())
                    || is_nonworking_local_llm_error(&error.to_string()) =>
            {
                return Err(error);
            }
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(CliError::io(if last_error.is_empty() {
        "episode distiller parse failed".to_string()
    } else {
        last_error
    }))
}

fn distill_segment(
    segment: &Segment,
    document: &SourceDocument,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<Vec<CanonicalEpisode>, CliError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let url = build_local_llm_chat_completions_url(&target.api_base_url, &target.api_path);
    let mut request = client.post(url).json(&json!({
        "model": target.model,
        "messages": build_messages(segment, document),
        "max_tokens": 4000,
        "temperature": 0
    }));
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("local-llm request failed: {error}")))?;
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after_seconds);
    let body = response
        .text()
        .map_err(|error| CliError::io(format!("failed to read local-llm response: {error}")))?;
    if !status.is_success() {
        let retry_after_message = retry_after_seconds
            .map(|seconds| format!(" retry_after_seconds={seconds}"))
            .unwrap_or_default();
        return Err(CliError::io(format!(
            "local-llm HTTP {}{}: {}",
            status.as_u16(),
            retry_after_message,
            truncate(&body, 1000)
        )));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        CliError::io(format!("failed to parse local-llm response JSON: {error}"))
    })?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::io("local-llm response did not include message content"))?;
    parse_canonical_array(content)
}

fn build_messages(segment: &Segment, document: &SourceDocument) -> Value {
    let system_content = [
        "あなたは ContextStill の episodeDistiller です。",
        "source evidence から、将来の作業判断に再利用できる task-oriented EpisodeCard だけを作ります。",
        "出力は JSON array のみ。JSON 以外の説明文や Markdown は返さないでください。",
        "JSON のキー名、enum 値、ファイルパス、コマンド名、API 名、固有名詞は指定どおり保持してください。それ以外の自然文は必ず日本語で書いてください。",
        "原則として 1 segment から 1 件だけ作ります。明確に異なる decision/failure/task が同時にある場合だけ最大 2 件までにしてください。",
        "context には状況・背景だけを書き、intent を混ぜないでください。",
        "actionTaken には実際に行った修正、検証、運用操作、または明示的に避けた approach を日本語で書いてください。",
        "outcome には作業結果・判断結果・残った状態を日本語で書いてください。",
        "scores.importance は将来の作業判断で再利用する価値、scores.confidence は source segment から妥当に読める確度として、0-100 の整数で別々に採点してください。",
    ]
    .join("\n");
    let user_content = [
        format!("Vibe memory id: {}", document.vibe_memory_id),
        format!("Session id: {}", document.session_id),
        format!(
            "Source byte range: {}-{}",
            segment.start_offset, segment.end_offset
        ),
        format!(
            "Source events: {}",
            if segment.event_ids.is_empty() {
                "-".to_string()
            } else {
                segment.event_ids.join(", ")
            }
        ),
        String::new(),
        "次の shape の JSON array を返してください。値の自然文は日本語で書いてください:".to_string(),
        r#"{"title":"...","context":"...","intent":"...","keyDecisions":["..."],"actionTaken":"...","outcome":"...","failedApproach":"","reusableLesson":"...","usefulFutureTriggers":["..."],"openLoops":["..."],"generationKind":"task_episode|failure_episode|decision_episode","outcomeKind":"success|failure|mixed|unknown","domains":["..."],"technologies":["..."],"changeTypes":["..."],"tools":["..."],"scores":{"importance":0,"confidence":0,"reusability":0,"decision_density":0,"failure_value":0,"causal_clarity":0,"project_specificity":0,"evidence_quality":0,"compression_quality":0,"staleness_risk":0}}"#.to_string(),
        String::new(),
        "Source segment:".to_string(),
        segment.text.clone(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    json!([
        {
            "role": "system",
            "content": system_content
        },
        {
            "role": "user",
            "content": user_content
        }
    ])
}

fn parse_canonical_array(content: &str) -> Result<Vec<CanonicalEpisode>, CliError> {
    let trimmed = content.trim();
    let candidate = if trimmed.starts_with("```") {
        trimmed
            .lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        trimmed.to_string()
    };
    let start = candidate
        .find('[')
        .ok_or_else(|| CliError::io("episode distiller output did not contain JSON array"))?;
    let end = candidate
        .rfind(']')
        .ok_or_else(|| CliError::io("episode distiller output did not contain JSON array end"))?;
    let json_text = candidate[start..=end].to_string();
    let mut items: Vec<CanonicalEpisode> = serde_json::from_str(&json_text)
        .map_err(|error| CliError::io(format!("episode distiller parse failed: {error}")))?;
    items.retain(|item| {
        !item.title.trim().is_empty()
            && !item.context.trim().is_empty()
            && !item.action_taken.trim().is_empty()
            && !item.outcome.trim().is_empty()
            && !item.reusable_lesson.trim().is_empty()
    });
    Ok(items)
}

fn build_local_llm_chat_completions_url(api_base_url: &str, api_path: &str) -> String {
    let base = api_base_url.trim().trim_end_matches('/');
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

fn parse_json_string_array(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value)
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn string_array_overlap_count(left: &[String], right: &[String]) -> usize {
    let right_set = right
        .iter()
        .map(|item| item.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    left.iter()
        .filter(|item| right_set.contains(&item.to_ascii_lowercase()))
        .count()
}

fn file_paths_for_range(document: &SourceDocument, start: usize, end: usize) -> Vec<String> {
    let mut paths = Vec::new();
    for event in &document.events {
        if event.end_offset <= start || event.start_offset >= end {
            continue;
        }
        if let Some(path) = event
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if !paths.iter().any(|item| item == path) {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

fn find_near_duplicate_candidates(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
) -> Result<Vec<NearDuplicateCandidate>, CliError> {
    let canonical = calibrate_episode(item.canonical.clone());
    let generation_kind = normalize_generation_kind(&canonical.generation_kind);
    let outcome_kind = normalize_outcome_kind(&canonical.outcome_kind);
    let current_files =
        file_paths_for_range(document, item.source_start_offset, item.source_end_offset);
    let mut statement = connection
        .prepare(
            "
            select id, title, situation, observations, action, outcome, lesson,
                   domains, technologies, change_types, repo_path, repo_key, source_key,
                   outcome_kind, coalesce(metadata, '{}')
            from episode_cards
            where source_kind = 'vibe_memory'
              and status = 'active'
              and classification_status = 'classified'
              and scope = ?3
              and source_key <> ?1
              and json_extract(metadata, '$.episodeDistillation.parentVibeMemoryId') = ?2
              and (?4 is null or project_ref = ?4)
              and (?5 is null or repo_path = ?5)
              and (?6 is null or repo_key = ?6)
            order by created_at desc
            limit 25
            ",
        )
        .map_err(|error| {
            CliError::io(format!("failed to prepare near duplicate query: {error}"))
        })?;
    let rows = statement
        .query_map(
            params![
                item.source_key,
                document.vibe_memory_id,
                identity.scope,
                identity.resolved.project_ref,
                identity.resolved.repo_path,
                identity.resolved.repo_key
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to query near duplicate candidates: {error}"
            ))
        })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (
            id,
            title,
            situation,
            observations,
            action,
            outcome,
            lesson,
            domains,
            technologies,
            change_types,
            _repo_path,
            _repo_key,
            _source_key,
            candidate_outcome_kind,
            metadata_text,
        ) = row
            .map_err(|error| CliError::io(format!("failed to read near duplicate row: {error}")))?;
        if normalize_outcome_kind(&candidate_outcome_kind) != outcome_kind {
            continue;
        }
        let metadata = parse_json_or_empty(&metadata_text);
        let candidate_generation_kind = metadata
            .pointer("/episodeDistillation/canonical/generationKind")
            .and_then(Value::as_str)
            .map(normalize_generation_kind)
            .or_else(|| {
                metadata
                    .pointer("/episodeDistillation/sourceStartOffset")
                    .and_then(Value::as_u64)
                    .map(|_| "task_episode".to_string())
            })
            .unwrap_or_else(|| "task_episode".to_string());
        if candidate_generation_kind != generation_kind {
            continue;
        }
        let Some(candidate_start) = metadata
            .pointer("/episodeDistillation/sourceStartOffset")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
        else {
            continue;
        };
        let Some(candidate_end) = metadata
            .pointer("/episodeDistillation/sourceEndOffset")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
        else {
            continue;
        };
        let candidate_files = file_paths_for_range(document, candidate_start, candidate_end);
        let same_file = string_array_overlap_count(&current_files, &candidate_files) > 0;
        let facet_overlap =
            string_array_overlap_count(&canonical.domains, &parse_json_string_array(&domains))
                + string_array_overlap_count(
                    &canonical.technologies,
                    &parse_json_string_array(&technologies),
                )
                + string_array_overlap_count(
                    &canonical.change_types,
                    &parse_json_string_array(&change_types),
                );
        if same_file && facet_overlap >= 2 {
            candidates.push(NearDuplicateCandidate {
                id,
                title,
                situation,
                observations,
                action,
                outcome,
                lesson,
            });
        }
        if candidates.len() >= 3 {
            break;
        }
    }
    Ok(candidates)
}

fn near_duplicate_review_messages(
    item: &PendingEpisode,
    candidates: &[NearDuplicateCandidate],
) -> Value {
    let canonical = calibrate_episode(item.canonical.clone());
    let system_content = [
        "あなたは ContextStill の EpisodeCard 登録前レビューアです。",
        "新規Episode候補が既存Episodeと実質的に同じ作業・判断・教訓を表す場合は登録しない判断を返してください。",
        "同じファイルや同じ親ログでも、別の判断・失敗・結果・再利用教訓を持つなら publish=true にしてください。",
        "出力は JSON object のみ。Markdown や説明文を付けないでください。",
    ]
    .join("\n");
    let user_content = [
        "次の shape の JSON object を返してください:".to_string(),
        r#"{"publish":true,"duplicateOfEpisodeId":null,"confidence":0,"reason":"..."}"#.to_string(),
        String::new(),
        "New Episode candidate:".to_string(),
        json!({
            "title": canonical.title,
            "context": canonical.context,
            "keyDecisions": canonical.key_decisions,
            "actionTaken": canonical.action_taken,
            "outcome": canonical.outcome,
            "reusableLesson": canonical.reusable_lesson,
            "generationKind": canonical.generation_kind,
            "outcomeKind": canonical.outcome_kind,
            "domains": canonical.domains,
            "technologies": canonical.technologies,
            "changeTypes": canonical.change_types
        })
        .to_string(),
        String::new(),
        "Existing candidate episodes:".to_string(),
        json!(candidates
            .iter()
            .map(|candidate| json!({
                "id": candidate.id,
                "title": candidate.title,
                "situation": candidate.situation,
                "observations": candidate.observations,
                "action": candidate.action,
                "outcome": candidate.outcome,
                "lesson": candidate.lesson
            }))
            .collect::<Vec<_>>())
        .to_string(),
    ]
    .join("\n");
    json!([
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content}
    ])
}

fn parse_near_duplicate_review(content: &str) -> Result<NearDuplicateReview, CliError> {
    let trimmed = content.trim();
    let candidate = if trimmed.starts_with("```") {
        trimmed
            .lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        trimmed.to_string()
    };
    let start = candidate
        .find('{')
        .ok_or_else(|| CliError::io("near duplicate review did not contain JSON object"))?;
    let end = candidate
        .rfind('}')
        .ok_or_else(|| CliError::io("near duplicate review did not contain JSON object end"))?;
    serde_json::from_str(&candidate[start..=end])
        .map_err(|error| CliError::io(format!("near duplicate review parse failed: {error}")))
}

fn review_near_duplicate_episode(
    item: &PendingEpisode,
    candidates: &[NearDuplicateCandidate],
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<NearDuplicateReview, CliError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let url = build_local_llm_chat_completions_url(&target.api_base_url, &target.api_path);
    let mut request = client.post(url).json(&json!({
        "model": target.model,
        "messages": near_duplicate_review_messages(item, candidates),
        "max_tokens": 800,
        "temperature": 0
    }));
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("near duplicate review request failed: {error}")))?;
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after_seconds);
    let body = response.text().map_err(|error| {
        CliError::io(format!(
            "failed to read near duplicate review response: {error}"
        ))
    })?;
    if !status.is_success() {
        let retry_after_message = retry_after_seconds
            .map(|seconds| format!(" retry_after_seconds={seconds}"))
            .unwrap_or_default();
        return Err(CliError::io(format!(
            "near duplicate review HTTP {}{}: {}",
            status.as_u16(),
            retry_after_message,
            truncate(&body, 1000)
        )));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        CliError::io(format!(
            "failed to parse near duplicate review response JSON: {error}"
        ))
    })?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::io("near duplicate review response did not include message content")
        })?;
    parse_near_duplicate_review(content)
}

fn near_duplicate_review_allows_publish(
    review: &NearDuplicateReview,
    candidates: &[NearDuplicateCandidate],
) -> bool {
    if review.publish {
        return true;
    }
    if review.confidence < 70 {
        return true;
    }
    let Some(duplicate_id) = review
        .duplicate_of_episode_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    !candidates
        .iter()
        .any(|candidate| candidate.id == duplicate_id)
}

#[allow(clippy::too_many_arguments)]
fn create_episode_idempotently(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<EpisodePersistOutcome, CliError> {
    if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
        return Ok(EpisodePersistOutcome::SourceDeduped(existing));
    }
    let candidates = find_near_duplicate_candidates(connection, item, document, identity)?;
    if !candidates.is_empty() {
        let review =
            review_near_duplicate_episode(item, &candidates, target, api_key, timeout_seconds)?;
        if !near_duplicate_review_allows_publish(&review, &candidates) {
            return Ok(EpisodePersistOutcome::NearDuplicateSkipped(review));
        }
    }
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| {
            CliError::io(format!("failed to begin episode card transaction: {error}"))
        })?;
    let result = create_episode_idempotently_in_transaction(connection, item, document, identity);
    match result {
        Ok(value) => {
            connection.execute_batch("COMMIT").map_err(|error| {
                CliError::io(format!(
                    "failed to commit episode card transaction: {error}"
                ))
            })?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
                Ok(EpisodePersistOutcome::SourceDeduped(existing))
            } else {
                Err(error)
            }
        }
    }
}

fn create_episode_idempotently_in_transaction(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
) -> Result<EpisodePersistOutcome, CliError> {
    if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
        return Ok(EpisodePersistOutcome::SourceDeduped(existing));
    }
    let id = pseudo_uuid();
    let ref_id = pseudo_uuid();
    let canonical = calibrate_episode(item.canonical.clone());
    let generation_kind = normalize_generation_kind(&canonical.generation_kind);
    let value_review = review_episode_value(&canonical);
    let observations = join_list(
        &canonical.key_decisions,
        "主要な判断は特定されませんでした。",
    );
    let action = if canonical.failed_approach.trim().is_empty() {
        canonical.action_taken.trim().to_string()
    } else {
        format!(
            "{}\n\n失敗した、または避けたアプローチ:\n{}",
            canonical.action_taken.trim(),
            canonical.failed_approach.trim()
        )
    };
    let source_fragment_key = item.source_key.clone();
    let project_identity = identity.snapshot();
    let metadata = json!({
        "source": "episodeDistiller",
        "episodeDistillation": {
            "version": EPISODE_DISTILLATION_VERSION,
            "canonical": canonical_json(&canonical),
            "scores": scores_json(&canonical.scores),
            "sourceFragmentKey": source_fragment_key,
            "sourceStartOffset": item.source_start_offset,
            "sourceEndOffset": item.source_end_offset,
            "sourceEventStart": item.event_start,
            "sourceEventEnd": item.event_end,
            "readRanges": [{"from": item.source_start_offset, "toExclusive": item.source_end_offset}],
            "parentVibeMemoryId": document.vibe_memory_id,
            "generatingQueueName": "episodeDistiller",
            "sessionId": document.session_id,
            "projectIdentity": project_identity,
            "valueReview": value_review_json(&value_review)
        },
        "triggers": canonical.useful_future_triggers
    });
    let applicability = json!({
        "sourceFragmentKey": source_fragment_key,
        "generationKind": generation_kind
    });
    let anti_applicability = json!({
        "requiresRawEvidenceCheck": true,
        "stalenessRisk": clamp_score(canonical.scores.staleness_risk),
        "openLoops": unique_strings(&canonical.open_loops)
    });
    connection
        .execute(
            "
            insert into episode_cards (
              id, title, situation, observations, action, outcome, lesson,
              applicability, anti_applicability, domains, technologies, change_types, tools,
              classification_status, scope, project_ref, repo_path, repo_key,
              source_kind, source_key, outcome_kind, importance, confidence,
              compile_use_count, decision_use_count, status, stale_at, metadata,
              created_at, updated_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'classified', ?14, ?15, ?16, ?17, 'vibe_memory', ?18, ?19, ?20, ?21, 0, 0, 'active', null, ?22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ",
            params![
                id,
                canonical.title.trim(),
                canonical.context.trim(),
                observations,
                action,
                canonical.outcome.trim(),
                canonical.reusable_lesson.trim(),
                applicability.to_string(),
                anti_applicability.to_string(),
                json!(unique_strings(&canonical.domains)).to_string(),
                json!(unique_strings(&canonical.technologies)).to_string(),
                json!(unique_strings(&canonical.change_types)).to_string(),
                json!(unique_strings(&canonical.tools)).to_string(),
                identity.scope,
                identity.resolved.project_ref,
                identity.resolved.repo_path,
                identity.resolved.repo_key,
                item.source_key,
                normalize_outcome_kind(&canonical.outcome_kind),
                clamp_score(canonical.scores.importance),
                clamp_score(canonical.scores.confidence),
                metadata.to_string()
            ],
        )
        .map_err(|error| CliError::io(format!("failed to insert episode card: {error}")))?;
    let rowid = connection
        .query_row(
            "select rowid from episode_cards where id = ?1",
            [&id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CliError::io(format!("failed to read episode card rowid: {error}")))?;
    if table_exists(connection, "episode_cards_fts")? {
        connection
            .execute(
                "
                insert into episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
                values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    rowid,
                    id,
                    canonical.title.trim(),
                    canonical.context.trim(),
                    observations,
                    action,
                    canonical.outcome.trim(),
                    canonical.reusable_lesson.trim()
                ],
            )
            .map_err(|error| CliError::io(format!("failed to insert episode card FTS row: {error}")))?;
    }
    connection
        .execute(
            "
            insert into episode_refs (
              id, episode_card_id, ref_kind, ref_value, locator, query_hint, metadata, created_at
            ) values (?1, ?2, 'vibe_memory', ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
            ",
            params![
                ref_id,
                id,
                document.vibe_memory_id,
                format!("bytes:{}-{}", item.source_start_offset, item.source_end_offset),
                canonical.title.trim(),
                json!({
                    "sourceFragmentKey": item.source_key,
                    "sourceStartOffset": item.source_start_offset,
                    "sourceEndOffset": item.source_end_offset,
                    "sourceEventStart": item.event_start,
                    "sourceEventEnd": item.event_end,
                    "readRanges": [{"from": item.source_start_offset, "toExclusive": item.source_end_offset}],
                    "sessionId": document.session_id,
                    "projectIdentity": project_identity
                }).to_string()
            ],
        )
        .map_err(|error| CliError::io(format!("failed to insert episode ref: {error}")))?;
    record_episode_identity_event(
        connection,
        "PROJECT_IDENTITY_PRODUCER_PERSISTED",
        json!({
            "producer": "episode-distiller.rust",
            "entityKind": "episode",
            "entityId": id,
            "scope": identity.scope,
            "matchBasis": identity.resolved.match_basis.as_str(),
            "identityFingerprint": identity.resolved.identity_fingerprint,
            "bindingStatus": identity.resolved.binding_status.as_str()
        }),
    );
    Ok(EpisodePersistOutcome::Created(id))
}

fn existing_episode_id(
    connection: &Connection,
    source_key: &str,
) -> Result<Option<String>, CliError> {
    connection
        .query_row(
            "select id from episode_cards where source_kind = 'vibe_memory' and source_key = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to check existing episode card: {error}")))
}

fn counters_from_metadata(metadata: &Value) -> ProcessCounters {
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

fn patch_episode_progress(
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
fn episode_progress_metadata(
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

fn internal_chunked_distillation_enabled() -> bool {
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

fn completed_segment_indexes(segment_results: &[Value]) -> HashSet<usize> {
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

fn is_completed_segment_status(status: &str) -> bool {
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

fn record_segment_result(segment_results: &mut Vec<Value>, result: Value) {
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

fn push_unique_string(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn mark_completed(
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

fn mark_failed(
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

fn mark_provider_unavailable_retry(
    connection: &Connection,
    job: &EpisodeDistillerJobRow,
    error: &str,
) -> Result<(), CliError> {
    let retry_after_seconds = provider_retry_after_seconds(error);
    connection
        .execute(
            "
            update episode_distiller_queue
            set status = 'pending',
                next_run_at = datetime('now', '+' || ?1 || ' seconds'),
                locked_by = null,
                locked_at = null,
                heartbeat_at = null,
                completed_at = null,
                last_error = ?2,
                last_outcome_kind = 'provider_unavailable_retry',
                metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?3),
                updated_at = CURRENT_TIMESTAMP
            where id = ?4
            ",
            params![
                retry_after_seconds,
                truncate(error, 1000),
                json!({"episodeDistiller": {"providerUnavailableRetriedAt": now_timestamp(), "providerUnavailableError": truncate(error, 1000), "providerRetryAfterSeconds": retry_after_seconds, "executor": "rust"}}).to_string(),
                job.id
            ],
        )
        .map_err(|error| CliError::io(format!("failed to return provider-unavailable episode distiller job to queue: {error}")))?;
    Ok(())
}

fn episode_source_fragment_key(
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

fn calibrate_episode(mut canonical: CanonicalEpisode) -> CanonicalEpisode {
    canonical.action_taken = canonical.action_taken.trim().to_string();
    canonical.failed_approach = canonical.failed_approach.trim().to_string();
    canonical.generation_kind = normalize_generation_kind(&canonical.generation_kind);
    canonical.outcome_kind = normalize_outcome_kind(&canonical.outcome_kind);
    canonical.scores = clamp_scores(canonical.scores);
    let small_change_signal = canonical.generation_kind == "task_episode"
        && canonical.scores.failure_value <= 10
        && canonical.scores.decision_density <= 70
        && canonical.scores.reusability <= 70;
    let value_score = quality_value_score(&canonical.scores);
    let mut importance_cap = 100.min(value_score + 10);
    if canonical.action_taken.is_empty() && canonical.failed_approach.is_empty() {
        importance_cap = importance_cap.min(65);
    }
    if small_change_signal {
        importance_cap = importance_cap.min(75);
    }
    canonical.scores.confidence = canonical.scores.confidence.min(80);
    canonical.scores.importance = canonical.scores.importance.min(importance_cap);
    canonical
}

fn review_episode_value(canonical: &CanonicalEpisode) -> ValueReview {
    let scores = &canonical.scores;
    let reusable_signal = scores
        .reusability
        .max(scores.decision_density)
        .max(scores.failure_value);
    let score = quality_value_score(scores);
    let mut reasons = Vec::new();
    if score < MIN_EPISODE_VALUE_SCORE {
        reasons.push("value_score_below_60".to_string());
    }
    if scores.importance < MIN_EPISODE_IMPORTANCE {
        reasons.push("importance_below_55".to_string());
    }
    if scores.confidence < MIN_EPISODE_CONFIDENCE {
        reasons.push("confidence_below_55".to_string());
    }
    if reusable_signal < MIN_EPISODE_REUSABLE_SIGNAL {
        reasons.push("reusable_signal_below_50".to_string());
    }
    if scores.evidence_quality < MIN_EPISODE_EVIDENCE_QUALITY {
        reasons.push("evidence_quality_below_50".to_string());
    }
    if scores.compression_quality < MIN_EPISODE_COMPRESSION_QUALITY {
        reasons.push("compression_quality_below_45".to_string());
    }
    ValueReview {
        publish: reasons.is_empty(),
        score,
        reasons,
    }
}

fn quality_value_score(scores: &EpisodeScores) -> i64 {
    ((scores.importance as f64 * 0.22)
        + (scores.confidence as f64 * 0.18)
        + (scores.reusability as f64 * 0.14)
        + (scores.decision_density as f64 * 0.1)
        + (scores.failure_value as f64 * 0.1)
        + (scores.causal_clarity as f64 * 0.1)
        + (scores.project_specificity as f64 * 0.06)
        + (scores.evidence_quality as f64 * 0.05)
        + (scores.compression_quality as f64 * 0.05))
        .round() as i64
}

fn canonical_json(canonical: &CanonicalEpisode) -> Value {
    json!({
        "title": canonical.title,
        "context": canonical.context,
        "intent": canonical.intent,
        "keyDecisions": canonical.key_decisions,
        "actionTaken": canonical.action_taken,
        "outcome": canonical.outcome,
        "failedApproach": canonical.failed_approach,
        "reusableLesson": canonical.reusable_lesson,
        "usefulFutureTriggers": canonical.useful_future_triggers,
        "openLoops": canonical.open_loops,
        "generationKind": canonical.generation_kind,
        "outcomeKind": canonical.outcome_kind,
        "domains": canonical.domains,
        "technologies": canonical.technologies,
        "changeTypes": canonical.change_types,
        "tools": canonical.tools,
        "scores": scores_json(&canonical.scores)
    })
}

fn scores_json(scores: &EpisodeScores) -> Value {
    json!({
        "importance": scores.importance,
        "confidence": scores.confidence,
        "reusability": scores.reusability,
        "decision_density": scores.decision_density,
        "failure_value": scores.failure_value,
        "causal_clarity": scores.causal_clarity,
        "project_specificity": scores.project_specificity,
        "evidence_quality": scores.evidence_quality,
        "compression_quality": scores.compression_quality,
        "staleness_risk": scores.staleness_risk
    })
}

fn value_review_json(review: &ValueReview) -> Value {
    json!({
        "publish": review.publish,
        "score": review.score,
        "reasons": review.reasons
    })
}

fn clamp_scores(mut scores: EpisodeScores) -> EpisodeScores {
    scores.importance = clamp_score(scores.importance);
    scores.confidence = clamp_score(scores.confidence);
    scores.reusability = clamp_score(scores.reusability);
    scores.decision_density = clamp_score(scores.decision_density);
    scores.failure_value = clamp_score(scores.failure_value);
    scores.causal_clarity = clamp_score(scores.causal_clarity);
    scores.project_specificity = clamp_score(scores.project_specificity);
    scores.evidence_quality = clamp_score(scores.evidence_quality);
    scores.compression_quality = clamp_score(scores.compression_quality);
    scores.staleness_risk = clamp_score(scores.staleness_risk);
    scores
}

fn clamp_score(value: i64) -> i64 {
    value.clamp(0, 100)
}

fn normalize_generation_kind(value: &str) -> String {
    match value {
        "failure_episode" | "decision_episode" => value.to_string(),
        _ => "task_episode".to_string(),
    }
}

fn normalize_outcome_kind(value: &str) -> String {
    match value {
        "success" | "failure" | "mixed" => value.to_string(),
        _ => "unknown".to_string(),
    }
}

fn default_score() -> i64 {
    50
}

fn deserialize_score<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        Value::Bool(value) => Some(if value { 100.0 } else { 0.0 }),
        _ => None,
    }
    .unwrap_or(50.0);
    let scaled = if number > 0.0 && number <= 1.0 {
        number * 100.0
    } else {
        number
    };
    Ok((scaled.round() as i64).clamp(0, 100))
}

fn default_generation_kind() -> String {
    "task_episode".to_string()
}

fn default_outcome_kind() -> String {
    "unknown".to_string()
}

fn unique_strings(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if seen.insert(value.to_string()) {
            result.push(value.to_string());
        }
    }
    result
}

fn join_list(values: &[String], fallback: &str) -> String {
    let items = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| format!("- {value}"))
        .collect::<Vec<_>>();
    if items.is_empty() {
        fallback.to_string()
    } else {
        items.join("\n")
    }
}

fn project_identity_snapshot_string(
    snapshot: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, CliError> {
    match snapshot.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(CliError::io(format!(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.{key} must be a string or null"
        ))),
    }
}

fn resolve_episode_write_identity(metadata: &Value) -> Result<EpisodeWriteIdentity, CliError> {
    let snapshot = metadata
        .get("projectIdentity")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CliError::io(
                "PROJECT_IDENTITY_REQUIRED: episodeDistiller requires metadata.projectIdentity",
            )
        })?;
    if snapshot.get("contractVersion").and_then(Value::as_u64) != Some(CONTRACT_VERSION.into()) {
        return Err(CliError::io(format!(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.contractVersion must be {CONTRACT_VERSION}"
        )));
    }
    if snapshot.get("classificationStatus").and_then(Value::as_str) != Some("classified") {
        return Err(CliError::io(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.classificationStatus must be classified",
        ));
    }
    let scope = snapshot
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| matches!(*scope, "repo" | "global"))
        .ok_or_else(|| {
            CliError::io(
                "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.scope must be repo or global",
            )
        })?
        .to_string();
    let resolved = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: project_identity_snapshot_string(snapshot, "projectRef")?,
            repo_key: project_identity_snapshot_string(snapshot, "repoKey")?,
            repo_path: project_identity_snapshot_string(snapshot, "repoPath")?,
        },
        CompileProjectIdentityTrust::TrustedAdapter,
        None,
    )
    .map_err(|error| CliError::io(error.to_string()))?;
    if scope == "repo" && resolved.match_basis == CompileProjectIdentityMatchBasis::None {
        return Err(CliError::io(
            "PROJECT_IDENTITY_REQUIRED: repo-scoped episode writes require projectRef, repoKey, or an absolute repoPath",
        ));
    }
    if scope == "global" && resolved.match_basis != CompileProjectIdentityMatchBasis::None {
        return Err(CliError::io(
            "PROJECT_IDENTITY_FORBIDDEN: global episode writes must not carry project identity",
        ));
    }
    if snapshot.get("scopeMode").and_then(Value::as_str) != Some(resolved.scope_mode) {
        return Err(CliError::io(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.scopeMode does not match its canonical identity",
        ));
    }
    Ok(EpisodeWriteIdentity { scope, resolved })
}

fn record_episode_identity_event(connection: &Connection, event_type: &str, payload: Value) {
    let _ = connection.execute(
        "insert into audit_logs (id, event_type, actor, payload, created_at) values (?1, ?2, 'agent', ?3, ?4)",
        (pseudo_uuid(), event_type, payload.to_string(), now_timestamp()),
    );
}

fn metadata_string_at(metadata: &Value, pointer: &str) -> Option<String> {
    metadata
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn metadata_i64_at(metadata: &Value, pointer: &str) -> i64 {
    metadata
        .pointer(pointer)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        })
        .unwrap_or(0)
}

fn metadata_string_array_at(metadata: &Value, pointer: &str) -> Option<Vec<String>> {
    Some(
        metadata
            .pointer(pointer)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    )
}

fn json_array_at(metadata: &Value, pointer: &str) -> Vec<Value> {
    metadata
        .pointer(pointer)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn parse_json_or_empty(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| json!({}))
}

fn estimate_token_count(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

fn slice_bytes_lossy(value: &str, start: usize, end: usize) -> String {
    String::from_utf8_lossy(&value.as_bytes()[start.min(value.len())..end.min(value.len())])
        .to_string()
}

fn nearest_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn parse_unixish(_value: &str) -> Option<u64> {
    None
}

fn to_isoish(value: &str) -> String {
    value.to_string()
}

fn push_optional_line(lines: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("{key}: {value}"));
    }
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect SQLite table {table_name}: {error}"
            ))
        })
}

fn is_provider_unavailable(error: &str) -> bool {
    is_provider_terminal_failure(error) || is_nonworking_local_llm_error(error)
}

fn is_provider_terminal_failure(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("http 503")
        || lower.contains("loading model")
        || lower.contains("unavailable_error")
}

fn is_nonworking_local_llm_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("local-llm request failed")
        || lower.contains("error sending request for url")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("transport closed")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
}

fn parse_retry_after_seconds(value: &str) -> Option<i64> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .map(|seconds| seconds.clamp(1, 3600))
}

fn provider_retry_after_seconds(error: &str) -> i64 {
    let Some(index) = error.find("retry_after_seconds=") else {
        return 30;
    };
    let value = &error[index + "retry_after_seconds=".len()..];
    let token = value
        .split(|ch: char| !ch.is_ascii_digit())
        .next()
        .unwrap_or_default();
    parse_retry_after_seconds(token).unwrap_or(30)
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn pseudo_uuid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let count = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let hex = format!("{:032x}", nanos ^ u128::from(count));
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn rust_episode_source_fragment_key_matches_distiller_contract() {
        let key = episode_source_fragment_key("memory-1", 10, 40, "task_episode");
        assert!(key.starts_with("vibe_memory:memory-1:episode:"));
        assert!(key.ends_with(":episode-distiller-v1"));
    }

    #[test]
    fn rust_episode_scores_coerce_fractional_and_string_values() {
        let episodes = parse_canonical_array(
            r#"[{
              "title":"score coercion",
              "context":"Rust accepts score shapes that TS Zod accepted.",
              "intent":"Keep LocalLLM output compatible.",
              "keyDecisions":[],
              "actionTaken":"Coerced scores during deserialization.",
              "outcome":"Fractional scores are scaled.",
              "failedApproach":"",
              "reusableLesson":"Native ports must preserve schema coercion semantics.",
              "usefulFutureTriggers":[],
              "openLoops":[],
              "generationKind":"task_episode",
              "outcomeKind":"success",
              "domains":[],
              "technologies":[],
              "changeTypes":[],
              "tools":[],
              "scores":{
                "importance":0.86,
                "confidence":"74",
                "reusability":82,
                "decision_density":0.7,
                "failure_value":0,
                "causal_clarity":78,
                "project_specificity":82,
                "evidence_quality":75,
                "compression_quality":72,
                "staleness_risk":0.25
              }
            }]"#,
        )
        .unwrap();

        assert_eq!(episodes[0].scores.importance, 86);
        assert_eq!(episodes[0].scores.confidence, 74);
        assert_eq!(episodes[0].scores.decision_density, 70);
        assert_eq!(episodes[0].scores.staleness_risk, 25);
    }

    #[test]
    fn rust_episode_parser_extracts_array_when_model_adds_trailing_text() {
        let episodes = parse_canonical_array(
            r#"[{
              "title":"trailing text",
              "context":"The model returned JSON plus prose.",
              "intent":"Keep parser behavior tolerant.",
              "actionTaken":"Extracted the JSON array boundaries.",
              "outcome":"The array parsed successfully.",
              "reusableLesson":"Local LLM outputs may include trailing text.",
              "scores":{"importance":80,"confidence":70,"reusability":75,"decision_density":70,"failure_value":55,"causal_clarity":70,"project_specificity":75,"evidence_quality":70,"compression_quality":70,"staleness_risk":20}
            }]
            trailing explanation"#,
        )
        .unwrap();

        assert_eq!(episodes.len(), 1);
        assert_eq!(episodes[0].title, "trailing text");
    }

    #[test]
    fn rust_local_llm_url_builder_matches_ts_v1_deduplication() {
        assert_eq!(
            build_local_llm_chat_completions_url(
                "http://192.168.0.61:50043/v1",
                "/v1/chat/completions"
            ),
            "http://192.168.0.61:50043/v1/chat/completions"
        );
        assert_eq!(
            build_local_llm_chat_completions_url(
                "http://192.168.0.61:50043",
                "v1/chat/completions"
            ),
            "http://192.168.0.61:50043/v1/chat/completions"
        );
    }

    #[test]
    fn rust_episode_distiller_writes_episode_card_from_local_llm_response() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        connection
            .execute(
                "
                insert into vibe_memories (id, session_id, content, metadata, created_at)
                values ('memory-1', 'session-1', 'Rust queue executor implemented native EpisodeDistiller processing with LocalLLM and SQLite persistence.', '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"repo\",\"scopeMode\":\"project\",\"repoKey\":\"contextstill\",\"repoPath\":\"/repo\"}}', '2026-06-23T00:00:00.000Z')
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                insert into episode_distiller_queue (
                  id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                  locked_by, locked_at, heartbeat_at, created_at, updated_at
                ) values (
                  'job-1', 'vibe_memory', 'memory-1', 'running', 10, 0, 2,
                  'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ",
                [],
            )
            .unwrap();
        let server = spawn_single_response_server(
            200,
            json!({
                "choices": [{
                    "message": {
                        "content": json!([{
                            "title": "Rust queue executor episodeDistiller native path",
                            "context": "Rust resident queue executor was being moved from maintenance-only behavior to native job processing.",
                            "intent": "Queue jobs should progress without relying on the TypeScript supervisor.",
                            "keyDecisions": ["episodeDistiller was implemented first because it was the active backlog."],
                            "actionTaken": "Rust added LocalLLM completion, source reading, EpisodeCard persistence, and queue completion handling.",
                            "outcome": "The job can complete and persist an EpisodeCard from the Rust executor.",
                            "failedApproach": "",
                            "reusableLesson": "When migrating queue ownership, implement a real executor path before claiming native ownership.",
                            "usefulFutureTriggers": ["Rust queue migration", "maintenance-only queue status"],
                            "openLoops": [],
                            "generationKind": "task_episode",
                            "outcomeKind": "success",
                            "domains": ["contextStill"],
                            "technologies": ["Rust", "SQLite", "LocalLLM"],
                            "changeTypes": ["runtime"],
                            "tools": ["cargo"],
                            "scores": {
                                "importance": 86,
                                "confidence": 76,
                                "reusability": 82,
                                "decision_density": 74,
                                "failure_value": 60,
                                "causal_clarity": 78,
                                "project_specificity": 82,
                                "evidence_quality": 75,
                                "compression_quality": 72,
                                "staleness_risk": 25
                            }
                        }]).to_string()
                    }
                }]
            })
            .to_string(),
        );
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: server,
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            Some("test-key"),
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Completed);
        let queue_status: String = connection
            .query_row(
                "select status from episode_distiller_queue where id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queue_status, "completed");
        let card_count: i64 = connection
            .query_row("select count(*) from episode_cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(card_count, 1);
        let ref_count: i64 = connection
            .query_row("select count(*) from episode_refs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ref_count, 1);
        let identity_columns: (String, String, Option<String>, Option<String>) = connection
            .query_row(
                "select classification_status, scope, repo_path, repo_key from episode_cards limit 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(identity_columns.0, "classified");
        assert_eq!(identity_columns.1, "repo");
        assert_eq!(identity_columns.2.as_deref(), Some("/repo"));
        assert_eq!(identity_columns.3.as_deref(), Some("contextstill"));
        let persisted_audit_count: i64 = connection
            .query_row(
                "select count(*) from audit_logs where event_type = 'PROJECT_IDENTITY_PRODUCER_PERSISTED'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted_audit_count, 1);
        let metadata: String = connection
            .query_row(
                "select metadata from episode_distiller_queue where id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let metadata = parse_json_or_empty(&metadata);
        assert_eq!(
            metadata.pointer("/episodeDistiller/segmentCount"),
            Some(&json!(1))
        );
        assert_eq!(
            metadata.pointer("/episodeDistiller/generated"),
            Some(&json!(1))
        );
        assert!(metadata
            .pointer("/episodeDistiller/lastEpisodeCreatedAt")
            .and_then(Value::as_str)
            .is_some());
        assert_eq!(
            metadata
                .pointer("/episodeDistiller/segmentResults/0/status")
                .and_then(Value::as_str),
            Some("saved")
        );
    }

    #[test]
    fn rust_episode_distiller_retries_partial_output_when_provider_returns_503() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        insert_two_segment_memory(&connection);
        insert_episode_job(&connection, "job-1", json!({}));
        let server = spawn_response_sequence_server(vec![
            (
                200,
                llm_response_body("First segment saved before retry", "task_episode"),
            ),
            (
                503,
                r#"{"error":{"message":"Loading model","type":"unavailable_error","code":503}}"#
                    .to_string(),
            ),
        ]);
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: server,
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            Some("test-key"),
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Retrying);
        let card_count: i64 = connection
            .query_row("select count(*) from episode_cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(card_count, 1);
        let row = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null, completed_at is not null, metadata from episode_distiller_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 0);
        assert_eq!(row.2, "provider_unavailable_retry");
        assert_eq!(row.3, 1);
        assert_eq!(row.4, 0);
        let metadata = parse_json_or_empty(&row.5);
        assert_eq!(
            metadata
                .pointer("/episodeDistiller/segmentResults/0/status")
                .and_then(Value::as_str),
            Some("saved")
        );
        assert_eq!(
            metadata
                .pointer("/episodeDistiller/segmentResults/1/status")
                .and_then(Value::as_str),
            Some("failed")
        );
        assert!(metadata
            .pointer("/episodeDistiller/savedEpisodeIds/0")
            .and_then(Value::as_str)
            .is_some());
        assert!(metadata
            .pointer("/episodeDistiller/providerUnavailableRetriedAt")
            .and_then(Value::as_str)
            .is_some());
        assert_eq!(
            metadata.pointer("/episodeDistiller/providerRetryAfterSeconds"),
            Some(&json!(30))
        );
        assert!(metadata
            .pointer("/episodeDistiller/lastEpisodeCreatedAt")
            .and_then(Value::as_str)
            .is_some());
    }

    #[test]
    fn rust_episode_distiller_resumes_after_saved_segment_metadata() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        insert_two_segment_memory(&connection);
        let document = read_source_document(&connection, "memory-1").unwrap();
        let segments = build_deterministic_segments(&document);
        assert_eq!(segments.len(), 2);
        let saved_source_key = episode_source_fragment_key(
            "memory-1",
            segments[0].start_offset,
            segments[0].end_offset,
            "task_episode",
        );
        let pending = PendingEpisode {
            canonical: test_canonical_episode(),
            source_key: saved_source_key.clone(),
            source_start_offset: segments[0].start_offset,
            source_end_offset: segments[0].end_offset,
            event_start: segments[0].event_start.clone(),
            event_end: segments[0].event_end.clone(),
        };
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };
        let write_identity = resolve_episode_write_identity(&document.metadata).unwrap();
        let saved_episode_id = match create_episode_idempotently(
            &connection,
            &pending,
            &document,
            &write_identity,
            &target,
            None,
            30,
        )
        .unwrap()
        {
            EpisodePersistOutcome::Created(id) => id,
            _ => panic!("expected new episode to be created"),
        };
        insert_episode_job(
            &connection,
            "job-1",
            json!({
                "episodeDistiller": {
                    "generated": 1,
                    "acceptedCandidateCount": 1,
                    "episodeIds": [saved_episode_id],
                    "savedEpisodeIds": [saved_episode_id],
                    "savedSourceKeys": [saved_source_key],
                    "segmentResults": [{
                        "segment": 0,
                        "status": "saved"
                    }]
                }
            }),
        );
        let server = spawn_single_response_server(
            200,
            llm_response_body("Second segment after resume", "task_episode"),
        );
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: server,
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            Some("test-key"),
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Completed);
        let card_count: i64 = connection
            .query_row("select count(*) from episode_cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(card_count, 2);
        let metadata: String = connection
            .query_row(
                "select metadata from episode_distiller_queue where id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let metadata = parse_json_or_empty(&metadata);
        assert_eq!(
            metadata
                .pointer("/episodeDistiller/segmentResults/0/status")
                .and_then(Value::as_str),
            Some("saved")
        );
        assert_eq!(
            metadata
                .pointer("/episodeDistiller/segmentResults/1/status")
                .and_then(Value::as_str),
            Some("saved")
        );
    }

    #[test]
    fn rust_episode_distiller_retry_does_not_carry_previous_failed_segment_count() {
        let counters = counters_from_metadata(&json!({
            "episodeDistiller": {
                "generated": 1,
                "failedSegments": 3,
                "savedEpisodeIds": ["episode-1"],
                "savedSourceKeys": ["source-key-1"]
            }
        }));

        assert_eq!(counters.generated, 1);
        assert_eq!(counters.failed_segments, 0);
        assert_eq!(counters.episode_ids, vec!["episode-1".to_string()]);
        assert_eq!(counters.saved_source_keys, vec!["source-key-1".to_string()]);
    }

    #[test]
    fn rust_episode_distiller_retries_when_provider_returns_503() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        connection
            .execute(
                "
                insert into vibe_memories (id, session_id, content, metadata, created_at)
                values ('memory-1', 'session-1', 'LocalLLM is still loading while the Rust executor owns queue processing.', '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"global\",\"scopeMode\":\"global_only\"}}', '2026-06-23T00:00:00.000Z')
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                insert into episode_distiller_queue (
                  id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                  locked_by, locked_at, heartbeat_at, created_at, updated_at
                ) values (
                  'job-1', 'vibe_memory', 'memory-1', 'running', 10, 0, 2,
                  'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ",
                [],
            )
            .unwrap();
        let server = spawn_single_response_server(
            503,
            r#"{"error":{"message":"Loading model","type":"unavailable_error","code":503}}"#
                .to_string(),
        );
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: server,
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            Some("test-key"),
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Retrying);
        let row = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null, completed_at is not null, metadata from episode_distiller_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 0);
        assert_eq!(row.2, "provider_unavailable_retry");
        assert_eq!(row.3, 1);
        assert_eq!(row.4, 0);
        let metadata = parse_json_or_empty(&row.5);
        assert!(metadata
            .pointer("/episodeDistiller/providerUnavailableRetriedAt")
            .and_then(Value::as_str)
            .is_some());
        assert_eq!(
            metadata.pointer("/episodeDistiller/providerRetryAfterSeconds"),
            Some(&json!(30))
        );
    }

    #[test]
    fn rust_episode_distiller_retries_when_local_llm_cannot_connect() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        connection
            .execute(
                "
                insert into vibe_memories (id, session_id, content, metadata, created_at)
                values ('memory-1', 'session-1', 'LocalLLM transport is down while the Rust executor owns queue processing.', '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"global\",\"scopeMode\":\"global_only\"}}', '2026-06-23T00:00:00.000Z')
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                insert into episode_distiller_queue (
                  id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                  locked_by, locked_at, heartbeat_at, created_at, updated_at
                ) values (
                  'job-1', 'vibe_memory', 'memory-1', 'running', 10, 0, 2,
                  'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ",
                [],
            )
            .unwrap();
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            Some("test-key"),
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Retrying);
        let row = connection
            .query_row(
                "select status, attempt_count, last_outcome_kind, next_run_at is not null, completed_at is not null, metadata from episode_distiller_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "pending");
        assert_eq!(row.1, 0);
        assert_eq!(row.2, "provider_unavailable_retry");
        assert_eq!(row.3, 1);
        assert_eq!(row.4, 0);
        let metadata = parse_json_or_empty(&row.5);
        assert!(metadata
            .pointer("/episodeDistiller/providerUnavailableRetriedAt")
            .and_then(Value::as_str)
            .is_some());
    }

    #[test]
    fn rust_episode_distiller_rejects_legacy_identityless_memory() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        connection
            .execute(
                "insert into vibe_memories (id, session_id, content, metadata, created_at) values ('memory-1', 'session-1', 'Legacy memory has enough content to distill.', '{\"cwd\":\"/legacy/repo\",\"project\":\"legacy\"}', CURRENT_TIMESTAMP)",
                [],
            )
            .unwrap();
        insert_episode_job(&connection, "job-1", json!({}));
        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };

        let status = run_episode_distiller_job_for_connection(
            &connection,
            "job-1",
            "worker-1",
            &target,
            None,
            30,
        )
        .unwrap();

        assert_eq!(status, EpisodeExecutionStatus::Failed);
        let last_error: String = connection
            .query_row(
                "select last_error from episode_distiller_queue where id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(last_error.starts_with("PROJECT_IDENTITY_REQUIRED:"));
        let rejected_audit_count: i64 = connection
            .query_row(
                "select count(*) from audit_logs where event_type = 'PROJECT_IDENTITY_PRODUCER_REJECTED' and json_extract(payload, '$.rejectionCode') = 'PROJECT_IDENTITY_REQUIRED'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rejected_audit_count, 1);
    }

    #[test]
    fn rust_episode_card_insert_rolls_back_when_ref_or_fts_insert_fails() {
        let connection = Connection::open_in_memory().unwrap();
        create_episode_runtime_tables(&connection);
        connection
            .execute("create table episode_cards_fts (id text primary key)", [])
            .unwrap();
        let document = SourceDocument {
            vibe_memory_id: "memory-1".to_string(),
            session_id: "session-1".to_string(),
            content: "source".to_string(),
            metadata: json!({
                "projectIdentity": {
                    "contractVersion": 1,
                    "classificationStatus": "classified",
                    "scope": "global",
                    "scopeMode": "global_only"
                }
            }),
            events: Vec::new(),
        };
        let pending = PendingEpisode {
            canonical: test_canonical_episode(),
            source_key: "vibe_memory:memory-1:episode:test:episode-distiller-v1".to_string(),
            source_start_offset: 0,
            source_end_offset: 6,
            event_start: None,
            event_end: None,
        };

        let target = LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        };
        let write_identity = resolve_episode_write_identity(&document.metadata).unwrap();
        let error = create_episode_idempotently(
            &connection,
            &pending,
            &document,
            &write_identity,
            &target,
            None,
            30,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("failed to insert episode card FTS row"));
        let card_count: i64 = connection
            .query_row("select count(*) from episode_cards", [], |row| row.get(0))
            .unwrap();
        let ref_count: i64 = connection
            .query_row("select count(*) from episode_refs", [], |row| row.get(0))
            .unwrap();
        let persisted_audit_count: i64 = connection
            .query_row(
                "select count(*) from audit_logs where event_type = 'PROJECT_IDENTITY_PRODUCER_PERSISTED'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(card_count, 0);
        assert_eq!(ref_count, 0);
        assert_eq!(persisted_audit_count, 0);
    }

    fn insert_two_segment_memory(connection: &Connection) {
        connection
            .execute(
                "
                insert into vibe_memories (id, session_id, content, metadata, created_at)
                values ('memory-1', 'session-1', 'Rust queue executor should save each completed episode segment before continuing to later LocalLLM calls.', '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"repo\",\"scopeMode\":\"project\",\"repoKey\":\"contextstill\",\"repoPath\":\"/repo\"}}', '2026-06-23T00:00:00.000Z')
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                insert into agent_diff_entries (
                  id, vibe_memory_id, file_path, diff_hunk, change_type, language,
                  symbol_name, symbol_kind, signature, start_line, end_line, created_at
                ) values (
                  'diff-1', 'memory-1', 'src/first.rs',
                  'Implemented the first segment of EpisodeDistiller incremental persistence and verified it writes EpisodeCard rows immediately.',
                  'modify', 'rust', 'first', 'function', 'fn first()', 10, 20, '2026-06-23T00:01:00.000Z'
                )
                ",
                [],
            )
            .unwrap();
        connection
            .execute(
                "
                insert into agent_diff_entries (
                  id, vibe_memory_id, file_path, diff_hunk, change_type, language,
                  symbol_name, symbol_kind, signature, start_line, end_line, created_at
                ) values (
                  'diff-2', 'memory-1', 'src/second.rs',
                  'Continued with a second segment so the worker must perform a later LocalLLM call after saving the first segment.',
                  'modify', 'rust', 'second', 'function', 'fn second()', 30, 40, '2026-06-23T00:02:00.000Z'
                )
                ",
                [],
            )
            .unwrap();
    }

    fn insert_episode_job(connection: &Connection, job_id: &str, metadata: Value) {
        connection
            .execute(
                "
                insert into episode_distiller_queue (
                  id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                  locked_by, locked_at, heartbeat_at, metadata, created_at, updated_at
                ) values (
                  ?1, 'vibe_memory', 'memory-1', 'running', 10, 0, 2,
                  'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                ",
                params![job_id, metadata.to_string()],
            )
            .unwrap();
    }

    fn create_episode_runtime_tables(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table vibe_memories (
                  id text primary key,
                  session_id text not null,
                  content text not null,
                  metadata text,
                  created_at text not null
                );
                create table episode_distiller_queue (
                  id text primary key,
                  source_kind text not null,
                  source_key text not null,
                  status text not null,
                  priority integer not null default 0,
                  attempt_count integer not null default 0,
                  max_attempts integer not null default 2,
                  locked_by text,
                  locked_at text,
                  heartbeat_at text,
                  next_run_at text,
                  completed_at text,
                  last_error text,
                  last_outcome_kind text,
                  metadata text,
                  created_at text not null,
                  updated_at text not null
                );
                create table episode_cards (
                  id text primary key,
                  title text not null,
                  situation text not null,
                  observations text not null,
                  action text not null,
                  outcome text not null,
                  lesson text not null,
                  applicability text not null,
                  anti_applicability text not null,
                  domains text not null,
                  technologies text not null,
                  change_types text not null,
                  tools text not null,
                  classification_status text not null,
                  scope text not null,
                  project_ref text,
                  repo_path text,
                  repo_key text,
                  source_kind text not null,
                  source_key text not null,
                  outcome_kind text not null,
                  importance integer not null,
                  confidence integer not null,
                  compile_use_count integer not null default 0,
                  decision_use_count integer not null default 0,
                  status text not null,
                  stale_at text,
                  metadata text not null,
                  created_at text not null,
                  updated_at text not null
                );
                create table episode_refs (
                  id text primary key,
                  episode_card_id text not null,
                  ref_kind text not null,
                  ref_value text not null,
                  locator text,
                  query_hint text,
                  metadata text not null,
                  created_at text not null
                );
                create table distillation_queue_events (
                  id text primary key,
                  queue_name text not null,
                  queue_job_id text not null,
                  event_type text not null,
                  message text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table audit_logs (
                  id text primary key,
                  event_type text not null,
                  actor text not null,
                  payload text not null default '{}',
                  created_at text not null
                );
                create table agent_diff_entries (
                  id text primary key,
                  vibe_memory_id text not null,
                  file_path text not null,
                  diff_hunk text not null,
                  change_type text,
                  language text,
                  symbol_name text,
                  symbol_kind text,
                  signature text,
                  start_line integer,
                  end_line integer,
                  created_at text not null
                );
                "#,
            )
            .unwrap();
    }

    fn test_canonical_episode() -> CanonicalEpisode {
        CanonicalEpisode {
            title: "Atomic EpisodeCard insert".to_string(),
            context: "Rust should not leave partial EpisodeCard rows.".to_string(),
            intent: "Protect retry semantics.".to_string(),
            key_decisions: vec!["Use one transaction for card, FTS, and refs.".to_string()],
            action_taken: "Wrapped EpisodeCard persistence in BEGIN IMMEDIATE.".to_string(),
            outcome: "Partial inserts roll back on downstream failure.".to_string(),
            failed_approach: String::new(),
            reusable_lesson: "Queue completion must follow confirmed persistence.".to_string(),
            useful_future_triggers: vec!["EpisodeCard persistence failure".to_string()],
            open_loops: Vec::new(),
            generation_kind: "task_episode".to_string(),
            outcome_kind: "success".to_string(),
            domains: vec!["contextStill".to_string()],
            technologies: vec!["Rust".to_string(), "SQLite".to_string()],
            change_types: vec!["runtime".to_string()],
            tools: vec!["cargo".to_string()],
            scores: EpisodeScores {
                importance: 85,
                confidence: 75,
                reusability: 80,
                decision_density: 70,
                failure_value: 65,
                causal_clarity: 75,
                project_specificity: 80,
                evidence_quality: 70,
                compression_quality: 70,
                staleness_risk: 20,
            },
        }
    }

    fn llm_response_body(title: &str, generation_kind: &str) -> String {
        json!({
            "choices": [{
                "message": {
                    "content": json!([{
                        "title": title,
                        "context": "Rust EpisodeDistiller is processing segmented source evidence.",
                        "intent": "Persist useful EpisodeCards as each segment completes.",
                        "keyDecisions": ["Save segment output immediately instead of waiting for job completion."],
                        "actionTaken": "The Rust worker persisted a segment result and updated queue progress metadata.",
                        "outcome": "Completed segment output remains available even if a later segment needs retry.",
                        "failedApproach": "",
                        "reusableLesson": "Long-running LLM jobs should publish durable partial outputs at natural boundaries.",
                        "usefulFutureTriggers": ["EpisodeDistiller long run", "queue retry after partial progress"],
                        "openLoops": [],
                        "generationKind": generation_kind,
                        "outcomeKind": "success",
                        "domains": ["contextStill"],
                        "technologies": ["Rust", "SQLite", "LocalLLM"],
                        "changeTypes": ["runtime"],
                        "tools": ["cargo"],
                        "scores": {
                            "importance": 86,
                            "confidence": 76,
                            "reusability": 82,
                            "decision_density": 74,
                            "failure_value": 60,
                            "causal_clarity": 78,
                            "project_specificity": 82,
                            "evidence_quality": 75,
                            "compression_quality": 72,
                            "staleness_risk": 25
                        }
                    }]).to_string()
                }
            }]
        })
        .to_string()
    }

    fn spawn_single_response_server(status: u16, body: String) -> String {
        spawn_response_sequence_server(vec![(status, body)])
    }

    fn spawn_response_sequence_server(responses: Vec<(u16, String)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                let reason = if status == 200 {
                    "OK"
                } else {
                    "Service Unavailable"
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        format!("http://{address}")
    }
}
