use std::collections::HashSet;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::RETRY_AFTER;
use serde_json::{json, Value};

use crate::shared::agent_session::{
    is_agent_session_api_path, run_agent_session_chat, AgentSessionRequest,
};
use crate::shared::errors::CliError;

use super::helpers::{
    is_nonworking_local_llm_error, is_provider_terminal_failure, parse_retry_after_seconds,
    truncate,
};
use super::types::{CanonicalEpisode, LocalLlmTargetConfig, Segment, SourceDocument};

pub(super) fn distill_segment_with_retry(
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

pub(super) fn distill_segment(
    segment: &Segment,
    document: &SourceDocument,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<Vec<CanonicalEpisode>, CliError> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let messages = build_messages(segment, document);
    if is_agent_session_api_path(&target.api_path) {
        let content = run_agent_session_chat(
            &client,
            AgentSessionRequest {
                api_base_url: &target.api_base_url,
                api_path: &target.api_path,
                api_key,
                model: &target.model,
                messages: &messages,
                max_tokens: 4_000,
                json_response: true,
            },
        )
        .map_err(CliError::io)?;
        return parse_canonical_array(&content);
    }
    let url = build_local_llm_chat_completions_url(&target.api_base_url, &target.api_path);
    let mut request_body = json!({
        "model": target.model,
        "messages": messages,
        "max_tokens": 4000,
        "temperature": 0
    });
    if target.target_id.starts_with("larm-agent-connection:") {
        request_body["stream"] = Value::Bool(false);
    }
    let mut request = client.post(url).json(&request_body);
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

pub(super) fn build_messages(segment: &Segment, document: &SourceDocument) -> Value {
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

pub(super) fn parse_canonical_array(content: &str) -> Result<Vec<CanonicalEpisode>, CliError> {
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

pub(super) fn build_local_llm_chat_completions_url(api_base_url: &str, api_path: &str) -> String {
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

pub(super) fn parse_json_string_array(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value)
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

pub(super) fn string_array_overlap_count(left: &[String], right: &[String]) -> usize {
    let right_set = right
        .iter()
        .map(|item| item.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    left.iter()
        .filter(|item| right_set.contains(&item.to_ascii_lowercase()))
        .count()
}

pub(super) fn file_paths_for_range(
    document: &SourceDocument,
    start: usize,
    end: usize,
) -> Vec<String> {
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
