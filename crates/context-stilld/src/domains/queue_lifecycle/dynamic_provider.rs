use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::domains::{
    provider_connection::{LarmConnectionConfig, LarmConnectionManager},
    sqlite_writer,
};
use crate::shared::errors::CliError;

use super::common::queue_table_name;
use super::episode_executor::LocalLlmTargetConfig;
use super::events::append_queue_event_for_connection;
use super::provider_execution::open_query_only_connection;
use super::provider_lease::{
    claim_next_job_with_provider_lease_for_connection, heartbeat_provider_lease_for_connection,
};
use super::state::heartbeat_queue_job_for_connection;
use super::types::{
    CandidatePolarityFilter, ClaimedProviderLeaseJob, ProviderPoolClaimConfig,
    ProviderQueueClaimSpec,
};

#[derive(Debug, Clone)]
struct DynamicProviderPlan {
    connection: LarmConnectionConfig,
    pool: ProviderPoolClaimConfig,
    priority_queues: Vec<ProviderQueueClaimSpec>,
}

pub(crate) struct DynamicProviderClaim {
    pub(crate) job: ClaimedProviderLeaseJob,
    pub(crate) target: LocalLlmTargetConfig,
    pub(crate) api_key: Option<Zeroizing<String>>,
    pub(crate) request_timeout_seconds: u64,
    _manager: LarmManagerCheckout,
}

static LARM_CONNECTION_MANAGERS: OnceLock<Mutex<BTreeMap<String, LarmConnectionManager>>> =
    OnceLock::new();

struct LarmManagerCheckout {
    connection_id: String,
    manager: Option<LarmConnectionManager>,
}

impl LarmManagerCheckout {
    fn take(config: &LarmConnectionConfig) -> Result<Self, CliError> {
        let registry = LARM_CONNECTION_MANAGERS.get_or_init(|| Mutex::new(BTreeMap::new()));
        let mut registry = registry
            .lock()
            .map_err(|_| CliError::runtime("LARM connection manager registry is poisoned"))?;
        let mut manager = registry.remove(&config.id);
        if manager
            .as_ref()
            .is_some_and(|manager| manager.config() != config)
        {
            if let Some(mut stale) = manager.take() {
                let _ = stale.release();
            }
        }
        let manager = match manager {
            Some(manager) => manager,
            None => LarmConnectionManager::new(config.clone()).map_err(|error| {
                CliError::io(format!(
                    "failed to initialize LARM connection {}: {error}",
                    config.id
                ))
            })?,
        };
        Ok(Self {
            connection_id: config.id.clone(),
            manager: Some(manager),
        })
    }

    fn manager_mut(&mut self) -> &mut LarmConnectionManager {
        self.manager
            .as_mut()
            .expect("checked-out LARM manager must exist")
    }
}

impl Drop for LarmManagerCheckout {
    fn drop(&mut self) {
        let Some(manager) = self.manager.take() else {
            return;
        };
        let registry = LARM_CONNECTION_MANAGERS.get_or_init(|| Mutex::new(BTreeMap::new()));
        if let Ok(mut registry) = registry.lock() {
            registry.insert(self.connection_id.clone(), manager);
        }
    }
}

fn release_unreferenced_larm_managers(active_connection_ids: &BTreeSet<String>) {
    let Some(registry) = LARM_CONNECTION_MANAGERS.get() else {
        return;
    };
    let Ok(mut registry) = registry.lock() else {
        return;
    };
    let stale_ids = registry
        .keys()
        .filter(|connection_id| !active_connection_ids.contains(*connection_id))
        .cloned()
        .collect::<Vec<_>>();
    for connection_id in stale_ids {
        if let Some(mut manager) = registry.remove(&connection_id) {
            let _ = manager.release();
        }
    }
}

pub(crate) fn release_dynamic_provider_connections() {
    release_unreferenced_larm_managers(&BTreeSet::new());
}

pub(crate) fn dynamic_provider_routes_configured(
    sqlite_path: &std::path::Path,
) -> Result<bool, CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let Some(settings) = load_settings_document(&reader)? else {
        return Ok(false);
    };
    let configured = settings
        .pointer("/providers/larm-agent-connection/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && task_routing_routes(&settings)
            .into_iter()
            .any(is_larm_route);
    if !configured {
        release_unreferenced_larm_managers(&BTreeSet::new());
    }
    Ok(configured)
}

