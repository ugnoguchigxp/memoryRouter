use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::shared::errors::CliError;

pub(super) fn metadata_i64_at(metadata: &Value, pointer: &str) -> i64 {
    metadata
        .pointer(pointer)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        })
        .unwrap_or(0)
}

pub(super) fn metadata_string_array_at(metadata: &Value, pointer: &str) -> Option<Vec<String>> {
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

pub(super) fn json_array_at(metadata: &Value, pointer: &str) -> Vec<Value> {
    metadata
        .pointer(pointer)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn parse_json_or_empty(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| json!({}))
}

pub(super) fn estimate_token_count(text: &str) -> usize {
    text.chars().count().div_ceil(4)
}

pub(super) fn slice_bytes_lossy(value: &str, start: usize, end: usize) -> String {
    String::from_utf8_lossy(&value.as_bytes()[start.min(value.len())..end.min(value.len())])
        .to_string()
}

pub(super) fn nearest_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

pub(super) fn parse_unixish(_value: &str) -> Option<u64> {
    None
}

pub(super) fn to_isoish(value: &str) -> String {
    value.to_string()
}

pub(super) fn push_optional_line(lines: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("{key}: {value}"));
    }
}

pub(super) fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
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

pub(super) fn is_provider_unavailable(error: &str) -> bool {
    is_provider_terminal_failure(error) || is_nonworking_local_llm_error(error)
}

pub(super) fn is_provider_terminal_failure(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("http 503")
        || lower.contains("loading model")
        || lower.contains("unavailable_error")
}

pub(super) fn is_nonworking_local_llm_error(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("local-llm request failed")
        || lower.contains("error sending request for url")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("transport closed")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
}

pub(super) fn parse_retry_after_seconds(value: &str) -> Option<i64> {
    value
        .trim()
        .parse::<i64>()
        .ok()
        .map(|seconds| seconds.clamp(1, 3600))
}

pub(super) fn provider_retry_after_seconds(error: &str) -> i64 {
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

pub(super) fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

pub(super) fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

pub(super) fn pseudo_uuid() -> String {
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
