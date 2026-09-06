#![cfg(test)]
use super::distillation::{build_local_llm_chat_completions_url, parse_canonical_array};
use super::entry::{run_episode_distiller_job_for_connection, run_episode_distiller_job_for_path};
use super::helpers::parse_json_or_empty;
use super::identity::resolve_episode_write_identity;
use super::persistence::create_episode_idempotently;
use super::progress::{counters_from_metadata, episode_source_fragment_key};
use super::source::{build_deterministic_segments, read_source_document};
use super::types::{
    CanonicalEpisode, EpisodeExecutionStatus, EpisodePersistOutcome, EpisodeScores,
    EpisodeSplitStatus, LocalLlmTargetConfig, PendingEpisode, SourceDocument,
};

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde_json::{json, Value};

use super::super::provider_execution::open_query_only_connection;
use super::super::types::{ClaimedProviderLeaseJob, ProviderLeaseAssignment};

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
        build_local_llm_chat_completions_url("http://192.168.0.61:50043", "v1/chat/completions"),
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
    assert_eq!(row.1, 1);
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
        Some(&json!(60))
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
    assert_eq!(row.1, 1);
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
        Some(&json!(60))
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
    assert_eq!(row.1, 1);
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

#[test]
fn split_episode_execution_uses_query_only_reads_and_fenced_writer_persistence() {
    let path = std::env::temp_dir().join(format!(
        "context-still-episode-split-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let connection = Connection::open(&path).unwrap();
    create_episode_runtime_tables(&connection);
    connection
            .execute(
                "insert into vibe_memories (id, session_id, content, metadata, created_at)
                 values ('memory-split', 'session-split', ?1,
                   '{\"projectIdentity\":{\"contractVersion\":1,\"classificationStatus\":\"classified\",\"scope\":\"repo\",\"scopeMode\":\"project\",\"repoKey\":\"contextstill\",\"repoPath\":\"/repo\"}}',
                   CURRENT_TIMESTAMP)",
                ["The split EpisodeDistiller keeps every core SQLite mutation on the resident writer while LocalLLM work runs outside it. This provides enough concrete evidence for one reusable implementation episode."],
            )
            .unwrap();
    connection
            .execute_batch(
                "insert into episode_distiller_queue (
                   id, source_kind, source_key, status, priority, attempt_count, max_attempts,
                   locked_by, locked_at, heartbeat_at, created_at, updated_at
                 ) values (
                   'episode-split-job', 'vibe_memory', 'memory-split', 'running', 10, 0, 2,
                   'split-worker', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                 );
                 insert into llm_provider_leases (
                   id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
                   locked_at, heartbeat_at, expires_at, created_at, updated_at
                 ) values (
                   'episode-split-lease', 'pool', 'local-a', 'episodeDistiller',
                   'episode-split-job', 'split-worker', 'active', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, '+120 seconds'),
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                 );",
            )
            .unwrap();
    drop(connection);

    let runtime =
        crate::domains::sqlite_writer::SqliteWriterRuntime::start_existing_for_test(&path, 16)
            .unwrap();
    crate::domains::sqlite_writer::install_global_writer(runtime.handle()).unwrap();
    let server = spawn_single_response_server(
        200,
        llm_response_body("Split episode execution", "task_episode"),
    );
    let status = run_episode_distiller_job_for_path(
        &path,
        ClaimedProviderLeaseJob {
            queue_name: "episodeDistiller".to_string(),
            id: "episode-split-job".to_string(),
            provider_lease: ProviderLeaseAssignment {
                id: "episode-split-lease".to_string(),
                pool_id: "pool".to_string(),
                target_id: "local-a".to_string(),
                queue_name: "episodeDistiller".to_string(),
                queue_job_id: "episode-split-job".to_string(),
                worker_id: "split-worker".to_string(),
            },
        },
        LocalLlmTargetConfig {
            target_id: "local-a".to_string(),
            api_base_url: server,
            api_path: "/v1/chat/completions".to_string(),
            model: "qwen".to_string(),
        },
        Some("test-key".to_string().into()),
        30,
    )
    .unwrap();
    assert_eq!(status, EpisodeSplitStatus::Completed);

    let reader = open_query_only_connection(&path).unwrap();
    let row: (String, i64, String, String) = reader
        .query_row(
            "select q.status,
                        (select count(*) from episode_cards),
                        l.status,
                        coalesce(l.release_reason, '')
                 from episode_distiller_queue q
                 join llm_provider_leases l on l.queue_job_id = q.id
                 where q.id = 'episode-split-job'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "completed".to_string(),
            1,
            "released".to_string(),
            "worker_finished".to_string()
        )
    );
    drop(reader);
    crate::domains::sqlite_writer::clear_global_writer(&path);
    runtime.shutdown().unwrap();
    let _ = std::fs::remove_file(path);
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
                create table llm_provider_leases (
                  id text primary key,
                  pool_id text not null,
                  target_id text not null,
                  queue_name text not null,
                  queue_job_id text not null,
                  worker_id text not null,
                  status text not null,
                  locked_at text not null,
                  heartbeat_at text not null,
                  expires_at text not null,
                  released_at text,
                  release_reason text,
                  metadata text not null default '{}',
                  created_at text not null,
                  updated_at text not null
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
