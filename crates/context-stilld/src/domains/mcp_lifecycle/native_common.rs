use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::native_tools::NativeToolContext;

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(super) struct HandlerEnv {
    project_root: String,
    sqlite_core_path: String,
}

impl HandlerEnv {
    pub(super) fn new(context: &NativeToolContext) -> Self {
        Self {
            project_root: context.project_root.to_string_lossy().into_owned(),
            sqlite_core_path: context.sqlite_core_path.to_string_lossy().into_owned(),
        }
    }
}

impl crate::shared::config::EnvProvider for HandlerEnv {
    fn var(&self, key: &str) -> Option<String> {
        match key {
            "CONTEXT_STILL_PROJECT_ROOT" => Some(self.project_root.clone()),
            "CONTEXT_STILL_SQLITE_CORE_PATH" => Some(self.sqlite_core_path.clone()),
            _ => std::env::var(key).ok(),
        }
    }
}

pub(super) fn open_database(context: &NativeToolContext) -> Result<Connection, String> {
    Connection::open_with_flags(
        &context.sqlite_core_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| format!("failed to open sqlite core db: {error}"))
}

pub(super) fn with_writer<T, F>(
    context: &NativeToolContext,
    operation: &'static str,
    job: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    crate::domains::sqlite_writer::execute_for_path(&context.sqlite_core_path, operation, job)
}

pub(super) fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        == 1
}

pub(super) fn content_json(value: Value) -> Value {
    json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())}]})
}

pub(super) fn no_content() -> Value {
    json!({"content":[{"type":"text","text":"no content"}]})
}

pub(super) fn tool_error(message: &str) -> Value {
    json!({"content":[{"type":"text","text":format!("[TOOL_ERROR] {message}")}],"isError":true})
}

pub(super) fn string_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn int_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

pub(super) fn usize_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

pub(super) fn bool_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

pub(super) fn request_session_id(
    params: &Value,
    args: &serde_json::Map<String, Value>,
) -> Option<String> {
    string_arg(args, "sessionId").or_else(|| {
        params
            .get("_meta")
            .and_then(Value::as_object)
            .and_then(|meta| {
                ["sessionId", "threadId", "conversationId", "codexSessionId"]
                    .iter()
                    .find_map(|key| meta.get(*key).and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
    })
}

pub(super) fn collect_scores(values: [Option<i64>; 5]) -> Option<Vec<i64>> {
    let mut scores = Vec::with_capacity(values.len());
    for value in values {
        let value = value?;
        if !(0..=100).contains(&value) {
            return None;
        }
        scores.push(value);
    }
    Some(scores)
}

pub(super) fn latest_run_id(params: &Value, connection: &Connection) -> Option<String> {
    let meta = params.get("_meta").and_then(Value::as_object)?;
    let session_id = ["sessionId", "threadId", "conversationId", "codexSessionId"]
        .iter()
        .find_map(|key| meta.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    connection
        .query_row(
            "select id from context_compile_runs where session_id = ?1 order by created_at desc, _rowid_ desc limit 1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

pub(super) fn score_text(value: &str, query: &str) -> i64 {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return 0;
    }
    let text = value.to_lowercase();
    let mut score = if text.contains(&query) { 4 } else { 0 };
    for token in query
        .split(|character: char| {
            !character.is_alphanumeric() && character != '_' && character != '-'
        })
        .map(str::trim)
        .filter(|token| token.chars().count() >= 2)
        .take(12)
    {
        if text.contains(token) {
            score += 1;
        }
    }
    score
}

pub(super) fn parse_json_or_empty(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| json!({}))
}

pub(super) fn parse_json_array(value: &str) -> Vec<Value> {
    serde_json::from_str(value).unwrap_or_default()
}

pub(super) fn single_line(value: &str, max_chars: usize) -> String {
    truncate_chars(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        max_chars,
    )
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    format!("{}...", value.chars().take(keep).collect::<String>())
}

pub(super) fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

pub(super) fn pseudo_uuid() -> String {
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
