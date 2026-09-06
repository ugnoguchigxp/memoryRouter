use std::collections::HashSet;

use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::super::native_common::{now_iso, pseudo_uuid, single_line, table_exists};

use super::json_array_string;
use super::telemetry::goal_hash;
use super::types::{PackEpisode, PackKnowledge, UsedEpisode, UsedKnowledge};

pub(super) struct CompileRunInsert<'a> {
    pub(super) connection: &'a Connection,
    pub(super) run_id: &'a str,
    pub(super) goal: &'a str,
    pub(super) session_id: Option<&'a str>,
    pub(super) project_ref: Option<&'a str>,
    pub(super) repo_path: Option<&'a str>,
    pub(super) repo_key: Option<&'a str>,
    pub(super) match_basis: &'a str,
    pub(super) identity_contract_version: u8,
    pub(super) scope_mode: &'a str,
    pub(super) identity_fingerprint: Option<&'a str>,
    pub(super) identity_trust: &'a str,
    pub(super) binding_status: &'a str,
    pub(super) input: &'a Value,
    pub(super) status: &'a str,
    pub(super) pack: &'a Value,
    pub(super) duration_ms: u128,
}

pub(super) fn insert_compile_run(params: CompileRunInsert<'_>) -> Result<(), String> {
    let now = now_iso();
    params
        .connection
        .execute(
            r#"
            insert into context_compile_runs (
              id, goal, intent, session_id, project_ref, repo_key, repo_path, match_basis,
              identity_contract_version, scope_mode, input, retrieval_mode, status,
              degraded_reasons, token_budget, duration_ms, source, pack_snapshot, created_at
            ) values (?1, ?2, 'mcp_context_compile', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'sqlite_text', ?11, '[]', 0, ?12, 'mcp', ?13, ?14)
            "#,
            (
                params.run_id,
                params.goal,
                params.session_id,
                params.project_ref,
                params.repo_key,
                params.repo_path,
                params.match_basis,
                i64::from(params.identity_contract_version),
                params.scope_mode,
                params.input.to_string(),
                params.status,
                i64::try_from(params.duration_ms).unwrap_or(i64::MAX),
                params.pack.to_string(),
                now,
            ),
        )
        .map_err(|error| format!("failed to insert context_compile run: {error}"))?;
    params
        .connection
        .execute(
            r#"
            insert or replace into context_compile_task_traces (
              run_id, retrieval_mode, project_ref, repo_path, repo_key, match_basis,
              identity_contract_version, scope_mode, identity_fingerprint, identity_trust,
              binding_status, technologies, change_types, domains, goal_hash
            ) values (?1, 'sqlite_text', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            (
                params.run_id,
                params.project_ref,
                params.repo_path,
                params.repo_key,
                params.match_basis,
                i64::from(params.identity_contract_version),
                params.scope_mode,
                params.identity_fingerprint,
                params.identity_trust,
                params.binding_status,
                json_array_string(params.input, "technologies"),
                json_array_string(params.input, "changeTypes"),
                json_array_string(params.input, "domains"),
                goal_hash(params.goal),
            ),
        )
        .map_err(|error| format!("failed to insert context_compile task trace: {error}"))?;
    Ok(())
}

pub(super) fn insert_compile_items(
    connection: &Connection,
    run_id: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> Result<(), String> {
    for item in knowledge {
        connection
            .execute(
                r#"
                insert into context_pack_items (
                  run_id, item_kind, item_id, section, score, ranking_reason, source_refs,
                  scope_snapshot
                ) values (?1, ?2, ?3, ?4, ?5, 'rust_native_text_score', ?6, ?7)
                "#,
                (
                    run_id,
                    if item.kind == "procedure" {
                        "procedure"
                    } else {
                        "rule"
                    },
                    &item.id,
                    if item.kind == "procedure" {
                        "procedures"
                    } else {
                        "rules"
                    },
                    item.score as f64,
                    json!(item.source_refs).to_string(),
                    item.scope_snapshot.to_string(),
                ),
            )
            .map_err(|error| format!("failed to insert context pack item: {error}"))?;
    }
    for item in episodes {
        connection
            .execute(
                r#"
                insert into context_pack_items (
                  run_id, item_kind, item_id, section, score, ranking_reason, source_refs,
                  scope_snapshot
                ) values (?1, 'episode', ?2, 'episodes', ?3, 'rust_native_text_score', '[]', ?4)
                "#,
                (
                    run_id,
                    &item.id,
                    item.score as f64,
                    item.scope_snapshot.to_string(),
                ),
            )
            .map_err(|error| format!("failed to insert episode pack item: {error}"))?;
    }
    Ok(())
}

pub(super) fn insert_candidate_traces(
    connection: &Connection,
    run_id: &str,
    knowledge: &[PackKnowledge],
) -> Result<(), String> {
    if knowledge.is_empty() || !table_exists(connection, "context_compile_candidate_traces") {
        return Ok(());
    }
    let now = now_iso();
    for (index, item) in knowledge.iter().enumerate() {
        let rank = i64::try_from(index + 1).unwrap_or(i64::MAX);
        let item_kind = if item.kind == "procedure" {
            "procedure"
        } else {
            "rule"
        };
        connection
            .execute(
                r#"
                insert into context_compile_candidate_traces (
                  run_id, item_kind, item_id, text_rank, text_score, merged_rank, merged_score,
                  final_rank, final_score, selected, suppressed, suppression_reason,
                  agentic_decision, ranking_reason, community_key, evidence, created_at
                ) values (?1, ?2, ?3, ?4, ?5, ?4, ?5, ?4, ?5, 1, 0, null,
                  'accepted', 'rust_native_text_score', null, ?6, ?7)
                "#,
                (
                    run_id,
                    item_kind,
                    &item.id,
                    rank,
                    item.score as f64,
                    json!({
                        "engine": "rust-native",
                        "retrievalMethod": "sqlite_text",
                        "scopeSnapshot": &item.scope_snapshot
                    })
                    .to_string(),
                    &now,
                ),
            )
            .map_err(|error| format!("failed to insert candidate trace: {error}"))?;
    }
    Ok(())
}

pub(super) fn insert_foundation_candidate_traces(
    connection: &Connection,
    run_id: &str,
    legacy: &[PackKnowledge],
    foundation: &[PackKnowledge],
    delivered: &[PackKnowledge],
) -> Result<(), String> {
    if (legacy.is_empty() && foundation.is_empty())
        || !table_exists(connection, "context_compile_candidate_traces")
    {
        return Ok(());
    }
    let now = now_iso();
    let legacy_ids = legacy
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let delivered_ids = delivered
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let foundation_ids = foundation
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let legacy_items = legacy
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let foundation_items = foundation
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let delivered_items = delivered
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut union = Vec::new();
    let mut seen = HashSet::new();
    for item in legacy.iter().chain(foundation.iter()) {
        if seen.insert(item.id.as_str()) {
            union.push(item);
        }
    }
    for (index, item) in union.into_iter().enumerate() {
        let legacy_rank = legacy_ids.get(item.id.as_str()).copied();
        let delivered_rank = delivered_ids.get(item.id.as_str()).copied();
        let foundation_rank = foundation_ids.get(item.id.as_str()).copied();
        let selected = delivered_rank.is_some();
        let legacy_score = legacy_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        let foundation_score = foundation_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        let final_score = delivered_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        let item_kind = if item.kind == "procedure" {
            "procedure"
        } else {
            "rule"
        };
        connection
            .execute(
                r#"
                insert into context_compile_candidate_traces (
                  run_id, item_kind, item_id, text_rank, text_score, merged_rank, merged_score,
                  final_rank, final_score, selected, suppressed, suppression_reason,
                  agentic_decision, ranking_reason, community_key, evidence, created_at
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                  'accepted', 'foundation_shadow_union', null, ?13, ?14)
                "#,
                (
                    run_id,
                    item_kind,
                    &item.id,
                    i64::try_from(legacy_rank.unwrap_or(index + 1)).unwrap_or(i64::MAX),
                    legacy_score.unwrap_or(item.score) as f64,
                    foundation_rank.map(|rank| i64::try_from(rank).unwrap_or(i64::MAX)),
                    foundation_score.map(|score| score as f64),
                    delivered_rank.map(|rank| i64::try_from(rank).unwrap_or(i64::MAX)),
                    final_score.map(|score| score as f64),
                    i64::from(selected),
                    i64::from(!selected),
                    (!selected).then_some("shadow_only"),
                    json!({
                        "engine": "rust-native",
                        "retrievalMethod": "sqlite_text",
                        "scopeSnapshot": &item.scope_snapshot,
                        "foundation": {
                            "contractVersion": 1,
                            "legacyRank": legacy_rank,
                            "foundationRank": foundation_rank,
                            "legacyScore": legacy_score,
                            "foundationScore": foundation_score,
                            "contentVersion": content_version(&item.title, &item.body),
                            "delivered": selected,
                            "shadow": !selected
                        }
                    })
                    .to_string(),
                    &now,
                ),
            )
            .map_err(|error| format!("failed to insert Foundation candidate trace: {error}"))?;
    }
    Ok(())
}

pub(super) fn insert_foundation_episode_candidate_traces(
    connection: &Connection,
    run_id: &str,
    legacy: &[PackEpisode],
    foundation: &[PackEpisode],
    delivered: &[PackEpisode],
) -> Result<(), String> {
    if (legacy.is_empty() && foundation.is_empty())
        || !table_exists(connection, "context_compile_candidate_traces")
    {
        return Ok(());
    }
    let now = now_iso();
    let legacy_ids = legacy
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let foundation_ids = foundation
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let delivered_ids = delivered
        .iter()
        .enumerate()
        .map(|(index, item)| (item.id.as_str(), index + 1))
        .collect::<std::collections::HashMap<_, _>>();
    let legacy_items = legacy
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let foundation_items = foundation
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let delivered_items = delivered
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let mut union = Vec::new();
    let mut seen = HashSet::new();
    for item in legacy.iter().chain(foundation.iter()) {
        if seen.insert(item.id.as_str()) {
            union.push(item);
        }
    }
    for (index, item) in union.into_iter().enumerate() {
        let legacy_rank = legacy_ids.get(item.id.as_str()).copied();
        let foundation_rank = foundation_ids.get(item.id.as_str()).copied();
        let delivered_rank = delivered_ids.get(item.id.as_str()).copied();
        let selected = delivered_rank.is_some();
        let legacy_score = legacy_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        let foundation_score = foundation_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        let final_score = delivered_items
            .get(item.id.as_str())
            .map(|candidate| candidate.score);
        connection
            .execute(
                r#"
                insert into context_compile_candidate_traces (
                  run_id, item_kind, item_id, text_rank, text_score, merged_rank, merged_score,
                  final_rank, final_score, selected, suppressed, suppression_reason,
                  agentic_decision, ranking_reason, community_key, evidence, created_at
                ) values (?1, 'episode', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                  'accepted', 'foundation_shadow_union', null, ?12, ?13)
                "#,
                (
                    run_id,
                    &item.id,
                    i64::try_from(legacy_rank.unwrap_or(index + 1)).unwrap_or(i64::MAX),
                    legacy_score.unwrap_or(item.score) as f64,
                    foundation_rank.map(|rank| i64::try_from(rank).unwrap_or(i64::MAX)),
                    foundation_score.map(|score| score as f64),
                    delivered_rank.map(|rank| i64::try_from(rank).unwrap_or(i64::MAX)),
                    final_score.map(|score| score as f64),
                    i64::from(selected),
                    i64::from(!selected),
                    (!selected).then_some("shadow_only"),
                    json!({
                        "engine": "rust-native",
                        "retrievalMethod": "sqlite_text",
                        "scopeSnapshot": &item.scope_snapshot,
                        "foundation": {
                            "contractVersion": 1,
                            "legacyRank": legacy_rank,
                            "foundationRank": foundation_rank,
                            "legacyScore": legacy_score,
                            "foundationScore": foundation_score,
                            "contentVersion": episode_content_version(item),
                            "delivered": selected,
                            "shadow": !selected
                        }
                    })
                    .to_string(),
                    &now,
                ),
            )
            .map_err(|error| format!("failed to insert Foundation episode trace: {error}"))?;
    }
    Ok(())
}

pub(super) fn content_version(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-still-foundation-content-v1\n");
    hasher.update(title.as_bytes());
    hasher.update(b"\n");
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(super) fn episode_content_version(item: &PackEpisode) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-still-foundation-episode-content-v1\n");
    hasher.update(item.title.as_bytes());
    hasher.update(b"\n");
    hasher.update(item.situation.as_bytes());
    hasher.update(b"\n");
    hasher.update(item.lesson.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(super) fn insert_knowledge_usage_events(
    connection: &Connection,
    run_id: &str,
    knowledge: &[PackKnowledge],
    used_knowledge: &[UsedKnowledge],
    agentic_used: bool,
) -> Result<(), String> {
    if !table_exists(connection, "knowledge_usage_events") || knowledge.is_empty() {
        return Ok(());
    }
    let used_by_id = used_knowledge
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let actor = if agentic_used { "agent" } else { "system" };
    let now = now_iso();
    let _ = connection.execute(
        "delete from knowledge_usage_events where run_id = ?1",
        [run_id],
    );
    for (index, item) in knowledge.iter().enumerate() {
        let used = used_by_id.get(item.id.as_str());
        let verdict = if used.is_some() { "used" } else { "not_used" };
        let reason = used
            .and_then(|used| used.reason.as_deref())
            .unwrap_or(if used.is_some() {
                "used_by_response_composer"
            } else {
                "selected_but_not_referenced"
            });
        let metadata = match used {
            Some(used) => json!({
                "source": "response_composer",
                "signalSource": "context_response_composer",
                "confidence": used.confidence,
                "evidence": used.evidence,
                "outputSection": used.output_section,
                "selectedRank": index + 1
                ,"scopeSnapshot": &item.scope_snapshot
            }),
            None => json!({
                "source": "response_composer",
                "signalSource": "context_response_composer",
                "selectedRank": index + 1
                ,"scopeSnapshot": &item.scope_snapshot
            }),
        };
        connection
            .execute(
                r#"
                insert into knowledge_usage_events (
                  id, run_id, knowledge_id, verdict, actor, reason, metadata, created_at, updated_at
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                "#,
                (
                    pseudo_uuid(),
                    run_id,
                    &item.id,
                    verdict,
                    actor,
                    single_line(reason, 160),
                    metadata.to_string(),
                    &now,
                ),
            )
            .map_err(|error| format!("failed to insert knowledge usage event: {error}"))?;
    }
    Ok(())
}

pub(super) fn insert_episode_retrieval_feedback(
    connection: &Connection,
    run_id: &str,
    episodes: &[PackEpisode],
    used_episodes: &[UsedEpisode],
    agentic_used: bool,
) -> Result<(), String> {
    if !table_exists(connection, "episode_retrieval_feedback") || episodes.is_empty() {
        return Ok(());
    }
    let used_by_id = used_episodes
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect::<std::collections::HashMap<_, _>>();
    let actor = if agentic_used { "agent" } else { "system" };
    let now = now_iso();
    let _ = connection.execute(
        "delete from episode_retrieval_feedback where run_id = ?1 and run_kind = 'compile'",
        [run_id],
    );
    for (index, item) in episodes.iter().enumerate() {
        let used = used_by_id.get(item.id.as_str());
        let verdict = if used.is_some() {
            "used"
        } else {
            "not_relevant"
        };
        let reason = used
            .and_then(|used| used.reason.as_deref())
            .unwrap_or(if used.is_some() {
                "used_by_response_composer"
            } else {
                "selected_but_not_referenced"
            });
        let metadata = match used {
            Some(used) => json!({
                "actor": actor,
                "source": "response_composer",
                "signalSource": "context_response_composer",
                "confidence": used.confidence,
                "evidence": used.evidence,
                "outputSection": used.output_section,
                "selectedRank": index + 1
                ,"scopeSnapshot": &item.scope_snapshot
            }),
            None => json!({
                "actor": actor,
                "source": "response_composer",
                "signalSource": "context_response_composer",
                "selectedRank": index + 1
                ,"scopeSnapshot": &item.scope_snapshot
            }),
        };
        connection
            .execute(
                r#"
                insert into episode_retrieval_feedback (
                  id, episode_card_id, run_kind, run_id, used_for, verdict, reason, metadata, created_at
                ) values (?1, ?2, 'compile', ?3, 'compile', ?4, ?5, ?6, ?7)
                "#,
                (
                    pseudo_uuid(),
                    &item.id,
                    run_id,
                    verdict,
                    single_line(reason, 160),
                    metadata.to_string(),
                    &now,
                ),
            )
            .map_err(|error| format!("failed to insert episode retrieval feedback: {error}"))?;
    }
    Ok(())
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct CompileCounterUpdate {
    pub(super) knowledge_updated: usize,
    pub(super) missing_knowledge_ids: Vec<String>,
    pub(super) episode_updated: usize,
    pub(super) missing_episode_ids: Vec<String>,
}

pub(super) fn increment_compile_counters(
    connection: &Connection,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
) -> Result<CompileCounterUpdate, String> {
    let now = now_iso();
    let mut update = CompileCounterUpdate::default();
    let mut seen_knowledge = HashSet::new();
    for item in knowledge {
        if !seen_knowledge.insert(item.id.as_str()) {
            continue;
        }
        let affected = connection
            .execute(
                "update knowledge_items set compile_select_count = compile_select_count + 1, last_compiled_at = ?1 where id = ?2",
                (&now, &item.id),
            )
            .map_err(|error| format!("failed to increment knowledge compile counter: {error}"))?;
        if affected == 0 {
            update.missing_knowledge_ids.push(item.id.clone());
        } else {
            update.knowledge_updated += affected;
        }
    }
    let mut seen_episodes = HashSet::new();
    for item in episodes {
        if !seen_episodes.insert(item.id.as_str()) {
            continue;
        }
        let affected = connection
            .execute(
                "update episode_cards set compile_use_count = compile_use_count + 1 where id = ?1",
                [&item.id],
            )
            .map_err(|error| format!("failed to increment episode compile counter: {error}"))?;
        if affected == 0 {
            update.missing_episode_ids.push(item.id.clone());
        } else {
            update.episode_updated += affected;
        }
    }
    Ok(update)
}
