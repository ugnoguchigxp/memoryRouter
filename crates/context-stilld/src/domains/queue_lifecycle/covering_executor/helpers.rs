use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::types::{NegativeCoveringResult, NegativeDistilled};

pub(super) fn build_negative_body(distilled: &NegativeDistilled) -> String {
    [
        Some(format!("避けること: {}", distilled.failure.trim())),
        labeled("影響", distilled.impact.as_deref()),
        labeled("発生条件", distilled.trigger.as_deref()),
        labeled("推奨対応", distilled.fix.as_deref()),
        labeled("確認方法", distilled.verification.as_deref()),
        labeled("判断シグナル", distilled.decision_signal.as_deref()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

pub(super) fn labeled(label: &str, value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("{label}: {value}"))
}

pub(super) fn non_empty(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

pub(super) fn failure_result(status: &str, reason: &str) -> NegativeCoveringResult {
    NegativeCoveringResult {
        status: status.to_string(),
        stage: "final",
        candidate: None,
        references: Vec::new(),
        duplicate_refs: Vec::new(),
        tool_events: vec![json!({
            "name": "negative_coverage",
            "ok": false,
            "error": truncate(reason, 500)
        })],
        reason: Some(truncate(reason, 500)),
    }
}

pub(super) fn retry_backoff_seconds(attempt_count: i64) -> i64 {
    let exponent = attempt_count.saturating_sub(1).clamp(0, 4) as u32;
    (30_i64.saturating_mul(2_i64.pow(exponent))).min(300)
}

pub(super) fn priority_for_source_kind(source_kind: &str) -> i64 {
    match source_kind {
        "knowledge_candidate" => 90,
        "web_ingest" => 80,
        "wiki_file" => 70,
        _ => 50,
    }
}

pub(super) fn chat_url(api_base_url: &str, api_path: &str) -> String {
    let base = api_base_url.trim_end_matches('/');
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

pub(super) fn stable_id(namespace: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}:{value}").as_bytes());
    format!("rust-{namespace}-{:x}", digest)
}

pub(super) fn parse_json(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
}

pub(super) fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
