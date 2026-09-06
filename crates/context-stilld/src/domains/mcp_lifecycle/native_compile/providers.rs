use std::collections::HashSet;
use std::env;
use std::time::Instant;

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::shared::agent_session::{
    is_agent_session_api_path, run_agent_session_chat, AgentSessionRequest,
};

use super::super::native_common::{single_line, table_exists};

use super::call_metrics::{ChatCompletion, ProviderCall};
use super::prompts::{string_value, trim_trailing_slashes, url_encode};
use super::types::{AzureSettings, LocalLlmSettings, OpenAiSettings, RuntimeSettings};

pub(super) fn load_runtime_settings(connection: &Connection) -> Option<RuntimeSettings> {
    if !table_exists(connection, "settings") {
        return None;
    }
    let value = query_setting_value(connection, "runtime", "settings.v1")
        .or_else(|| query_setting_value(connection, "runtime", "runtime_settings"))?;
    let document = serde_json::from_str::<Value>(&value).ok()?;
    let settings = document.get("settings").unwrap_or(&document);
    let task_routing = settings.get("taskRouting")?;
    let agentic = task_routing.get("agenticCompile")?;
    let providers = settings.get("providers").unwrap_or(&Value::Null);

    let provider = string_value(agentic.get("provider")).unwrap_or_default();
    let fallback = agentic
        .get("fallback")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| string_value(Some(value)))
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let local_llm_model = string_value(agentic.get("localLlmModel"))
        .or_else(|| string_value(agentic.get("model")))
        .filter(|value| !value.is_empty());
    Some(RuntimeSettings {
        agentic_enabled: agentic
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        provider,
        fallback,
        timeout_ms: agentic
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(10_000),
        max_tokens: agentic
            .get("maxTokens")
            .and_then(Value::as_i64)
            .unwrap_or(2048),
        azure: load_azure_settings(connection, providers.get("azure-openai")),
        local: load_local_settings(connection, providers.get("local-llm")),
        openai: load_openai_settings(connection, providers.get("openai")),
        local_llm_model,
    })
}

pub(super) fn load_azure_settings(
    connection: &Connection,
    value: Option<&Value>,
) -> Option<AzureSettings> {
    let provider = value?;
    if !provider
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let deployments = provider.get("deployments").and_then(Value::as_array);
    let deployment = deployments
        .and_then(|values| {
            values.iter().find(|entry| {
                string_value(entry.get("apiBaseUrl")).is_some_and(|value| !value.is_empty())
                    && string_value(entry.get("model")).is_some_and(|value| !value.is_empty())
            })
        })
        .unwrap_or(provider);
    let api_key = query_secret_value(connection, "azureOpenAiApiKey")
        .or_else(|| env::var("AZURE_OPENAI_API_KEY").ok())
        .unwrap_or_default();
    let api_base_url = string_value(deployment.get("apiBaseUrl"))?;
    let model = string_value(deployment.get("model"))?;
    Some(AzureSettings {
        api_key,
        api_base_url: trim_trailing_slashes(&api_base_url),
        api_path: string_value(deployment.get("apiPath"))
            .or_else(|| string_value(provider.get("apiPath")))
            .unwrap_or_else(|| "/openai/deployments".to_string()),
        api_version: string_value(deployment.get("apiVersion"))
            .or_else(|| string_value(provider.get("apiVersion")))
            .unwrap_or_else(|| "2025-04-01-preview".to_string()),
        model,
    })
}

pub(super) fn load_local_settings(
    connection: &Connection,
    value: Option<&Value>,
) -> Option<LocalLlmSettings> {
    let provider = value?;
    if !provider
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let models = provider.get("models").and_then(Value::as_array);
    let model_config = models
        .and_then(|values| {
            values.iter().find(|entry| {
                string_value(entry.get("apiBaseUrl")).is_some_and(|value| !value.is_empty())
                    && string_value(entry.get("model")).is_some_and(|value| !value.is_empty())
            })
        })
        .unwrap_or(provider);
    let api_base_url = string_value(model_config.get("apiBaseUrl"))?;
    let model = string_value(model_config.get("model"))?;
    Some(LocalLlmSettings {
        api_key: query_secret_value(connection, "localLlmApiKey")
            .or_else(|| env::var("LOCAL_LLM_API_KEY").ok())
            .unwrap_or_default(),
        api_base_url: trim_trailing_slashes(&api_base_url),
        api_path: string_value(model_config.get("apiPath"))
            .or_else(|| string_value(provider.get("apiPath")))
            .unwrap_or_else(|| "/v1/chat/completions".to_string()),
        model,
    })
}

pub(super) fn load_openai_settings(
    connection: &Connection,
    value: Option<&Value>,
) -> Option<OpenAiSettings> {
    let provider = value?;
    if !provider
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let api_base_url = string_value(provider.get("apiBaseUrl"))?;
    let model = string_value(provider.get("model"))?;
    Some(OpenAiSettings {
        api_key: query_secret_value(connection, "openaiApiKey")
            .or_else(|| env::var("OPENAI_API_KEY").ok())
            .unwrap_or_default(),
        api_base_url: trim_trailing_slashes(&api_base_url),
        model,
    })
}

pub(super) fn query_setting_value(
    connection: &Connection,
    namespace: &str,
    key: &str,
) -> Option<String> {
    connection
        .query_row(
            "select value from settings where namespace = ?1 and key = ?2 limit 1",
            (namespace, key),
            |row| row.get::<_, String>(0),
        )
        .ok()
}

