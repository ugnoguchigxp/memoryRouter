use super::*;
use crate::domains::queue_lifecycle::test_support::*;
use crate::shared::config::MapEnv;
use rusqlite::Connection;
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

#[path = "executor/tests/dynamic_larm_canary_tests.rs"]
mod dynamic_larm_canary_tests;

fn serve_covering_response(content: Value) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let response_body = json!({
        "choices": [{"message": {"content": content.to_string()}}]
    })
    .to_string();
    let handle = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some(value) = line
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
            {
                content_length = value;
            }
        }
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
        reader.get_mut().write_all(response.as_bytes()).unwrap();
    });
    (format!("http://{address}"), handle)
}

fn serve_embedding_response() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).unwrap();
        let body = r#"{"embeddings":[[0.1,0.2,0.3]],"dimension":3}"#;
        write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
    });
    (format!("http://{address}"), handle)
}

#[test]
fn covering_turn_is_rate_limited_but_not_starved_by_other_provider_backlog() {
    let connection = Connection::open_in_memory().unwrap();
    create_queue_events_table(&connection);

    assert!(covering_turn_due(&connection, 60).unwrap());
    connection
            .execute(
                "insert into distillation_queue_events (id, queue_name, queue_job_id, event_type, metadata) values ('event-1', 'coveringEvidence', 'cover-1', 'claimed', '{\"executor\":\"rust\"}')",
                [],
            )
            .unwrap();
    assert!(!covering_turn_due(&connection, 60).unwrap());

    connection
            .execute(
                "update distillation_queue_events set created_at = datetime(CURRENT_TIMESTAMP, '-2 minutes') where id = 'event-1'",
                [],
            )
            .unwrap();
    assert!(!covering_turn_due(&connection, 60).unwrap());
    connection
            .execute(
                "insert into distillation_queue_events (id, queue_name, queue_job_id, event_type, metadata) values ('event-2', 'episodeDistiller', 'episode-1', 'claimed', '{\"executor\":\"rust\"}')",
                [],
            )
            .unwrap();
    assert!(covering_turn_due(&connection, 60).unwrap());
}

#[test]
fn rust_covering_mode_accepts_rollout_states_and_rejects_unknown_values() {
    for (value, expected) in [
        ("off", RustCoveringMode::Off),
        ("negative", RustCoveringMode::Negative),
        ("canary", RustCoveringMode::Canary),
        ("all", RustCoveringMode::All),
    ] {
        let env = MapEnv::from_pairs(vec![("CONTEXT_STILL_RUST_COVERING_MODE", value)]);
        assert_eq!(rust_covering_mode(&env).unwrap(), expected);
    }
    let env = MapEnv::from_pairs(vec![("CONTEXT_STILL_RUST_COVERING_MODE", "positive")]);
    assert!(rust_covering_mode(&env)
        .unwrap_err()
        .to_string()
        .contains("expected off, negative, canary, or all"));
}

