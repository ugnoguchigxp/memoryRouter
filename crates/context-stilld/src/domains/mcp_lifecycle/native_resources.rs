use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::domains::doctor;
use crate::shared::process::OsSupervisor;

use super::native_common::{open_database, parse_json_or_empty, table_exists, HandlerEnv};
use super::native_tools::NativeToolContext;

const SCHEME: &str = "context-still://";

pub(crate) fn list_resources() -> Value {
    json!({
        "resources": [
            resource("context-compiler-summary", "summary/context-compiler", "contextStill Context Compiler summary and retrieval modes.", "text/plain"),
            resource("context-pack-runs-list", "packs/list", "Recent context_compile run summaries.", "application/json"),
            resource("context-pack-latest", "packs/latest", "Latest context_compile run with selected items.", "application/json"),
            resource("doctor-health", "health/doctor", "Doctor health report including DB, table, and run-health diagnostics.", "application/json")
        ]
    })
}

pub(crate) fn read_resource(params: &Value, context: &NativeToolContext) -> Value {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let canonical = normalize_uri(uri);
    match canonical.strip_prefix(SCHEME).unwrap_or(&canonical) {
        "summary/context-compiler" => text_content(uri, summary_text()),
        "packs/list" => json_content(uri, recent_runs(context, 20)),
        "packs/latest" => json_content(uri, latest_run_snapshot(context)),
        "health/doctor" => {
            let env = HandlerEnv::new(context);
            json_content(uri, json!(doctor::service::summary(&env, &OsSupervisor)))
        }
        path if path.starts_with("packs/run/") => {
            let run_id = path.trim_start_matches("packs/run/").trim();
            if run_id.is_empty() {
                json_content(uri, json!({"error": "run id is required"}))
            } else {
                json_content(uri, run_snapshot(context, run_id))
            }
        }
        _ => json_content(uri, json!({"error": "resource not found", "uri": uri})),
    }
}

fn resource(name: &str, path: &str, description: &str, mime_type: &str) -> Value {
    json!({
        "name": name,
        "uri": format!("{SCHEME}{path}"),
        "description": description,
        "mimeType": mime_type
    })
}

fn text_content(uri: &str, text: String) -> Value {
    json!({"contents":[{"uri":uri,"mimeType":"text/plain","text":text}]})
}

fn json_content(uri: &str, value: Value) -> Value {
    json!({"contents":[{"uri":uri,"mimeType":"application/json","text":serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())}]})
}

fn summary_text() -> String {
    [
        "# contextStill context compiler",
        "",
        "- tool: context_compile",
        "- retrieval modes: sqlite_text",
        "- instructions are selected from active knowledge by default",
        "- source refs are stored per selected pack item and at pack-level",
        "- runtime: Rust-native MCP endpoint without TypeScript sidecar",
    ]
    .join("\n")
}

fn recent_runs(context: &NativeToolContext, limit: usize) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error, "runs": []}),
    };
    if !table_exists(&connection, "context_compile_runs") {
        return json!({"runs": []});
    }
    let mut statement = match connection.prepare(
        r#"
        select id, goal, intent, session_id, repo_path, retrieval_mode, status,
               degraded_reasons, token_budget, duration_ms, source, created_at
        from context_compile_runs
        order by created_at desc, rowid desc
        limit ?1
        "#,
    ) {
        Ok(statement) => statement,
        Err(error) => return json!({"error": error.to_string(), "runs": []}),
    };
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(20)], run_summary_from_row)
        .map(|rows| rows.flatten().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({"runs": rows})
}

fn latest_run_snapshot(context: &NativeToolContext) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error}),
    };
    if !table_exists(&connection, "context_compile_runs") {
        return json!({"message": "No context_compile run found yet."});
    }
    let run_id = connection
        .query_row(
            "select id from context_compile_runs order by created_at desc, rowid desc limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    match run_id {
        Some(run_id) => snapshot_from_connection(&connection, &run_id),
        None => json!({"message": "No context_compile run found yet."}),
    }
}

fn run_snapshot(context: &NativeToolContext, run_id: &str) -> Value {
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return json!({"error": error, "runId": run_id}),
    };
    snapshot_from_connection(&connection, run_id)
}

fn snapshot_from_connection(connection: &Connection, run_id: &str) -> Value {
    let snapshot = connection
        .query_row(
            "select pack_snapshot from context_compile_runs where id = ?1 limit 1",
            [run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten();
    match snapshot {
        Some(value) => parse_json_or_empty(&value),
        None => json!({"error": "run not found", "runId": run_id}),
    }
}

fn run_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let degraded_reasons: String = row.get(7)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "goal": row.get::<_, String>(1)?,
        "intent": row.get::<_, String>(2)?,
        "sessionId": row.get::<_, Option<String>>(3)?,
        "repoPath": row.get::<_, Option<String>>(4)?,
        "retrievalMode": row.get::<_, String>(5)?,
        "status": row.get::<_, String>(6)?,
        "degradedReasons": serde_json::from_str::<Value>(&degraded_reasons).unwrap_or_else(|_| json!([])),
        "tokenBudget": row.get::<_, i64>(8)?,
        "durationMs": row.get::<_, i64>(9)?,
        "source": row.get::<_, String>(10)?,
        "createdAt": row.get::<_, String>(11)?
    }))
}

