use crate::{
    domains::cli::routing::ContextCompileAction,
    shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor},
};

use super::foundation;

pub fn handle_command<E: EnvProvider, S: ProcessSupervisor>(
    action: ContextCompileAction,
    json: bool,
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    let report = foundation::run(action, env, supervisor)?;
    if json {
        Ok(serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string()))
    } else {
        Ok(foundation::summary(&report))
    }
}