pub(crate) fn claim_dynamic_provider_execution_for_path(
    sqlite_path: &std::path::Path,
    queue_stale_seconds: u64,
) -> Result<Option<DynamicProviderClaim>, CliError> {
    let reader = open_query_only_connection(sqlite_path)?;
    let Some(settings) = load_settings_document(&reader)? else {
        return Ok(None);
    };
    let paused_queues = load_paused_queues(&reader)?;
    let plans = dynamic_provider_plans(&settings, &paused_queues)?;
    let active_connection_ids = plans
        .iter()
        .map(|plan| plan.connection.id.clone())
        .collect::<BTreeSet<_>>();
    release_unreferenced_larm_managers(&active_connection_ids);

    for plan in plans {
        let due_job_exists = dynamic_plan_has_runnable_job(&reader, &plan)?;
        let mut manager = LarmManagerCheckout::take(&plan.connection)?;
        let reconciled = match manager.manager_mut().reconcile(due_job_exists) {
            Ok(reconciled) => reconciled,
            Err(error) => {
                eprintln!(
                    "LARM connection {} is unavailable; queue remains unclaimed: {error}",
                    plan.connection.id
                );
                continue;
            }
        };
        if !due_job_exists || !reconciled.ready {
            continue;
        }
        let claimed_target = manager
            .manager_mut()
            .target()
            .ok_or_else(|| CliError::runtime("ready LARM manager has no claimed target"))?;
        let target = LocalLlmTargetConfig {
            target_id: plan.pool.targets[0].clone(),
            api_base_url: claimed_target.api_base_url.clone(),
            api_path: "/v1/chat/completions".to_string(),
            model: claimed_target.model.clone(),
        };
        let api_key = Some(Zeroizing::new(
            claimed_target.bearer_token.as_str().to_string(),
        ));
        let worker_id = format!(
            "context-stilld-rust-executor:{}:{}",
            plan.pool.pool_id,
            unique_suffix()
        );
        let lease_id = format!("rust-lease-{}", unique_suffix());
        let pool = plan.pool.clone();
        let priority_queues = plan.priority_queues.clone();
        let job = sqlite_writer::execute_for_path(
            sqlite_path,
            "queue.dynamic_provider_claim",
            move |connection| {
                let job = claim_next_job_with_provider_lease_for_connection(
                    connection,
                    &pool,
                    &priority_queues,
                    &worker_id,
                    &lease_id,
                    queue_stale_seconds,
                )
                .map_err(|error| error.to_string())?;
                if let Some(job) = job.as_ref() {
                    append_claimed_event(connection, job, &worker_id);
                    heartbeat_claim(connection, job);
                }
                Ok(job)
            },
        )
        .map_err(|error| CliError::io(format!("SQLite writer dynamic claim failed: {error}")))?;
        let Some(job) = job else {
            continue;
        };
        return Ok(Some(DynamicProviderClaim {
            job,
            target,
            api_key,
            request_timeout_seconds: plan.connection.request_timeout_ms.div_ceil(1_000),
            _manager: manager,
        }));
    }
    Ok(None)
}

fn append_claimed_event(connection: &Connection, job: &ClaimedProviderLeaseJob, worker_id: &str) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        &format!("rust-queue-event-{}", unique_suffix()),
        &job.queue_name,
        &job.id,
        "claimed",
        Some("job claimed for dynamic LARM execution"),
        Some(
            &json!({
                "workerId": worker_id,
                "executor": "rust",
                "providerKind": "larm-agent-connection"
            })
            .to_string(),
        ),
    ) {
        eprintln!(
            "failed to append dynamic {}/{} claimed queue event: {error}",
            job.queue_name, job.id
        );
    }
}

fn heartbeat_claim(connection: &Connection, job: &ClaimedProviderLeaseJob) {
    if let Err(error) = heartbeat_queue_job_for_connection(connection, &job.queue_name, &job.id) {
        eprintln!(
            "failed to heartbeat newly claimed dynamic {}/{} queue job: {error}",
            job.queue_name, job.id
        );
    }
    if let Err(error) = heartbeat_provider_lease_for_connection(connection, &job.provider_lease.id)
    {
        eprintln!(
            "failed to heartbeat newly claimed dynamic provider lease {}: {error}",
            job.provider_lease.id
        );
    }
}

fn dynamic_provider_plans(
    settings: &Value,
    paused_queues: &HashSet<String>,
) -> Result<Vec<DynamicProviderPlan>, CliError> {
    let connection_ids = task_routing_routes(settings)
        .into_iter()
        .filter(|route| is_larm_route(route))
        .filter_map(|route| string_field(route, "connectionId"))
        .collect::<BTreeSet<_>>();
    let mut plans = Vec::new();
    for connection_id in connection_ids {
        let Some(connection) = LarmConnectionConfig::from_settings(settings, &connection_id)
            .map_err(|error| {
                CliError::invalid_arguments(format!(
                    "invalid LARM connection {connection_id}: {error}"
                ))
            })?
        else {
            continue;
        };
        let target_id = format!("larm-agent-connection:{connection_id}");
        let mut priority_queues = Vec::new();
        push_finding_plan(
            settings,
            paused_queues,
            &connection_id,
            &target_id,
            &mut priority_queues,
        );
        push_episode_plan(
            settings,
            paused_queues,
            &connection_id,
            &target_id,
            &mut priority_queues,
        );
        if priority_queues.is_empty() {
            continue;
        }
        plans.push(DynamicProviderPlan {
            pool: ProviderPoolClaimConfig {
                pool_id: target_id.clone(),
                targets: vec![target_id],
                max_concurrent: 1,
                stale_lease_seconds: connection.ttl_seconds.min(900),
                low_priority_aging_seconds: 1800,
            },
            connection,
            priority_queues,
        });
    }
    Ok(plans)
}

