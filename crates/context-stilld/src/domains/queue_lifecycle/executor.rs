use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::domains::{
    bootstrap::service::resolve_paths, daemon::repository::ProcessState,
    process_lifecycle::service as process_lifecycle_service, sqlite_writer,
};
use crate::shared::{config::EnvProvider, errors::CliError, process};

use super::episode_executor::{
    run_episode_distiller_job_for_connection, EpisodeExecutionStatus, LocalLlmTargetConfig,
};
use super::events::append_queue_event_for_connection;
use super::finding_executor::{run_finding_candidate_job_for_connection, FindingExecutionStatus};
use super::provider_lease::{
    claim_next_job_with_provider_lease_for_connection, heartbeat_provider_lease_for_connection,
    release_provider_lease_for_connection,
};
use super::state::{
    heartbeat_queue_job_for_connection, keep_queue_job_waiting_for_worker_for_connection,
};
use super::types::{
    ProviderPoolClaimConfig, ProviderQueueClaimSpec, RowTargetPreference, QUEUE_SUPERVISOR,
};

const PROVIDER_QUEUE_PRIORITY_ORDER: &[&str] = &[
    "findingCandidate",
    "coveringEvidence",
    "episodeDistiller",
    "deadZoneMergeReview",
    "mergeActivationFinalize",
    "finalizeDistille",
];

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum LocalExecutionOutcome {
    Completed,
    Failed,
    Retrying,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueExecutorTickReport {
    pub process: &'static str,
    pub action: &'static str,
    pub status: String,
    pub sqlite_status: &'static str,
    pub sqlite_core_path: String,
    pub claimed: u64,
    pub completed: u64,
    pub failed: u64,
    pub unsupported: u64,
    pub message: String,
}

pub fn run_executor_tick_report<E: EnvProvider>(
    env: &E,
) -> Result<QueueExecutorTickReport, CliError> {
    let paths = resolve_paths(env);
    let sqlite_core_path = process::path_to_string(&paths.sqlite_core_path);
    if !paths.sqlite_core_path.exists() {
        let report = QueueExecutorTickReport {
            process: QUEUE_SUPERVISOR.state_name,
            action: "executor_tick",
            status: "missing_sqlite".to_string(),
            sqlite_status: "missing",
            sqlite_core_path,
            claimed: 0,
            completed: 0,
            failed: 0,
            unsupported: 0,
            message: "queue executor skipped; SQLite core database is missing".to_string(),
        };
        write_executor_state(&paths.run_dir, &report)?;
        return Ok(report);
    }

    let config = ExecutorTickConfig {
        max_claims: env_u64_default(env, "CONTEXT_STILL_RUST_QUEUE_EXECUTOR_MAX_CLAIMS", 1).max(1),
        queue_stale_seconds: env_u64_default(env, "CONTEXT_STILL_QUEUE_STALE_SECONDS", 120)
            .clamp(30, 120),
        llm_timeout_seconds: env_u64_default(env, "CONTEXT_STILL_RUST_LLM_TIMEOUT_SECONDS", 600),
        local_llm_api_key: env.var("LOCAL_LLM_API_KEY"),
    };
    let run_dir = paths.run_dir.clone();
    sqlite_writer::execute_for_path(
        &paths.sqlite_core_path,
        "queue.executor_tick",
        move |connection| {
            run_executor_tick_with_connection(connection, sqlite_core_path, run_dir, config)
                .map_err(|error| error.to_string())
        },
    )
    .map_err(|error| CliError::io(format!("SQLite writer executor tick failed: {error}")))
}

struct ExecutorTickConfig {
    max_claims: u64,
    queue_stale_seconds: u64,
    llm_timeout_seconds: u64,
    local_llm_api_key: Option<String>,
}

fn run_executor_tick_with_connection(
    connection: &mut Connection,
    sqlite_core_path: String,
    run_dir: std::path::PathBuf,
    config: ExecutorTickConfig,
) -> Result<QueueExecutorTickReport, CliError> {
    let Some(settings) = load_settings_document(connection)? else {
        let report = idle_report(
            sqlite_core_path,
            "executor_unconfigured",
            "queue executor skipped; runtime settings are missing",
        );
        write_executor_state(&run_dir, &report)?;
        return Ok(report);
    };
    let paused_queues = load_paused_queues(connection)?;
    let pools = provider_pools(&settings);
    if pools.is_empty() {
        let report = idle_report(
            sqlite_core_path,
            "executor_unconfigured",
            "queue executor skipped; no enabled provider pools are configured",
        );
        write_executor_state(&run_dir, &report)?;
        return Ok(report);
    }

    let mut claimed = 0;
    let mut completed = 0;
    let mut failed = 0;
    let mut unsupported = 0;

    for pool in pools {
        if claimed >= config.max_claims {
            break;
        }
        let priority_queues =
            executor_priority_queues_for_pool(&settings, &pool.pool_id, &paused_queues);
        if priority_queues.is_empty() {
            continue;
        }
        let worker_id = format!(
            "context-stilld-rust-executor:{}:{}",
            pool.pool_id,
            unique_suffix()
        );
        let lease_id = format!("rust-lease-{}", unique_suffix());
        let Some(job) = claim_next_job_with_provider_lease_for_connection(
            connection,
            &pool,
            &priority_queues,
            &worker_id,
            &lease_id,
            config.queue_stale_seconds,
        )?
        else {
            continue;
        };
        claimed += 1;

        append_queue_event_best_effort(
            connection,
            &format!("rust-queue-event-{}", unique_suffix()),
            &job.queue_name,
            &job.id,
            "claimed",
            Some("job claimed by Rust resident executor"),
            Some(&format!(
                r#"{{"workerId":"{}","executor":"rust"}}"#,
                worker_id
            )),
        );
        heartbeat_claim_best_effort(connection, &job);

        if job.queue_name == "episodeDistiller" || job.queue_name == "findingCandidate" {
            let target = local_llm_target_config(&settings, &job.provider_lease.target_id)?;
            let secret_key = local_llm_target_secret_key(&settings, &job.provider_lease.target_id)?;
            let api_key = load_secret_value(connection, &secret_key).or_else(|| {
                if secret_key == "localLlmApiKey" {
                    config.local_llm_api_key.clone()
                } else {
                    None
                }
            });
            let execution_status = if job.queue_name == "findingCandidate" {
                match run_finding_candidate_job_for_connection(
                    connection,
                    &job.id,
                    &job.provider_lease.worker_id,
                    &target,
                    api_key.as_deref(),
                    config.llm_timeout_seconds,
                )? {
                    FindingExecutionStatus::Completed | FindingExecutionStatus::Skipped => {
                        LocalExecutionOutcome::Completed
                    }
                    FindingExecutionStatus::Failed => LocalExecutionOutcome::Failed,
                    FindingExecutionStatus::Retrying => LocalExecutionOutcome::Retrying,
                }
            } else {
                match run_episode_distiller_job_for_connection(
                    connection,
                    &job.id,
                    &job.provider_lease.worker_id,
                    &target,
                    api_key.as_deref(),
                    config.llm_timeout_seconds,
                )? {
                    EpisodeExecutionStatus::Completed | EpisodeExecutionStatus::Skipped => {
                        LocalExecutionOutcome::Completed
                    }
                    EpisodeExecutionStatus::Failed => LocalExecutionOutcome::Failed,
                    EpisodeExecutionStatus::Retrying => LocalExecutionOutcome::Retrying,
                }
            };
            match execution_status {
                LocalExecutionOutcome::Completed => {
                    release_provider_lease_for_connection(
                        connection,
                        &job.provider_lease.id,
                        "worker_finished",
                    )?;
                    completed += 1;
                }
                LocalExecutionOutcome::Failed => {
                    release_provider_lease_for_connection(
                        connection,
                        &job.provider_lease.id,
                        "worker_failed",
                    )?;
                    failed += 1;
                }
                LocalExecutionOutcome::Retrying => {
                    release_provider_lease_for_connection(
                        connection,
                        &job.provider_lease.id,
                        "provider_unavailable_retry",
                    )?;
                    failed += 1;
                }
            }
            continue;
        }

        let reason = format!(
            "unsupported_executor: Rust executor for {} is not implemented yet",
            job.queue_name
        );
        keep_queue_job_waiting_for_worker_for_connection(
            connection,
            &job.queue_name,
            &job.id,
            &reason,
        )?;
        append_queue_event_best_effort(
            connection,
            &format!("rust-queue-event-{}", unique_suffix()),
            &job.queue_name,
            &job.id,
            "retried",
            Some("job kept waiting because Rust executor is not implemented"),
            Some(&format!(
                r#"{{"workerId":"{}","executor":"rust","reason":"unsupported_executor"}}"#,
                worker_id
            )),
        );
        release_provider_lease_for_connection(
            connection,
            &job.provider_lease.id,
            "unsupported_executor",
        )?;
        unsupported += 1;
    }

    let status = if claimed == 0 {
        "idle"
    } else if unsupported > 0 {
        "unsupported"
    } else if failed > 0 {
        "degraded"
    } else {
        "executed"
    };
    let report = QueueExecutorTickReport {
        process: QUEUE_SUPERVISOR.state_name,
        action: "executor_tick",
        status: status.to_string(),
        sqlite_status: "ok",
        sqlite_core_path,
        claimed,
        completed,
        failed,
        unsupported,
        message: format!(
            "queue executor tick completed; claimed={claimed} completed={completed} failed={failed} unsupported={unsupported}"
        ),
    };
    write_executor_state(&run_dir, &report)?;
    Ok(report)
}

fn append_queue_event_best_effort(
    connection: &Connection,
    event_id: &str,
    queue_name: &str,
    queue_job_id: &str,
    event_type: &str,
    message: Option<&str>,
    metadata_json: Option<&str>,
) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        event_id,
        queue_name,
        queue_job_id,
        event_type,
        message,
        metadata_json,
    ) {
        eprintln!("failed to append {queue_name}/{queue_job_id} {event_type} queue event: {error}");
    }
}

