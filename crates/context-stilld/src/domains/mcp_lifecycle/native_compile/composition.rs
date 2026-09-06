use std::collections::HashSet;
use std::time::Duration;

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde_json::Value;

use super::super::native_common::single_line;
use super::call_metrics::ProviderCall;

use super::prompts::{
    build_composer_system_prompt, build_composer_user_prompt, build_plan_system_prompt,
    build_plan_user_prompt, first_sentence, looks_goal_aligned, looks_like_json_payload,
    max_tokens_with_json_headroom, normalize_composer_output, planner_max_tokens, sanitize_heading,
    section_lines,
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
        };
    }
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
            }
        }
    };
    let route = provider_route(&settings);
    if route.is_empty() {
        return ComposeResult {
            markdown: fallback,
            agentic_used: false,
            error: Some("CONTEXT_RESPONSE_COMPOSER_NO_CONFIGURED_PROVIDER".to_string()),
            used_knowledge: fallback_used_knowledge,
            used_episodes: fallback_used_episodes,
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
            }
        }
    };
    let default_plan = ComposePlan::default();
    let mut errors = Vec::new();
    for provider in route {
        let plan = match chat_json(
            &client,
            &settings,
            &provider,
            &build_plan_system_prompt(),
            &build_plan_user_prompt(goal, knowledge, episodes),
            planner_max_tokens(settings.max_tokens),
            calls,
        ) {
            Ok(raw) => parse_compose_plan(&raw).unwrap_or_else(|| default_plan.clone()),
            Err(error) => {
                errors.push(format!("{provider}:CONTEXT_RESPONSE_PLAN_FAILED: {error}"));
                default_plan.clone()
            }
        };
        let system_prompt = build_composer_system_prompt(settings.max_tokens, &plan);
        let user_prompt = build_composer_user_prompt(goal, knowledge, episodes, &plan);
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
                        };
                    }
                    if looks_goal_aligned(&markdown, goal) {
                        return ComposeResult {
                            markdown,
                            agentic_used: true,
                            error: None,
                            used_knowledge,
                            used_episodes,
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
    }
}

pub(super) fn build_fallback_compose(
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    plan: &ComposePlan,
) -> String {
    let rules = knowledge
        .iter()
        .filter(|item| item.kind != "procedure" && item.polarity != "negative")
        .collect::<Vec<_>>();
    let procedures = knowledge
        .iter()
        .filter(|item| item.kind == "procedure" && item.polarity != "negative")
        .collect::<Vec<_>>();
    let guardrails = knowledge
        .iter()
        .filter(|item| item.polarity == "negative")
        .collect::<Vec<_>>();

    let mut lines = vec![
        format!("## {}", plan.focus),
        String::new(),
        format!("- {}", single_line(goal, 220)),
    ];
    for rule in rules.iter().take(2) {
        lines.push(format!(
            "- {} を考慮して取り組む。",
            single_line(&rule.title, 120)
        ));
    }

    lines.push(String::new());
    lines.push(format!("## {}", plan.steps));
    lines.push(String::new());
    if !procedures.is_empty() {
        for (index, item) in procedures.iter().take(3).enumerate() {
            let workflow = section_lines(&item.body, "Workflow");
            let detail = workflow
                .first()
                .map(|line| format!("（{}）", single_line(line, 140)))
                .unwrap_or_default();
            lines.push(format!(
                "{}. {}{}",
                index + 1,
                single_line(&item.title, 120),
                detail
            ));
        }
    } else {
        for (index, rule) in rules.iter().take(3).enumerate() {
            lines.push(format!(
                "{}. {} を反映する。",
                index + 1,
                single_line(&rule.title, 120)
            ));
        }
    }
    for episode in episodes.iter().take(2) {
        lines.push(format!(
            "- 過去事例として {} を参照し、現在のコードで適用可否を確認する。",
            single_line(&episode.title, 120)
        ));
    }

    lines.push(String::new());
    lines.push(format!("## {}", plan.verification));
    lines.push(String::new());
    let verification = procedures
        .iter()
        .flat_map(|item| section_lines(&item.body, "Verification"))
        .take(3)
        .collect::<Vec<_>>();
    if verification.is_empty() {
        for item in rules.iter().chain(procedures.iter()).take(2) {
            lines.push(format!(
                "- {} の要件が成立していることを確認する。",
                single_line(&item.title, 120)
            ));
        }
        if !episodes.is_empty() {
            lines.push(
                "- EpisodeCard precedent をそのまま根拠にせず、現在のコード・DB状態で適用可否を確認する。"
                    .to_string(),
            );
        }
    } else {
        for item in verification {
            lines.push(format!("- {}", single_line(&item, 180)));
        }
    }

    let avoid = guardrails
        .iter()
        .flat_map(|item| section_lines(&item.body, "Avoid"))
        .chain(
            procedures
                .iter()
                .flat_map(|item| section_lines(&item.body, "Avoid")),
        )
        .take(3)
        .collect::<Vec<_>>();
    if plan.include_avoid_section
        || !guardrails.is_empty()
        || !avoid.is_empty()
        || !episodes.is_empty()
    {
        lines.push(String::new());
        lines.push(format!("## {}", plan.avoid));
        lines.push(String::new());
        for guardrail in guardrails.iter().take(3) {
            lines.push(format!(
                "- {}: {}",
                single_line(&guardrail.title, 100),
                first_sentence(&guardrail.body, 160)
            ));
        }
        for item in avoid {
            lines.push(format!("- {}", single_line(&item, 180)));
        }
        if !episodes.is_empty() {
            lines.push(
                "- EpisodeCard precedent を現在の source truth や Knowledge rule として扱わない。"
                    .to_string(),
            );
        }
    }
    lines.join("\n").trim().to_string()
}

