use crate::domains::cli::routing::QueueAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: QueueAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    match action {
        QueueAction::Start => {
            render_lifecycle(super::service::start_report(env, supervisor)?, json)
        }
        QueueAction::Stop => render_lifecycle(super::service::stop_report(env, supervisor)?, json),
        QueueAction::Status => {
            render_lifecycle(super::service::status_report(env, supervisor)?, json)
        }
        QueueAction::Inspect => {
            let report = super::service::inspect_report(env, supervisor)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        QueueAction::ExecutorTick => {
            let report = super::service::run_offline_executor_tick_report(env)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
    }
}

fn render_lifecycle(
    report: crate::domains::process_lifecycle::service::LifecycleReport,
    json: bool,
) -> Result<String, CliError> {
    if json {
        Ok(report.to_json())
    } else {
        Ok(report.to_text())
    }
}
