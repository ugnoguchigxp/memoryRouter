use std::collections::HashSet;
use std::time::Duration;

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde_json::Value;

use super::super::native_common::single_line;
use super::call_metrics::ProviderCall;
use super::evidence::{render as render_evidence, DEFAULT_OUTPUT_MAX_BYTES};

use super::prompts::{
    build_composer_system_prompt, build_composer_user_prompt, looks_goal_aligned,
    looks_like_json_payload, max_tokens_with_json_headroom, normalize_composer_output,
};
use super::providers::{chat_json, load_runtime_settings, provider_route};
use super::types::{
    ComposePlan, ComposeResult, PackEpisode, PackKnowledge, RuntimeSettings, UsedEpisode,
    UsedKnowledge,
};

pub(super) fn compose_context_response(
    connection: &Connection,
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> ComposeResult {
    compose_context_response_with_settings(
        load_runtime_settings(connection),
        goal,
        knowledge,
        episodes,
    )
}

pub(super) fn compose_context_response_with_settings(
    runtime_settings: Option<RuntimeSettings>,
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> ComposeResult {
    compose_context_response_observed(runtime_settings, goal, knowledge, episodes, &mut Vec::new())
}

pub(super) fn compose_context_response_observed(
    runtime_settings: Option<RuntimeSettings>,
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    calls: &mut Vec<ProviderCall>,
) -> ComposeResult {
    if knowledge.is_empty() && episodes.is_empty() {
        return ComposeResult {
            markdown: "No Content".to_string(),
            agentic_used: false,
            error: None,
            used_knowledge: Vec::new(),
            used_episodes: Vec::new(),
            provider_calls: calls.clone(),
            partial_reasons: Vec::new(),
        };
    }
    let fallback_partial_reasons =
        render_evidence(knowledge, episodes, DEFAULT_OUTPUT_MAX_BYTES).partial_reasons;
    let fallback_used_knowledge =
        fallback_used_knowledge(knowledge, episodes, &ComposePlan::default());
    let fallback_used_episodes = fallback_used_episodes(episodes);
    let fallback = build_fallback_compose(goal, knowledge, episodes, &ComposePlan::default());
    let settings = match runtime_settings {
        Some(settings) if settings.agentic_enabled => settings,
        _ => {
            return ComposeResult {
                markdown: fallback,
                agentic_used: false,
                error: None,
                used_knowledge: fallback_used_knowledge,
                used_episodes: fallback_used_episodes,
                provider_calls: calls.clone(),
                partial_reasons: fallback_partial_reasons,
            }
        }
    };
    let evidence_chars = knowledge
        .iter()
        .map(|item| item.title.chars().count() + item.body.chars().count())
        .sum::<usize>()
        + episodes
            .iter()
            .map(|item| {
                item.title.chars().count()
                    + item.situation.chars().count()
                    + item.lesson.chars().count()
            })
            .sum::<usize>();
    let input_budget_chars = usize::try_from(settings.max_tokens.max(128)).unwrap_or(128) * 4;
    if evidence_chars > input_budget_chars {
        return ComposeResult {
            markdown: fallback,
            agentic_used: false,
            error: Some("CONTEXT_RESPONSE_INPUT_EVIDENCE_BUDGET_EXCEEDED".to_string()),
            used_knowledge: fallback_used_knowledge,
            used_episodes: fallback_used_episodes,
            provider_calls: calls.clone(),
            partial_reasons: fallback_partial_reasons,
        };
    }
    let route = provider_route(&settings);
    if route.is_empty() {
        return ComposeResult {
            markdown: fallback,
            agentic_used: false,
            error: Some("CONTEXT_RESPONSE_COMPOSER_NO_CONFIGURED_PROVIDER".to_string()),
            used_knowledge: fallback_used_knowledge,
            used_episodes: fallback_used_episodes,
            provider_calls: calls.clone(),
            partial_reasons: fallback_partial_reasons,
        };
    }

    let client = match Client::builder()
        .timeout(Duration::from_millis(settings.timeout_ms.max(1000)))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return ComposeResult {
                markdown: fallback,
                agentic_used: false,
                error: Some(format!("CONTEXT_RESPONSE_COMPOSE_FAILED: {error}")),
                used_knowledge: fallback_used_knowledge,
                used_episodes: fallback_used_episodes,
                provider_calls: calls.clone(),
                partial_reasons: fallback_partial_reasons,
            }
        }
    };
    // Headings and evidence sections are deterministic. Keeping planning local removes a
    // second provider call without changing the evidence supplied to the composer.
    let plan = ComposePlan::default();
    let system_prompt = build_composer_system_prompt(settings.max_tokens, &plan);
    let user_prompt = build_composer_user_prompt(goal, knowledge, episodes, &plan);
    let mut errors = Vec::new();
    for provider in route.into_iter().take(2) {
        match chat_json(
            &client,
            &settings,
            &provider,
            &system_prompt,
            &user_prompt,
            max_tokens_with_json_headroom(settings.max_tokens),
            calls,
        ) {
            Ok(raw) => match parse_composer_payload(&raw, knowledge, episodes) {
                Some((markdown, used_knowledge, used_episodes)) => {
                    if markdown == "No Content" {
                        return ComposeResult {
                            markdown,
                            agentic_used: true,
                            error: None,
                            used_knowledge: Vec::new(),
                            used_episodes: Vec::new(),
                            provider_calls: calls.clone(),
                            partial_reasons: Vec::new(),
                        };
                    }
                    if looks_goal_aligned(&markdown, goal) {
                        return ComposeResult {
                            markdown,
                            agentic_used: true,
                            error: None,
                            used_knowledge,
                            used_episodes,
                            provider_calls: calls.clone(),
                            partial_reasons: Vec::new(),
                        };
                    }
                    errors.push(format!("{provider}:COMPOSER_GOAL_ALIGNMENT_FAILED"));
                    continue;
                }
                None => {
                    errors.push(format!("{provider}:COMPOSER_JSON_PARSE_FAILED"));
                    continue;
                }
            },
            Err(error) => {
                errors.push(format!(
                    "{provider}:CONTEXT_RESPONSE_COMPOSE_FAILED: {error}"
                ));
                continue;
            }
        }
    }
    ComposeResult {
        markdown: fallback,
        agentic_used: false,
        error: Some(format!(
            "CONTEXT_RESPONSE_COMPOSE_FAILED: {}",
            errors.join(" | ")
        )),
        used_knowledge: fallback_used_knowledge,
        used_episodes: fallback_used_episodes,
        provider_calls: calls.clone(),
        partial_reasons: fallback_partial_reasons,
    }
}

