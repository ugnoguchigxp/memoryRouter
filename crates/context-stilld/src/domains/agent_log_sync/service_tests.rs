#![allow(clippy::format_in_format_args)]

use rusqlite::{params, Connection};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

use super::service::{backfill_codex_historical_report, run_sync, CodexHistoricalBackfillOptions};
use crate::shared::config::MapEnv;

fn temp_app_dir() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "context_still_agent_log_sync_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn rust_agent_log_sync_imports_codex_jsonl_into_sqlite() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let long_text = "x".repeat(2100);
    let assistant_line = format!(
        r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{long_text}"}}]}}}}"#
    );
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"session-1","cwd":"/tmp/project","timestamp":"2026-06-22T00:00:00.000Z"}}"#,
            r#"{"type":"response_item","timestamp":"2026-06-22T00:00:01.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please look at this code."}]}}"#,
            assistant_line
        ),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("AGENT_LOG_MIN_DISTILLABLE_CHARS", "120"),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let count: i64 = connection
        .query_row("select count(*) from vibe_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let metadata: String = connection
        .query_row("select metadata from vibe_memories limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata.get("projectName").and_then(Value::as_str),
        Some("project")
    );
    assert_eq!(
        metadata.get("projectRoot").and_then(Value::as_str),
        Some("/tmp/project")
    );
    let finding_queue_count: i64 = connection
        .query_row("select count(*) from finding_candidate_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(finding_queue_count, 0);
    let episode_queue_count: i64 = connection
        .query_row("select count(*) from episode_distiller_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(episode_queue_count, 1);

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_agent_log_sync_strips_nightworkers_runtime_contract_before_storage() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let user_prompt = [
        "実装依頼: Runtime Contract を保存前に除去してください。",
        "",
        "[NightWorkers Runtime Contract]",
        "taskId: task-impl-1",
        "runId: run-impl-1",
        "repoRoot: /Users/y.noguchi/Code/example",
        "executionMode: implementation",
        "NightWorkers MCP:",
        "- MCP server name: nightworkers",
        "Minimal implementation behavior:",
        "- Use nightworkers.todo_list as the single Todo control tool.",
    ]
    .join("\n");
    let user_text = serde_json::to_string(&user_prompt).unwrap();
    let assistant_text = serde_json::to_string("sanitize 処理を追加し、検証しました。").unwrap();
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"nightworkers-session","cwd":"/tmp/nightWorkers","timestamp":"2026-06-22T00:00:00.000Z"}}"#,
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:01.000Z","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{user_text}}}]}}}}"#
            ),
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":{assistant_text}}}]}}}}"#
            )
        ),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("AGENT_LOG_MIN_DISTILLABLE_CHARS", "20"),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let content: String = connection
        .query_row("select content from vibe_memories limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(content.contains("実装依頼: Runtime Contract を保存前に除去してください。"));
    assert!(content.contains("sanitize 処理を追加し、検証しました。"));
    assert!(!content.contains("[NightWorkers Runtime Contract]"));
    let fts_content: String = connection
        .query_row("select content from vibe_memories_fts limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!fts_content.contains("[NightWorkers Runtime Contract]"));
    let metadata: String = connection
        .query_row("select metadata from vibe_memories limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata
            .get("nightWorkersRuntimeContractStripped")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        metadata
            .get("nightWorkersRuntimeContractStrippedCount")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert_eq!(
        metadata
            .get("nightWorkersRuntimeContractExecutionMode")
            .and_then(Value::as_str),
        Some("implementation")
    );
    assert_eq!(
        metadata.get("nightWorkersTaskId").and_then(Value::as_str),
        Some("task-impl-1")
    );
    assert_eq!(
        metadata.get("nightWorkersRunId").and_then(Value::as_str),
        Some("run-impl-1")
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_agent_log_sync_uses_codex_turn_context_cwd_for_project_metadata() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let long_text = "x".repeat(2100);
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n",
            r#"{"type":"turn_context","payload":{"cwd":"/tmp/contextStill"}}"#,
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{long_text}"}}]}}}}"#
            )
        ),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("AGENT_LOG_MIN_DISTILLABLE_CHARS", "120"),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let metadata: String = connection
        .query_row("select metadata from vibe_memories limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata.get("projectName").and_then(Value::as_str),
        Some("contextStill")
    );
    assert_eq!(
        metadata.get("projectRoot").and_then(Value::as_str),
        Some("/tmp/contextStill")
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_agent_log_sync_enqueues_eligible_vibe_memory_finding_job() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let user_text = serde_json::to_string("finding queue の復旧手順を確認してください。").unwrap();
    let assistant_text = serde_json::to_string("原因は provider failure と source_missing を混ぜていたことです。sqlite3 で finding_candidate_queue を確認し、cargo test -p context-stilld agent_log_sync が通りました。復旧時は retry と queue event を分けて検証してください。").unwrap();
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"session-eligible","cwd":"/tmp/contextStill","timestamp":"2026-06-22T00:00:00.000Z"}}"#,
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:01.000Z","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{user_text}}}]}}}}"#
            ),
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":{assistant_text}}}]}}}}"#
            )
        ),
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("AGENT_LOG_MIN_DISTILLABLE_CHARS", "120"),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let finding_queue_count: i64 = connection
        .query_row("select count(*) from finding_candidate_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(finding_queue_count, 1);
    let metadata: String = connection
        .query_row(
            "select metadata from finding_candidate_queue limit 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata.get("enqueuedBy").and_then(Value::as_str),
        Some("vibe-finding-controlled-enqueue")
    );
    assert_eq!(
        metadata.get("backfill").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        metadata
            .pointer("/projectIdentity/repoPath")
            .and_then(Value::as_str),
        Some("/tmp/contextStill")
    );
    let memory_created_at: String = connection
        .query_row("select created_at from vibe_memories limit 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        metadata.get("sourceCreatedAt").and_then(Value::as_str),
        Some(memory_created_at.as_str())
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_agent_log_sync_skips_finding_job_when_dedupe_key_already_completed() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("session.jsonl");
    let user_text = serde_json::to_string("finding queue の復旧手順を確認してください。").unwrap();
    let assistant_text = serde_json::to_string("原因は provider failure と source_missing を混ぜていたことです。sqlite3 で finding_candidate_queue を確認し、cargo test -p context-stilld agent_log_sync が通りました。復旧時は retry と queue event を分けて検証してください。").unwrap();
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"session-eligible","cwd":"/tmp/contextStill","timestamp":"2026-06-22T00:00:00.000Z"}}"#,
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:01.000Z","payload":{{"type":"message","role":"user","content":[{{"type":"input_text","text":{user_text}}}]}}}}"#
            ),
            format!(
                r#"{{"type":"response_item","timestamp":"2026-06-22T00:00:02.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":{assistant_text}}}]}}}}"#
            )
        ),
    )
    .unwrap();
    let dedupe_key = "codex_logs:codex_logs:contextStill:session-eligible:0";
    let connection = Connection::open(&sqlite_path).unwrap();
    connection
        .execute_batch(include_str!("schema_agent_log_sync.sql"))
        .unwrap();
    connection
        .execute(
            "
            insert into finding_candidate_queue (
              id, source_kind, source_key, source_uri, distillation_version,
              status, metadata, created_at, updated_at
            ) values (
              'completed-finding', 'vibe_memory', 'old-memory-id',
              'vibe_memory:old-memory-id', 'select-distillation-target-v1',
              'completed', ?, '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z'
            )
            ",
            params![serde_json::json!({"dedupeKey": dedupe_key}).to_string()],
        )
        .unwrap();
    drop(connection);
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("AGENT_LOG_MIN_DISTILLABLE_CHARS", "120"),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let summary = run_sync(&env).unwrap();

    assert_eq!(summary.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let memory_count: i64 = connection
        .query_row("select count(*) from vibe_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(memory_count, 1);
    let finding_queue_count: i64 = connection
        .query_row("select count(*) from finding_candidate_queue", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(finding_queue_count, 1);
    let status: String = connection
        .query_row(
            "select status from finding_candidate_queue where id = 'completed-finding'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");

    std::fs::remove_dir_all(&app_dir).unwrap();
}

#[test]
fn rust_agent_log_sync_backfills_codex_cursor_skipped_historical_file() {
    let _guard = test_lock();
    let app_dir = temp_app_dir();
    let codex_dir = app_dir.join("codex-sessions");
    std::fs::create_dir_all(&codex_dir).unwrap();
    let sqlite_path = app_dir.join("core.sqlite");
    let session_path = codex_dir.join("old-session.jsonl");
    let partial_path = codex_dir.join("partial-session.jsonl");
    let old_text = "x".repeat(2200);
    std::fs::write(
        &session_path,
        format!(
            "{}\n{}\n",
            r#"{"type":"session_meta","payload":{"id":"session-old","cwd":"/tmp/contextStill","timestamp":"2026-01-01T00:00:00.000Z"}}"#,
            format!(
                r#"{{"type":"response_item","timestamp":"2026-01-01T00:00:01.000Z","payload":{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"{old_text}"}}]}}}}"#
            )
        ),
    )
    .unwrap();
    std::fs::write(
        &partial_path,
        r#"{"type":"response_item","timestamp":"2026-01-01T00:00:02.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"partial unread should stay for normal sync"}]}}"#,
    )
    .unwrap();
    let file_size = std::fs::metadata(&session_path).unwrap().len();
    let partial_size = std::fs::metadata(&partial_path).unwrap().len();
    let file_path = session_path.to_string_lossy().to_string();
    let partial_file_path = partial_path.to_string_lossy().to_string();
    let connection = Connection::open(&sqlite_path).unwrap();
    connection
        .execute_batch(include_str!("schema_agent_log_sync.sql"))
        .unwrap();
    let mut cursor = serde_json::Map::new();
    cursor.insert(
        file_path,
        serde_json::json!({"offset": file_size, "mtimeMs": 0_u64}),
    );
    cursor.insert(
        partial_file_path.clone(),
        serde_json::json!({"offset": 1_u64, "mtimeMs": 0_u64}),
    );
    connection
        .execute(
            "
            insert into sync_states (id, last_synced_at, cursor, metadata, created_at, updated_at)
            values ('codex_logs', '2999-01-08T00:00:00.000Z', ?, '{}', '2999-01-08T00:00:00.000Z', '2999-01-08T00:00:00.000Z')
            ",
            [Value::Object(cursor).to_string()],
        )
        .unwrap();
    drop(connection);
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CODEX_SESSION_DIR", codex_dir.to_str().unwrap()),
        (
            "CODEX_ARCHIVED_SESSION_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        (
            "ANTIGRAVITY_LOG_DIR",
            app_dir.join("missing").to_str().unwrap(),
        ),
        ("CLAUDE_LOG_DIRS", ""),
    ]);

    let dry_run = backfill_codex_historical_report(
        &env,
        CodexHistoricalBackfillOptions {
            dry_run: true,
            limit: 10,
            max_bytes: 1024 * 1024,
        },
    )
    .unwrap();

    assert_eq!(dry_run.candidate_files, 1);
    assert_eq!(dry_run.selected_files, 1);
    assert_eq!(dry_run.imported, 0);

    let report = backfill_codex_historical_report(
        &env,
        CodexHistoricalBackfillOptions {
            dry_run: false,
            limit: 10,
            max_bytes: 1024 * 1024,
        },
    )
    .unwrap();

    assert_eq!(report.selected_files, 1);
    assert_eq!(report.imported, 1);
    let connection = Connection::open(&sqlite_path).unwrap();
    let memory_count: i64 = connection
        .query_row("select count(*) from vibe_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(memory_count, 1);
    let processed_cursor: String = connection
        .query_row(
            "select cursor from sync_states where id = 'codex_logs_historical_backfill'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(processed_cursor.contains("old-session.jsonl"));
    let main_cursor: String = connection
        .query_row(
            "select cursor from sync_states where id = 'codex_logs'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let main_cursor: Value = serde_json::from_str(&main_cursor).unwrap();
    assert_eq!(
        main_cursor
            .get(&partial_file_path)
            .and_then(|entry| entry.get("offset"))
            .and_then(Value::as_u64),
        Some(1)
    );
    assert!(
        partial_size > 1,
        "fixture must prove partial cursor was not advanced"
    );

    std::fs::remove_dir_all(&app_dir).unwrap();
}