fn push_finding_plan(
    settings: &Value,
    paused_queues: &HashSet<String>,
    connection_id: &str,
    target_id: &str,
    queues: &mut Vec<ProviderQueueClaimSpec>,
) {
    if paused_queues.contains("findingCandidate") {
        return;
    }
    let source_connection = route_connection_id(settings, "/taskRouting/findCandidate/source");
    let vibe_connection = route_connection_id(settings, "/taskRouting/findCandidate/vibe");
    let mut allowed_route_values = Vec::new();
    if source_connection.as_deref() == Some(connection_id) {
        allowed_route_values.extend(
            ["knowledge_candidate", "web_ingest", "wiki_file", "source"]
                .into_iter()
                .map(str::to_string),
        );
    }
    if vibe_connection.as_deref() == Some(connection_id) {
        allowed_route_values.push("vibe_memory".to_string());
    }
    if allowed_route_values.is_empty() {
        return;
    }
    queues.push(ProviderQueueClaimSpec {
        queue_name: "findingCandidate".to_string(),
        preferred_target_ids: vec![target_id.to_string()],
        route_target_column: Some("source_kind"),
        route_target_preferences: Vec::new(),
        allowed_route_values: Some(allowed_route_values),
        candidate_polarity_filter: CandidatePolarityFilter::Any,
        allowed_job_ids: None,
    });
}

fn push_episode_plan(
    settings: &Value,
    paused_queues: &HashSet<String>,
    connection_id: &str,
    target_id: &str,
    queues: &mut Vec<ProviderQueueClaimSpec>,
) {
    if paused_queues.contains("episodeDistiller")
        || route_connection_id(settings, "/taskRouting/episodeDistiller").as_deref()
            != Some(connection_id)
    {
        return;
    }
    queues.push(ProviderQueueClaimSpec {
        queue_name: "episodeDistiller".to_string(),
        preferred_target_ids: vec![target_id.to_string()],
        route_target_column: None,
        route_target_preferences: Vec::new(),
        allowed_route_values: None,
        candidate_polarity_filter: CandidatePolarityFilter::Any,
        allowed_job_ids: None,
    });
}

