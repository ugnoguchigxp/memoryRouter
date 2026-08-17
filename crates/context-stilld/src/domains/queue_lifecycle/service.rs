use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::ProcessState,
    process_lifecycle::service::{self, LifecycleReport},
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub use super::claim::claim_next_queue_job_for_connection;
pub use super::events::append_queue_event_for_connection;
pub use super::executor::{run_executor_tick_report, QueueExecutorTickReport};
pub use super::inspect::inspect_report;
pub use super::maintenance::{run_maintenance_once_report, QueueMaintenanceReport};
pub use super::provider_lease::{
    claim_next_job_with_provider_lease_for_connection,
    count_available_provider_pool_slots_for_connection, heartbeat_provider_lease_for_connection,
    recover_stale_provider_leases_for_connection, release_provider_lease_for_connection,
};
pub use super::state::{
    keep_queue_job_waiting_for_worker_for_connection, pause_queue_job_for_connection,
    pause_running_queue_jobs_for_connection, resume_queue_job_for_connection,
    retry_queue_job_for_connection,
};
use super::types::QUEUE_SUPERVISOR;
pub use super::types::{
    ActiveProviderLease, ClaimedProviderLeaseJob, ClaimedQueueJob, ProviderLeaseAssignment,
    ProviderPoolClaimConfig, ProviderQueueClaimSpec, QueueInspectReport, QueueStateRow,
    QueueStatusCount, QueueTableInspect, RowTargetPreference, UnsupportedQueueBacklog,
};

pub fn start<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(start_report(env, supervisor)?.to_text())
}

pub fn start_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    _supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let maintenance = run_maintenance_once_report(env)?;
    let paths = resolve_paths(env);
    let state = ProcessState {
        pid: None,
        status: maintenance.status.clone(),
        log_path: paths
            .logs_dir
            .join(QUEUE_SUPERVISOR.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at: None,
        updated_at: Some(service::now_timestamp()),
        last_error: None,
        command: Some("context-stilld".to_string()),
        args: Some(vec!["queue".to_string(), "start".to_string()]),
        sqlite_core_path: Some(maintenance.sqlite_core_path.clone()),
        ..ProcessState::default()
    };
    Ok(service::report_from_state(
        &QUEUE_SUPERVISOR,
        "start",
        maintenance.status,
        maintenance.message,
        state,
    ))
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::stop(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&QUEUE_SUPERVISOR, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&QUEUE_SUPERVISOR, env, supervisor)
}
