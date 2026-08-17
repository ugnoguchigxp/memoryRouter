use serde::Serialize;
use std::path::Path;

use crate::{
    domains::{
        bootstrap::service::{resolve_paths, PathReport},
        runtime_identity,
    },
    shared::{
        config::EnvProvider,
        process::{OsSupervisor, ProcessSupervisor},
    },
};

use super::repository;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime_host: &'static str,
    pub version: &'static str,
    pub resident_supervisor: String,
    pub hono_admin_api: String,
    pub mcp_server: String,
    pub queue_supervisor: String,
    pub agent_log_sync: String,
    pub managed_default_flags: ManagedDefaultFlags,
    pub paths: PathReport,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedDefaultFlags {
    pub mcp: bool,
    pub queue: bool,
    pub agent_log_sync: bool,
    pub admin_api: bool,
}

pub fn status<E: EnvProvider>(env: &E) -> RuntimeStatus {
    let supervisor = OsSupervisor;
    status_with_supervisor(env, &supervisor)
}

pub fn status_with_supervisor<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> RuntimeStatus {
    let mut paths = resolve_paths(env);
    let database_identity = runtime_identity::resolve(env, supervisor);
    paths.sqlite_core_path = database_identity.effective_path;
    let run_dir = &paths.run_dir;

    let resident_supervisor = resolve_process_status(run_dir, "context-stilld", supervisor);
    let hono_admin_api = resolve_process_status(run_dir, "admin-api", supervisor);
    let mcp_server = resolve_process_status(run_dir, "mcp-server", supervisor);
    let queue_supervisor = resolve_process_status(run_dir, "queue-supervisor", supervisor);
    let agent_log_sync = resolve_process_status(run_dir, "agent-log-sync", supervisor);

    RuntimeStatus {
        runtime_host: "rust-resident",
        version: repository::runtime_version(),
        resident_supervisor: resident_supervisor.clone(),
        hono_admin_api,
        mcp_server,
        queue_supervisor,
        agent_log_sync,
        managed_default_flags: ManagedDefaultFlags {
            mcp: env_flag_default(env, "CONTEXT_STILL_RESIDENT_MCP", true),
            queue: env_flag_default(env, "CONTEXT_STILL_RESIDENT_QUEUE", true),
            agent_log_sync: env_flag_default(env, "CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC", true),
            admin_api: env_flag(env, "CONTEXT_STILL_DAEMON_MANAGED_ADMIN_API"),
        },
        paths,
    }
}

fn env_flag<E: EnvProvider>(env: &E, key: &str) -> bool {
    matches!(
        env.var(key).as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on")
    )
}

fn env_flag_default<E: EnvProvider>(env: &E, key: &str, default: bool) -> bool {
    match env.var(key).as_deref() {
        Some("0") | Some("false") | Some("FALSE") | Some("no") | Some("off") => false,
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on") => true,
        Some(_) => default,
        None => default,
    }
}

fn resolve_process_status<S: ProcessSupervisor>(
    run_dir: &Path,
    name: &str,
    supervisor: &S,
) -> String {
    if let Ok(Some(state)) = repository::read_state(run_dir, name) {
        if let Some(pid) = state.pid {
            if supervisor.is_alive(pid) {
                return state.status;
            }
        } else if !state.status.is_empty() {
            return state.status;
        }
        return "stopped".to_string();
    }

    if let Ok(Some(pid)) = repository::read_pid(run_dir, name) {
        if supervisor.is_alive(pid) {
            return "running".to_string();
        }
    }

    "stopped".to_string()
}

impl RuntimeStatus {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("runtimeHost={}", self.runtime_host),
            format!("version={}", self.version),
            format!("residentSupervisor={}", self.resident_supervisor),
            format!("honoAdminApi={}", self.hono_admin_api),
            format!("mcpServer={}", self.mcp_server),
            format!("queueSupervisor={}", self.queue_supervisor),
            format!("agentLogSync={}", self.agent_log_sync),
            format!(
                "managedDefaultFlags=mcp:{} queue:{} agentLogSync:{} adminApi:{}",
                self.managed_default_flags.mcp,
                self.managed_default_flags.queue,
                self.managed_default_flags.agent_log_sync,
                self.managed_default_flags.admin_api
            ),
            self.paths.to_text(),
        ]
        .join("\n")
    }
}
