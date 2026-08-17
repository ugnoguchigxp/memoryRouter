use crate::domains::cli::routing::BackupAction;
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: BackupAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    match action {
        BackupAction::Preflight { require_idle } => {
            let report = super::service::preflight(env, supervisor);
            if require_idle && !report.active_managed_writers.is_empty() {
                return Err(CliError::runtime(format!(
                    "managed writers are active: {}",
                    report.active_managed_writers.join(",")
                )));
            }
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        BackupAction::Create => {
            let report = super::service::create(env, supervisor)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
    }
}