pub(super) fn query_secret_value(connection: &Connection, key: &str) -> Option<String> {
    let value = query_setting_value(connection, "runtime.secret", key)?;
    let parsed = serde_json::from_str::<Value>(&value).ok()?;
    string_value(parsed.get("value")).filter(|value| !value.is_empty())
}

pub(super) fn provider_route(settings: &RuntimeSettings) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut route = Vec::new();
    for provider in std::iter::once(&settings.provider).chain(settings.fallback.iter()) {
        let normalized = provider.trim();
        if normalized.is_empty() || normalized == "auto" || !seen.insert(normalized.to_string()) {
            continue;
        }
        let configured = match normalized {
            "azure-openai" => settings.azure.as_ref().is_some_and(|item| {
                !item.api_key.trim().is_empty()
                    && !item.api_base_url.trim().is_empty()
                    && !item.model.trim().is_empty()
            }),
            "local-llm" => settings.local.as_ref().is_some_and(|item| {
                !item.api_base_url.trim().is_empty() && !item.model.trim().is_empty()
            }),
            "openai" => settings.openai.as_ref().is_some_and(|item| {
                !item.api_key.trim().is_empty()
                    && !item.api_base_url.trim().is_empty()
                    && !item.model.trim().is_empty()
            }),
            _ => false,
        };
        if configured {
            route.push(normalized.to_string());
        }
    }
    route
}

pub(super) fn chat_json(
    client: &Client,
    settings: &RuntimeSettings,
    provider: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
    calls: &mut Vec<ProviderCall>,
) -> Result<String, String> {
    let started = Instant::now();
    let result = match provider {
        "azure-openai" => chat_azure(
            client,
            settings.azure.as_ref(),
            system_prompt,
            user_prompt,
            max_tokens,
        ),
        "local-llm" => chat_local(client, settings, system_prompt, user_prompt, max_tokens),
        "openai" => chat_openai(
            client,
            settings.openai.as_ref(),
            system_prompt,
            user_prompt,
            max_tokens,
        ),
        other => Err(format!(
            "{other} is not supported by Rust context_compile composer"
        )),
    };
    calls.push(ProviderCall {
        provider: provider.to_string(),
        succeeded: result.is_ok(),
        latency_ms: started.elapsed().as_secs_f64() * 1000.0,
        input_tokens: result.as_ref().ok().and_then(|value| value.input_tokens),
        output_tokens: result.as_ref().ok().and_then(|value| value.output_tokens),
        reported_model: result
            .as_ref()
            .ok()
            .and_then(|value| value.reported_model.clone()),
    });
    result.map(|completion| completion.content)
}

pub(super) fn chat_azure(
    client: &Client,
    settings: Option<&AzureSettings>,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<ChatCompletion, String> {
    let settings = settings.ok_or_else(|| "azure-openai is not configured".to_string())?;
    let api_path = settings.api_path.trim_end_matches('/');
    let url = format!(
        "{}/{}/{}/chat/completions?api-version={}",
        settings.api_base_url,
        api_path.trim_start_matches('/'),
        url_encode(&settings.model),
        url_encode(&settings.api_version)
    );
    let response = client
        .post(url)
        .header("api-key", settings.api_key.trim())
        .json(&json!({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0,
            "max_completion_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        }))
        .send()
        .map_err(|error| error.to_string())?;
    parse_chat_response(response, "Azure OpenAI")
}

pub(super) fn chat_local(
    client: &Client,
    settings: &RuntimeSettings,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<ChatCompletion, String> {
    let local = settings
        .local
        .as_ref()
        .ok_or_else(|| "local-llm is not configured".to_string())?;
    let url = format!(
        "{}/{}",
        local.api_base_url,
        local.api_path.trim_start_matches('/')
    );
    let model = settings
        .local_llm_model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&local.model);
    let messages = json!([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]);
    if is_agent_session_api_path(&local.api_path) {
        let content = run_agent_session_chat(
            client,
            AgentSessionRequest {
                api_base_url: &local.api_base_url,
                api_path: &local.api_path,
                api_key: Some(&local.api_key),
                model,
                messages: &messages,
                max_tokens,
                json_response: true,
            },
        )?;
        return Ok(ChatCompletion {
            content,
            input_tokens: None,
            output_tokens: None,
            reported_model: Some(model.to_string()),
        });
    }
    let mut request = client.post(url).header("content-type", "application/json");
    if !local.api_key.trim().is_empty() {
        request = request.header("authorization", format!("Bearer {}", local.api_key.trim()));
    }
    let response = request
        .json(&json!({
            "model": model,
            "messages": messages,
            "stream": false,
            "temperature": 0,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        }))
        .send()
        .map_err(|error| error.to_string())?;
    parse_chat_response(response, "local-llm")
}

pub(super) fn chat_openai(
    client: &Client,
    settings: Option<&OpenAiSettings>,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<ChatCompletion, String> {
    let settings = settings.ok_or_else(|| "OpenAI is not configured".to_string())?;
    let response = client
        .post(format!("{}/chat/completions", settings.api_base_url))
        .bearer_auth(settings.api_key.trim())
        .json(&json!({
            "model": settings.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0,
            "max_completion_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        }))
        .send()
        .map_err(|error| error.to_string())?;
    parse_chat_response(response, "OpenAI")
}

pub(super) fn parse_chat_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<ChatCompletion, String> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "{label} HTTP {status}: {}",
            single_line(&body, 500)
        ));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| error.to_string())?;
    let content = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label} returned empty response"))?;
    Ok(ChatCompletion {
        content: content.to_string(),
        input_tokens: payload
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_u64),
        output_tokens: payload
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64),
        reported_model: payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
