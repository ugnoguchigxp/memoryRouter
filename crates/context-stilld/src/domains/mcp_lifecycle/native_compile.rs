use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::domains::context_compile::runtime::CompileFoundationMode;

use super::native_common::{
    now_iso, open_database, pseudo_uuid, request_session_id, score_text, single_line, string_arg,
    table_exists, tool_error, with_writer,
};
use super::native_tools::NativeToolContext;
use super::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput, CompileProjectIdentityTrust,
};
use super::repository_scope::{
    applicability_general, eligible_scope_clause, facets_allow, json_string_array,
    parse_json_object, query_params, scope_snapshot, RepositoryRequestFacets,
};

static FOUNDATION_TELEMETRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn optional_identity_string_arg(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn validate_compile_argument_keys(args: &serde_json::Map<String, Value>) -> Result<(), String> {
    const ALLOWED_KEYS: [&str; 7] = [
        "goal",
        "changeTypes",
        "technologies",
        "domains",
        "projectRef",
        "repoKey",
        "repoPath",
    ];
    if let Some(key) = args
        .keys()
        .find(|key| !ALLOWED_KEYS.contains(&key.as_str()))
    {
        return Err(format!("unknown context_compile argument: {key}"));
    }
    Ok(())
}

fn optional_string_array_arg(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, String> {
    let Some(value) = args.get(key) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(format!("{key} must be an array of non-empty strings"));
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .ok_or_else(|| format!("{key} must contain only non-empty strings"))
        })
        .collect()
}

pub(crate) fn context_compile(params: &Value, context: &NativeToolContext) -> Value {
    match context.compile_runtime.mode {
        CompileFoundationMode::Legacy => context_compile_legacy(params, context),
        mode => context_compile_split(params, context, mode),
    }
}

fn context_compile_legacy(params: &Value, context: &NativeToolContext) -> Value {
    let owned_params = params.clone();
    let owned_context = context.clone();
    match with_writer(context, "mcp.context_compile", move |connection| {
        Ok(context_compile_on_connection(
            &owned_params,
            &owned_context,
            connection,
        ))
    }) {
        Ok(value) => value,
        Err(error) => tool_error(&error),
    }
}

fn context_compile_on_connection(
    params: &Value,
    _context: &NativeToolContext,
    connection: &mut Connection,
) -> Value {
    let started = Instant::now();
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("context_compile arguments must be an object");
    };
    if let Err(error) = validate_compile_argument_keys(args) {
        return tool_error(&error);
    }
    let goal = match string_arg(args, "goal") {
        Some(goal) => goal,
        None => return tool_error("goal is required"),
    };
    let session_id = request_session_id(params, args);
    let technologies = match optional_string_array_arg(args, "technologies") {
        Ok(values) => values,
        Err(error) => return tool_error(&error),
    };
    let change_types = match optional_string_array_arg(args, "changeTypes") {
        Ok(values) => values,
        Err(error) => return tool_error(&error),
    };
    let domains = match optional_string_array_arg(args, "domains") {
        Ok(values) => values,
        Err(error) => return tool_error(&error),
    };
    let identity_input = match (
        optional_identity_string_arg(args, "projectRef"),
        optional_identity_string_arg(args, "repoKey"),
        optional_identity_string_arg(args, "repoPath"),
    ) {
        (Ok(project_ref), Ok(repo_key), Ok(repo_path)) => CompileProjectIdentityInput {
            project_ref,
            repo_key,
            repo_path,
        },
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            return tool_error(&error);
        }
    };
    let project_identity = match resolve_compile_project_identity(
        &identity_input,
        CompileProjectIdentityTrust::RequestHint,
        None,
    ) {
        Ok(identity) => identity,
        Err(error) => return tool_error(&error.to_string()),
    };
    if !table_exists(connection, "context_compile_runs") {
        return tool_error("context_compile_runs table is not available");
    }

    let search_text = search_text(&goal, &technologies, &change_types, &domains);
    let request_facets = RepositoryRequestFacets {
        technologies: technologies.clone(),
        change_types: change_types.clone(),
        domains: domains.clone(),
    };
    let knowledge = search_knowledge_items(
        connection,
        &search_text,
        8,
        &project_identity,
        &request_facets,
        false,
    );
    let episodes = search_episode_cards(
        connection,
        &search_text,
        3,
        &project_identity,
        &request_facets,
        false,
    );
    let run_id = pseudo_uuid();
    let mut degraded_reasons = degraded_reasons(connection);
    let composed = compose_context_response(connection, &goal, &knowledge, &episodes);
    if let Some(reason) = composed.error.as_ref() {
        degraded_reasons.push(reason.clone());
    }
    let status = if degraded_reasons.is_empty() {
        "ok"
    } else {
        "degraded"
    };
    let markdown = composed.markdown;
    let used_knowledge = composed
        .used_knowledge
        .iter()
        .map(UsedKnowledge::to_json)
        .collect::<Vec<_>>();
    let used_episodes = composed
        .used_episodes
        .iter()
        .map(UsedEpisode::to_json)
        .collect::<Vec<_>>();
    let pack = json!({
        "runId": run_id,
        "goal": goal,
        "rules": knowledge.iter().filter(|item| item.kind == "rule").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "procedures": knowledge.iter().filter(|item| item.kind == "procedure").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "episodes": episodes.iter().map(PackEpisode::to_json).collect::<Vec<_>>(),
        "diagnostics": {
            "engine": "rust-native",
            "degradedReasons": degraded_reasons,
            "selectedKnowledge": knowledge.len(),
            "selectedEpisodes": episodes.len(),
            "repositoryIsolation": {
                "mode": "enforced",
                "matchBasis": project_identity.match_basis.as_str(),
                "scopeMode": project_identity.scope_mode,
                "identityFingerprint": project_identity.identity_fingerprint,
                "missingIdentityGlobalOnly": project_identity.match_basis.as_str() == "none"
            },
            "responseComposer": {
                "used": composed.agentic_used,
                "markdownKind": if markdown == "No Content" { "no-content" } else { "narrative" },
                "error": composed.error,
                "usedKnowledge": used_knowledge,
                "usedEpisodes": used_episodes
            }
        },
        "outputMarkdown": markdown
    });
    let input = json!({
        "goal": goal,
        "technologies": technologies,
        "changeTypes": change_types,
        "domains": domains,
        "projectRef": project_identity.project_ref,
        "repoKey": project_identity.repo_key,
        "repoPath": project_identity.repo_path,
        "projectIdentity": project_identity
    });
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return tool_error(&format!("failed to start compile transaction: {error}")),
    };
    if let Err(error) = insert_compile_run(CompileRunInsert {
        connection: &transaction,
        run_id: &run_id,
        goal: &goal,
        session_id: session_id.as_deref(),
        project_ref: project_identity.project_ref.as_deref(),
        repo_path: project_identity.repo_path.as_deref(),
        repo_key: project_identity.repo_key.as_deref(),
        match_basis: project_identity.match_basis.as_str(),
        identity_contract_version: project_identity.contract_version,
        scope_mode: project_identity.scope_mode,
        identity_fingerprint: project_identity.identity_fingerprint.as_deref(),
        identity_trust: project_identity.trust.as_str(),
        binding_status: project_identity.binding_status.as_str(),
        input: &input,
        status,
        pack: &pack,
        duration_ms: started.elapsed().as_millis(),
    }) {
        return tool_error(&error);
    }
    if let Err(error) = insert_compile_items(&transaction, &run_id, &knowledge, &episodes) {
        return tool_error(&error);
    }
    if let Err(error) = insert_candidate_traces(&transaction, &run_id, &knowledge) {
        return tool_error(&error);
    }
    if let Err(error) = insert_knowledge_usage_events(
        &transaction,
        &run_id,
        &knowledge,
        &composed.used_knowledge,
        composed.agentic_used,
    ) {
        return tool_error(&error);
    }
    if let Err(error) = insert_episode_retrieval_feedback(
        &transaction,
        &run_id,
        &episodes,
        &composed.used_episodes,
        composed.agentic_used,
    ) {
        return tool_error(&error);
    }
    if let Err(error) = transaction.commit() {
        return tool_error(&format!("failed to commit compile transaction: {error}"));
    }
    if markdown == "No Content" {
        return json!({"content":[{"type":"text","text":"No Content"}]});
    }
    json!({"content":[{"type":"text","text":markdown}]})
}

struct SplitPrepared {
    started: Instant,
    retrieval_duration: Duration,
    compose_duration: Duration,
    goal: String,
    session_id: Option<String>,
    technologies: Vec<String>,
    change_types: Vec<String>,
    domains: Vec<String>,
    project_identity: super::project_identity::ResolvedCompileProjectIdentity,
    knowledge: Vec<PackKnowledge>,
    episodes: Vec<PackEpisode>,
    legacy_knowledge: Vec<PackKnowledge>,
    legacy_episodes: Vec<PackEpisode>,
    candidate_knowledge: Vec<PackKnowledge>,
    candidate_episodes: Vec<PackEpisode>,
    foundation_knowledge: Vec<PackKnowledge>,
    foundation_episodes: Vec<PackEpisode>,
    settings: Option<RuntimeSettings>,
    degraded_reasons: Vec<String>,
}

fn context_compile_split(
    params: &Value,
    context: &NativeToolContext,
    mode: CompileFoundationMode,
) -> Value {
    let mut prepared = match prepare_split_compile(params, context) {
        Ok(prepared) => prepared,
        Err(error) => return tool_error(&error),
    };
    if matches!(
        mode,
        CompileFoundationMode::SplitShadowRank | CompileFoundationMode::Foundation
    ) {
        apply_foundation_ranking(&mut prepared);
    }
    if mode == CompileFoundationMode::Foundation {
        prepared.knowledge = prepared.foundation_knowledge.clone();
        prepared.episodes = prepared.foundation_episodes.clone();
    }
    let compose_started = Instant::now();
    let composed = compose_context_response_with_settings(
        prepared.settings.clone(),
        &prepared.goal,
        &prepared.knowledge,
        &prepared.episodes,
    );
    prepared.compose_duration = compose_started.elapsed();
    persist_split_compile(prepared, composed, context, mode)
}

