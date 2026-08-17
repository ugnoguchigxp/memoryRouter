use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::native_handlers::*;
use crate::domains::mcp_lifecycle::native_tools::NativeToolContext;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn temp_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("context_still_native_handlers_{nanos}_{id}.sqlite"))
}

fn create_eval_schema(connection: &Connection) {
    connection
        .execute_batch(
            r#"
            create table context_compile_runs (
              id text primary key,
              goal text not null,
              intent text not null,
              session_id text,
              repo_path text,
              retrieval_mode text not null,
              status text not null,
              degraded_reasons text not null default '[]',
              token_budget integer not null default 0,
              duration_ms integer not null default 0,
              source text not null default 'unknown',
              pack_snapshot text,
              created_at text not null default CURRENT_TIMESTAMP
            );
            create table context_compile_evals (
              id text primary key,
              run_id text not null,
              session_id text,
              score integer not null,
              outcome text not null,
              title text,
              body text not null,
              source text not null default 'mcp',
              metadata text not null default '{}',
              relevance integer not null,
              actionability integer not null,
              coverage integer not null,
              clarity integer not null,
              specificity integer not null,
              created_at text not null default CURRENT_TIMESTAMP,
              updated_at text not null default CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();
}

fn make_context(db_path: &Path) -> NativeToolContext {
    NativeToolContext::for_test(std::env::temp_dir(), db_path.to_path_buf())
}

fn is_error(val: &Value) -> bool {
    val.get("isError").and_then(Value::as_bool).unwrap_or(false)
}

fn get_error_message(val: &Value) -> String {
    val.get("content")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn parse_inner(val: &Value) -> Value {
    let text = val["content"][0]["text"].as_str().unwrap();
    serde_json::from_str(text).unwrap()
}

fn insert_dummy_run(connection: &Connection, run_id: &str) {
    connection.execute(
        "insert into context_compile_runs (id, goal, intent, session_id, retrieval_mode, status) values (?1, 'goal', 'intent', 'sess', 'mode', 'status')",
        [run_id]
    ).unwrap();
}

#[test]
fn compile_eval_requires_args() {
    let db_path = temp_db_path();
    let context = make_context(&db_path);
    let res = compile_eval(&json!({}), &context);
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("arguments must be an object"));
}

#[test]
fn compile_eval_requires_evals_table() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    // Do not create tables
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(&json!({"arguments": {"runId": "run1"}}), &context);
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("context_compile_evals table is not available"));
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_requires_run_id() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {"outcome": "useful", "body": "test"}}),
        &context,
    );
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("runId is required"));
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_validates_outcome() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    insert_dummy_run(&connection, "run1");
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {"runId": "run1", "outcome": "invalid", "body": "test"}}),
        &context,
    );
    assert!(is_error(&res));
    assert!(
        get_error_message(&res).contains("outcome must be useful, partial, misleading, or unused")
    );
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_requires_body() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    insert_dummy_run(&connection, "run1");
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {"runId": "run1", "outcome": "useful", "body": ""}}),
        &context,
    );
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("body is required"));
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_validates_scores() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    insert_dummy_run(&connection, "run1");
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {
            "runId": "run1",
            "outcome": "useful",
            "body": "test",
            "relevance": 150,
            "actionability": 50,
            "coverage": 50,
            "clarity": 50,
            "specificity": 50
        }}),
        &context,
    );
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("must be 0-100 integers"));
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_run_not_found() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    // Do not insert run1
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {
            "runId": "run1",
            "outcome": "useful",
            "body": "test",
            "relevance": 50,
            "actionability": 50,
            "coverage": 50,
            "clarity": 50,
            "specificity": 50
        }}),
        &context,
    );
    assert!(is_error(&res));
    assert!(get_error_message(&res).contains("context_compile run not found"));
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_eval_happy_path_explicit_run_id() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_eval_schema(&connection);
    connection.execute(
        "insert into context_compile_runs (id, goal, intent, session_id, retrieval_mode, status) values (?1, ?2, ?3, ?4, ?5, ?6)",
        ("run1", "goal1", "intent1", "sess1", "mode1", "status1")
    ).unwrap();
    drop(connection);

    let context = make_context(&db_path);
    let res = compile_eval(
        &json!({"arguments": {
            "runId": "run1",
            "outcome": "useful",
            "body": "test evaluation body",
            "relevance": 90,
            "actionability": 80,
            "coverage": 70,
            "clarity": 60,
            "specificity": 50
        }}),
        &context,
    );

    assert!(!is_error(&res));
    let inner = parse_inner(&res);
    let data = &inner["evaluation"];
    assert_eq!(data["runId"].as_str().unwrap(), "run1");
    assert_eq!(data["avg"].as_i64().unwrap(), 70); // (90+80+70+60+50)/5 = 70
    assert_eq!(data["outcome"].as_str().unwrap(), "useful");

    let conn = Connection::open(&db_path).unwrap();
    let count: i64 = conn
        .query_row("select count(1) from context_compile_evals", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn doctor_smoke_test() {
    let db_path = temp_db_path();
    let context = make_context(&db_path);
    let _ = doctor(&context);
}
