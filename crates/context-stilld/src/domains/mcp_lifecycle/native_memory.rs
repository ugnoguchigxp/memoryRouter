use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::native_common::{
    bool_arg, content_json, no_content, open_database, parse_json_or_empty, score_text,
    single_line, string_arg, table_exists, tool_error, truncate_chars, usize_arg,
};
use super::native_tools::NativeToolContext;

pub(crate) fn search_memory(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("search_memory arguments must be an object");
    };
    let query = match string_arg(args, "query") {
        Some(query) if !query.is_empty() => query,
        _ => return tool_error("query is required"),
    };
    let limit = usize_arg(args, "limit").unwrap_or(10).min(100);
    let include_content = bool_arg(args, "includeContent").unwrap_or(false);
    let preview_chars = usize_arg(args, "previewChars").unwrap_or(320);
    let session_id = string_arg(args, "sessionId");
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "vibe_memories") {
        return no_content();
    }

    let mut statement = match connection.prepare(
        r#"
        select id, session_id, content, memory_type, metadata, created_at
        from vibe_memories
        order by created_at desc
        limit 500
        "#,
    ) {
        Ok(statement) => statement,
        Err(error) => return tool_error(&format!("failed to search memories: {error}")),
    };
    let rows = match statement.query_map([], |row| {
        Ok(MemoryRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            content: row.get(2)?,
            memory_type: row.get(3)?,
            created_at: row.get(5)?,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&format!("failed to search memories: {error}")),
    };
    let mut items = Vec::new();
    for row in rows.flatten() {
        if session_id
            .as_ref()
            .is_some_and(|expected| expected != &row.session_id)
        {
            continue;
        }
        let score = score_text(&row.content, &query)
            + memory_diff_match_count(&connection, &row.id, &query).unwrap_or(0) as i64;
        if score <= 0 {
            continue;
        }
        let mut item = json!({
            "id": row.id,
            "sessionId": row.session_id,
            "memoryType": row.memory_type,
            "createdAt": row.created_at,
            "score": score,
            "title": pick_title(&row.content),
            "summary": single_line(&row.content, 180)
        });
        if include_content {
            let preview = truncate_chars(&row.content, preview_chars);
            item["contentPreview"] = json!(preview);
            item["previewChars"] = json!(preview_chars);
            item["contentTruncated"] = json!(row.content.chars().count() > preview_chars);
        }
        items.push((score, row.created_at, item));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    let values = items
        .into_iter()
        .take(limit)
        .map(|(_, _, item)| item)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return no_content();
    }
    content_json(json!({ "items": values }))
}

pub(crate) fn fetch_memory(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("fetch_memory arguments must be an object");
    };
    let id = match string_arg(args, "id") {
        Some(id) if !id.is_empty() => id,
        _ => return tool_error("id is required"),
    };
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    let row = match fetch_memory_row(&connection, &id) {
        Ok(Some(row)) => row,
        Ok(None) => return tool_error("Memory not found."),
        Err(error) => return tool_error(&error),
    };
    let full_text = row.content;
    let max_chars = usize_arg(args, "maxChars");
    let mut start = usize_arg(args, "start").unwrap_or(0).min(full_text.len());
    let mut end = usize_arg(args, "end")
        .unwrap_or(full_text.len())
        .min(full_text.len());
    if let Some(query) = string_arg(args, "query") {
        if let Some(index) = full_text.to_lowercase().find(&query.to_lowercase()) {
            let window = max_chars.unwrap_or(1000);
            let half = window / 2;
            start = index.saturating_sub(half);
            end = (index + query.len() + half).min(full_text.len());
        }
    }
    if end < start {
        end = start;
    }
    let mut text = full_text[start..end].to_string();
    if let Some(max_chars) = max_chars {
        text = truncate_chars(&text, max_chars);
        end = start + text.len();
    }
    let truncated = start > 0 || end < full_text.len();
    if bool_arg(args, "returnMetaOnly").unwrap_or(false) {
        return content_json(json!({
            "id": row.id,
            "sessionId": row.session_id,
            "memoryType": row.memory_type,
            "createdAt": row.created_at,
            "contentLength": full_text.len(),
            "sliceStart": start,
            "sliceEnd": end,
            "truncated": truncated
        }));
    }
    let mut payload = json!({
        "id": row.id,
        "sessionId": row.session_id,
        "content": text,
        "memoryType": row.memory_type,
        "metadata": parse_json_or_empty(&row.metadata),
        "createdAt": row.created_at,
        "sliceStart": start,
        "sliceEnd": end,
        "truncated": truncated,
        "contentLength": full_text.len()
    });
    if bool_arg(args, "includeAgentDiffs").unwrap_or(false) {
        payload["agentDiffs"] = json!(fetch_agent_diffs(&connection, &row.id));
    }
    content_json(payload)
}