fn heartbeat_claim_best_effort(
    connection: &Connection,
    job: &super::types::ClaimedProviderLeaseJob,
) {
    if let Err(error) = heartbeat_queue_job_for_connection(connection, &job.queue_name, &job.id) {
        eprintln!(
            "failed to heartbeat newly claimed {}/{} queue job: {error}",
            job.queue_name, job.id
        );
    }
    if let Err(error) = heartbeat_provider_lease_for_connection(connection, &job.provider_lease.id)
    {
        eprintln!(
            "failed to heartbeat newly claimed {} provider lease: {error}",
            job.provider_lease.id
        );
    }
}

fn idle_report(sqlite_core_path: String, status: &str, message: &str) -> QueueExecutorTickReport {
    QueueExecutorTickReport {
        process: QUEUE_SUPERVISOR.state_name,
        action: "executor_tick",
        status: status.to_string(),
        sqlite_status: "ok",
        sqlite_core_path,
        claimed: 0,
        completed: 0,
        failed: 0,
        unsupported: 0,
        message: message.to_string(),
    }
}

fn load_settings_document(connection: &Connection) -> Result<Option<Value>, CliError> {
    if !table_exists(connection, "settings")? {
        return Ok(None);
    }
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime' and key = 'settings.v1' limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .or_else(|_| {
            connection.query_row(
                "select value from settings where key = 'settings.v1' limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .ok();
    let Some(value) = value else {
        return Ok(None);
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse runtime settings: {error}")))?;
    Ok(Some(document.get("settings").cloned().unwrap_or(document)))
}

fn load_paused_queues(connection: &Connection) -> Result<HashSet<String>, CliError> {
    if !table_exists(connection, "settings")? {
        return Ok(HashSet::new());
    }
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime' and key = 'queue.controls.v1' limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .or_else(|_| {
            connection.query_row(
                "select value from settings where key = 'queue.controls.v1' limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .ok();
    let Some(value) = value else {
        return Ok(HashSet::new());
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse queue controls: {error}")))?;
    let queues = document
        .get("queues")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|queues| queues.iter())
        .filter_map(|(queue_name, control)| {
            control
                .get("paused")
                .and_then(Value::as_bool)
                .filter(|paused| *paused)
                .map(|_| queue_name.clone())
        })
        .collect();
    Ok(queues)
}

fn provider_pools(settings: &Value) -> Vec<ProviderPoolClaimConfig> {
    let legacy_pools = legacy_provider_pool_configs(settings);
    let mut route_targets: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for route in task_routing_routes(settings) {
        let Some(group_id) = route_claim_group_id(route) else {
            continue;
        };
        let targets = if route_provider_pool_id(route).is_some() {
            legacy_pools
                .get(&group_id)
                .map(|pool| pool.targets.clone())
                .unwrap_or_default()
        } else {
            local_llm_route_target_ids(settings, route)
        };
        if targets.is_empty() {
            continue;
        }
        route_targets
            .entry(group_id)
            .or_default()
            .extend(targets.into_iter());
    }

    route_targets
        .into_iter()
        .map(|(pool_id, targets)| {
            let target_count = targets.len() as u64;
            let legacy = legacy_pools.get(&pool_id);
            ProviderPoolClaimConfig {
                pool_id,
                targets: targets.into_iter().collect(),
                max_concurrent: legacy
                    .map(|pool| pool.max_concurrent)
                    .unwrap_or(target_count)
                    .max(1),
                stale_lease_seconds: legacy.map(|pool| pool.stale_lease_seconds).unwrap_or(120),
                low_priority_aging_seconds: legacy
                    .map(|pool| pool.low_priority_aging_seconds)
                    .unwrap_or(1800),
            }
        })
        .collect()
}

fn legacy_provider_pool_configs(settings: &Value) -> BTreeMap<String, ProviderPoolClaimConfig> {
    settings
        .get("providerPools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pool| {
            if pool
                .get("enabled")
                .and_then(Value::as_bool)
                .is_some_and(|enabled| !enabled)
            {
                return None;
            }
            let pool_id = string_field(pool, "id")?;
            let targets = pool
                .get("targets")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(target_id)
                .collect::<Vec<_>>();
            if targets.is_empty() {
                return None;
            }
            Some(ProviderPoolClaimConfig {
                pool_id,
                targets,
                max_concurrent: pool
                    .get("maxConcurrent")
                    .and_then(Value::as_u64)
                    .unwrap_or(1),
                stale_lease_seconds: pool
                    .get("staleLeaseSeconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(120),
                low_priority_aging_seconds: pool
                    .get("lowPriorityAgingSeconds")
                    .and_then(Value::as_u64)
                    .unwrap_or(1800),
            })
        })
        .map(|pool| (pool.pool_id.clone(), pool))
        .collect()
}

fn task_routing_routes(settings: &Value) -> Vec<&Value> {
    [
        "/taskRouting/findCandidate/source",
        "/taskRouting/findCandidate/vibe",
        "/taskRouting/webSourceResearch",
        "/taskRouting/episodeDistiller",
        "/taskRouting/coverEvidence/sourceSupport",
        "/taskRouting/coverEvidence/externalEvidence",
        "/taskRouting/coverEvidence/mcpEvidence",
        "/taskRouting/deadZoneMergeReview",
        "/taskRouting/mergeActivationFinalize",
        "/taskRouting/finalizeDistille",
    ]
    .into_iter()
    .filter_map(|pointer| settings.pointer(pointer))
    .collect()
}

fn priority_queues_for_pool(
    settings: &Value,
    pool_id: &str,
    paused_queues: &HashSet<String>,
) -> Vec<ProviderQueueClaimSpec> {
    PROVIDER_QUEUE_PRIORITY_ORDER
        .iter()
        .filter(|queue_name| !paused_queues.contains(**queue_name))
        .filter_map(|queue_name| queue_spec_for_pool(settings, queue_name, pool_id))
        .collect()
}

fn executor_priority_queues_for_pool(
    settings: &Value,
    pool_id: &str,
    paused_queues: &HashSet<String>,
) -> Vec<ProviderQueueClaimSpec> {
    priority_queues_for_pool(settings, pool_id, paused_queues)
        .into_iter()
        .filter(|spec| rust_executor_supports_queue(&spec.queue_name))
        .collect()
}

fn rust_executor_supports_queue(queue_name: &str) -> bool {
    matches!(queue_name, "findingCandidate" | "episodeDistiller")
}

fn queue_spec_for_pool(
    settings: &Value,
    queue_name: &str,
    pool_id: &str,
) -> Option<ProviderQueueClaimSpec> {
    match queue_name {
        "findingCandidate" => {
            let source_targets = route_target_preference(
                settings,
                settings.pointer("/taskRouting/findCandidate/source"),
                pool_id,
            );
            let vibe_targets = route_target_preference(
                settings,
                settings.pointer("/taskRouting/findCandidate/vibe"),
                pool_id,
            );
            if source_targets.is_none() && vibe_targets.is_none() {
                return None;
            }
            let source_targets = source_targets.unwrap_or_default();
            let vibe_targets = vibe_targets.unwrap_or_default();
            let mut preferences = Vec::new();
            if !vibe_targets.is_empty() {
                preferences.push(RowTargetPreference {
                    value: "vibe_memory".to_string(),
                    preferred_target_ids: vibe_targets,
                });
            }
            for value in ["knowledge_candidate", "web_ingest", "wiki_file", "source"] {
                if !source_targets.is_empty() {
                    preferences.push(RowTargetPreference {
                        value: value.to_string(),
                        preferred_target_ids: source_targets.clone(),
                    });
                }
            }
            Some(ProviderQueueClaimSpec {
                queue_name: queue_name.to_string(),
                preferred_target_ids: source_targets,
                route_target_column: Some("source_kind"),
                route_target_preferences: preferences,
                allowed_route_values: Some(vec!["vibe_memory".to_string()]),
            })
        }
        "episodeDistiller" => simple_route_spec(
            settings,
            queue_name,
            settings.pointer("/taskRouting/episodeDistiller"),
            pool_id,
        ),
        "coveringEvidence" => {
            let mut matched_route = false;
            let mut targets = BTreeSet::new();
            for pointer in [
                "/taskRouting/coverEvidence/sourceSupport",
                "/taskRouting/coverEvidence/externalEvidence",
                "/taskRouting/coverEvidence/mcpEvidence",
            ] {
                if let Some(route_targets) =
                    route_target_preference(settings, settings.pointer(pointer), pool_id)
                {
                    matched_route = true;
                    for target in route_targets {
                        targets.insert(target);
                    }
                }
            }
            if !matched_route {
                return None;
            }
            Some(ProviderQueueClaimSpec {
                queue_name: queue_name.to_string(),
                preferred_target_ids: targets.into_iter().collect(),
                route_target_column: Some("provider_policy"),
                route_target_preferences: Vec::new(),
                allowed_route_values: None,
            })
        }
        "deadZoneMergeReview" => simple_route_spec(
            settings,
            queue_name,
            settings.pointer("/taskRouting/deadZoneMergeReview"),
            pool_id,
        ),
        "mergeActivationFinalize" => simple_route_spec(
            settings,
            queue_name,
            settings.pointer("/taskRouting/mergeActivationFinalize"),
            pool_id,
        ),
        "finalizeDistille" => simple_route_spec(
            settings,
            queue_name,
            settings.pointer("/taskRouting/finalizeDistille"),
            pool_id,
        ),
        _ => None,
    }
}

fn simple_route_spec(
    settings: &Value,
    queue_name: &str,
    route: Option<&Value>,
    pool_id: &str,
) -> Option<ProviderQueueClaimSpec> {
    let targets = route_target_preference(settings, route, pool_id)?;
    Some(ProviderQueueClaimSpec {
        queue_name: queue_name.to_string(),
        preferred_target_ids: targets,
        route_target_column: None,
        route_target_preferences: Vec::new(),
        allowed_route_values: None,
    })
}

fn route_target_preference(
    settings: &Value,
    route: Option<&Value>,
    pool_id: &str,
) -> Option<Vec<String>> {
    let route = route?;
    if route_claim_group_id(route).as_deref() != Some(pool_id) {
        return None;
    }
    if route_provider_pool_id(route).is_some() {
        return Some(Vec::new());
    }
    let targets = local_llm_route_target_ids(settings, route);
    if targets.is_empty() {
        None
    } else {
        Some(targets)
    }
}

fn route_claim_group_id(route: &Value) -> Option<String> {
    if string_field(route, "provider").as_deref() != Some("local-llm") {
        return None;
    }
    route_provider_pool_id(route)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some("task-routing:local-llm".to_string()))
}

fn route_provider_pool_id(route: &Value) -> Option<String> {
    string_field(route, "providerPoolId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn local_llm_route_target_ids(settings: &Value, route: &Value) -> Vec<String> {
    if string_field(route, "provider").as_deref() != Some("local-llm") {
        return Vec::new();
    }
    let Some(target) =
        string_field(route, "localLlmModel").or_else(|| string_field(route, "model"))
    else {
        return Vec::new();
    };
    preferred_local_llm_target_ids(settings, &target)
}

fn preferred_local_llm_target_ids(settings: &Value, route_target: &str) -> Vec<String> {
    let parsed = parse_local_llm_route_target(route_target);
    settings
        .pointer("/providers/local-llm/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = local_llm_model_id(model)?;
            if id == route_target || string_field(model, "model").as_deref() == Some(route_target) {
                return Some(id);
            }
            let (api_base_url, api_path, model_name) = parsed.as_ref()?;
            let model_api_base_url = string_field(model, "apiBaseUrl")
                .map(|value| value.trim_end_matches('/').to_string());
            let model_api_path = string_field(model, "apiPath");
            let model_model = string_field(model, "model");
            if model_api_base_url.as_deref() == Some(api_base_url.as_str())
                && api_path
                    .as_ref()
                    .map(|expected| model_api_path.as_deref() == Some(expected.as_str()))
                    .unwrap_or(true)
                && model_model.as_deref() == Some(model_name.as_str())
            {
                Some(id)
            } else {
                None
            }
        })
        .collect()
}

fn parse_local_llm_route_target(value: &str) -> Option<(String, Option<String>, String)> {
    let parsed = serde_json::from_str::<Value>(value).ok()?;
    let api_base_url = string_field(&parsed, "apiBaseUrl")?
        .trim_end_matches('/')
        .to_string();
    let api_path = string_field(&parsed, "apiPath");
    let model = string_field(&parsed, "model")?;
    Some((api_base_url, api_path, model))
}

fn target_id(target: &Value) -> Option<String> {
    match string_field(target, "provider").as_deref() {
        Some("local-llm") => string_field(target, "localLlmModelId"),
        Some("azure-openai") => target.get("deploymentSlot").and_then(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
        }),
        _ => string_field(target, "targetId"),
    }
}

fn local_llm_target_config(
    settings: &Value,
    target_id: &str,
) -> Result<LocalLlmTargetConfig, CliError> {
    let provider = settings
        .pointer("/providers/local-llm")
        .ok_or_else(|| CliError::io("local-llm provider settings are missing"))?;
    let target = provider
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|model| local_llm_model_id(model).as_deref() == Some(target_id))
        .ok_or_else(|| CliError::io(format!("local-llm target not found: {target_id}")))?;
    let api_base_url = string_field(target, "apiBaseUrl")
        .or_else(|| string_field(provider, "apiBaseUrl"))
        .ok_or_else(|| CliError::io(format!("local-llm target {target_id} has no apiBaseUrl")))?;
    let api_path = string_field(target, "apiPath")
        .or_else(|| string_field(provider, "apiPath"))
        .unwrap_or_else(|| "/v1/chat/completions".to_string());
    let model = string_field(target, "model")
        .or_else(|| string_field(provider, "model"))
        .ok_or_else(|| CliError::io(format!("local-llm target {target_id} has no model")))?;
    Ok(LocalLlmTargetConfig {
        target_id: target_id.to_string(),
        api_base_url: api_base_url.trim_end_matches('/').to_string(),
        api_path,
        model,
    })
}

