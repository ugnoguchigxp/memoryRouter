use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::ProcessState,
    process_lifecycle::service::{self, LifecycleReport},
    sqlite_writer,
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub use super::claim::claim_next_queue_job_for_connection;
pub(crate) use super::dynamic_provider::release_dynamic_provider_connections;
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

/// Runs one executor tick under a process-local single writer. This is intended
/// for controlled offline databases; it fails closed when another writer owns
/// the database lock.
pub fn run_offline_executor_tick_report<E: EnvProvider>(
    env: &E,
) -> Result<QueueExecutorTickReport, CliError> {
    let paths = resolve_paths(env);
    let queue_capacity = env
        .var("CONTEXT_STILL_SQLITE_WRITER_QUEUE_CAPACITY")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(256)
        .min(65_536);
    let vector_dimension = env
        .var("CONTEXT_STILL_EMBEDDING_DIMENSION")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(384)
        .min(65_536);
    let writer = sqlite_writer::SqliteWriterRuntime::start(
        &paths.sqlite_core_path,
        queue_capacity,
        vector_dimension,
    )
    .map_err(|error| {
        CliError::runtime(format!("failed to start offline SQLite writer: {error}"))
    })?;
    sqlite_writer::install_global_writer(writer.handle()).map_err(|error| {
        CliError::runtime(format!("failed to install offline SQLite writer: {error}"))
    })?;

    let report = run_executor_tick_report(env);
    sqlite_writer::clear_global_writer(&paths.sqlite_core_path);
    let shutdown = writer.shutdown().map_err(|error| {
        CliError::runtime(format!("failed to stop offline SQLite writer: {error}"))
    });
    match (report, shutdown) {
        (Ok(report), Ok(())) => Ok(report),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

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