#[derive(Debug)]
struct MemoryRow {
    id: String,
    session_id: String,
    content: String,
    memory_type: String,
    created_at: String,
}

#[derive(Debug)]
struct MemoryFetchRow {
    id: String,
    session_id: String,
    content: String,
    memory_type: String,
    metadata: String,
    created_at: String,
}

fn pick_title(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| single_line(line, 100))
        .unwrap_or_else(|| "(untitled memory)".to_string())
}

fn memory_diff_match_count(
    connection: &Connection,
    memory_id: &str,
    query: &str,
) -> Result<usize, rusqlite::Error> {
    let pattern = format!("%{}%", query.to_lowercase());
    let count: i64 = connection.query_row(
        r#"
        select count(*) from agent_diff_entries
        where vibe_memory_id = ?1
          and (
            lower(file_path) like ?2
            or lower(diff_hunk) like ?2
            or lower(coalesce(symbol_name, '')) like ?2
            or lower(coalesce(symbol_kind, '')) like ?2
            or lower(coalesce(signature, '')) like ?2
          )
        "#,
        (memory_id, pattern),
        |row| row.get(0),
    )?;
    Ok(count.max(0) as usize)
}

fn fetch_memory_row(connection: &Connection, id: &str) -> Result<Option<MemoryFetchRow>, String> {
    connection
        .query_row(
            r#"
            select id, session_id, content, memory_type, metadata, created_at
            from vibe_memories
            where id = ?1
            limit 1
            "#,
            [id],
            |row| {
                Ok(MemoryFetchRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    content: row.get(2)?,
                    memory_type: row.get(3)?,
                    metadata: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to fetch memory: {error}"))
}

fn fetch_agent_diffs(connection: &Connection, memory_id: &str) -> Vec<Value> {
    let mut statement = match connection.prepare(
        r#"
        select id, file_path, diff_hunk, change_type, language, symbol_name, symbol_kind,
               signature, start_line, end_line, metadata, created_at, updated_at
        from agent_diff_entries
        where vibe_memory_id = ?1
        order by created_at desc
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([memory_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "filePath": row.get::<_, String>(1)?,
                "diffHunk": row.get::<_, String>(2)?,
                "changeType": row.get::<_, Option<String>>(3)?,
                "language": row.get::<_, Option<String>>(4)?,
                "symbolName": row.get::<_, Option<String>>(5)?,
                "symbolKind": row.get::<_, Option<String>>(6)?,
                "signature": row.get::<_, Option<String>>(7)?,
                "startLine": row.get::<_, Option<i64>>(8)?,
                "endLine": row.get::<_, Option<i64>>(9)?,
                "metadata": parse_json_or_empty(&row.get::<_, String>(10)?),
                "createdAt": row.get::<_, String>(11)?,
                "updatedAt": row.get::<_, String>(12)?
            }))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("context_still_native_memory_{nanos}_{id}.sqlite"))
    }

    fn create_memory_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table vibe_memories (
                  id text primary key,
                  session_id text not null,
                  content text not null,
                  memory_type text not null default 'conversation',
                  embedding_status text not null default 'pending',
                  created_at text not null default CURRENT_TIMESTAMP,
                  metadata text not null default '{}'
                );
                create table agent_diff_entries (
                  id text primary key,
                  vibe_memory_id text not null,
                  file_path text not null,
                  diff_hunk text not null default '',
                  change_type text,
                  language text,
                  symbol_name text,
                  symbol_kind text,
                  signature text,
                  start_line integer,
                  end_line integer,
                  metadata text not null default '{}',
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

    fn insert_memory(connection: &Connection, id: &str, session_id: &str, content: &str) {
        connection
            .execute(
                "insert into vibe_memories (id, session_id, content) values (?1, ?2, ?3)",
                (id, session_id, content),
            )
            .unwrap();
    }

    fn insert_memory_with_meta(
        connection: &Connection,
        id: &str,
        session_id: &str,
        content: &str,
        metadata: &str,
        created_at: &str,
    ) {
        connection
            .execute(
                "insert into vibe_memories (id, session_id, content, metadata, created_at) values (?1, ?2, ?3, ?4, ?5)",
                (id, session_id, content, metadata, created_at),
            )
            .unwrap();
    }

    fn insert_diff(
        connection: &Connection,
        id: &str,
        memory_id: &str,
        file_path: &str,
        diff_hunk: &str,
        symbol_name: Option<&str>,
    ) {
        connection
            .execute(
                "insert into agent_diff_entries (id, vibe_memory_id, file_path, diff_hunk, symbol_name) values (?1, ?2, ?3, ?4, ?5)",
                (id, memory_id, file_path, diff_hunk, symbol_name),
            )
            .unwrap();
    }

    /// is_error かどうかを判定するヘルパー
    fn is_error(result: &serde_json::Value) -> bool {
        result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// content テキストを取得するヘルパー
    fn extract_text(result: &serde_json::Value) -> String {
        result["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    /// content テキストを JSON としてパースするヘルパー
    fn extract_json(result: &serde_json::Value) -> serde_json::Value {
        let text = extract_text(result);
        serde_json::from_str(&text).unwrap_or(json!({}))
    }

    // ─── search_memory tests ───

    #[test]
    fn search_memory_requires_query() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(&json!({"arguments": {}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("query is required"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_no_table_returns_no_content() {
        let db_path = temp_db_path();
        // テーブルを作成せずにDBだけ作る
        let _connection = Connection::open(&db_path).unwrap();
        drop(_connection);

        let context = make_context(&db_path);
        let result = search_memory(&json!({"arguments": {"query": "test"}}), &context);
        assert!(!is_error(&result));
        assert!(extract_text(&result).contains("no content"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_matches_query() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory(&connection, "m1", "s1", "Rust error handling patterns");
        insert_memory(&connection, "m2", "s1", "Python data analysis pipeline");
        insert_memory(&connection, "m3", "s1", "Rust async runtime internals");
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(&json!({"arguments": {"query": "Rust"}}), &context);
        assert!(!is_error(&result));
        let data = extract_json(&result);
        let items = data["items"].as_array().unwrap();
        // "Rust" を含むメモリのみ返される
        assert!(items.len() >= 2);
        for item in items {
            let id = item["id"].as_str().unwrap();
            assert!(id == "m1" || id == "m3", "unexpected id: {id}");
        }

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_respects_limit() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        for i in 0..5 {
            insert_memory(
                &connection,
                &format!("m{i}"),
                "s1",
                &format!("Rust topic number {i} with some Rust details"),
            );
        }
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(
            &json!({"arguments": {"query": "Rust", "limit": 2}}),
            &context,
        );
        let data = extract_json(&result);
        let items = data["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_include_content_adds_preview() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory(
            &connection,
            "m1",
            "s1",
            "Rust performance tuning guide for production systems",
        );
        drop(connection);

        let context = make_context(&db_path);
        // includeContent=false (デフォルト) - contentPreview は含まれない
        let result_no = search_memory(&json!({"arguments": {"query": "Rust"}}), &context);
        let data_no = extract_json(&result_no);
        let item_no = &data_no["items"][0];
        assert!(item_no.get("contentPreview").is_none());

        // includeContent=true - contentPreview が含まれる
        let result_yes = search_memory(
            &json!({"arguments": {"query": "Rust", "includeContent": true}}),
            &context,
        );
        let data_yes = extract_json(&result_yes);
        let item_yes = &data_yes["items"][0];
        assert!(item_yes.get("contentPreview").is_some());
        assert!(item_yes["contentPreview"]
            .as_str()
            .unwrap()
            .contains("Rust"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_preview_chars_respected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        let long_content = format!("Rust {}", "x".repeat(500));
        insert_memory(&connection, "m1", "s1", &long_content);
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(
            &json!({"arguments": {"query": "Rust", "includeContent": true, "previewChars": 20}}),
            &context,
        );
        let data = extract_json(&result);
        let item = &data["items"][0];
        let preview = item["contentPreview"].as_str().unwrap();
        // previewChars=20 なので最大20文字（+ "..." の truncation）
        assert!(
            preview.chars().count() <= 20,
            "preview too long: {}",
            preview.chars().count()
        );
        assert_eq!(item["previewChars"].as_u64().unwrap(), 20);
        assert!(item["contentTruncated"].as_bool().unwrap());

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_filters_by_session_id() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory(&connection, "m1", "session-a", "Rust memory in session A");
        insert_memory(&connection, "m2", "session-b", "Rust memory in session B");
        insert_memory(
            &connection,
            "m3",
            "session-a",
            "Another Rust item session A",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(
            &json!({"arguments": {"query": "Rust", "sessionId": "session-a"}}),
            &context,
        );
        let data = extract_json(&result);
        let items = data["items"].as_array().unwrap();
        // session-a のみが返される
        for item in items {
            assert_eq!(item["sessionId"].as_str().unwrap(), "session-a");
        }
        assert_eq!(items.len(), 2);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_memory_diff_match_boosts_score() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        // 同じ content を持つ2つのメモリ
        insert_memory(&connection, "m-no-diff", "s1", "implement parser module");
        insert_memory(&connection, "m-with-diff", "s1", "implement parser module");
        // m-with-diff のみにマッチする diff を追加
        insert_diff(
            &connection,
            "d1",
            "m-with-diff",
            "src/parser.rs",
            "+fn parse_token() {}",
            Some("parser"),
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_memory(&json!({"arguments": {"query": "parser"}}), &context);
        let data = extract_json(&result);
        let items = data["items"].as_array().unwrap();
        assert!(items.len() >= 2);
        // diff がある方がスコアが高くなり先頭に来る
        assert_eq!(items[0]["id"].as_str().unwrap(), "m-with-diff");
        let score_with = items[0]["score"].as_i64().unwrap();
        let score_without = items[1]["score"].as_i64().unwrap();
        assert!(
            score_with > score_without,
            "diff match should boost score: {score_with} > {score_without}"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    // ─── fetch_memory tests ───

    #[test]
    fn fetch_memory_happy_path() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory_with_meta(
            &connection,
            "mem-1",
            "sess-1",
            "Full memory content for testing",
            r#"{"key": "value"}"#,
            "2025-01-01T00:00:00Z",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(&json!({"arguments": {"id": "mem-1"}}), &context);
        assert!(!is_error(&result));
        let data = extract_json(&result);
        assert_eq!(data["id"].as_str().unwrap(), "mem-1");
        assert_eq!(data["sessionId"].as_str().unwrap(), "sess-1");
        assert_eq!(
            data["content"].as_str().unwrap(),
            "Full memory content for testing"
        );
        assert_eq!(data["memoryType"].as_str().unwrap(), "conversation");
        assert_eq!(data["metadata"]["key"].as_str().unwrap(), "value");
        assert!(!data["truncated"].as_bool().unwrap());

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_not_found() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(&json!({"arguments": {"id": "nonexistent"}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("not found"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_return_meta_only() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory(&connection, "mem-meta", "s1", "Secret content here");
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(
            &json!({"arguments": {"id": "mem-meta", "returnMetaOnly": true}}),
            &context,
        );
        assert!(!is_error(&result));
        let data = extract_json(&result);
        assert_eq!(data["id"].as_str().unwrap(), "mem-meta");
        assert_eq!(data["sessionId"].as_str().unwrap(), "s1");
        // returnMetaOnly=true なので content フィールドは含まれない
        assert!(data.get("content").is_none());
        // contentLength は含まれる
        assert!(data["contentLength"].as_u64().unwrap() > 0);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_include_agent_diffs() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        insert_memory(&connection, "mem-diff", "s1", "Memory with diffs attached");
        insert_diff(
            &connection,
            "diff-1",
            "mem-diff",
            "src/main.rs",
            "+fn main() {}",
            Some("main"),
        );
        insert_diff(
            &connection,
            "diff-2",
            "mem-diff",
            "src/lib.rs",
            "+pub mod utils;",
            None,
        );
        drop(connection);

        let context = make_context(&db_path);
        // includeAgentDiffs=false (デフォルト) → agentDiffs なし
        let result_no = fetch_memory(&json!({"arguments": {"id": "mem-diff"}}), &context);
        let data_no = extract_json(&result_no);
        assert!(data_no.get("agentDiffs").is_none());

        // includeAgentDiffs=true → agentDiffs あり
        let result_yes = fetch_memory(
            &json!({"arguments": {"id": "mem-diff", "includeAgentDiffs": true}}),
            &context,
        );
        let data_yes = extract_json(&result_yes);
        let diffs = data_yes["agentDiffs"].as_array().unwrap();
        assert_eq!(diffs.len(), 2);
        // diff の内容を検証
        let paths: Vec<&str> = diffs
            .iter()
            .map(|d| d["filePath"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"src/lib.rs"));

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_max_chars_truncation() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        let long_content = "A".repeat(500);
        insert_memory(&connection, "mem-long", "s1", &long_content);
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(
            &json!({"arguments": {"id": "mem-long", "maxChars": 50}}),
            &context,
        );
        let data = extract_json(&result);
        let content = data["content"].as_str().unwrap();
        assert!(
            content.len() <= 50,
            "content should be truncated to maxChars"
        );
        assert!(data["truncated"].as_bool().unwrap());
        assert_eq!(data["contentLength"].as_u64().unwrap(), 500);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_start_end_range() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        // 26文字: "abcdefghijklmnopqrstuvwxyz"
        insert_memory(&connection, "mem-range", "s1", "abcdefghijklmnopqrstuvwxyz");
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(
            &json!({"arguments": {"id": "mem-range", "start": 5, "end": 10}}),
            &context,
        );
        let data = extract_json(&result);
        let content = data["content"].as_str().unwrap();
        assert_eq!(content, "fghij");
        assert_eq!(data["sliceStart"].as_u64().unwrap(), 5);
        assert_eq!(data["sliceEnd"].as_u64().unwrap(), 10);
        assert!(data["truncated"].as_bool().unwrap());

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_memory_query_window() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_memory_schema(&connection);
        // "needle" がオフセット50付近にあるテキスト
        let prefix = "x".repeat(50);
        let suffix = "y".repeat(50);
        let content = format!("{prefix}NEEDLE{suffix}");
        insert_memory(&connection, "mem-query", "s1", &content);
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_memory(
            &json!({"arguments": {"id": "mem-query", "query": "needle", "maxChars": 30}}),
            &context,
        );
        let data = extract_json(&result);
        let slice = data["content"].as_str().unwrap();
        // query でウィンドウが "needle" を中心に配置される
        assert!(
            slice.to_lowercase().contains("needle"),
            "query window should contain the matched term, got: {slice}"
        );
        assert!(data["truncated"].as_bool().unwrap());

        let _ = std::fs::remove_file(&db_path);
    }
}