fn local_llm_target_secret_key(settings: &Value, target_id: &str) -> Result<String, CliError> {
    let provider = settings
        .pointer("/providers/local-llm")
        .ok_or_else(|| CliError::io("local-llm provider settings are missing"))?;
    let target_index = provider
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .position(|model| local_llm_model_id(model).as_deref() == Some(target_id))
        .ok_or_else(|| CliError::io(format!("local-llm target not found: {target_id}")))?;
    Ok(if target_index == 0 {
        "localLlmApiKey".to_string()
    } else {
        format!("localLlmApiKey{}", target_index + 1)
    })
}

fn local_llm_model_id(model: &Value) -> Option<String> {
    string_field(model, "id").or_else(|| stable_local_llm_model_id(model))
}

fn stable_local_llm_model_id(model: &Value) -> Option<String> {
    let api_base_url = string_field(model, "apiBaseUrl")?
        .trim_end_matches('/')
        .to_string();
    let api_path =
        string_field(model, "apiPath").unwrap_or_else(|| "/v1/chat/completions".to_string());
    let model_name = string_field(model, "model")?;
    let normalized = serde_json::json!({
        "apiBaseUrl": api_base_url,
        "apiPath": api_path.trim(),
        "model": model_name.trim()
    })
    .to_string();
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    Some(format!("local-llm-{}", &digest[..12]))
}