fn normalize_uri(uri: &str) -> String {
    uri.strip_prefix("memory-router://")
        .map(|tail| format!("{SCHEME}{tail}"))
        .unwrap_or_else(|| uri.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::domains::mcp_lifecycle::native_tools::NativeToolContext;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "context_still_native_resources_{nanos}_{id}.sqlite"
        ))
    }

    fn create_resources_schema(connection: &Connection) {
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
                "#,
            )
            .unwrap();
    }

    fn make_context(db_path: &Path) -> NativeToolContext {
        NativeToolContext::for_test(std::env::temp_dir(), db_path.to_path_buf())
    }

    #[test]
    fn list_resources_returns_expected_entries() {
        let val = list_resources();
        let resources = val["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 4);
        let names: Vec<&str> = resources
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"context-compiler-summary"));
        assert!(names.contains(&"context-pack-runs-list"));
        assert!(names.contains(&"context-pack-latest"));
        assert!(names.contains(&"doctor-health"));
    }

    #[test]
    fn list_resources_uris_use_context_still_scheme() {
        let val = list_resources();
        let resources = val["resources"].as_array().unwrap();
        for res in resources {
            let uri = res["uri"].as_str().unwrap();
            assert!(uri.starts_with("context-still://"));
        }
    }

    #[test]
    fn read_resource_summary_returns_text_content() {
        let db_path = temp_db_path();
        let context = make_context(&db_path);
        let val = read_resource(
            &json!({"uri": "context-still://summary/context-compiler"}),
            &context,
        );
        let contents = val["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["mimeType"].as_str().unwrap(), "text/plain");
        assert!(contents[0]["text"]
            .as_str()
            .unwrap()
            .contains("# contextStill context compiler"));
    }

    #[test]
    fn read_resource_packs_list_empty_db() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_resources_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/list"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["runs"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn read_resource_packs_list_with_runs() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_resources_schema(&connection);
        connection.execute(
            r#"
            insert into context_compile_runs (
              id, goal, intent, session_id, repo_path, retrieval_mode, status, degraded_reasons, token_budget, duration_ms, source, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
            ("run1", "goal1", "intent1", "sess1", "repo1", "mode1", "status1", "[]", &100, &200, "source1", "2026-06-23T00:00:00Z")
        ).unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/list"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        let runs = decoded["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["id"].as_str().unwrap(), "run1");
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn read_resource_packs_latest_no_runs() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_resources_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/latest"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(
            decoded["message"].as_str().unwrap(),
            "No context_compile run found yet."
        );
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn read_resource_packs_latest_with_snapshot() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_resources_schema(&connection);
        connection
            .execute(
                r#"
            insert into context_compile_runs (
              id, goal, intent, retrieval_mode, status, pack_snapshot, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
                (
                    "run1",
                    "goal1",
                    "intent1",
                    "mode1",
                    "status1",
                    "{\"snapshot_key\":\"snapshot_val\"}",
                    "2026-06-23T00:00:00Z",
                ),
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/latest"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["snapshot_key"].as_str().unwrap(), "snapshot_val");
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn read_resource_packs_run_specific() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_resources_schema(&connection);
        connection
            .execute(
                r#"
            insert into context_compile_runs (
              id, goal, intent, retrieval_mode, status, pack_snapshot, created_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
                (
                    "run1",
                    "goal1",
                    "intent1",
                    "mode1",
                    "status1",
                    "{\"snapshot_key\":\"snapshot_val\"}",
                    "2026-06-23T00:00:00Z",
                ),
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/run/run1"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["snapshot_key"].as_str().unwrap(), "snapshot_val");
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn read_resource_packs_run_empty_id() {
        let db_path = temp_db_path();
        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://packs/run/   "}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["error"].as_str().unwrap(), "run id is required");
    }

    #[test]
    fn read_resource_unknown_uri() {
        let db_path = temp_db_path();
        let context = make_context(&db_path);
        let val = read_resource(&json!({"uri": "context-still://unknown"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["error"].as_str().unwrap(), "resource not found");
    }

    #[test]
    fn normalize_uri_converts_memory_router() {
        let converted = normalize_uri("memory-router://foo/bar");
        assert_eq!(converted, "context-still://foo/bar");
    }

    #[test]
    fn normalize_uri_keeps_context_still() {
        let kept = normalize_uri("context-still://foo/bar");
        assert_eq!(kept, "context-still://foo/bar");
    }

    #[test]
    fn read_resource_no_table_returns_empty() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        drop(connection);
        let context = make_context(&db_path);
        // Table context_compile_runs does not exist
        let val = read_resource(&json!({"uri": "context-still://packs/list"}), &context);
        let contents = val["contents"].as_array().unwrap();
        let text_raw = contents[0]["text"].as_str().unwrap();
        let decoded: Value = serde_json::from_str(text_raw).unwrap();
        assert_eq!(decoded["runs"].as_array().unwrap().len(), 0);

        let latest_val = read_resource(&json!({"uri": "context-still://packs/latest"}), &context);
        let latest_contents = latest_val["contents"].as_array().unwrap();
        let latest_text_raw = latest_contents[0]["text"].as_str().unwrap();
        let latest_decoded: Value = serde_json::from_str(latest_text_raw).unwrap();
        assert_eq!(
            latest_decoded["message"].as_str().unwrap(),
            "No context_compile run found yet."
        );
    }

    #[test]
    fn read_resource_doctor_smoke() {
        let db_path = temp_db_path();
        let context = make_context(&db_path);
        // Just call it to verify it doesn't panic
        let _ = read_resource(&json!({"uri": "context-still://health/doctor"}), &context);
    }
}