pub(super) fn build_fallback_compose(
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    plan: &ComposePlan,
) -> String {
    let evidence = render_evidence(knowledge, episodes, DEFAULT_OUTPUT_MAX_BYTES);
    if evidence.markdown == "No Content" {
        return evidence.markdown;
    }
    let mut lines = vec![
        format!("## {}", plan.focus),
        String::new(),
        format!("- {}", single_line(goal, 220)),
    ];
    lines.push(String::new());
    lines.push(
        evidence
            .markdown
            .replacen("## 関連する根拠", &format!("## {}", plan.steps), 1),
    );
    lines.push(String::new());
    lines.push(format!("## {}", plan.verification));
    lines.push(String::new());
    lines.push(
        "- 引用した根拠の適用条件と、現在のコード・DB状態が一致することを確認する。".to_string(),
    );
    lines.join("\n").trim().to_string()
}

pub(super) fn fallback_used_knowledge(
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    plan: &ComposePlan,
) -> Vec<UsedKnowledge> {
    let _ = (episodes, plan);
    knowledge
        .iter()
        .map(|item| UsedKnowledge {
            id: item.id.clone(),
            confidence: 0.35,
            evidence: Some(single_line(&item.body, 240)),
            output_section: Some(
                if item.polarity == "negative" {
                    "適用条件・禁止事項"
                } else {
                    "実装手順"
                }
                .to_string(),
            ),
            reason: Some("fallback_evidence_rendered".to_string()),
        })
        .collect()
}

pub(super) fn fallback_used_episodes(episodes: &[PackEpisode]) -> Vec<UsedEpisode> {
    episodes
        .iter()
        .map(|episode| UsedEpisode {
            id: episode.id.clone(),
            confidence: 0.35,
            evidence: Some(single_line(&episode.lesson, 240)),
            output_section: Some("過去事例".to_string()),
            reason: Some("fallback_evidence_rendered".to_string()),
        })
        .collect()
}

pub(super) fn parse_composer_payload(
    raw: &str,
    selectable_knowledge: &[PackKnowledge],
    selectable_episodes: &[PackEpisode],
) -> Option<(String, Vec<UsedKnowledge>, Vec<UsedEpisode>)> {
    let normalized = normalize_composer_output(raw);
    if normalized == "No Content" {
        return Some((normalized, Vec::new(), Vec::new()));
    }
    match serde_json::from_str::<Value>(&normalized) {
        Ok(parsed) => {
            let markdown = parsed
                .get("markdown")
                .and_then(Value::as_str)
                .map(normalize_composer_output)?;
            let used_knowledge =
                parse_used_knowledge_array(parsed.get("usedKnowledge"), selectable_knowledge);
            let used_episodes =
                parse_used_episode_array(parsed.get("usedEpisodes"), selectable_episodes);
            Some((markdown, used_knowledge, used_episodes))
        }
        Err(_) if !looks_like_json_payload(&normalized) => {
            Some((normalized, Vec::new(), Vec::new()))
        }
        Err(_) => None,
    }
}

pub(super) fn parse_used_knowledge_array(
    value: Option<&Value>,
    selectable_knowledge: &[PackKnowledge],
) -> Vec<UsedKnowledge> {
    let selectable = selectable_knowledge
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let Some(values) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in values {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(id) = record
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| selectable.contains(id))
        else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let confidence = record
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        result.push(UsedKnowledge {
            id: id.to_string(),
            confidence,
            evidence: record
                .get("evidence")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 240)),
            output_section: record
                .get("outputSection")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 120)),
            reason: record
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 160)),
        });
    }
    result
}

pub(super) fn parse_used_episode_array(
    value: Option<&Value>,
    selectable_episodes: &[PackEpisode],
) -> Vec<UsedEpisode> {
    let selectable = selectable_episodes
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let Some(values) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in values {
        let Some(record) = item.as_object() else {
            continue;
        };
        let Some(id) = record
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| selectable.contains(id))
        else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let confidence = record
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.5)
            .clamp(0.0, 1.0);
        result.push(UsedEpisode {
            id: id.to_string(),
            confidence,
            evidence: record
                .get("evidence")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 240)),
            output_section: record
                .get("outputSection")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 120)),
            reason: record
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| single_line(value, 160)),
        });
    }
    result
}