fn load_secret_value(connection: &Connection, key: &str) -> Option<String> {
    if !table_exists(connection, "settings").ok()? {
        return None;
    }
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime.secret' and key = ?1 limit 1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let parsed = serde_json::from_str::<Value>(&value).ok()?;
    string_field(&parsed, "value")
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect SQLite table {table_name}: {error}"
            ))
        })
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn write_executor_state(
    run_dir: &std::path::Path,
    report: &QueueExecutorTickReport,
) -> Result<(), CliError> {
    let state = ProcessState {
        pid: None,
        status: report.status.clone(),
        log_path: String::new(),
        started_at: None,
        updated_at: Some(process_lifecycle_service::now_timestamp()),
        last_error: if report.status == "unsupported" || report.status == "executor_unconfigured" {
            Some(report.message.clone())
        } else {
            None
        },
        command: Some("context-stilld".to_string()),
        args: Some(vec!["queue".to_string(), "executor_tick".to_string()]),
        sqlite_core_path: Some(report.sqlite_core_path.clone()),
        ..ProcessState::default()
    };
    process_lifecycle_service::write_process_state(&QUEUE_SUPERVISOR, run_dir, &state)
}

impl QueueExecutorTickReport {
    pub fn to_text(&self) -> String {
        self.message.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use crate::shared::config::MapEnv;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn rust_executor_tick_does_not_claim_unsupported_queue() {
        let app_dir = temp_app_dir("executor_tick");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_provider_claim_queue_table(&connection, "covering_evidence_queue");
        create_queue_events_table(&connection);
        create_provider_lease_table(&connection);
        connection
            .execute_batch(
                r#"
                create table settings (
                  id text primary key,
                  namespace text not null,
                  key text not null,
                  value text not null
                );
                insert into covering_evidence_queue (
                  id, status, priority, created_at, updated_at, next_run_at
                ) values (
                  'job-1', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null
                );
                "#,
            )
            .unwrap();
        let settings = json!({
            "settings": {
                "providerPools": [{
                    "id": "local-llm-default",
                    "enabled": true,
                    "targets": [{"provider": "local-llm", "localLlmModelId": "local-b"}],
                    "maxConcurrent": 1,
                    "staleLeaseSeconds": 120,
                    "lowPriorityAgingSeconds": 1800
                }],
                "providers": {
                    "local-llm": {
                        "models": [{"id": "local-b", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"}]
                    }
                },
                "taskRouting": {
                    "coverEvidence": {
                        "sourceSupport": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
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

        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);

        let report = run_executor_tick_report(&env).unwrap();

        assert_eq!(report.status, "idle");
        assert_eq!(report.claimed, 0);
        assert_eq!(report.unsupported, 0);
        let connection = Connection::open(&sqlite_path).unwrap();
        let row = connection
            .query_row(
                "select status, last_outcome_kind, last_error is not null, next_run_at is not null from covering_evidence_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, ("pending".to_string(), None, 0, 0));
        let active_leases: i64 = connection
            .query_row(
                "select count(*) from llm_provider_leases where status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_leases, 0);
        let retried_events: i64 = connection
            .query_row(
                "select count(*) from distillation_queue_events where event_type = 'retried'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retried_events, 0);

        std::fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn rust_executor_includes_supported_queues() {
        let settings = json!({
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": "local-a"}],
                "maxConcurrent": 1
            }],
            "providers": {
                "local-llm": {
                    "models": [{"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"}]
                }
            },
            "taskRouting": {
                "findCandidate": {
                    "source": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "vibe": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
                },
                "episodeDistiller": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
            }
        });

        let queues =
            executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());

        assert_eq!(
            queues
                .iter()
                .map(|queue| queue.queue_name.as_str())
                .collect::<Vec<_>>(),
            vec!["findingCandidate", "episodeDistiller"]
        );
        assert_eq!(
            queues[0].allowed_route_values,
            Some(vec!["vibe_memory".to_string()])
        );
    }

    #[test]
    fn rust_executor_resolves_stable_local_llm_target_ids_when_model_id_is_absent() {
        let model = json!({
            "apiBaseUrl": "http://192.168.0.61:50043/v1",
            "apiPath": "/v1/chat/completions",
            "model": "Qwen 3.6 27B"
        });
        let target_id = local_llm_model_id(&model).unwrap();
        assert_eq!(target_id, "local-llm-3aeb3b705406");
        let settings = json!({
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": target_id}],
                "maxConcurrent": 1
            }],
            "providers": {
                "local-llm": {
                    "models": [model]
                }
            },
            "taskRouting": {
                "episodeDistiller": {
                    "provider": "local-llm",
                    "providerPoolId": "local-llm-default",
                    "model": "{\"apiBaseUrl\":\"http://192.168.0.61:50043/v1\",\"apiPath\":\"/v1/chat/completions\",\"model\":\"Qwen 3.6 27B\"}"
                }
            }
        });

        let queues =
            executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());
        assert_eq!(queues.len(), 1);
        assert_eq!(queues[0].queue_name, "episodeDistiller");
        assert_eq!(queues[0].preferred_target_ids, Vec::<String>::new());
        let target = local_llm_target_config(&settings, &target_id).unwrap();
        assert_eq!(target.model, "Qwen 3.6 27B");
    }

    #[test]
    fn rust_executor_keeps_provider_pool_targets_as_membership_source_of_truth() {
        let settings = json!({
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [{"provider": "local-llm", "localLlmModelId": "local-a"}],
                "maxConcurrent": 2,
                "staleLeaseSeconds": 120,
                "lowPriorityAgingSeconds": 1800
            }],
            "providers": {
                "local-llm": {
                    "models": [
                        {"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "old"},
                        {"id": "local-b", "apiBaseUrl": "http://localhost:2", "apiPath": "/v1/chat/completions", "model": "route-target"}
                    ]
                }
            },
            "taskRouting": {
                "episodeDistiller": {
                    "provider": "local-llm",
                    "providerPoolId": "local-llm-default",
                    "model": "route-target"
                }
            }
        });

        let pools = provider_pools(&settings);
        assert_eq!(pools.len(), 1);
        assert_eq!(pools[0].pool_id, "local-llm-default");
        assert_eq!(pools[0].targets, vec!["local-a".to_string()]);

        let queues =
            executor_priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new());
        assert_eq!(queues.len(), 1);
        assert_eq!(queues[0].queue_name, "episodeDistiller");
        assert_eq!(queues[0].preferred_target_ids, Vec::<String>::new());
    }

    #[test]
    fn rust_executor_treats_provider_pool_routes_as_pool_wide_selection() {
        let settings = json!({
            "providerPools": [{
                "id": "local-llm-default",
                "enabled": true,
                "targets": [
                    {"provider": "local-llm", "localLlmModelId": "local-a"},
                    {"provider": "local-llm", "localLlmModelId": "local-b"}
                ],
                "maxConcurrent": 2,
                "staleLeaseSeconds": 120,
                "lowPriorityAgingSeconds": 1800
            }],
            "providers": {
                "local-llm": {
                    "models": [
                        {"id": "local-a", "apiBaseUrl": "http://localhost:1", "apiPath": "/v1/chat/completions", "model": "qwen"},
                        {"id": "local-b", "apiBaseUrl": "http://localhost:2", "apiPath": "/v1/chat/completions", "model": "qwen"}
                    ]
                }
            },
            "taskRouting": {
                "findCandidate": {
                    "source": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "vibe": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
                },
                "coverEvidence": {
                    "sourceSupport": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "externalEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"},
                    "mcpEvidence": {"provider": "local-llm", "providerPoolId": "local-llm-default", "model": "qwen"}
                }
            }
        });

        let finding = priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new())
            .into_iter()
            .find(|queue| queue.queue_name == "findingCandidate")
            .unwrap();
        assert_eq!(finding.preferred_target_ids, Vec::<String>::new());
        assert!(finding.route_target_preferences.is_empty());

        let covering = priority_queues_for_pool(&settings, "local-llm-default", &HashSet::new())
            .into_iter()
            .find(|queue| queue.queue_name == "coveringEvidence")
            .unwrap();
        assert_eq!(covering.preferred_target_ids, Vec::<String>::new());
    }
}