#[test]
fn covering_canary_manifest_is_database_bound_and_deduplicated() {
    let app_dir = temp_app_dir("covering_canary_manifest");
    let sqlite_path = app_dir.join("queue.sqlite");
    Connection::open(&sqlite_path).unwrap();
    let manifest_path = app_dir.join("covering-canary.json");
    std::fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "databasePath": sqlite_path,
            "jobIds": ["cover-b", "cover-a", "cover-a"]
        })
        .to_string(),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_RUST_COVERING_MODE", "canary"),
        (
            "CONTEXT_STILL_RUST_COVERING_CANARY_MANIFEST",
            manifest_path.to_str().unwrap(),
        ),
    ]);

    let (mode, ids) = rust_covering_config(&env, &sqlite_path).unwrap();

    assert_eq!(mode, RustCoveringMode::Canary);
    assert_eq!(ids, vec!["cover-a".to_string(), "cover-b".to_string()]);
    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_executor_tick_does_not_claim_unsupported_queue() {
    let app_dir = temp_app_dir("executor_tick");
    let sqlite_path = app_dir.join("queue.sqlite");
    let connection = Connection::open(&sqlite_path).unwrap();
    create_provider_claim_queue_table(&connection, "covering_evidence_queue");
    create_queue_events_table(&connection);
    create_provider_lease_table(&connection);
    connection
        .execute_batch(
            r#"
                create table settings (
                  id text primary key,
                  namespace text not null,
                  key text not null,
                  value text not null
                );
                insert into covering_evidence_queue (
                  id, status, priority, created_at, updated_at, next_run_at
                ) values (
                  'job-1', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null
                );
                "#,
        )
        .unwrap();
    let settings = json!({
        "settings": {
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": "local-b"}],
                "maxConcurrent": 1,
                "staleLeaseSeconds": 120,
                "lowPriorityAgingSeconds": 1800
            }],
            "providers": {
                "local-llm": {
                    "models": [{"id": "local-b", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"}]
                }
            },
            "taskRouting": {
                "coverEvidence": {
                    "sourceSupport": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
                }
            }
        }
    });
    connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
    drop(connection);

    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
    ]);

    let report = run_executor_tick_report(&env).unwrap();

    assert_eq!(report.status, "idle");
    assert_eq!(report.claimed, 0);
    assert_eq!(report.unsupported, 0);
    let connection = Connection::open(&sqlite_path).unwrap();
    let row = connection
            .query_row(
                "select status, last_outcome_kind, last_error is not null, next_run_at is not null from covering_evidence_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(row, ("pending".to_string(), None, 0, 0));
    let active_leases: i64 = connection
        .query_row(
            "select count(*) from llm_provider_leases where status = 'active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active_leases, 0);
    let retried_events: i64 = connection
        .query_row(
            "select count(*) from distillation_queue_events where event_type = 'retried'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retried_events, 0);

    std::fs::remove_dir_all(app_dir).unwrap();
}

#[test]
fn provider_setup_failure_returns_job_and_lease_atomically() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    create_queue_events_table(&connection);
    connection
        .execute_batch(
            r#"
                insert into finding_candidate_queue (
                  id, status, priority, attempt_count, created_at, updated_at,
                  locked_by, locked_at, heartbeat_at
                ) values (
                  'job-setup', 'running', 10, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  'worker-setup', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id,
                  status, expires_at
                ) values (
                  'lease-setup', 'pool-1', 'target-1', 'findingCandidate',
                  'job-setup', 'worker-setup', 'active',
                  datetime(CURRENT_TIMESTAMP, '+2 minutes')
                );
                "#,
        )
        .unwrap();
    let job = super::super::types::ClaimedProviderLeaseJob {
        queue_name: "findingCandidate".to_string(),
        id: "job-setup".to_string(),
        provider_lease: super::super::types::ProviderLeaseAssignment {
            id: "lease-setup".to_string(),
            pool_id: "pool-1".to_string(),
            target_id: "target-1".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "job-setup".to_string(),
            worker_id: "worker-setup".to_string(),
        },
    };

    return_provider_setup_failure_for_connection(
        &mut connection,
        &job,
        "heartbeat writer unavailable",
    )
    .unwrap();

    let queue = connection
            .query_row(
                "select status, locked_by, next_run_at is not null, last_outcome_kind, last_error from finding_candidate_queue where id = 'job-setup'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(
        queue,
        (
            "pending".to_string(),
            None,
            1,
            "worker_setup_failed".to_string(),
            "heartbeat writer unavailable".to_string(),
        )
    );
    let lease = connection
        .query_row(
            "select status, release_reason from llm_provider_leases where id = 'lease-setup'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(
        lease,
        ("released".to_string(), "worker_setup_failed".to_string())
    );
    let retried_events: i64 = connection
            .query_row(
                "select count(*) from distillation_queue_events where queue_name = 'findingCandidate' and queue_job_id = 'job-setup' and event_type = 'retried'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(retried_events, 1);
}

#[test]
fn provider_setup_failure_rolls_back_when_lease_fence_is_lost() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_provider_claim_queue_table(&connection, "finding_candidate_queue");
    create_provider_lease_table(&connection);
    create_queue_events_table(&connection);
    connection
        .execute_batch(
            r#"
                insert into finding_candidate_queue (
                  id, status, priority, attempt_count, created_at, updated_at,
                  locked_by, locked_at, heartbeat_at
                ) values (
                  'job-fenced', 'running', 10, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  'worker-old', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id,
                  status, expires_at
                ) values (
                  'lease-fenced', 'pool-1', 'target-1', 'findingCandidate',
                  'job-fenced', 'worker-new', 'active',
                  datetime(CURRENT_TIMESTAMP, '+2 minutes')
                );
                "#,
        )
        .unwrap();
    let job = super::super::types::ClaimedProviderLeaseJob {
        queue_name: "findingCandidate".to_string(),
        id: "job-fenced".to_string(),
        provider_lease: super::super::types::ProviderLeaseAssignment {
            id: "lease-fenced".to_string(),
            pool_id: "pool-1".to_string(),
            target_id: "target-1".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "job-fenced".to_string(),
            worker_id: "worker-old".to_string(),
        },
    };

    let error = return_provider_setup_failure_for_connection(
        &mut connection,
        &job,
        "heartbeat writer unavailable",
    )
    .unwrap_err();

    assert!(error.to_string().contains("ownership changed"));
    let queue_status: String = connection
        .query_row(
            "select status from finding_candidate_queue where id = 'job-fenced'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let lease_status: String = connection
        .query_row(
            "select status from llm_provider_leases where id = 'lease-fenced'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queue_status, "running");
    assert_eq!(lease_status, "active");
}

#[test]
fn rust_finalize_local_lane_preempts_covering_and_finding_provider_backlog() {
    let app_dir = temp_app_dir("finalize_local_lane");
    let sqlite_path = app_dir.join("queue.sqlite");
    let (embedding_url, embedding_server) = serve_embedding_response();
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open(&sqlite_path).unwrap();
    crate::domains::sqlite_writer::schema::configure_writer_connection(&connection).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut connection, 3).unwrap();
    let settings = json!({
        "settings": {
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": "local-cover"}],
                "maxConcurrent": 1,
                "staleLeaseSeconds": 120,
                "lowPriorityAgingSeconds": 1800
            }],
            "providers": {"local-llm":{"models":[{
                "id": "local-cover",
                "apiBaseUrl": embedding_url,
                "apiPath": "/v1/chat/completions",
                "model": "qwen"
            }]}},
            "taskRouting": {"coverEvidence": {
                "sourceSupport": {
                    "provider": "local-llm",
                    "providerPoolId": "local-llm-default",
                    "model": "qwen"
                }
            }},
            "embedding": {"provider":"daemon","daemonUrl":embedding_url,"timeoutMs":5000},
            "distillationRuntime": {"lowImportanceRejectThreshold":50}
        }
    });
    connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-finalize', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
    connection.execute_batch(r#"
            insert into vibe_memories (id,session_id,content,memory_type,metadata,created_at)
            values ('memory-finalize','session-1','source','chat','{"rustAgentLogSync":true,"projectRoot":"/work/project"}',CURRENT_TIMESTAMP);
            insert into finding_candidate_queue (
              id,input_kind,source_kind,source_key,source_uri,distillation_version,status,priority,metadata,created_at,updated_at
            ) values
              ('finding-backlog','source_target','vibe_memory','memory-backlog','vibe_memory:memory-backlog','v1','pending',50,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
              ('finding-finalize','source_target','vibe_memory','memory-finalize','vibe_memory:memory-finalize','v1','completed',50,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            insert into found_candidates (
              id,finding_job_id,candidate_index,type,title,content,origin,metadata,created_at,updated_at
            ) values
              ('candidate-finalize','finding-finalize',0,'rule','Finalize local lane','Persist only after embedding succeeds.','{}','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
              ('candidate-covering','finding-finalize',1,'rule','Covering provider lane','This job must remain pending until Finalize is durable.','{"polarity":"negative"}','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            insert into covering_evidence_queue (
              id,found_candidate_id,distillation_version,status,priority,attempt_count,max_attempts,metadata,created_at,updated_at
            ) values ('covering-backlog','candidate-covering','v1','pending',50,0,5,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
            insert into evidence_coverage_results (
              id,found_candidate_id,producer_queue,producer_job_id,distillation_version,status,stage,type,title,body,importance,confidence,applies_to,"references",duplicate_refs,tool_events,created_at,updated_at
            ) values (
              'evidence-finalize','candidate-finalize','coveringEvidence','cover-finalize','v1','knowledge_ready','final','rule','Finalize local lane',
              'Persist only after embedding succeeds.',80,90,
              '{"technologies":["Rust"],"changeTypes":["bug_fix"],"domains":["queue"],"repoPath":"/work/project"}',
              '[]','[]','[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
            );
            insert into finalize_distille_queue (
              id,evidence_result_id,distillation_version,status,priority,attempt_count,max_attempts,metadata,next_run_at,created_at,updated_at
            ) values ('finalize-local','evidence-finalize','v1','paused',50,0,5,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        "#).unwrap();
    drop(connection);
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_RUST_COVERING_MODE", "all"),
    ]);

    let report = run_executor_tick_report(&env).unwrap();
    embedding_server.join().unwrap();

    assert_eq!(report.status, "executed");
    assert_eq!((report.claimed, report.completed), (1, 1));
    let connection = Connection::open(&sqlite_path).unwrap();
    let statuses = connection
            .query_row(
                "select (select status from finalize_distille_queue where id='finalize-local'), (select status from covering_evidence_queue where id='covering-backlog'), (select status from finding_candidate_queue where id='finding-backlog')",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(
        statuses,
        (
            "completed".to_string(),
            "pending".to_string(),
            "pending".to_string(),
        )
    );
    let vectors: i64 = connection
        .query_row(
            "select count(*) from knowledge_items_vec_fallback where embedding_dimension=3",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(vectors, 1);
    let claimed_events: i64 = connection
            .query_row(
                "select count(*) from distillation_queue_events where queue_name='finalizeDistille' and queue_job_id='finalize-local' and event_type='claimed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(claimed_events, 1);
    let active_provider_leases: i64 = connection
        .query_row(
            "select count(*) from llm_provider_leases where status='active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(active_provider_leases, 0);

    std::fs::remove_dir_all(app_dir).unwrap();
}

#[test]
fn rust_executor_negative_covering_tick_claims_executes_and_persists() {
    let app_dir = temp_app_dir("negative_covering_tick");
    let sqlite_path = app_dir.join("queue.sqlite");
    let (api_base_url, server) = serve_covering_response(json!({
        "status": "ready",
        "polarity": "negative",
        "intentTags": ["data_integrity"],
        "appliesTo": {
            "technologies": ["sqlite"],
            "changeTypes": ["implementation"],
            "domains": ["queue"]
        },
        "distilled": {
            "failure": "複数writerがキュー状態を競合更新する",
            "impact": "キュー状態を失う",
            "trigger": "resident以外がSQLiteへ直接書き込む",
            "fix": "resident writer経由へ統一する",
            "verification": "queue smoke testを実行する",
            "decisionSignal": null
        },
        "evidence": ["競合を再現した", "単一writerで解消した"],
        "originRefs": ["vibe_memory:memory-1"]
    }));
    let connection = Connection::open(&sqlite_path).unwrap();
    create_provider_lease_table(&connection);
    create_queue_events_table(&connection);
    connection
            .execute_batch(
                r#"
                create table settings (
                  id text primary key,
                  namespace text not null,
                  key text not null,
                  value text not null
                );
                create table finding_candidate_queue (
                  id text primary key,
                  input_kind text not null,
                  source_kind text not null,
                  source_key text not null,
                  source_uri text not null,
                  status text not null,
                  next_run_at text,
                  created_at text not null,
                  updated_at text not null
                );
                create table found_candidates (
                  id text primary key,
                  finding_job_id text not null,
                  type text not null default 'rule',
                  title text not null,
                  content text not null,
                  origin text not null default '{}',
                  metadata text not null default '{}'
                );
                create table covering_evidence_queue (
                  id text primary key,
                  found_candidate_id text not null,
                  distillation_version text not null,
                  status text not null,
                  priority integer not null,
                  attempt_count integer not null,
                  max_attempts integer not null,
                  input_generation integer not null default 0,
                  protocol_version integer not null default 1,
                  provider_policy text,
                  next_run_at text,
                  completed_at text,
                  locked_by text,
                  locked_at text,
                  heartbeat_at text,
                  last_error text,
                  last_outcome_kind text,
                  created_at text not null,
                  updated_at text not null
                );
                create table vibe_memories (
                  id text primary key,
                  content text not null
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
                  current_revision_id text,
                  created_at text not null,
                  updated_at text not null
                );
                create table covering_evidence_inputs (
                  id text primary key, covering_job_id text not null, input_generation integer not null,
                  input_hash text not null, identity_json text not null, evidence_bundle_json text not null,
                  prompt_version text not null, model_config_hash text not null, created_at text not null default current_timestamp,
                  unique(covering_job_id, input_generation)
                );
                create table covering_evidence_revisions (
                  id text primary key, evidence_result_id text not null, revision_no integer not null,
                  input_id text not null, input_generation integer not null, attempt_id text not null unique,
                  protocol_version integer not null, result_status text not null, result_json text not null,
                  artifact_hash text, created_at text not null default current_timestamp,
                  unique(evidence_result_id, revision_no)
                );
                create table finalize_distille_queue (
                  id text primary key,
                  evidence_result_id text not null,
                  distillation_version text not null,
                  status text not null,
                  priority integer not null,
                  protocol_version integer not null default 1,
                  requested_revision_id text,
                  provider_policy text,
                  metadata text not null,
                  created_at text not null,
                  updated_at text not null
                );
                insert into finding_candidate_queue (
                  id, input_kind, source_kind, source_key, source_uri, status, created_at, updated_at
                ) values (
                  'finding-1', 'source_target', 'vibe_memory', 'memory-1',
                  'vibe_memory:memory-1', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                insert into vibe_memories (id, content) values (
                  'memory-1', '複数writerによる競合をresident writerへの統一で防ぐ。'
                );
                insert into found_candidates (
                  id, finding_job_id, title, content, origin, metadata
                ) values (
                  'candidate-1', 'finding-1', 'SQLite writer ownership regression',
                  '複数writerによる競合をresident writerへの統一で防ぐ。',
                  '{"polarity":"negative"}', '{}'
                );
                insert into covering_evidence_queue (
                  id, found_candidate_id, distillation_version, status, priority,
                  attempt_count, max_attempts, provider_policy, created_at, updated_at
                ) values (
                  'cover-1', 'candidate-1', 'v-test', 'pending', 50,
                  0, 2, 'default', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
                "#,
            )
            .unwrap();
    let settings = json!({
        "settings": {
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": "local-cover"}],
                "maxConcurrent": 1,
                "staleLeaseSeconds": 120,
                "lowPriorityAgingSeconds": 1800
            }],
            "providers": {
                "local-llm": {
                    "models": [{
                        "id": "local-cover",
                        "apiBaseUrl": api_base_url,
                        "apiPath": "/v1/chat/completions",
                        "model": "qwen"
                    }]
                }
            },
            "taskRouting": {
                "coverEvidence": {
                    "sourceSupport": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "externalEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "mcpEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
                }
            }
        }
    });
    connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
    drop(connection);
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CONTEXT_STILL_RUST_COVERING_MODE", "negative"),
        ("CONTEXT_STILL_RUST_LLM_TIMEOUT_SECONDS", "30"),
    ]);

    let report = run_executor_tick_report(&env).unwrap();
    server.join().unwrap();

    assert_eq!(report.status, "executed");
    assert_eq!(report.claimed, 1);
    assert_eq!(report.completed, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let queue_status: String = connection
        .query_row(
            "select status from covering_evidence_queue where id = 'cover-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let evidence_count: i64 = connection
        .query_row(
            "select count(*) from evidence_coverage_results where status = 'knowledge_ready'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let finalize_count: i64 = connection
        .query_row("select count(*) from finalize_distille_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queue_status, "completed");
    assert_eq!(evidence_count, 1);
    assert_eq!(finalize_count, 1);

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_executor_includes_supported_queues() {
    let settings = json!({
        "providerPools": [{
            "id": "local-llm-default",
            "enabled": true,
            "targets": [{"provider": "local-llm", "localLlmModelId": "local-a"}],
            "maxConcurrent": 1
        }],
        "providers": {
            "local-llm": {
                "models": [{"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"}]
            }
        },
        "taskRouting": {
            "findCandidate": {
                "source": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                "vibe": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
            },
            "episodeDistiller": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
            "finalizeDistille": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
        }
    });

    let queues = executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());

    assert_eq!(
        queues
            .iter()
            .map(|queue| queue.queue_name.as_str())
            .collect::<Vec<_>>(),
        vec!["findingCandidate", "episodeDistiller"]
    );
    assert!(rust_executor_supports_queue("finalizeDistille"));
    assert!(!rust_provider_executor_supports_queue("finalizeDistille"));
    assert_eq!(
        queues[0].allowed_route_values,
        Some(vec!["vibe_memory".to_string()])
    );
}

#[test]
fn rust_executor_resolves_stable_local_llm_target_ids_when_model_id_is_absent() {
    let model = json!({
        "apiBaseUrl": "http://192.168.0.61:50043/v1",
        "apiPath": "/v1/chat/completions",
        "model": "Qwen 3.6 27B"
    });
    let target_id = local_llm_model_id(&model).unwrap();
    assert_eq!(target_id, "local-llm-3aeb3b705406");
    let settings = json!({
        "providerPools": [{
            "id": "local-llm-default",
            "enabled": true,
            "targets": [{"provider": "local-llm", "localLlmModelId": target_id}],
            "maxConcurrent": 1
        }],
        "providers": {
            "local-llm": {
                "models": [model]
            }
        },
        "taskRouting": {
            "episodeDistiller": {
                "provider": "local-llm",
                "providerPoolId": "local-llm-default",
                "model": "{\"apiBaseUrl\":\"http://192.168.0.61:50043/v1\",\"apiPath\":\"/v1/chat/completions\",\"model\":\"Qwen 3.6 27B\"}"
            }
        }
    });

    let queues = executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());
    assert_eq!(queues.len(), 1);
    assert_eq!(queues[0].queue_name, "episodeDistiller");
    assert_eq!(queues[0].preferred_target_ids, Vec::<String>::new());
    let target = local_llm_target_config(&settings, &target_id).unwrap();
    assert_eq!(target.model, "Qwen 3.6 27B");
}

#[test]
fn rust_executor_keeps_provider_pool_targets_as_membership_source_of_truth() {
    let settings = json!({
        "providerPools": [{
            "id": "local-llm-default",
            "enabled": true,
            "targets": [{"provider": "local-llm", "localLlmModelId": "local-a"}],
            "maxConcurrent": 2,
            "staleLeaseSeconds": 120,
            "lowPriorityAgingSeconds": 1800
        }],
        "providers": {
            "local-llm": {
                "models": [
                    {"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "old"},
                    {"id": "local-b", "apiBaseUrl": "http://localhost:2", "apiPath": "/v1/chat/completions", "model": "route-target"}
                ]
            }
        },
        "taskRouting": {
            "episodeDistiller": {
                "provider": "local-llm",
                "providerPoolId": "local-llm-default",
                "model": "route-target"
            }
        }
    });

    let pools = provider_pools(&settings);
    assert_eq!(pools.len(), 1);
    assert_eq!(pools[0].pool_id, "local-llm-default");
    assert_eq!(pools[0].targets, vec!["local-a".to_string()]);

    let queues = executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());
    assert_eq!(queues.len(), 1);
    assert_eq!(queues[0].queue_name, "episodeDistiller");
    assert_eq!(queues[0].preferred_target_ids, Vec::<String>::new());
}

#[test]
fn rust_executor_treats_provider_pool_routes_as_pool_wide_selection() {
    let settings = json!({
        "providerPools": [{
            "id": "local-llm-default",
            "enabled": true,
            "targets": [
                {"provider": "local-llm", "localLlmModelId": "local-a"},
                {"provider": "local-llm", "localLlmModelId": "local-b"}
            ],
            "maxConcurrent": 2,
            "staleLeaseSeconds": 120,
            "lowPriorityAgingSeconds": 1800
        }],
        "providers": {
            "local-llm": {
                "models": [
                    {"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"},
                    {"id": "local-b", "apiBaseUrl": "http://localhost:2", "apiPath": "/v1/chat/completions", "model": "qwen"}
                ]
            }
        },
        "taskRouting": {
            "findCandidate": {
                "source": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                "vibe": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
            },
            "coverEvidence": {
                "sourceSupport": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                "externalEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                "mcpEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
            }
        }
    });

    let finding = priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new())
        .into_iter()
        .find(|queue| queue.queue_name == "findingCandidate")
        .unwrap();
    assert_eq!(finding.preferred_target_ids, Vec::<String>::new());
    assert!(finding.route_target_preferences.is_empty());

    let covering = priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new())
        .into_iter()
        .find(|queue| queue.queue_name == "coveringEvidence")
        .unwrap();
    assert_eq!(covering.preferred_target_ids, Vec::<String>::new());
}