fn dynamic_plan_has_runnable_job(
    connection: &Connection,
    plan: &DynamicProviderPlan,
) -> Result<bool, CliError> {
    for queue in &plan.priority_queues {
        let table_name = queue_table_name(&queue.queue_name)?;
        if !table_exists(connection, table_name)? {
            continue;
        }
        let allowed = queue.allowed_route_values.as_deref().unwrap_or_default();
        let (route_condition, parameters) = route_filter(queue, allowed)?;
        let sql = format!(
            "select exists(
               select 1 from {table_name}
               where (
                 (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
                 or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
               )
               {route_condition}
             )"
        );
        let exists = connection
            .query_row(&sql, rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| {
                CliError::io(format!(
                    "failed to inspect dynamic {} queue: {error}",
                    queue.queue_name
                ))
            })?;
        if exists != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn route_filter<'a>(
    queue: &ProviderQueueClaimSpec,
    allowed: &'a [String],
) -> Result<(String, Vec<&'a String>), CliError> {
    if allowed.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let column = match queue.route_target_column {
        Some("source_kind") => "source_kind",
        Some("provider_policy") => "provider_policy",
        Some(other) => {
            return Err(CliError::invalid_arguments(format!(
                "unsupported dynamic route column: {other}"
            )))
        }
        None => {
            return Err(CliError::invalid_arguments(format!(
                "dynamic queue {} restricts route values without a route column",
                queue.queue_name
            )))
        }
    };
    let placeholders = (1..=allowed.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok((
        format!("and {column} in ({placeholders})"),
        allowed.iter().collect(),
    ))
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
        .optional()
        .map_err(|error| CliError::io(format!("failed to load runtime settings: {error}")))?;
    let Some(value) = value else {
        return Ok(None);
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse runtime settings: {error}")))?;
    Ok(Some(document.get("settings").cloned().unwrap_or(document)))
}

fn load_paused_queues(connection: &Connection) -> Result<HashSet<String>, CliError> {
    let value = connection
        .query_row(
            "select value from settings where namespace = 'runtime' and key = 'queue.controls.v1' limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load queue controls: {error}")))?;
    let Some(value) = value else {
        return Ok(HashSet::new());
    };
    let document = serde_json::from_str::<Value>(&value)
        .map_err(|error| CliError::io(format!("failed to parse queue controls: {error}")))?;
    Ok(document
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
        .collect())
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

fn route_connection_id(settings: &Value, pointer: &str) -> Option<String> {
    settings
        .pointer(pointer)
        .filter(|route| is_larm_route(route))
        .and_then(|route| string_field(route, "connectionId"))
}

fn is_larm_route(route: &Value) -> bool {
    string_field(route, "kind").as_deref() == Some("larm-agent-connection")
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

fn unique_suffix() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}-{millis}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::super::executor::{executor_priority_queues_for_pool, provider_pools};
    use super::*;

    #[test]
    fn builds_row_aware_larm_claim_plan() {
        let settings = json!({
            "providers": {
                "larm-agent-connection": {
                    "enabled": true,
                    "connections": [{
                        "id": "contextstill-background",
                        "controlBaseUrl": "http://127.0.0.1:9810",
                        "agentProfile": "contextstill-background",
                        "audience": "saaa-desktop",
                        "availabilityPollMs": 5000,
                        "availabilityTimeoutMs": 2000,
                        "controlTimeoutMs": 5000,
                        "readyTimeoutMs": 180000,
                        "ttlSeconds": 900,
                        "requestTimeoutMs": 300000
                    }]
                }
            },
            "taskRouting": {
                "findCandidate": {
                    "source": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"},
                    "vibe": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
                },
                "episodeDistiller": {"kind": "larm-agent-connection", "connectionId": "contextstill-background"}
            }
        });

        let plans = dynamic_provider_plans(&settings, &HashSet::new()).unwrap();

        assert_eq!(plans.len(), 1);
        assert_eq!(
            plans[0].pool.pool_id,
            "larm-agent-connection:contextstill-background"
        );
        assert_eq!(plans[0].priority_queues.len(), 2);
        assert_eq!(plans[0].priority_queues[0].queue_name, "findingCandidate");
        assert_eq!(
            plans[0].priority_queues[0].allowed_route_values,
            Some(vec![
                "knowledge_candidate".to_string(),
                "web_ingest".to_string(),
                "wiki_file".to_string(),
                "source".to_string(),
                "vibe_memory".to_string(),
            ])
        );
        assert_eq!(plans[0].priority_queues[1].queue_name, "episodeDistiller");
    }

    #[test]
    fn static_rust_executor_does_not_claim_larm_dynamic_routes() {
        let settings = json!({
            "providerPools": [{
                "id": "dynamic-background",
                "enabled": true,
                "targets": [{
                    "provider": "larm-agent-connection",
                    "connectionId": "contextstill-background"
                }],
                "maxConcurrent": 1
            }],
            "taskRouting": {
                "findCandidate": {
                    "source": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    },
                    "vibe": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                }
            }
        });

        assert!(provider_pools(&settings).is_empty());
        assert!(executor_priority_queues_for_pool(
            &settings,
            "dynamic-background",
            &HashSet::new()
        )
        .is_empty());
    }
    #[test]
    fn static_rust_executor_does_not_partially_execute_a_mixed_larm_pool() {
        let settings = json!({
            "providerPools": [{
                "id": "mixed-background",
                "enabled": true,
                "targets": [
                    {
                        "provider": "local-llm",
                        "localLlmModelId": "local-a"
                    },
                    {
                        "provider": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                ],
                "maxConcurrent": 2
            }],
            "taskRouting": {
                "episodeDistiller": {
                    "provider": "local-llm",
                    "providerPoolId": "mixed-background",
                    "fallback": []
                }
            }
        });

        assert!(provider_pools(&settings).is_empty());
    }

    #[test]
    fn static_rust_executor_does_not_claim_a_dynamic_vibe_row_from_a_static_source_pool() {
        let settings = json!({
            "providerPools": [{
                "id": "static-source",
                "enabled": true,
                "targets": [{
                    "provider": "local-llm",
                    "localLlmModelId": "local-a"
                }],
                "maxConcurrent": 1
            }],
            "taskRouting": {
                "findCandidate": {
                    "source": {
                        "provider": "local-llm",
                        "providerPoolId": "static-source",
                        "fallback": []
                    },
                    "vibe": {
                        "kind": "larm-agent-connection",
                        "connectionId": "contextstill-background"
                    }
                }
            }
        });

        assert!(
            executor_priority_queues_for_pool(&settings, "static-source", &HashSet::new())
                .is_empty()
        );
    }
}