fn apply_foundation_ranking(prepared: &mut SplitPrepared) {
    let mut knowledge = prepared
        .candidate_knowledge
        .iter()
        .filter(|item| item.query_score > 0)
        .cloned()
        .collect::<Vec<_>>();
    knowledge.sort_by(|left, right| {
        right
            .query_score
            .cmp(&left.query_score)
            .then_with(|| {
                normalized_ranking_score(right.dynamic_score, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.dynamic_score, 0.0, 100.0))
            })
            .then_with(|| {
                normalized_ranking_score(right.importance, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    for item in &mut knowledge {
        item.score = foundation_score(item.query_score, item.dynamic_score, item.importance);
    }
    knowledge.truncate(8);
    let mut episodes = prepared
        .candidate_episodes
        .iter()
        .filter(|item| item.query_score > 0)
        .cloned()
        .collect::<Vec<_>>();
    episodes.sort_by(|left, right| {
        right
            .query_score
            .cmp(&left.query_score)
            .then_with(|| {
                normalized_ranking_score(right.importance, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    for item in &mut episodes {
        item.score = foundation_score(item.query_score, 0.0, item.importance);
    }
    episodes.truncate(3);
    prepared.foundation_knowledge = knowledge;
    prepared.foundation_episodes = episodes;
}

fn prepare_split_compile(
    params: &Value,
    context: &NativeToolContext,
) -> Result<SplitPrepared, String> {
    let started = Instant::now();
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| "context_compile arguments must be an object".to_string())?;
    validate_compile_argument_keys(args)?;
    let goal = string_arg(args, "goal").ok_or_else(|| "goal is required".to_string())?;
    let session_id = request_session_id(params, args);
    let technologies = optional_string_array_arg(args, "technologies")?;
    let change_types = optional_string_array_arg(args, "changeTypes")?;
    let domains = optional_string_array_arg(args, "domains")?;
    let identity_input = CompileProjectIdentityInput {
        project_ref: optional_identity_string_arg(args, "projectRef")?,
        repo_key: optional_identity_string_arg(args, "repoKey")?,
        repo_path: optional_identity_string_arg(args, "repoPath")?,
    };
    let project_identity = resolve_compile_project_identity(
        &identity_input,
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .map_err(|error| error.to_string())?;
    let search_text = search_text(&goal, &technologies, &change_types, &domains);
    let request_facets = RepositoryRequestFacets {
        technologies: technologies.clone(),
        change_types: change_types.clone(),
        domains: domains.clone(),
    };
    let retrieval_started = Instant::now();
    let (candidate_knowledge, candidate_episodes, settings, degraded_reasons) = {
        let connection = open_database(context)?;
        if !table_exists(&connection, "context_compile_runs") {
            return Err("context_compile_runs table is not available".to_string());
        }
        let knowledge = search_knowledge_items(
            &connection,
            &search_text,
            256,
            &project_identity,
            &request_facets,
            true,
        );
        let episodes = search_episode_cards(
            &connection,
            &search_text,
            96,
            &project_identity,
            &request_facets,
            true,
        );
        let settings = load_runtime_settings(&connection);
        let degraded_reasons = degraded_reasons(&connection);
        (knowledge, episodes, settings, degraded_reasons)
    };
    let mut knowledge = candidate_knowledge.clone();
    knowledge.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    knowledge.truncate(8);
    let mut episodes = candidate_episodes.clone();
    episodes.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.id.cmp(&right.id))
    });
    episodes.truncate(3);
    Ok(SplitPrepared {
        started,
        retrieval_duration: retrieval_started.elapsed(),
        compose_duration: Duration::ZERO,
        goal,
        session_id,
        technologies,
        change_types,
        domains,
        project_identity,
        legacy_knowledge: knowledge.clone(),
        legacy_episodes: episodes.clone(),
        knowledge,
        episodes,
        candidate_knowledge,
        candidate_episodes,
        foundation_knowledge: Vec::new(),
        foundation_episodes: Vec::new(),
        settings,
        degraded_reasons,
    })
}

fn persist_split_compile(
    mut prepared: SplitPrepared,
    composed: ComposeResult,
    context: &NativeToolContext,
    mode: CompileFoundationMode,
) -> Value {
    if let Some(reason) = composed.error.as_ref() {
        prepared.degraded_reasons.push(reason.clone());
    }
    let status = if prepared.degraded_reasons.is_empty() {
        "ok"
    } else {
        "degraded"
    };
    let run_id = pseudo_uuid();
    let markdown = composed.markdown.clone();
    let used_knowledge = composed
        .used_knowledge
        .iter()
        .map(UsedKnowledge::to_json)
        .collect::<Vec<_>>();
    let used_episodes = composed
        .used_episodes
        .iter()
        .map(UsedEpisode::to_json)
        .collect::<Vec<_>>();
    let foundation_diagnostics = json!({
        "contractVersion": 1,
        "snapshotComplete": false,
        "writerTelemetryExpected": true,
        "pipelineVersion": "foundation-v1",
        "pipelineMode": mode.as_str(),
        "runtime": {
            "engine": "rust-native",
            "version": crate::VERSION,
            "buildId": context.compile_runtime.runtime_build_id,
            "databaseIdentitySource": context.compile_runtime.database_identity_source,
            "databaseIdentityFingerprint": context.compile_runtime.database_identity_fingerprint
        },
        "timingsUs": {
            "prepare": prepared.retrieval_duration.as_micros().min(u64::MAX as u128) as u64,
            "retrieval": prepared.retrieval_duration.as_micros().min(u64::MAX as u128) as u64,
            "compose": prepared.compose_duration.as_micros().min(u64::MAX as u128) as u64
        },
        "llm": {
            "logicalCalls": if composed.agentic_used { 2 } else { 0 },
            "providerAttempts": if composed.agentic_used { 2 } else { 0 },
            "failovers": 0,
            "attempts": []
        },
        "candidates": {
            "eligibleKnowledge": prepared.candidate_knowledge.len(),
            "queryMatchedKnowledge": if matches!(mode, CompileFoundationMode::SplitShadowRank | CompileFoundationMode::Foundation) { prepared.foundation_knowledge.len() } else { prepared.knowledge.len() },
            "deliveredKnowledge": prepared.knowledge.len(),
            "eligibleEpisodes": prepared.candidate_episodes.len(),
            "queryMatchedEpisodes": if matches!(mode, CompileFoundationMode::SplitShadowRank | CompileFoundationMode::Foundation) { prepared.foundation_episodes.len() } else { prepared.episodes.len() },
            "deliveredEpisodes": prepared.episodes.len()
        },
        "persistence": {
            "knowledgeCounterExpected": prepared.knowledge.len(),
            "knowledgeCounterUpdated": 0,
            "missingKnowledgeIds": [],
            "episodeCounterExpected": prepared.episodes.len(),
            "episodeCounterUpdated": 0,
            "missingEpisodeIds": []
        },
        "compositionRoute": "current_two_call",
        "rankingPolicy": if mode == CompileFoundationMode::Foundation { "foundation-v1" } else if mode == CompileFoundationMode::SplitShadowRank { "legacy_with_foundation_shadow" } else { "legacy" }
    });
    let mut pack = json!({
        "runId": run_id,
        "goal": prepared.goal,
        "rules": prepared.knowledge.iter().filter(|item| item.kind == "rule").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "procedures": prepared.knowledge.iter().filter(|item| item.kind == "procedure").map(PackKnowledge::to_json).collect::<Vec<_>>(),
        "episodes": prepared.episodes.iter().map(PackEpisode::to_json).collect::<Vec<_>>(),
        "diagnostics": {
            "engine": "rust-native",
            "degradedReasons": prepared.degraded_reasons,
            "selectedKnowledge": prepared.knowledge.len(),
            "selectedEpisodes": prepared.episodes.len(),
            "foundation": foundation_diagnostics,
            "repositoryIsolation": {
                "mode": "enforced",
                "matchBasis": prepared.project_identity.match_basis.as_str(),
                "scopeMode": prepared.project_identity.scope_mode,
                "identityFingerprint": prepared.project_identity.identity_fingerprint,
                "missingIdentityGlobalOnly": prepared.project_identity.match_basis.as_str() == "none"
            },
            "responseComposer": {
                "used": composed.agentic_used,
                "markdownKind": if markdown == "No Content" { "no-content" } else { "narrative" },
                "error": composed.error,
                "usedKnowledge": used_knowledge,
                "usedEpisodes": used_episodes
            }
        },
        "outputMarkdown": markdown
    });
    let input = json!({
        "goal": prepared.goal,
        "technologies": prepared.technologies,
        "changeTypes": prepared.change_types,
        "domains": prepared.domains,
        "projectRef": prepared.project_identity.project_ref,
        "repoKey": prepared.project_identity.repo_key,
        "repoPath": prepared.project_identity.repo_path,
        "projectIdentity": prepared.project_identity
    });
    let started = prepared.started;
    let run_id_for_write = run_id.clone();
    let result = crate::domains::sqlite_writer::execute_for_path_observed(
        &context.sqlite_core_path,
        "mcp.context_compile.persist",
        move |connection| {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("failed to start compile transaction: {error}"))?;
            insert_compile_run(CompileRunInsert {
                connection: &transaction,
                run_id: &run_id_for_write,
                goal: &prepared.goal,
                session_id: prepared.session_id.as_deref(),
                project_ref: prepared.project_identity.project_ref.as_deref(),
                repo_path: prepared.project_identity.repo_path.as_deref(),
                repo_key: prepared.project_identity.repo_key.as_deref(),
                match_basis: prepared.project_identity.match_basis.as_str(),
                identity_contract_version: prepared.project_identity.contract_version,
                scope_mode: prepared.project_identity.scope_mode,
                identity_fingerprint: prepared.project_identity.identity_fingerprint.as_deref(),
                identity_trust: prepared.project_identity.trust.as_str(),
                binding_status: prepared.project_identity.binding_status.as_str(),
                input: &input,
                status,
                pack: &pack,
                duration_ms: started.elapsed().as_millis(),
            })?;
            insert_compile_items(
                &transaction,
                &run_id_for_write,
                &prepared.knowledge,
                &prepared.episodes,
            )?;
            if matches!(
                mode,
                CompileFoundationMode::SplitShadowRank | CompileFoundationMode::Foundation
            ) {
                insert_foundation_candidate_traces(
                    &transaction,
                    &run_id_for_write,
                    &prepared.legacy_knowledge,
                    &prepared.foundation_knowledge,
                    &prepared.knowledge,
                )?;
                insert_foundation_episode_candidate_traces(
                    &transaction,
                    &run_id_for_write,
                    &prepared.legacy_episodes,
                    &prepared.foundation_episodes,
                    &prepared.episodes,
                )?;
            } else {
                insert_candidate_traces(&transaction, &run_id_for_write, &prepared.knowledge)?;
            }
            insert_knowledge_usage_events(
                &transaction,
                &run_id_for_write,
                &prepared.knowledge,
                &composed.used_knowledge,
                composed.agentic_used,
            )?;
            insert_episode_retrieval_feedback(
                &transaction,
                &run_id_for_write,
                &prepared.episodes,
                &composed.used_episodes,
                composed.agentic_used,
            )?;
            let counter_update =
                increment_compile_counters(&transaction, &prepared.knowledge, &prepared.episodes)?;
            if let Some(persistence) = pack
                .pointer_mut("/diagnostics/foundation/persistence")
                .and_then(Value::as_object_mut)
            {
                persistence.insert(
                    "knowledgeCounterUpdated".to_string(),
                    json!(counter_update.knowledge_updated),
                );
                persistence.insert(
                    "missingKnowledgeIds".to_string(),
                    json!(counter_update.missing_knowledge_ids),
                );
                persistence.insert(
                    "episodeCounterUpdated".to_string(),
                    json!(counter_update.episode_updated),
                );
                persistence.insert(
                    "missingEpisodeIds".to_string(),
                    json!(counter_update.missing_episode_ids),
                );
            }
            if let Some(foundation) = pack.pointer_mut("/diagnostics/foundation") {
                foundation["snapshotComplete"] = Value::Bool(true);
            }
            transaction
                .execute(
                    "update context_compile_runs set pack_snapshot = ?1 where id = ?2",
                    (pack.to_string(), &run_id_for_write),
                )
                .map_err(|error| format!("failed to finalize compile pack snapshot: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("failed to commit compile transaction: {error}"))?;
            Ok(())
        },
    );
    match result {
        Ok(execution) => {
            append_foundation_telemetry(
                context,
                FoundationTelemetryInput {
                    run_id: &run_id,
                    mode,
                    queue_wait: execution.queue_wait,
                    work_duration: execution.work_duration,
                    total_duration: execution.total_duration,
                    error: execution.result.as_ref().err().map(String::as_str),
                    pre_ledger_total: started.elapsed(),
                },
            );
            if let Err(error) = execution.result {
                return tool_error(&error);
            }
        }
        Err(error) => {
            append_foundation_telemetry(
                context,
                FoundationTelemetryInput {
                    run_id: &run_id,
                    mode,
                    queue_wait: Duration::ZERO,
                    work_duration: Duration::ZERO,
                    total_duration: Duration::ZERO,
                    error: Some(error.as_str()),
                    pre_ledger_total: started.elapsed(),
                },
            );
            return tool_error(&error);
        }
    }
    if markdown == "No Content" {
        json!({"content":[{"type":"text","text":"No Content"}]})
    } else {
        json!({"content":[{"type":"text","text":markdown}]})
    }
}

#[derive(Debug, Clone)]
struct PackKnowledge {
    id: String,
    kind: String,
    title: String,
    body: String,
    polarity: String,
    score: i64,
    query_score: i64,
    dynamic_score: f64,
    importance: f64,
    source_refs: Vec<String>,
    scope_snapshot: Value,
}

impl PackKnowledge {
    fn to_json(&self) -> Value {
        json!({
            "kind": "knowledge",
            "id": self.id,
            "type": self.kind,
            "title": self.title,
            "body": self.body,
            "polarity": self.polarity,
            "score": self.score,
            "sourceRefs": self.source_refs
        })
    }
}

#[derive(Debug, Clone)]
struct PackEpisode {
    id: String,
    title: String,
    situation: String,
    lesson: String,
    score: i64,
    query_score: i64,
    importance: f64,
    scope_snapshot: Value,
}

impl PackEpisode {
    fn to_json(&self) -> Value {
        json!({
            "kind": "episode",
            "id": self.id,
            "title": self.title,
            "situation": self.situation,
            "lesson": self.lesson,
            "score": self.score
        })
    }
}

fn search_text(
    goal: &str,
    technologies: &[String],
    change_types: &[String],
    domains: &[String],
) -> String {
    [&[goal.to_string()][..], technologies, change_types, domains]
        .concat()
        .join(" ")
}

fn search_knowledge_items(
    connection: &Connection,
    query: &str,
    limit: usize,
    identity: &super::project_identity::ResolvedCompileProjectIdentity,
    request_facets: &RepositoryRequestFacets,
    include_query_matches: bool,
) -> Vec<PackKnowledge> {
    if !table_exists(connection, "knowledge_items") {
        return Vec::new();
    }
    let (scope_clause, values) = eligible_scope_clause(identity);
    let sql = format!(
        r#"
        select id, type, polarity, title, body, coalesce(dynamic_score, 0), applies_to,
               scope, project_ref, repo_key, repo_path, coalesce(importance, 0)
        from knowledge_items
        where status = 'active' and {scope_clause}
        order by importance desc, updated_at desc
        "#,
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map(query_params(&values), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, f64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(
            |(
                id,
                kind,
                polarity,
                title,
                body,
                dynamic_score,
                applies_to_raw,
                item_scope,
                project_ref,
                repo_key,
                repo_path,
                importance,
            )| {
                let applies_to = parse_json_object(&applies_to_raw);
                let technologies = json_string_array(&applies_to, "technologies");
                let change_types = json_string_array(&applies_to, "changeTypes");
                let domains = json_string_array(&applies_to, "domains");
                if !facets_allow(
                    request_facets,
                    &technologies,
                    &change_types,
                    &domains,
                    applicability_general(&applies_to, &technologies, &change_types, &domains),
                ) {
                    return None;
                }
                let query_score = score_text(&format!("{title}\n{body}"), query);
                let score = query_score + dynamic_score.round() as i64;
                (score > 0 || (include_query_matches && query_score > 0)).then(|| PackKnowledge {
                    source_refs: knowledge_source_refs(connection, &id),
                    scope_snapshot: scope_snapshot(
                        identity,
                        &item_scope,
                        project_ref.as_deref(),
                        repo_key.as_deref(),
                        repo_path.as_deref(),
                    ),
                    id,
                    kind,
                    title,
                    body,
                    polarity,
                    score,
                    query_score,
                    dynamic_score,
                    importance,
                })
            },
        )
        .collect::<Vec<_>>();
    if !include_query_matches {
        items.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        items.truncate(limit);
        return items;
    }
    foundation_candidate_pool(
        items,
        limit,
        8,
        |item| item.query_score > 0,
        |left, right| {
            right
                .query_score
                .cmp(&left.query_score)
                .then_with(|| {
                    normalized_ranking_score(right.dynamic_score, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.dynamic_score, 0.0, 100.0))
                })
                .then_with(|| {
                    normalized_ranking_score(right.importance, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
                })
                .then_with(|| left.id.cmp(&right.id))
        },
    )
}

fn search_episode_cards(
    connection: &Connection,
    query: &str,
    limit: usize,
    identity: &super::project_identity::ResolvedCompileProjectIdentity,
    request_facets: &RepositoryRequestFacets,
    include_query_matches: bool,
) -> Vec<PackEpisode> {
    if !table_exists(connection, "episode_cards") {
        return Vec::new();
    }
    let (scope_clause, values) = eligible_scope_clause(identity);
    let sql = format!(
        r#"
        select id, title, situation, lesson, importance, technologies, change_types, domains,
               applicability, scope, project_ref, repo_key, repo_path
        from episode_cards
        where status = 'active' and {scope_clause}
        order by importance desc, updated_at desc
        "#,
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map(query_params(&values), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(
            |(
                id,
                title,
                situation,
                lesson,
                importance,
                technologies_raw,
                change_types_raw,
                domains_raw,
                applicability_raw,
                item_scope,
                project_ref,
                repo_key,
                repo_path,
            )| {
                let technologies =
                    serde_json::from_str::<Vec<String>>(&technologies_raw).unwrap_or_default();
                let change_types =
                    serde_json::from_str::<Vec<String>>(&change_types_raw).unwrap_or_default();
                let domains = serde_json::from_str::<Vec<String>>(&domains_raw).unwrap_or_default();
                let applicability = parse_json_object(&applicability_raw);
                if !facets_allow(
                    request_facets,
                    &technologies,
                    &change_types,
                    &domains,
                    applicability_general(&applicability, &technologies, &change_types, &domains),
                ) {
                    return None;
                }
                let query_score = score_text(&format!("{title}\n{situation}\n{lesson}"), query);
                let score = query_score + importance / 10;
                (score > 0 || (include_query_matches && query_score > 0)).then_some(PackEpisode {
                    id,
                    title,
                    situation,
                    lesson,
                    score,
                    query_score,
                    importance: importance as f64,
                    scope_snapshot: scope_snapshot(
                        identity,
                        &item_scope,
                        project_ref.as_deref(),
                        repo_key.as_deref(),
                        repo_path.as_deref(),
                    ),
                })
            },
        )
        .collect::<Vec<_>>();
    if !include_query_matches {
        items.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        items.truncate(limit);
        return items;
    }
    foundation_candidate_pool(
        items,
        limit,
        3,
        |item| item.query_score > 0,
        |left, right| {
            right
                .query_score
                .cmp(&left.query_score)
                .then_with(|| {
                    normalized_ranking_score(right.importance, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
                })
                .then_with(|| left.id.cmp(&right.id))
        },
    )
}

fn foundation_candidate_pool<T, QueryMatched, FoundationOrder>(
    items: Vec<T>,
    limit: usize,
    legacy_budget: usize,
    query_matched: QueryMatched,
    foundation_order: FoundationOrder,
) -> Vec<T>
where
    T: Clone + CandidateIdentity + LegacyScored,
    QueryMatched: Fn(&T) -> bool,
    FoundationOrder: Fn(&T, &T) -> std::cmp::Ordering,
{
    let mut legacy = items.iter().collect::<Vec<_>>();
    legacy.sort_by(|left, right| legacy_candidate_order(*left, *right));
    legacy.truncate(legacy_budget.min(limit));

    let mut query_matched = items
        .iter()
        .filter(|item| query_matched(item))
        .collect::<Vec<_>>();
    query_matched.sort_by(|left, right| foundation_order(*left, *right));

    let mut selected = Vec::with_capacity(limit);
    let mut seen = HashSet::new();
    for item in legacy.into_iter().chain(query_matched) {
        if seen.insert(item.candidate_id().to_string()) {
            selected.push((*item).clone());
            if selected.len() == limit {
                break;
            }
        }
    }
    selected
}

trait CandidateIdentity {
    fn candidate_id(&self) -> &str;
}

trait LegacyScored {
    fn legacy_score(&self) -> i64;
}

fn legacy_candidate_order<T: LegacyScored + CandidateIdentity>(
    left: &T,
    right: &T,
) -> std::cmp::Ordering {
    right
        .legacy_score()
        .cmp(&left.legacy_score())
        .then_with(|| left.candidate_id().cmp(right.candidate_id()))
}

impl CandidateIdentity for PackKnowledge {
    fn candidate_id(&self) -> &str {
        &self.id
    }
}

impl LegacyScored for PackKnowledge {
    fn legacy_score(&self) -> i64 {
        self.score
    }
}

impl CandidateIdentity for PackEpisode {
    fn candidate_id(&self) -> &str {
        &self.id
    }
}

impl LegacyScored for PackEpisode {
    fn legacy_score(&self) -> i64 {
        self.score
    }
}

fn normalized_ranking_score(value: f64, lower: f64, upper: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    value.clamp(lower, upper).round() as i64
}

fn foundation_score(query_score: i64, dynamic_score: f64, importance: f64) -> i64 {
    query_score
        .saturating_mul(10_000)
        .saturating_add(normalized_ranking_score(dynamic_score, 0.0, 100.0).saturating_mul(100))
        .saturating_add(normalized_ranking_score(importance, 0.0, 100.0))
}

#[derive(Debug)]
struct ComposeResult {
    markdown: String,
    agentic_used: bool,
    error: Option<String>,
    used_knowledge: Vec<UsedKnowledge>,
    used_episodes: Vec<UsedEpisode>,
}

#[derive(Debug, Clone)]
struct UsedKnowledge {
    id: String,
    confidence: f64,
    evidence: Option<String>,
    output_section: Option<String>,
    reason: Option<String>,
}

impl UsedKnowledge {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "confidence": self.confidence,
            "evidence": self.evidence,
            "outputSection": self.output_section,
            "reason": self.reason
        })
    }
}

#[derive(Debug, Clone)]
struct UsedEpisode {
    id: String,
    confidence: f64,
    evidence: Option<String>,
    output_section: Option<String>,
    reason: Option<String>,
}

impl UsedEpisode {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "confidence": self.confidence,
            "evidence": self.evidence,
            "outputSection": self.output_section,
            "reason": self.reason
        })
    }
}

#[derive(Debug, Clone)]
struct ComposePlan {
    focus: String,
    steps: String,
    verification: String,
    avoid: String,
    include_avoid_section: bool,
    response_style: String,
}

impl Default for ComposePlan {
    fn default() -> Self {
        Self {
            focus: "実装フォーカス".to_string(),
            steps: "実装手順".to_string(),
            verification: "検証観点".to_string(),
            avoid: "注意点".to_string(),
            include_avoid_section: false,
            response_style: "narrative".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
struct RuntimeSettings {
    agentic_enabled: bool,
    provider: String,
    fallback: Vec<String>,
    timeout_ms: u64,
    max_tokens: i64,
    azure: Option<AzureSettings>,
    local: Option<LocalLlmSettings>,
    openai: Option<OpenAiSettings>,
    local_llm_model: Option<String>,
}

#[derive(Debug, Clone)]
struct AzureSettings {
    api_key: String,
    api_base_url: String,
    api_path: String,
    api_version: String,
    model: String,
}

#[derive(Debug, Clone)]
struct LocalLlmSettings {
    api_key: String,
    api_base_url: String,
    api_path: String,
    model: String,
}

#[derive(Debug, Clone)]
struct OpenAiSettings {
    api_key: String,
    api_base_url: String,
    model: String,
}

fn compose_context_response(
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

fn compose_context_response_with_settings(
    runtime_settings: Option<RuntimeSettings>,
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
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

fn build_fallback_compose(
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

fn fallback_used_knowledge(
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

fn fallback_used_episodes(episodes: &[PackEpisode]) -> Vec<UsedEpisode> {
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

fn build_plan_system_prompt() -> String {
    [
        "あなたは context_compile の返答構成プランナーです。",
        "goal と候補要約だけを使って、次ラウンドで使う返答構成・出力形式・検索ヒントを JSON で設計してください。",
        "",
        "JSON 形式:",
        "{ \"headings\": { \"focus\": \"...\", \"steps\": \"...\", \"verification\": \"...\", \"avoid\": \"...\" }, \"includeAvoidSection\": true, \"ruleQueryHints\": [\"...\"], \"procedureQueryHints\": [\"...\"], \"exclusionHints\": [\"...\"], \"responseStyle\": \"skill|narrative\", \"styleReason\": \"...\", \"styleConfidence\": 0.0, \"candidateSufficiency\": \"enough|limited|insufficient\" }",
        "",
        "必須ルール:",
        "- 回答は JSON のみ。Markdown や説明文は返さない。",
        "- 見出しは goal に合わせて自然な日本語で作る。",
        "- ruleQueryHints / procedureQueryHints は、候補検索・選別で使える短い語句を2-6件に絞る。",
        "- Goal が再利用可能な手順を求め、候補が十分な場合は responseStyle=skill を優先する。",
        "- 候補が不足している場合は responseStyle=narrative を選ぶ。",
        "- 過剰な一般論は避け、goal達成に必要な最小限へ絞る。",
    ]
    .join("\n")
}

fn build_composer_system_prompt(max_tokens: i64, plan: &ComposePlan) -> String {
    let heading_rule = if plan.response_style == "skill" {
        "- 見出しは `## Use when` / `## Workflow` / `## Verification` / `## Avoid` をこの順で必ず出す。".to_string()
    } else if plan.include_avoid_section {
        format!(
            "- 見出しは `{}` / `{}` / `{}` / `{}` をこの順で必ず出す。",
            plan.focus, plan.steps, plan.verification, plan.avoid
        )
    } else {
        format!(
            "- 見出しは `{}` / `{}` / `{}` をこの順で必ず出す。必要な場合のみ `{}` を追加。",
            plan.focus, plan.steps, plan.verification, plan.avoid
        )
    };
    let style_rule = if plan.response_style == "skill" {
        "- 出力は再利用可能な手順書として書き、Workflow は番号付き手順で具体化する。"
    } else {
        "- 出力は実装・調査判断に使える narrative コンテキストとして要点をまとめる。"
    };
    [
        "あなたは context_compile の最終コンテキスト編集者です。",
        "入力された knowledge 候補をそのまま列挙せず、現在の goal に直結する指示へ統合してください。回答はJSONのみ返してください。",
        "",
        "JSON 形式:",
        "{ \"markdown\": \"...\", \"usedKnowledge\": [{ \"id\": \"knowledge-id\", \"confidence\": 0.0, \"evidence\": \"...\", \"outputSection\": \"...\", \"reason\": \"...\" }], \"usedEpisodes\": [{ \"id\": \"episode-id\", \"confidence\": 0.0, \"evidence\": \"...\", \"outputSection\": \"...\", \"reason\": \"...\" }] }",
        "",
        "必須ルール:",
        "- 出力は日本語 Markdown。",
        &heading_rule,
        style_rule,
        "- `Rules` や `Procedures` の見出しは使わない。",
        "- `negative guardrails` は参考情報ではなく、実行可否・修正条件・確認条件を制約する negative evidence として扱う。",
        "- `episode precedents` は過去の類似ケースであり、Knowledge rule や現在の source truth ではない。",
        "- 入力knowledgeに無い事実を追加しない。",
        &format!("- markdown フィールドの本文は {} トークン以内を目標に収める。", max_tokens.max(128)),
        "- JSON は必ず完結させる。",
        "- goal と直接関係する指示が作れない場合は、`{\"markdown\":\"No Content\",\"usedKnowledge\":[],\"usedEpisodes\":[]}` を返す。",
        "- ノイズを避け、受け手が次に行う行動へ変換する。",
    ]
    .join("\n")
}

fn build_plan_user_prompt(
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
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
        format!("goal: {}", single_line(goal, 240)),
        "retrievalMode: sqlite_text".to_string(),
        format!("ruleCandidates: {}", rules.len()),
        format!("procedureCandidates: {}", procedures.len()),
        format!("guardrailCandidates: {}", guardrails.len()),
        format!("episodePrecedents: {}", episodes.len()),
        format!(
            "topRuleTitles: {}",
            joined_titles(&rules.into_iter().take(4).collect::<Vec<_>>())
        ),
        format!(
            "topProcedureTitles: {}",
            joined_titles(&procedures.into_iter().take(4).collect::<Vec<_>>())
        ),
        format!(
            "topGuardrailTitles: {}",
            joined_titles(&guardrails.into_iter().take(4).collect::<Vec<_>>())
        ),
        format!(
            "topEpisodePrecedents: {}",
            episodes
                .iter()
                .take(4)
                .map(|item| single_line(&item.title, 80))
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        String::new(),
        "output requirements:".to_string(),
        "- JSON only".to_string(),
        "- sections should feel natural for this goal".to_string(),
        "- include concise query hints".to_string(),
        "- decide responseStyle from goal + candidate sufficiency".to_string(),
    ];
    if lines[8].ends_with(": ") {
        lines[8].push_str("(none)");
    }
    lines.join("\n")
}

fn build_composer_user_prompt(
    goal: &str,
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    plan: &ComposePlan,
) -> String {
    let items = select_prompt_knowledge_candidates(knowledge, plan);
    let guardrails = knowledge
        .iter()
        .filter(|item| item.polarity == "negative")
        .collect::<Vec<_>>();
    let mut lines = vec![
        format!("goal: {}", single_line(goal, 240)),
        "retrievalMode: sqlite_text".to_string(),
        format!(
            "compositionPlan: {}",
            json!({
                "headings": {
                    "focus": plan.focus,
                    "steps": plan.steps,
                    "verification": plan.verification,
                    "avoid": plan.avoid
                },
                "includeAvoidSection": plan.include_avoid_section,
                "responseStyle": plan.response_style
            })
        ),
    ];
    if !guardrails.is_empty() {
        lines.push(String::new());
        lines.push("negative guardrails:".to_string());
        for item in guardrails.iter().take(4) {
            lines.push(format!("- id: {}", item.id));
            lines.push(format!("  title: {}", single_line(&item.title, 120)));
            lines.push(format!("  summary: {}", first_sentence(&item.body, 180)));
        }
    }
    if !episodes.is_empty() {
        lines.push(String::new());
        lines.push("episode precedents:".to_string());
        for item in episodes.iter().take(3) {
            lines.push(format!("- id: {}", item.id));
            lines.push(format!("  title: {}", single_line(&item.title, 120)));
            let summary = if item.lesson.trim().is_empty() {
                &item.situation
            } else {
                &item.lesson
            };
            lines.push(format!("  summary: {}", first_sentence(summary, 180)));
        }
    }
    lines.push(String::new());
    lines.push("knowledge candidates:".to_string());
    for item in items {
        lines.push(format!("- id: {}", item.id));
        lines.push(format!("  kind: {}", item.kind));
        lines.push(format!("  title: {}", single_line(&item.title, 120)));
        lines.push(format!("  summary: {}", first_sentence(&item.body, 160)));
    }
    lines.join("\n")
}

fn load_runtime_settings(connection: &Connection) -> Option<RuntimeSettings> {
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

fn load_azure_settings(connection: &Connection, value: Option<&Value>) -> Option<AzureSettings> {
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

fn load_local_settings(connection: &Connection, value: Option<&Value>) -> Option<LocalLlmSettings> {
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

fn load_openai_settings(connection: &Connection, value: Option<&Value>) -> Option<OpenAiSettings> {
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

fn query_setting_value(connection: &Connection, namespace: &str, key: &str) -> Option<String> {
    connection
        .query_row(
            "select value from settings where namespace = ?1 and key = ?2 limit 1",
            (namespace, key),
            |row| row.get::<_, String>(0),
        )
        .ok()
}

fn query_secret_value(connection: &Connection, key: &str) -> Option<String> {
    let value = query_setting_value(connection, "runtime.secret", key)?;
    let parsed = serde_json::from_str::<Value>(&value).ok()?;
    string_value(parsed.get("value")).filter(|value| !value.is_empty())
}

fn provider_route(settings: &RuntimeSettings) -> Vec<String> {
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

fn chat_json(
    client: &Client,
    settings: &RuntimeSettings,
    provider: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<String, String> {
    match provider {
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
    }
}

fn chat_azure(
    client: &Client,
    settings: Option<&AzureSettings>,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<String, String> {
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

fn chat_local(
    client: &Client,
    settings: &RuntimeSettings,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<String, String> {
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
    let mut request = client.post(url).header("content-type", "application/json");
    if !local.api_key.trim().is_empty() {
        request = request.header("authorization", format!("Bearer {}", local.api_key.trim()));
    }
    let response = request
        .json(&json!({
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "stream": false,
            "temperature": 0,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"}
        }))
        .send()
        .map_err(|error| error.to_string())?;
    parse_chat_response(response, "local-llm")
}

fn chat_openai(
    client: &Client,
    settings: Option<&OpenAiSettings>,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: i64,
) -> Result<String, String> {
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

fn parse_chat_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<String, String> {
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
    Ok(content.to_string())
}

fn parse_compose_plan(raw: &str) -> Option<ComposePlan> {
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

fn parse_composer_payload(
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

fn parse_used_knowledge_array(
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

fn parse_used_episode_array(
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

fn normalize_composer_output(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("no content") {
        return "No Content".to_string();
    }
    let without_fence = trimmed
        .strip_prefix("```json\n")
        .or_else(|| trimmed.strip_prefix("```markdown\n"))
        .or_else(|| trimmed.strip_prefix("```md\n"))
        .or_else(|| trimmed.strip_prefix("```text\n"))
        .or_else(|| trimmed.strip_prefix("```\n"))
        .and_then(|value| value.strip_suffix("\n```"))
        .unwrap_or(trimmed)
        .trim();
    if without_fence.is_empty() || without_fence.eq_ignore_ascii_case("no content") {
        "No Content".to_string()
    } else {
        without_fence.to_string()
    }
}

fn select_prompt_knowledge_candidates<'a>(
    knowledge: &'a [PackKnowledge],
    _plan: &ComposePlan,
) -> Vec<&'a PackKnowledge> {
    let mut items = knowledge.iter().collect::<Vec<_>>();
    items.sort_by(|left, right| right.score.cmp(&left.score));
    items.truncate(8);
    items
}

fn section_lines(content: &str, label: &str) -> Vec<String> {
    let mut in_section = false;
    let mut captured = Vec::new();
    let target = format!("{}:", label.to_lowercase());
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
            && line.contains(':')
        {
            in_section = line.to_lowercase().starts_with(&target);
            continue;
        }
        if !in_section {
            continue;
        }
        let cleaned = line
            .trim_start_matches(|character: char| {
                character.is_ascii_digit()
                    || character == '.'
                    || character == '-'
                    || character == '・'
                    || character == '•'
                    || character.is_whitespace()
            })
            .trim();
        if !cleaned.is_empty() {
            captured.push(cleaned.to_string());
        }
    }
    captured
}

fn first_sentence(text: &str, max_chars: usize) -> String {
    let normalized = single_line(text, max_chars.saturating_mul(2));
    if normalized.is_empty() {
        return normalized;
    }
    let sentence_end = normalized
        .char_indices()
        .find_map(|(index, character)| {
            matches!(character, '。' | '.' | '!' | '?').then_some(index + character.len_utf8())
        })
        .unwrap_or(normalized.len());
    single_line(&normalized[..sentence_end], max_chars)
}

fn joined_titles(items: &[&PackKnowledge]) -> String {
    let joined = items
        .iter()
        .map(|item| single_line(&item.title, 80))
        .collect::<Vec<_>>()
        .join(" | ");
    if joined.is_empty() {
        "(none)".to_string()
    } else {
        joined
    }
}

fn sanitize_heading(value: Option<&Value>, fallback: &str) -> String {
    string_value(value)
        .map(|value| {
            value
                .trim_start_matches('#')
                .trim()
                .chars()
                .take(32)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn trim_trailing_slashes(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn looks_like_json_payload(value: &str) -> bool {
    let normalized = normalize_composer_output(value);
    normalized.starts_with('{') || normalized.starts_with('[')
}

fn looks_goal_aligned(markdown: &str, goal: &str) -> bool {
    if markdown == "No Content" {
        return false;
    }
    let goal_tokens = goal
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .filter(|token| token.len() >= 3)
        .filter(|token| !matches!(*token, "with" | "from" | "into" | "that" | "this"))
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    if goal_tokens.is_empty() {
        return true;
    }
    let text = markdown.to_lowercase();
    goal_tokens.iter().any(|token| text.contains(token))
}

fn max_tokens_with_json_headroom(markdown_target_tokens: i64) -> i64 {
    let normalized = markdown_target_tokens.max(128);
    (normalized + 512)
        .max(((normalized as f64) * 1.15).ceil() as i64)
        .min(16_384)
}

fn planner_max_tokens(markdown_target_tokens: i64) -> i64 {
    let normalized = markdown_target_tokens.max(128);
    2048.min(384.max((normalized as f64 * 0.35).floor() as i64))
}

struct CompileRunInsert<'a> {
    connection: &'a Connection,
    run_id: &'a str,
    goal: &'a str,
    session_id: Option<&'a str>,
    project_ref: Option<&'a str>,
    repo_path: Option<&'a str>,
    repo_key: Option<&'a str>,
    match_basis: &'a str,
    identity_contract_version: u8,
    scope_mode: &'a str,
    identity_fingerprint: Option<&'a str>,
    identity_trust: &'a str,
    binding_status: &'a str,
    input: &'a Value,
    status: &'a str,
    pack: &'a Value,
    duration_ms: u128,
}

fn insert_compile_run(params: CompileRunInsert<'_>) -> Result<(), String> {
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

fn insert_compile_items(
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

fn insert_candidate_traces(
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

fn insert_foundation_candidate_traces(
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

fn insert_foundation_episode_candidate_traces(
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

fn content_version(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-still-foundation-content-v1\n");
    hasher.update(title.as_bytes());
    hasher.update(b"\n");
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn episode_content_version(item: &PackEpisode) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-still-foundation-episode-content-v1\n");
    hasher.update(item.title.as_bytes());
    hasher.update(b"\n");
    hasher.update(item.situation.as_bytes());
    hasher.update(b"\n");
    hasher.update(item.lesson.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn insert_knowledge_usage_events(
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

fn insert_episode_retrieval_feedback(
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
struct CompileCounterUpdate {
    knowledge_updated: usize,
    missing_knowledge_ids: Vec<String>,
    episode_updated: usize,
    missing_episode_ids: Vec<String>,
}

fn increment_compile_counters(
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

struct FoundationTelemetryInput<'a> {
    run_id: &'a str,
    mode: CompileFoundationMode,
    queue_wait: Duration,
    work_duration: Duration,
    total_duration: Duration,
    error: Option<&'a str>,
    pre_ledger_total: Duration,
}

fn append_foundation_telemetry(context: &NativeToolContext, input: FoundationTelemetryInput<'_>) {
    let directory = context
        .compile_runtime
        .logs_dir
        .join("context-compile-foundation");
    let lock = FOUNDATION_TELEMETRY_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(format!(
        "{}.{}.jsonl",
        &context.compile_runtime.runtime_build_id[..16],
        std::process::id()
    ));
    let record = json!({
        "contractVersion": 1,
        "runId": input.run_id,
        "recordedAt": now_iso(),
        "pipelineVersion": "foundation-v1",
        "pipelineMode": input.mode.as_str(),
        "runtimeVersion": crate::VERSION,
        "runtimeBuildId": context.compile_runtime.runtime_build_id,
        "databaseIdentityFingerprint": context.compile_runtime.database_identity_fingerprint,
        "writer": {
            "operation": if input.mode == CompileFoundationMode::Legacy { "mcp.context_compile" } else { "mcp.context_compile.persist" },
            "queueWaitUs": input.queue_wait.as_micros().min(u64::MAX as u128) as u64,
            "workUs": input.work_duration.as_micros().min(u64::MAX as u128) as u64,
            "totalUs": input.total_duration.as_micros().min(u64::MAX as u128) as u64,
            "success": input.error.is_none(),
            "errorCategory": input.error.map(|_| "writer_error")
        },
        "preLedgerEndToEndUs": input.pre_ledger_total.as_micros().min(u64::MAX as u128) as u64
    });
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(line) = serde_json::to_vec(&record) else {
        return;
    };
    if line.len() > 16 * 1024 {
        return;
    }
    let _ = file.write_all(&line);
    let _ = file.write_all(b"\n");
    let _ = file.flush();
}

fn knowledge_source_refs(connection: &Connection, knowledge_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select s.uri, sf.locator
        from knowledge_source_links ksl
        join source_fragments sf on sf.id = ksl.source_fragment_id
        join sources s on s.id = sf.source_id
        where ksl.knowledge_id = ?1
        order by ksl.confidence desc, ksl.created_at desc
        limit 5
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([knowledge_id], |row| {
            let uri: String = row.get(0)?;
            let locator: String = row.get(1)?;
            Ok(format!("{uri}#{locator}"))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn degraded_reasons(connection: &Connection) -> Vec<String> {
    let mut reasons = Vec::new();
    if !table_exists(connection, "knowledge_items") {
        reasons.push("knowledge_items_missing".to_string());
    }
    if !table_exists(connection, "episode_cards") {
        reasons.push("episode_cards_missing".to_string());
    }
    reasons
}

fn json_array_string(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|values| json!(values).to_string())
        .unwrap_or_else(|| "[]".to_string())
}

fn goal_hash(goal: &str) -> String {
    let mut hasher = DefaultHasher::new();
    goal.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use rusqlite::Connection;
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("context_still_native_compile_{nanos}_{id}.sqlite"))
    }

    fn create_minimal_compile_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table knowledge_items (
                  id text primary key,
                  type text not null,
                  status text not null,
                  scope text not null default 'global',
                  classification_status text not null default 'classified',
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  polarity text not null default 'positive',
                  title text not null,
                  body text not null,
                  intent_tags text not null default '[]',
                  applies_to text not null default '{}',
                  importance real not null default 70,
                  dynamic_score real not null default 0,
                  compile_select_count integer not null default 0,
                  last_compiled_at text,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_runs (
                  id text primary key,
                  goal text not null,
                  intent text not null,
                  session_id text,
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  match_basis text not null default 'none',
                  identity_contract_version integer not null default 1,
                  scope_mode text not null default 'global_only',
                  input text not null default '{}',
                  retrieval_mode text not null,
                  status text not null,
                  degraded_reasons text not null default '[]',
                  token_budget integer not null default 0,
                  duration_ms integer not null default 0,
                  source text not null default 'unknown',
                  pack_snapshot text,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_task_traces (
                  run_id text primary key,
                  retrieval_mode text not null,
                  project_ref text,
                  repo_path text,
                  repo_key text,
                  match_basis text not null default 'none',
                  identity_contract_version integer not null default 1,
                  scope_mode text not null default 'global_only',
                  identity_fingerprint text,
                  identity_trust text not null default 'request_hint',
                  binding_status text not null default 'not_applicable',
                  technologies text not null default '[]',
                  change_types text not null default '[]',
                  domains text not null default '[]',
                  goal_hash text not null,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_pack_items (
                  id integer primary key autoincrement,
                  run_id text not null,
                  item_kind text not null,
                  item_id text not null,
                  section text not null,
                  score real not null default 0,
                  ranking_reason text not null default '',
                  source_refs text not null default '[]',
                  scope_snapshot text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table knowledge_usage_events (
                  id text primary key,
                  run_id text not null,
                  knowledge_id text not null,
                  verdict text not null,
                  actor text not null,
                  reason text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_candidate_traces (
                  id integer primary key autoincrement,
                  run_id text not null,
                  item_kind text not null,
                  item_id text not null,
                  text_rank integer,
                  text_score real,
                  vector_rank integer,
                  vector_score real,
                  merged_rank integer,
                  merged_score real,
                  final_rank integer,
                  final_score real,
                  selected integer not null default 0,
                  suppressed integer not null default 0,
                  suppression_reason text,
                  agentic_decision text not null default 'not_evaluated',
                  ranking_reason text,
                  community_key text,
                  evidence text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table episode_cards (
                  id text primary key,
                  title text not null,
                  situation text not null,
                  lesson text not null default '',
                  technologies text not null default '[]',
                  change_types text not null default '[]',
                  domains text not null default '[]',
                  applicability text not null default '{}',
                  classification_status text not null default 'classified',
                  scope text not null default 'global',
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  importance integer not null default 50,
                  compile_use_count integer not null default 0,
                  status text not null default 'active',
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table episode_retrieval_feedback (
                  id text primary key,
                  episode_card_id text not null,
                  run_kind text not null,
                  run_id text not null,
                  used_for text not null,
                  verdict text not null,
                  reason text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table settings (
                  id text primary key,
                  namespace text not null,
                  key text not null,
                  value text not null default '{}',
                  value_kind text not null default 'json',
                  secret_ref text,
                  is_secret integer not null default 0,
                  description text,
                  schema_version integer not null default 1,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP,
                  updated_by text,
                  unique(namespace, key)
                );
                "#,
            )
            .unwrap();
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RepositoryIsolationFixture {
        candidates: Vec<RepositoryIsolationCandidate>,
        legacy_reproduction: LegacyReproduction,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RepositoryIsolationCandidate {
        id: String,
        entity_kind: String,
        status: String,
        classification_status: String,
        scope: String,
        project_ref: Option<String>,
        repo_key: Option<String>,
        repo_path: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyReproduction {
        goal: String,
        wrong_project_knowledge_id: String,
        unresolved_knowledge_id: String,
        expected_legacy_selected_any: Vec<String>,
    }

    fn repository_isolation_fixture() -> RepositoryIsolationFixture {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/context-compile-repository-isolation-v1.json"
        )))
        .expect("repository isolation fixture must parse")
    }

    fn seed_repository_isolation_knowledge(
        connection: &Connection,
        fixture: &RepositoryIsolationFixture,
    ) {
        for candidate in fixture
            .candidates
            .iter()
            .filter(|candidate| candidate.entity_kind == "knowledge")
        {
            let importance =
                if candidate.id == fixture.legacy_reproduction.wrong_project_knowledge_id {
                    100
                } else if candidate.id == fixture.legacy_reproduction.unresolved_knowledge_id {
                    99
                } else {
                    10
                };
            connection
                .execute(
                    r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref, repo_key,
                      repo_path, title, body, importance
                    ) values (?1, 'rule', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                    "#,
                    rusqlite::params![
                        candidate.id,
                        candidate.status,
                        candidate.scope,
                        candidate.classification_status,
                        candidate.project_ref,
                        candidate.repo_key,
                        candidate.repo_path,
                        format!("{} {}", fixture.legacy_reproduction.goal, candidate.id),
                        format!(
                            "{} verification candidate {}",
                            fixture.legacy_reproduction.goal, candidate.id
                        ),
                        importance,
                    ],
                )
                .unwrap();
        }
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap_or(0);
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }
        let body_start = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .unwrap_or(bytes.len());
        String::from_utf8_lossy(&bytes[body_start..]).to_string()
    }

    fn spawn_composer_mock(
        goal: &str,
        used_ids: &[String],
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let goal = goal.to_string();
        let used_ids = used_ids.to_vec();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_http_request(&mut stream));
                let content = if index == 0 {
                    json!({
                        "headings": {
                            "focus": "実装フォーカス",
                            "steps": "実装手順",
                            "verification": "検証観点",
                            "avoid": "注意点"
                        },
                        "includeAvoidSection": false,
                        "responseStyle": "narrative",
                        "styleConfidence": 0.9,
                        "candidateSufficiency": "enough"
                    })
                    .to_string()
                } else {
                    json!({
                        "markdown": format!("## 実装フォーカス\n- {goal}\n\n## 実装手順\n1. fixture\n\n## 検証観点\n- ids"),
                        "usedKnowledge": used_ids
                            .iter()
                            .map(|id| json!({"id": id, "confidence": 0.8}))
                            .collect::<Vec<_>>(),
                        "usedEpisodes": []
                    })
                    .to_string()
                };
                let response_body = json!({
                    "choices": [{"message": {"content": content}}]
                })
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (format!("http://{address}"), handle)
    }

    #[test]
    fn native_compile_excludes_wrong_project_and_unresolved_selection() {
        let fixture = repository_isolation_fixture();
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_minimal_compile_schema(&connection);
        seed_repository_isolation_knowledge(&connection, &fixture);
        drop(connection);

        let result = context_compile(
            &json!({"arguments": {
                "goal": fixture.legacy_reproduction.goal,
                "projectRef": "project-A"
            }}),
            &NativeToolContext::for_test(std::env::temp_dir(), db_path.clone()),
        );
        assert_ne!(result["content"][0]["text"], "No Content");

        let connection = Connection::open(&db_path).unwrap();
        let pack_ids = connection
            .prepare("select item_id from context_pack_items order by id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        let candidate_ids = connection
            .prepare(
                "select item_id from context_compile_candidate_traces where selected = 1 order by id",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(pack_ids, candidate_ids);
        assert!(!fixture
            .legacy_reproduction
            .expected_legacy_selected_any
            .iter()
            .any(|id| pack_ids.contains(id)));
        assert!(!pack_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
        assert!(!pack_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
        assert!(pack_ids.contains(&"knowledge-repo-a-project".to_string()));
        assert!(pack_ids.contains(&"knowledge-global-general".to_string()));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn split_legacy_rank_preserves_legacy_selected_ids() {
        let fixture = repository_isolation_fixture();
        let legacy_path = temp_db_path();
        let split_path = temp_db_path();
        for path in [&legacy_path, &split_path] {
            let connection = Connection::open(path).unwrap();
            create_minimal_compile_schema(&connection);
            seed_repository_isolation_knowledge(&connection, &fixture);
        }
        let arguments = json!({"arguments": {
            "goal": fixture.legacy_reproduction.goal,
            "projectRef": "project-A"
        }});
        let legacy_context = NativeToolContext::for_test(std::env::temp_dir(), legacy_path.clone());
        let mut split_context =
            NativeToolContext::for_test(std::env::temp_dir(), split_path.clone());
        split_context.compile_runtime = std::sync::Arc::new(
            crate::domains::context_compile::runtime::CompileRuntimeContext {
                mode: CompileFoundationMode::SplitLegacyRank,
                ..(*split_context.compile_runtime).clone()
            },
        );

        let legacy = context_compile(&arguments, &legacy_context);
        let split = context_compile(&arguments, &split_context);
        assert!(legacy.get("isError").is_none());
        assert!(split.get("isError").is_none());

        let selected_ids = |path: &std::path::Path| {
            let connection = Connection::open(path).unwrap();
            let ids = connection
                .prepare("select item_id from context_pack_items order by item_kind, item_id")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .flatten()
                .collect::<Vec<_>>();
            ids
        };
        assert_eq!(selected_ids(&legacy_path), selected_ids(&split_path));
        let split_pack: Value = Connection::open(&split_path)
            .unwrap()
            .query_row(
                "select pack_snapshot from context_compile_runs limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
        assert_eq!(
            split_pack["diagnostics"]["foundation"]["pipelineMode"],
            "split_legacy_rank"
        );

        let _ = std::fs::remove_file(legacy_path);
        let _ = std::fs::remove_file(split_path);
    }

    #[test]
    fn native_retrieval_applies_scope_and_facets_before_any_candidate_limit() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_minimal_compile_schema(&connection);
        let transaction = connection.transaction().unwrap();
        for index in 0..501 {
            transaction
                .execute(
                    r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref,
                      title, body, importance, applies_to
                    ) values (?1, 'rule', 'active', 'repo', 'classified', 'project-B',
                      'knowledge saturation anchor', 'wrong repository', 100, '{"general":true}')
                    "#,
                    [format!("wrong-project-{index:04}")],
                )
                .unwrap();
        }
        transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, project_ref,
                  title, body, importance, applies_to
                ) values ('knowledge-anchor', 'rule', 'active', 'repo', 'classified', 'project-A',
                  'knowledge saturation anchor', 'correct repository', 1, '{"technologies":["rust"]}')
                "#,
                [],
            )
            .unwrap();
        for index in 0..501 {
            transaction
                .execute(
                    r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref,
                      title, body, importance, applies_to
                    ) values (?1, 'rule', 'active', 'repo', 'classified', 'project-A',
                      'facet saturation anchor', 'typescript only', 100, '{"technologies":["typescript"]}')
                    "#,
                    [format!("wrong-facet-{index:04}")],
                )
                .unwrap();
        }
        transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, project_ref,
                  title, body, importance, applies_to
                ) values ('knowledge-facet-anchor', 'rule', 'active', 'repo', 'classified', 'project-A',
                  'facet saturation anchor', 'rust match', 1, '{"technologies":["rust"]}')
                "#,
                [],
            )
            .unwrap();
        for index in 0..201 {
            transaction
                .execute(
                    r#"
                    insert into episode_cards (
                      id, title, situation, lesson, technologies, classification_status,
                      scope, project_ref, importance
                    ) values (?1, 'episode saturation anchor', 'wrong repository', 'ignore',
                      '["rust"]', 'classified', 'repo', 'project-B', 100)
                    "#,
                    [format!("wrong-episode-{index:04}")],
                )
                .unwrap();
        }
        transaction
            .execute(
                r#"
                insert into episode_cards (
                  id, title, situation, lesson, technologies, classification_status,
                  scope, project_ref, importance
                ) values ('episode-anchor', 'episode saturation anchor', 'correct repository',
                  'use this', '["rust"]', 'classified', 'repo', 'project-A', 1)
                "#,
                [],
            )
            .unwrap();
        transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, title, body, importance, applies_to
                ) values ('global-anchor', 'rule', 'active', 'global', 'classified',
                  'global only anchor', 'global candidate', 1, '{"general":true}')
                "#,
                [],
            )
            .unwrap();
        transaction.commit().unwrap();

        let project_identity = resolve_compile_project_identity(
            &CompileProjectIdentityInput {
                project_ref: Some("project-A".to_string()),
                repo_key: None,
                repo_path: None,
            },
            CompileProjectIdentityTrust::RequestHint,
            None,
        )
        .unwrap();
        let rust_facets = RepositoryRequestFacets {
            technologies: vec!["rust".to_string()],
            change_types: Vec::new(),
            domains: Vec::new(),
        };

        let scoped = search_knowledge_items(
            &connection,
            "knowledge saturation anchor",
            8,
            &project_identity,
            &rust_facets,
            false,
        );
        assert!(scoped.iter().any(|item| item.id == "knowledge-anchor"));
        assert!(!scoped
            .iter()
            .any(|item| item.id.starts_with("wrong-project-")));

        let faceted = search_knowledge_items(
            &connection,
            "facet saturation anchor",
            8,
            &project_identity,
            &rust_facets,
            false,
        );
        assert!(faceted
            .iter()
            .any(|item| item.id == "knowledge-facet-anchor"));
        assert!(!faceted
            .iter()
            .any(|item| item.id.starts_with("wrong-facet-")));

        let episodes = search_episode_cards(
            &connection,
            "episode saturation anchor",
            3,
            &project_identity,
            &rust_facets,
            false,
        );
        assert!(episodes.iter().any(|item| item.id == "episode-anchor"));
        assert!(!episodes
            .iter()
            .any(|item| item.id.starts_with("wrong-episode-")));

        let global_identity = resolve_compile_project_identity(
            &CompileProjectIdentityInput::default(),
            CompileProjectIdentityTrust::RequestHint,
            None,
        )
        .unwrap();
        let global = search_knowledge_items(
            &connection,
            "global only anchor",
            8,
            &global_identity,
            &RepositoryRequestFacets::default(),
            false,
        );
        assert_eq!(
            global
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["global-anchor"]
        );
    }

    #[test]
    fn agentic_harness_observes_candidate_outbound_and_pack_ids() {
        let fixture = repository_isolation_fixture();
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_minimal_compile_schema(&connection);
        seed_repository_isolation_knowledge(&connection, &fixture);
        let expected_used_ids = vec![
            "knowledge-global-general".to_string(),
            "knowledge-global-rust".to_string(),
            "knowledge-repo-a-project".to_string(),
            "knowledge-repo-a-general".to_string(),
        ];
        let (base_url, mock_handle) =
            spawn_composer_mock(&fixture.legacy_reproduction.goal, &expected_used_ids);
        let settings = json!({
            "settings": {
                "providers": {
                    "openai": {"enabled": false, "apiBaseUrl": "https://api.openai.com/v1", "model": "gpt-test"},
                    "azure-openai": {"enabled": false, "apiBaseUrl": "", "apiPath": "/openai/deployments", "apiVersion": "2025-04-01-preview", "model": ""},
                    "local-llm": {
                        "enabled": true,
                        "apiBaseUrl": base_url,
                        "apiPath": "/chat",
                        "model": "fixture-model",
                        "models": []
                    }
                },
                "taskRouting": {
                    "agenticCompile": {
                        "enabled": true,
                        "provider": "local-llm",
                        "model": "fixture-model",
                        "fallback": [],
                        "timeoutMs": 5000,
                        "maxTokens": 512
                    }
                }
            }
        });
        connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
        drop(connection);

        let result = context_compile(
            &json!({"arguments": {
                "goal": fixture.legacy_reproduction.goal,
                "projectRef": "project-A"
            }}),
            &NativeToolContext::for_test(std::env::temp_dir(), db_path.clone()),
        );
        assert!(!result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        let outbound_requests = mock_handle.join().unwrap();

        let connection = Connection::open(&db_path).unwrap();
        let selected_ids = connection
            .prepare(
                "select item_id from context_compile_candidate_traces where selected = 1 order by id",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<BTreeSet<_>>();
        let pack_ids = connection
            .prepare("select item_id from context_pack_items order by id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<BTreeSet<_>>();
        let all_fixture_ids = fixture
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect::<Vec<_>>();
        let outbound_ids = outbound_requests
            .iter()
            .flat_map(|request| {
                let payload: Value = serde_json::from_str(request).unwrap();
                let user_content = payload["messages"]
                    .as_array()
                    .and_then(|messages| messages.iter().find(|message| message["role"] == "user"))
                    .and_then(|message| message["content"].as_str())
                    .unwrap_or_default();
                all_fixture_ids
                    .iter()
                    .filter(move |id| user_content.contains(**id))
                    .map(|id| (*id).to_string())
                    .collect::<Vec<_>>()
            })
            .collect::<BTreeSet<_>>();

        assert_eq!(selected_ids, pack_ids);
        assert!(outbound_ids.is_subset(&selected_ids));
        for expected in expected_used_ids {
            assert!(selected_ids.contains(&expected));
            assert!(outbound_ids.contains(&expected));
        }
        assert!(!selected_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
        assert!(!selected_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
        assert!(!outbound_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
        assert!(!outbound_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
        let _ = std::fs::remove_file(db_path);
    }

    fn sample_knowledge() -> Vec<PackKnowledge> {
        vec![
            PackKnowledge {
                id: "rule-1".to_string(),
                kind: "rule".to_string(),
                title: "Rust native context_compile must preserve TS composer behavior".to_string(),
                body: "Use when: migrating context_compile to Rust.\nVerification:\n- Output is composed markdown, not a raw context pack.".to_string(),
                polarity: "positive".to_string(),
                score: 10,
                query_score: 10,
                dynamic_score: 0.0,
                importance: 70.0,
                source_refs: vec![],
                scope_snapshot: json!({}),
            },
            PackKnowledge {
                id: "procedure-1".to_string(),
                kind: "procedure".to_string(),
                title: "Route context_compile through the configured composer".to_string(),
                body: "Workflow:\n1. Load runtime settings from SQLite.\n2. Use taskRouting.agenticCompile.\nVerification:\n- The result has task-focused headings.\nAvoid:\n- Do not expose ranking metadata as the user-facing answer.".to_string(),
                polarity: "positive".to_string(),
                score: 9,
                query_score: 9,
                dynamic_score: 0.0,
                importance: 70.0,
                source_refs: vec![],
                scope_snapshot: json!({}),
            },
        ]
    }

    #[test]
    fn fallback_compose_does_not_render_raw_context_pack() {
        let markdown = build_fallback_compose(
            "Rust composer fallback should follow TS output contract",
            &sample_knowledge(),
            &[],
            &ComposePlan::default(),
        );

        assert!(markdown.contains("## 実装フォーカス"));
        assert!(markdown.contains("## 実装手順"));
        assert!(markdown.contains("## 検証観点"));
        assert!(!markdown.contains("# Context Pack"));
        assert!(!markdown.contains("runId"));
        assert!(!markdown.contains("score"));
        assert!(!markdown.contains("[rule-1]"));
    }

    #[test]
    fn compile_run_insert_fails_closed_when_identity_trace_cannot_be_saved() {
        let mut connection = Connection::open_in_memory().unwrap();
        create_minimal_compile_schema(&connection);
        connection
            .execute("drop table context_compile_task_traces", [])
            .unwrap();
        let input = json!({"goal": "trace persistence", "projectRef": "project-A"});
        let pack = json!({});
        let transaction = connection.transaction().unwrap();
        let error = insert_compile_run(CompileRunInsert {
            connection: &transaction,
            run_id: "run-trace-failure",
            goal: "trace persistence",
            session_id: None,
            project_ref: Some("project-A"),
            repo_path: None,
            repo_key: None,
            match_basis: "project_ref",
            identity_contract_version: 1,
            scope_mode: "project",
            identity_fingerprint: Some(
                "0513f9c3cf83583e36682ab931ecc66a70eafc5cd40b15123fab848a60cd7407",
            ),
            identity_trust: "request_hint",
            binding_status: "not_applicable",
            input: &input,
            status: "ok",
            pack: &pack,
            duration_ms: 1,
        })
        .expect_err("missing identity trace table must fail the compile write");
        assert!(error.contains("failed to insert context_compile task trace"));
        drop(transaction);

        let run_count: i64 = connection
            .query_row("select count(*) from context_compile_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(run_count, 0);
    }

    #[test]
    fn context_compile_disabled_agentic_settings_returns_composed_fallback() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_minimal_compile_schema(&connection);
        connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body) values (?1, ?2, 'active', ?3, ?4)",
                (
                    "procedure-1",
                    "procedure",
                    "Rust composer fallback route",
                    "Workflow:\n1. Load runtime settings.\n2. Compose user-facing markdown.\nVerification:\n- No raw Context Pack is returned.",
                ),
            )
            .unwrap();
        connection
            .execute(
                "insert into episode_cards (id, title, situation, lesson, importance) values (?1, ?2, ?3, ?4, 80)",
                (
                    "episode-1",
                    "Rust composer fallback route precedent",
                    "Rust context_compile was moved to native daemon.",
                    "Keep MCP context_compile persistence in Rust, including audit signals.",
                ),
            )
            .unwrap();
        let settings = json!({
            "settings": {
                "providers": {
                    "openai": {"enabled": false, "apiBaseUrl": "https://api.openai.com/v1", "model": "gpt-test"},
                    "azure-openai": {"enabled": false, "apiBaseUrl": "", "apiPath": "/openai/deployments", "apiVersion": "2025-04-01-preview", "model": ""},
                    "local-llm": {"enabled": false, "apiBaseUrl": "http://127.0.0.1:4444", "apiPath": "/v1/chat/completions", "model": "local-test", "models": []}
                },
                "taskRouting": {
                    "agenticCompile": {
                        "enabled": false,
                        "provider": "local-llm",
                        "model": "local-test",
                        "fallback": [],
                        "timeoutMs": 1000,
                        "maxTokens": 512
                    }
                }
            }
        });
        connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
        drop(connection);

        let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
        let result = context_compile(
            &json!({"arguments": {
                "goal": "Rust composer fallback route",
                "projectRef": "project-A",
                "repoKey": "ORG/Repo-A",
                "repoPath": "/work/./repo-a"
            }}),
            &context,
        );
        let text = result["content"][0]["text"].as_str().unwrap();

        assert!(text.contains("## 実装フォーカス"));
        assert!(text.contains("## 実装手順"));
        assert!(!text.contains("# Context Pack"));
        assert!(!text.contains("runId"));
        assert!(!text.contains("score"));
        assert!(!text.contains("project-A"));
        assert!(!text.contains("/work/repo-a"));
        assert!(!result
            .get("isError")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false));

        let connection = Connection::open(&db_path).unwrap();
        let usage_rows = connection
            .query_row(
                "select count(*), sum(case when verdict = 'used' then 1 else 0 end) from knowledge_usage_events",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(usage_rows, (1, 1));
        let episode_usage_rows = connection
            .query_row(
                "select count(*), sum(case when verdict = 'used' then 1 else 0 end) from episode_retrieval_feedback",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(episode_usage_rows, (1, 1));
        let pack_kind = connection
            .query_row(
                "select item_kind from context_pack_items where run_id = (select id from context_compile_runs limit 1) limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(pack_kind, "procedure");
        let trace_rows = connection
            .query_row(
                "select count(*), sum(case when selected = 1 then 1 else 0 end) from context_compile_candidate_traces",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(trace_rows, (1, 1));
        let trace_reason = connection
            .query_row(
                "select ranking_reason from context_compile_candidate_traces limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(trace_reason, "rust_native_text_score");
        let run_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, identity_contract_version, scope_mode, input from context_compile_runs limit 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(run_identity.0, "project-A");
        assert_eq!(run_identity.1, "org/repo-a");
        assert_eq!(run_identity.2, "/work/repo-a");
        assert_eq!(run_identity.3, "project_ref");
        assert_eq!(run_identity.4, 1);
        assert_eq!(run_identity.5, "project");
        let persisted_input: Value = serde_json::from_str(&run_identity.6).unwrap();
        assert_eq!(
            persisted_input["projectIdentity"]["bindingStatus"],
            "unverified"
        );
        let trace_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, identity_fingerprint, identity_trust, binding_status from context_compile_task_traces limit 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(trace_identity.0, "project-A");
        assert_eq!(trace_identity.1, "org/repo-a");
        assert_eq!(trace_identity.2, "/work/repo-a");
        assert_eq!(trace_identity.3, "project_ref");
        assert_eq!(trace_identity.4.len(), 64);
        assert_eq!(trace_identity.5, "request_hint");
        assert_eq!(trace_identity.6, "unverified");

        let global_only = context_compile(
            &json!({"arguments": {"goal": "Rust global-only identity trace"}}),
            &context,
        );
        assert!(!global_only
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false));
        let global_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, scope_mode, input from context_compile_runs where goal = 'Rust global-only identity trace'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(global_identity.0, None);
        assert_eq!(global_identity.1, None);
        assert_eq!(global_identity.2, None);
        assert_eq!(global_identity.3, "none");
        assert_eq!(global_identity.4, "global_only");
        let global_input: Value = serde_json::from_str(&global_identity.5).unwrap();
        assert_eq!(global_input["projectIdentity"]["matchValue"], Value::Null);
        assert_eq!(
            global_input["projectIdentity"]["identityFingerprint"],
            Value::Null
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn foundation_split_persists_counter_and_diagnostic_contracts() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_minimal_compile_schema(&connection);
        connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body, dynamic_score) values ('rule-foundation', 'rule', 'active', 'Foundation split persistence', 'Persist selected counters through the SQLite writer.', -999)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body, dynamic_score) values ('rule-unmatched', 'rule', 'active', 'Unrelated candidate', 'This content has no requested terms.', 999)",
                [],
            )
            .unwrap();
        for index in 0..300 {
            connection
                .execute(
                    "insert into knowledge_items (id, type, status, title, body, dynamic_score) values (?1, 'rule', 'active', 'Unrelated candidate', 'This content has no requested terms.', 1000)",
                    [format!("rule-unmatched-{index:03}")],
                )
                .unwrap();
        }
        connection
            .execute(
                "insert into episode_cards (id, title, situation, lesson) values ('episode-foundation', 'Foundation split persistence precedent', 'A compile transaction needs verified counters.', 'Commit the pack snapshot and counter changes together.')",
                [],
            )
            .unwrap();
        drop(connection);

        let mut context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
        context.compile_runtime = std::sync::Arc::new(
            crate::domains::context_compile::runtime::CompileRuntimeContext {
                mode: CompileFoundationMode::Foundation,
                ..(*context.compile_runtime).clone()
            },
        );
        let result = context_compile(
            &json!({"arguments": {"goal": "Foundation split persistence"}}),
            &context,
        );
        assert!(result.get("isError").is_none());

        let connection = Connection::open(&db_path).unwrap();
        let knowledge_counter: i64 = connection
            .query_row(
                "select compile_select_count from knowledge_items where id = 'rule-foundation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let episode_counter: i64 = connection
            .query_row(
                "select compile_use_count from episode_cards where id = 'episode-foundation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(knowledge_counter, 1);
        assert_eq!(episode_counter, 1);
        let pack: Value = connection
            .query_row(
                "select pack_snapshot from context_compile_runs limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
        assert_eq!(pack["diagnostics"]["foundation"]["snapshotComplete"], true);
        assert_eq!(
            pack["diagnostics"]["foundation"]["pipelineMode"],
            "foundation"
        );
        assert_eq!(
            pack["diagnostics"]["foundation"]["persistence"]["knowledgeCounterUpdated"],
            1
        );
        assert_eq!(
            pack["diagnostics"]["foundation"]["persistence"]["episodeCounterUpdated"],
            1
        );
        assert_eq!(
            pack["diagnostics"]["foundation"]["candidates"]["eligibleKnowledge"],
            9
        );
        assert_eq!(
            pack["diagnostics"]["foundation"]["candidates"]["queryMatchedKnowledge"],
            1
        );
        let delivered_ids = connection
            .prepare("select item_id from context_pack_items where item_kind != 'episode'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(delivered_ids, vec!["rule-foundation"]);
        let evidence: Value = connection
            .query_row(
                "select evidence from context_compile_candidate_traces where item_id = 'rule-foundation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
        assert_eq!(evidence["foundation"]["delivered"], true);
        assert_eq!(
            evidence["foundation"]["contentVersion"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        let shadow_selected: i64 = connection
            .query_row(
                "select count(*) from context_compile_candidate_traces where item_kind != 'episode' and selected = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(shadow_selected > 0);
        let episode_trace: Value = connection
            .query_row(
                "select evidence from context_compile_candidate_traces where item_id = 'episode-foundation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
        assert_eq!(episode_trace["foundation"]["delivered"], true);
        assert_eq!(
            episode_trace["foundation"]["contentVersion"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        drop(connection);
        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn context_compile_rejects_non_string_project_identity() {
        let db_path = temp_db_path();
        let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
        let result = context_compile(
            &json!({"arguments": {"goal": "Reject malformed identity", "projectRef": 42}}),
            &context,
        );

        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("projectRef must be a string")));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn context_compile_rejects_unknown_and_control_arguments() {
        let db_path = temp_db_path();
        let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
        let unknown = context_compile(
            &json!({"arguments": {"goal": "Reject unknown argument", "tokenBudget": 1000}}),
            &context,
        );
        assert_eq!(unknown["isError"], true);
        assert!(unknown["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("unknown context_compile argument: tokenBudget")));

        let control = context_compile(
            &json!({"arguments": {"goal": "Reject control", "projectRef": "project-A\n"}}),
            &context,
        );
        assert_eq!(control["isError"], true);
        assert!(control["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("INVALID_PROJECT_REF")));

        let malformed_facets = context_compile(
            &json!({"arguments": {
                "goal": "Reject malformed facets",
                "technologies": ["Rust", 42]
            }}),
            &context,
        );
        assert_eq!(malformed_facets["isError"], true);
        assert!(malformed_facets["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("technologies must contain only non-empty strings")));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn parses_agentic_used_knowledge_from_composer_json() {
        let episodes = vec![PackEpisode {
            id: "episode-1".to_string(),
            title: "Rust native episode".to_string(),
            situation: "Rust-native compile uses episode precedent.".to_string(),
            lesson: "Persist episode retrieval feedback from composer output.".to_string(),
            score: 8,
            query_score: 8,
            importance: 50.0,
            scope_snapshot: json!({}),
        }];
        let parsed = parse_composer_payload(
            r###"{"markdown":"## 実装フォーカス\n- Rust context_compile","usedKnowledge":[{"id":"rule-1","confidence":0.82,"evidence":"applied","outputSection":"実装フォーカス","reason":"directly relevant"},{"id":"unknown","confidence":1}],"usedEpisodes":[{"id":"episode-1","confidence":0.7,"reason":"precedent applied"},{"id":"missing","confidence":1}]}"###,
            &sample_knowledge(),
            &episodes,
        )
        .unwrap();

        assert_eq!(parsed.1.len(), 1);
        assert_eq!(parsed.1[0].id, "rule-1");
        assert_eq!(parsed.1[0].confidence, 0.82);
        assert_eq!(parsed.1[0].reason.as_deref(), Some("directly relevant"));
        assert_eq!(parsed.2.len(), 1);
        assert_eq!(parsed.2[0].id, "episode-1");
        assert_eq!(parsed.2[0].reason.as_deref(), Some("precedent applied"));
    }

    #[test]
    fn goal_alignment_rejects_unrelated_markdown_without_relabeling_it_as_no_content() {
        let parsed = parse_composer_payload(
            r###"{"markdown":"## unrelated\n- This only discusses release notes.","usedKnowledge":[],"usedEpisodes":[]}"###,
            &sample_knowledge(),
            &[],
        )
        .unwrap();

        assert_ne!(parsed.0, "No Content");
        assert!(!looks_goal_aligned(
            &parsed.0,
            "Rust native context_compile composer persistence",
        ));
    }
}
