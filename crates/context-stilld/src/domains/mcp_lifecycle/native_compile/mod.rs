use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::domains::context_compile::runtime::CompileFoundationMode;

use super::native_common::{
    open_database, pseudo_uuid, request_session_id, string_arg, table_exists, tool_error,
    with_writer,
};
use super::native_tools::NativeToolContext;
use super::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput, CompileProjectIdentityTrust,
};
use super::repository_scope::RepositoryRequestFacets;

#[cfg(test)]
use composition::{build_fallback_compose, fallback_used_knowledge, parse_composer_payload};
use composition::{compose_context_response, compose_context_response_with_settings};
use persistence::{
    increment_compile_counters, insert_candidate_traces, insert_compile_items, insert_compile_run,
    insert_episode_retrieval_feedback, insert_foundation_candidate_traces,
    insert_foundation_episode_candidate_traces, insert_knowledge_usage_events, CompileRunInsert,
};
#[cfg(test)]
use prompts::looks_goal_aligned;
use providers::load_runtime_settings;
use retrieval::{
    degraded_reasons, search_episode_cards, search_knowledge_items, search_text,
    validate_retrieval_schema,
};
use telemetry::{append_foundation_telemetry, FoundationTelemetryInput};
#[cfg(test)]
use types::ComposePlan;
use types::{
    ComposeResult, PackEpisode, PackKnowledge, RuntimeSettings, UsedEpisode, UsedKnowledge,
};

mod call_metrics;
mod composition;
mod evidence;
pub(super) mod experiment;
mod persistence;
mod prompts;
mod providers;
mod retrieval;
pub(crate) mod selector;
mod telemetry;
mod test_support;
mod tests;
mod types;

fn count_provider_failovers(calls: &[call_metrics::ProviderCall]) -> usize {
    calls
        .windows(2)
        .filter(|pair| !pair[0].succeeded && pair[0].provider != pair[1].provider)
        .count()
}

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
    if let Err(error) = validate_retrieval_schema(connection) {
        return tool_error(&error);
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
    let status = if degraded_reasons.is_empty() && composed.partial_reasons.is_empty() {
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
                "partialReasons": composed.partial_reasons,
                "providerAttempts": composed.provider_calls,
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
    prepared.foundation_knowledge =
        retrieval::rank_foundation_knowledge(&prepared.candidate_knowledge);
    prepared.foundation_episodes =
        retrieval::rank_foundation_episodes(&prepared.candidate_episodes);
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
        validate_retrieval_schema(&connection)?;
        let knowledge = search_knowledge_items(
            &connection,
            &search_text,
            retrieval::KNOWLEDGE_CANDIDATE_LIMIT,
            &project_identity,
            &request_facets,
            true,
        );
        let episodes = search_episode_cards(
            &connection,
            &search_text,
            retrieval::EPISODE_CANDIDATE_LIMIT,
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
    if !composed.partial_reasons.is_empty() {
        prepared.degraded_reasons.extend(
            composed
                .partial_reasons
                .iter()
                .map(|reason| format!("CONTEXT_EVIDENCE_PARTIAL:{reason}")),
        );
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
            "logicalCalls": composed.provider_calls.len(),
            "providerAttempts": composed.provider_calls.len(),
            "failovers": count_provider_failovers(&composed.provider_calls),
            "attempts": composed.provider_calls
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
                "partialReasons": composed.partial_reasons,
                "providerAttempts": composed.provider_calls,
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

fn json_array_string(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|values| json!(values).to_string())
        .unwrap_or_else(|| "[]".to_string())
}
