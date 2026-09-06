use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::external_fetch::read_bounded_body;
use super::helpers::{chat_url, truncate};
use super::types::{NegativeCoveringExecution, LLM_RESPONSE_BYTE_LIMIT, NEGATIVE_SYSTEM_PROMPT};

pub(super) fn request_negative_evidence(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> Result<String, CliError> {
    request_covering_completion(
        execution,
        NEGATIVE_SYSTEM_PROMPT,
        &json!({
            "candidate": {
                "title": execution.candidate_title,
                "content": execution.candidate_content
            }
        })
        .to_string(),
        2048,
        timeout_seconds,
    )
}

pub(super) fn request_covering_completion(
    execution: &NegativeCoveringExecution,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u64,
    timeout_seconds: u64,
) -> Result<String, CliError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .redirect(Policy::none())
        .build()
        .map_err(|error| CliError::io(format!("failed to build covering LLM client: {error}")))?;
    let url = chat_url(&execution.target.api_base_url, &execution.target.api_path);
    let request_body = json!({
        "model": execution.target.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "max_tokens": max_tokens,
        "temperature": 0
    });
    let mut request = client.post(url).json(&request_body);
    if let Some(api_key) = execution
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("covering LLM request failed: {error}")))?;
    let status = response.status();
    let body = String::from_utf8(
        read_bounded_body(response, LLM_RESPONSE_BYTE_LIMIT, "covering LLM")
            .map_err(CliError::io)?,
    )
    .map_err(|error| CliError::io(format!("covering LLM response was not UTF-8: {error}")))?;
    if !status.is_success() {
        return Err(CliError::io(format!(
            "covering LLM HTTP {}: {}",
            status.as_u16(),
            truncate(&body, 1_000)
        )));
    }
    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| CliError::io(format!("invalid covering LLM response JSON: {error}")))?;
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| CliError::io("covering LLM response omitted message content"))
}