pub(super) fn fallback_used_knowledge(
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    plan: &ComposePlan,
) -> Vec<UsedKnowledge> {
    let rules = knowledge
        .iter()
        .filter(|item| item.kind != "procedure" && item.polarity != "negative")
        .collect::<Vec<_>>();
    let procedures = knowledge
        .iter()
        .filter(|item| item.kind == "procedure" && item.polarity != "negative")
        .collect::<Vec<_>>();
    let guardrails = knowledge
        .iter()
        .filter(|item| item.polarity == "negative")
        .collect::<Vec<_>>();
    let mut used_ids = Vec::<String>::new();
    let mut push = |item: &PackKnowledge| {
        if !used_ids.iter().any(|id| id == &item.id) {
            used_ids.push(item.id.clone());
        }
    };

    for item in rules.iter().take(2) {
        push(item);
    }
    if !procedures.is_empty() {
        for item in procedures.iter().take(3) {
            push(item);
        }
    } else {
        for item in rules.iter().take(3) {
            push(item);
        }
    }
    for item in rules.iter().chain(procedures.iter()).take(2) {
        push(item);
    }
    if plan.include_avoid_section || !guardrails.is_empty() || !episodes.is_empty() {
        for item in guardrails.iter().take(3) {
            push(item);
        }
        for item in procedures.iter().take(2) {
            push(item);
        }
    }

    used_ids
        .into_iter()
        .map(|id| UsedKnowledge {
            id,
            confidence: 0.35,
            evidence: None,
            output_section: None,
            reason: Some("fallback_compose_reference".to_string()),
        })
        .collect()
}

pub(super) fn fallback_used_episodes(episodes: &[PackEpisode]) -> Vec<UsedEpisode> {
    episodes
        .iter()
        .take(2)
        .map(|episode| UsedEpisode {
            id: episode.id.clone(),
            confidence: 0.35,
            evidence: None,
            output_section: None,
            reason: Some("fallback_compose_reference".to_string()),
        })
        .collect()
}

pub(super) fn parse_compose_plan(raw: &str) -> Option<ComposePlan> {
    let normalized = normalize_composer_output(raw);
    let parsed = serde_json::from_str::<Value>(&normalized).ok()?;
    let headings = parsed.get("headings").unwrap_or(&Value::Null);
    let default = ComposePlan::default();
    let response_style = match parsed.get("responseStyle").and_then(Value::as_str) {
        Some("skill") => "skill",
        _ => "narrative",
    };
    let candidate_sufficiency = parsed
        .get("candidateSufficiency")
        .and_then(Value::as_str)
        .unwrap_or("limited");
    let confidence = parsed
        .get("styleConfidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.5);
    let response_style =
        if response_style == "skill" && confidence >= 0.7 && candidate_sufficiency == "enough" {
            "skill"
        } else {
            "narrative"
        };
    Some(ComposePlan {
        focus: sanitize_heading(headings.get("focus"), &default.focus),
        steps: sanitize_heading(headings.get("steps"), &default.steps),
        verification: sanitize_heading(headings.get("verification"), &default.verification),
        avoid: sanitize_heading(headings.get("avoid"), &default.avoid),
        include_avoid_section: parsed
            .get("includeAvoidSection")
            .and_then(Value::as_bool)
            .unwrap_or(default.include_avoid_section),
        response_style: response_style.to_string(),
    })
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
