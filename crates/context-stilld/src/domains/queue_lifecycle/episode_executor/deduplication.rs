use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::RETRY_AFTER;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::shared::agent_session::{
    is_agent_session_api_path, run_agent_session_chat, AgentSessionRequest,
};
use crate::shared::errors::CliError;

use super::distillation::{
    build_local_llm_chat_completions_url, file_paths_for_range, parse_json_string_array,
    string_array_overlap_count,
};
use super::helpers::{parse_json_or_empty, parse_retry_after_seconds, truncate};
use super::quality::{calibrate_episode, normalize_generation_kind, normalize_outcome_kind};
use super::types::{
    EpisodeWriteIdentity, LocalLlmTargetConfig, NearDuplicateCandidate, NearDuplicateReview,
    PendingEpisode, SourceDocument,
};

pub(super) fn find_near_duplicate_candidates(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
) -> Result<Vec<NearDuplicateCandidate>, CliError> {
    let canonical = calibrate_episode(item.canonical.clone());
    let generation_kind = normalize_generation_kind(&canonical.generation_kind);
    let outcome_kind = normalize_outcome_kind(&canonical.outcome_kind);
    let current_files =
        file_paths_for_range(document, item.source_start_offset, item.source_end_offset);
    let mut statement = connection
        .prepare(
            "
            select id, title, situation, observations, action, outcome, lesson,
                   domains, technologies, change_types, repo_path, repo_key, source_key,
                   outcome_kind, coalesce(metadata, '{}')
            from episode_cards
            where source_kind = 'vibe_memory'
              and status = 'active'
              and classification_status = 'classified'
              and scope = ?3
              and source_key <> ?1
              and json_extract(metadata, '$.episodeDistillation.parentVibeMemoryId') = ?2
              and (?4 is null or project_ref = ?4)
              and (?5 is null or repo_path = ?5)
              and (?6 is null or repo_key = ?6)
            order by created_at desc
            limit 25
            ",
        )
        .map_err(|error| {
            CliError::io(format!("failed to prepare near duplicate query: {error}"))
        })?;
    let rows = statement
        .query_map(
            params![
                item.source_key,
                document.vibe_memory_id,
                identity.scope,
                identity.resolved.project_ref,
                identity.resolved.repo_path,
                identity.resolved.repo_key
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .map_err(|error| {
            CliError::io(format!(
                "failed to query near duplicate candidates: {error}"
            ))
        })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (
            id,
            title,
            situation,
            observations,
            action,
            outcome,
            lesson,
            domains,
            technologies,
            change_types,
            _repo_path,
            _repo_key,
            _source_key,
            candidate_outcome_kind,
            metadata_text,
        ) = row
            .map_err(|error| CliError::io(format!("failed to read near duplicate row: {error}")))?;
        if normalize_outcome_kind(&candidate_outcome_kind) != outcome_kind {
            continue;
        }
        let metadata = parse_json_or_empty(&metadata_text);
        let candidate_generation_kind = metadata
            .pointer("/episodeDistillation/canonical/generationKind")
            .and_then(Value::as_str)
            .map(normalize_generation_kind)
            .or_else(|| {
                metadata
                    .pointer("/episodeDistillation/sourceStartOffset")
                    .and_then(Value::as_u64)
                    .map(|_| "task_episode".to_string())
            })
            .unwrap_or_else(|| "task_episode".to_string());
        if candidate_generation_kind != generation_kind {
            continue;
        }
        let Some(candidate_start) = metadata
            .pointer("/episodeDistillation/sourceStartOffset")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
        else {
            continue;
        };
        let Some(candidate_end) = metadata
            .pointer("/episodeDistillation/sourceEndOffset")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
        else {
            continue;
        };
        let candidate_files = file_paths_for_range(document, candidate_start, candidate_end);
        let same_file = string_array_overlap_count(&current_files, &candidate_files) > 0;
        let facet_overlap =
            string_array_overlap_count(&canonical.domains, &parse_json_string_array(&domains))
                + string_array_overlap_count(
                    &canonical.technologies,
                    &parse_json_string_array(&technologies),
                )
                + string_array_overlap_count(
                    &canonical.change_types,
                    &parse_json_string_array(&change_types),
                );
        if same_file && facet_overlap >= 2 {
            candidates.push(NearDuplicateCandidate {
                id,
                title,
                situation,
                observations,
                action,
                outcome,
                lesson,
            });
        }
        if candidates.len() >= 3 {
            break;
        }
    }
    Ok(candidates)
}

pub(super) fn near_duplicate_review_messages(
    item: &PendingEpisode,
    candidates: &[NearDuplicateCandidate],
) -> Value {
    let canonical = calibrate_episode(item.canonical.clone());
    let system_content = [
        "あなたは ContextStill の EpisodeCard 登録前レビューアです。",
        "新規Episode候補が既存Episodeと実質的に同じ作業・判断・教訓を表す場合は登録しない判断を返してください。",
        "同じファイルや同じ親ログでも、別の判断・失敗・結果・再利用教訓を持つなら publish=true にしてください。",
        "出力は JSON object のみ。Markdown や説明文を付けないでください。",
    ]
    .join("\n");
    let user_content = [
        "次の shape の JSON object を返してください:".to_string(),
        r#"{"publish":true,"duplicateOfEpisodeId":null,"confidence":0,"reason":"..."}"#.to_string(),
        String::new(),
        "New Episode candidate:".to_string(),
        json!({
            "title": canonical.title,
            "context": canonical.context,
            "keyDecisions": canonical.key_decisions,
            "actionTaken": canonical.action_taken,
            "outcome": canonical.outcome,
            "reusableLesson": canonical.reusable_lesson,
            "generationKind": canonical.generation_kind,
            "outcomeKind": canonical.outcome_kind,
            "domains": canonical.domains,
            "technologies": canonical.technologies,
            "changeTypes": canonical.change_types
        })
        .to_string(),
        String::new(),
        "Existing candidate episodes:".to_string(),
        json!(candidates
            .iter()
            .map(|candidate| json!({
                "id": candidate.id,
                "title": candidate.title,
                "situation": candidate.situation,
                "observations": candidate.observations,
                "action": candidate.action,
                "outcome": candidate.outcome,
                "lesson": candidate.lesson
            }))
            .collect::<Vec<_>>())
        .to_string(),
    ]
    .join("\n");
    json!([
        {"role": "system", "content": system_content},
        {"role": "user", "content": user_content}
    ])
}

pub(super) fn parse_near_duplicate_review(content: &str) -> Result<NearDuplicateReview, CliError> {
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
        .find('{')
        .ok_or_else(|| CliError::io("near duplicate review did not contain JSON object"))?;
    let end = candidate
        .rfind('}')
        .ok_or_else(|| CliError::io("near duplicate review did not contain JSON object end"))?;
    serde_json::from_str(&candidate[start..=end])
        .map_err(|error| CliError::io(format!("near duplicate review parse failed: {error}")))
}

pub(super) fn review_near_duplicate_episode(
    item: &PendingEpisode,
    candidates: &[NearDuplicateCandidate],
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<NearDuplicateReview, CliError> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let messages = near_duplicate_review_messages(item, candidates);
    if is_agent_session_api_path(&target.api_path) {
        let content = run_agent_session_chat(
            &client,
            AgentSessionRequest {
                api_base_url: &target.api_base_url,
                api_path: &target.api_path,
                api_key,
                model: &target.model,
                messages: &messages,
                max_tokens: 800,
                json_response: true,
            },
        )
        .map_err(CliError::io)?;
        return parse_near_duplicate_review(&content);
    }
    let url = build_local_llm_chat_completions_url(&target.api_base_url, &target.api_path);
    let mut request = client.post(url).json(&json!({
        "model": target.model,
        "messages": messages,
        "max_tokens": 800,
        "temperature": 0
    }));
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .map_err(|error| CliError::io(format!("near duplicate review request failed: {error}")))?;
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after_seconds);
    let body = response.text().map_err(|error| {
        CliError::io(format!(
            "failed to read near duplicate review response: {error}"
        ))
    })?;
    if !status.is_success() {
        let retry_after_message = retry_after_seconds
            .map(|seconds| format!(" retry_after_seconds={seconds}"))
            .unwrap_or_default();
        return Err(CliError::io(format!(
            "near duplicate review HTTP {}{}: {}",
            status.as_u16(),
            retry_after_message,
            truncate(&body, 1000)
        )));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|error| {
        CliError::io(format!(
            "failed to parse near duplicate review response JSON: {error}"
        ))
    })?;
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::io("near duplicate review response did not include message content")
        })?;
    parse_near_duplicate_review(content)
}

pub(super) fn near_duplicate_review_allows_publish(
    review: &NearDuplicateReview,
    candidates: &[NearDuplicateCandidate],
) -> bool {
    if review.publish {
        return true;
    }
    if review.confidence < 70 {
        return true;
    }
    let Some(duplicate_id) = review
        .duplicate_of_episode_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };
    !candidates
        .iter()
        .any(|candidate| candidate.id == duplicate_id)
}
