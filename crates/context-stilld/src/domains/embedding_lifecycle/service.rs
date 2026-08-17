use std::{
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use reqwest::{blocking::Client, Url};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

use crate::{
    domains::{
        bootstrap::service::resolve_paths,
        daemon::repository::{self, ProcessState},
        process_lifecycle::service::{self as process_lifecycle, LifecycleReport},
    },
    shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor},
};

const STATE_NAME: &str = "embedding-daemon";
const LOG_FILE: &str = "embedding-daemon.log";
const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:44512";

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EmbeddingRuntimeConfig {
    pub provider: String,
    pub daemon_url: String,
    pub resident_enabled: bool,
    pub embedding_root: PathBuf,
    pub python: PathBuf,
    pub model_dir: PathBuf,
    pub request_timeout_seconds: u64,
    pub readiness_timeout: Duration,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingDaemonHealth {
    pub url: String,
    pub reachable: bool,
    pub status: String,
    pub managed_by: String,
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingCliHealth {
    pub python: String,
    pub root: String,
    pub model_dir: String,
    pub usable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingHealthReport {
    pub configured: bool,
    pub provider: String,
    pub effective_mode: String,
    pub daemon: EmbeddingDaemonHealth,
    pub cli: EmbeddingCliHealth,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct ManagedEndpoint {
    host: String,
    port: u16,
}

pub fn resolve_config<E: EnvProvider>(env: &E) -> EmbeddingRuntimeConfig {
    let paths = resolve_paths(env);
    let settings = read_runtime_settings(&paths.sqlite_core_path);
    let project_root = env
        .var("CONTEXT_STILL_PROJECT_ROOT")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let default_embedding_root = project_root
        .parent()
        .unwrap_or(&project_root)
        .join("local-llm")
        .join("embedding");
    let embedding_root = project_env(env, "LOCAL_LLM_EMBEDDING_ROOT")
        .map(PathBuf::from)
        .unwrap_or(default_embedding_root);
    let python = project_env(env, "LOCAL_LLM_EMBEDDING_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| embedding_root.join(".venv/bin/python"));
    let model_dir = project_env(env, "LOCAL_LLM_EMBEDDING_MODEL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| embedding_root.join("models/multilingual-e5-small"));
    let provider = settings
        .as_ref()
        .and_then(|value| value.pointer("/embedding/provider"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| project_env(env, "EMBEDDING_PROVIDER"))
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let daemon_url = settings
        .as_ref()
        .and_then(|value| value.pointer("/embedding/daemonUrl"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| project_env(env, "EMBEDDING_DAEMON_URL"))
        .unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let request_timeout_ms = settings
        .as_ref()
        .and_then(|value| value.pointer("/embedding/timeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(30_000);

    EmbeddingRuntimeConfig {
        provider,
        daemon_url,
        resident_enabled: env_flag_default(env, "CONTEXT_STILL_RESIDENT_EMBEDDING", true),
        embedding_root,
        python,
        model_dir,
        request_timeout_seconds: request_timeout_ms.div_ceil(1_000).max(1),
        readiness_timeout: Duration::from_millis(env_u64_default(
            env,
            "CONTEXT_STILL_EMBEDDING_READY_TIMEOUT_MS",
            60_000,
        )),
    }
}

pub fn health_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> EmbeddingHealthReport {
    let config = resolve_config(env);
    health_report_with_config(env, supervisor, &config)
}

pub fn reconcile_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let config = resolve_config(env);
    let endpoint = managed_endpoint(&config.daemon_url);
    let should_manage = config.resident_enabled
        && matches!(config.provider.as_str(), "auto" | "daemon")
        && endpoint.is_some();

    if !should_manage {
        stop_previous_managed_process(env, supervisor)?;
        return Ok(report_from_health(
            "reconcile",
            health_report_with_config(env, supervisor, &config),
        ));
    }

    let current_health = health_report_with_config(env, supervisor, &config);
    if current_health.daemon.reachable {
        if current_health.daemon.pid.is_some() {
            persist_running_status(env, "managed_ready", None)?;
        }
        return Ok(report_from_health("reconcile", current_health));
    }

    if !config.python.is_file() || !config.embedding_root.is_dir() || !config.model_dir.is_dir() {
        let error = cli_asset_error(&config)
            .unwrap_or_else(|| "embedding daemon assets are not available".to_string());
        persist_terminal_state(env, &config, "unavailable", None, Some(error.clone()))?;
        return Ok(lifecycle_report(
            "reconcile",
            "unavailable",
            format!("embedding-daemon unavailable: {error}"),
            None,
            env,
            &config,
            Some(error),
        ));
    }

    if let Some(state) = managed_state(env)? {
        if let Some(pid) = live_managed_pid(&state, supervisor) {
            if startup_timed_out(&state, config.readiness_timeout) {
                terminate_process(supervisor, pid);
                clear_runtime_pid(env)?;
                let error = format!(
                    "embedding-daemon did not become ready within {} ms",
                    config.readiness_timeout.as_millis()
                );
                persist_terminal_state(env, &config, "failed", None, Some(error.clone()))?;
                return Ok(lifecycle_report(
                    "reconcile",
                    "failed",
                    error.clone(),
                    None,
                    env,
                    &config,
                    Some(error),
                ));
            }
            return Ok(lifecycle_report(
                "reconcile",
                "starting",
                format!("embedding-daemon is starting (pid={pid})"),
                Some(pid),
                env,
                &config,
                state.last_error,
            ));
        }
        if let Some(pid) = state.pid {
            clear_runtime_pid(env)?;
            let error = format!(
                "embedding-daemon process {pid} exited or no longer matches its ownership signature before readiness"
            );
            persist_terminal_state(env, &config, "failed", None, Some(error.clone()))?;
            return Ok(lifecycle_report(
                "reconcile",
                "failed",
                error.clone(),
                None,
                env,
                &config,
                Some(error),
            ));
        }
    }

    let endpoint = endpoint.expect("managed endpoint checked above");
    let command = config.python.to_string_lossy().into_owned();
    let args = daemon_args(&config, &endpoint);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let paths = resolve_paths(env);
    let log_path = paths.logs_dir.join(LOG_FILE);
    let pid = match supervisor.spawn(&command, &arg_refs, &log_path, &config.embedding_root) {
        Ok(pid) => pid,
        Err(error) => {
            let message = format!("failed to spawn embedding-daemon: {error}");
            persist_terminal_state(env, &config, "failed", None, Some(message.clone()))?;
            return Ok(lifecycle_report(
                "start",
                "failed",
                message.clone(),
                None,
                env,
                &config,
                Some(message),
            ));
        }
    };
    if let Err(error) = persist_running_state(env, &config, pid, &command, &args) {
        terminate_process(supervisor, pid);
        let paths = resolve_paths(env);
        let _ = repository::clear_pid(&paths.run_dir, STATE_NAME);
        let _ = repository::clear_state(&paths.run_dir, STATE_NAME);
        return Err(error);
    }

    Ok(lifecycle_report(
        "start",
        "starting",
        format!("embedding-daemon started and is awaiting readiness (pid={pid})"),
        Some(pid),
        env,
        &config,
        None,
    ))
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    Ok(report_from_health("status", health_report(env, supervisor)))
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    let config = resolve_config(env);
    let Some(state) = managed_state(env)? else {
        return Ok(lifecycle_report(
            "stop",
            "not_running",
            "embedding-daemon has no resident-owned process".to_string(),
            None,
            env,
            &config,
            None,
        ));
    };
    let Some(pid) = live_managed_pid(&state, supervisor) else {
        clear_runtime_pid(env)?;
        persist_terminal_state(env, &config, "stopped", None, state.last_error.clone())?;
        return Ok(lifecycle_report(
            "stop",
            "not_running",
            "embedding-daemon has no verified resident-owned process".to_string(),
            None,
            env,
            &config,
            state.last_error,
        ));
    };

    terminate_process(supervisor, pid);
    clear_runtime_pid(env)?;
    persist_terminal_state(env, &config, "stopped", None, None)?;
    Ok(lifecycle_report(
        "stop",
        "stopped",
        format!("resident-owned embedding-daemon stopped (pid={pid})"),
        Some(pid),
        env,
        &config,
        None,
    ))
}

fn health_report_with_config<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
    config: &EmbeddingRuntimeConfig,
) -> EmbeddingHealthReport {
    let probe = probe_health(&config.daemon_url, Duration::from_millis(1_500));
    let reachable = probe.is_ok();
    let state = managed_state(env).ok().flatten();
    let managed_pid = state
        .as_ref()
        .and_then(|state| live_managed_pid(state, supervisor));
    let cli_error = cli_asset_error(config);
    let cli_usable = cli_error.is_none();
    let configured = config.provider != "disabled";
    let managed_by = if managed_pid.is_some() {
        "rust-resident"
    } else if reachable {
        "external"
    } else {
        "none"
    };
    let daemon_status = if !configured || config.provider == "openai" {
        "not_required"
    } else if reachable && managed_pid.is_some() {
        "managed_ready"
    } else if reachable {
        "external_ready"
    } else if managed_pid.is_some() {
        "starting"
    } else {
        "offline"
    };
    let effective_mode = if !configured {
        "disabled"
    } else if config.provider == "openai" {
        "openai"
    } else if reachable {
        "daemon"
    } else if config.provider == "auto" && cli_usable {
        "cli_fallback"
    } else {
        "unavailable"
    };

    EmbeddingHealthReport {
        configured,
        provider: config.provider.clone(),
        effective_mode: effective_mode.to_string(),
        daemon: EmbeddingDaemonHealth {
            url: config.daemon_url.clone(),
            reachable,
            status: daemon_status.to_string(),
            managed_by: managed_by.to_string(),
            pid: managed_pid,
            error: probe.err(),
        },
        cli: EmbeddingCliHealth {
            python: config.python.to_string_lossy().into_owned(),
            root: config.embedding_root.to_string_lossy().into_owned(),
            model_dir: config.model_dir.to_string_lossy().into_owned(),
            usable: cli_usable,
            error: cli_error,
        },
    }
}

fn report_from_health(action: &str, health: EmbeddingHealthReport) -> LifecycleReport {
    let status = match health.effective_mode.as_str() {
        "daemon" => health.daemon.status.clone(),
        "cli_fallback" => "cli_fallback".to_string(),
        "disabled" => "disabled".to_string(),
        "openai" => "not_required".to_string(),
        _ => "unavailable".to_string(),
    };
    let message = match status.as_str() {
        "managed_ready" => format!(
            "embedding-daemon managed by rust resident at {}",
            health.daemon.url
        ),
        "external_ready" => format!(
            "external embedding-daemon reachable at {}",
            health.daemon.url
        ),
        "cli_fallback" => "embedding-daemon offline; CLI fallback is usable".to_string(),
        "disabled" => "embedding provider is disabled".to_string(),
        "not_required" => format!(
            "local embedding-daemon is not required for provider {}",
            health.provider
        ),
        _ => format!(
            "embedding provider unavailable: {}",
            health
                .daemon
                .error
                .as_deref()
                .unwrap_or("daemon is offline and CLI fallback is unavailable")
        ),
    };
    LifecycleReport {
        process: STATE_NAME,
        action: action.to_string(),
        status,
        message,
        pid: health.daemon.pid,
        log_path: None,
        started_at: None,
        updated_at: Some(process_lifecycle::now_timestamp()),
        exit_code: None,
        exit_signal: None,
        last_error: health.daemon.error,
        command: None,
        args: None,
    }
}

fn lifecycle_report<E: EnvProvider>(
    action: &str,
    status: &str,
    message: String,
    pid: Option<u32>,
    env: &E,
    config: &EmbeddingRuntimeConfig,
    last_error: Option<String>,
) -> LifecycleReport {
    let paths = resolve_paths(env);
    LifecycleReport {
        process: STATE_NAME,
        action: action.to_string(),
        status: status.to_string(),
        message,
        pid,
        log_path: Some(paths.logs_dir.join(LOG_FILE).to_string_lossy().into_owned()),
        started_at: None,
        updated_at: Some(process_lifecycle::now_timestamp()),
        exit_code: None,
        exit_signal: None,
        last_error,
        command: Some(config.python.to_string_lossy().into_owned()),
        args: managed_endpoint(&config.daemon_url).map(|endpoint| daemon_args(config, &endpoint)),
    }
}

fn persist_running_state<E: EnvProvider>(
    env: &E,
    config: &EmbeddingRuntimeConfig,
    pid: u32,
    command: &str,
    args: &[String],
) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let now = process_lifecycle::now_timestamp();
    let state = ProcessState {
        pid: Some(pid),
        status: "starting".to_string(),
        log_path: paths.logs_dir.join(LOG_FILE).to_string_lossy().into_owned(),
        started_at: Some(now.clone()),
        updated_at: Some(now),
        command: Some(command.to_string()),
        args: Some(args.to_vec()),
        project_root: env.var("CONTEXT_STILL_PROJECT_ROOT"),
        sqlite_core_path: Some(paths.sqlite_core_path.to_string_lossy().into_owned()),
        ..ProcessState::default()
    };
    repository::write_state(&paths.run_dir, STATE_NAME, &state)
        .map_err(|error| CliError::io(format!("failed to write embedding state: {error}")))?;
    repository::write_pid(&paths.run_dir, STATE_NAME, pid)
        .map_err(|error| CliError::io(format!("failed to write embedding pid: {error}")))?;
    let _ = config;
    Ok(())
}

fn persist_running_status<E: EnvProvider>(
    env: &E,
    status: &str,
    last_error: Option<String>,
) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let Some(mut state) = repository::read_state(&paths.run_dir, STATE_NAME)
        .map_err(|error| CliError::io(format!("failed to read embedding state: {error}")))?
    else {
        return Ok(());
    };
    state.status = status.to_string();
    state.updated_at = Some(process_lifecycle::now_timestamp());
    state.last_error = last_error;
    repository::write_state(&paths.run_dir, STATE_NAME, &state)
        .map_err(|error| CliError::io(format!("failed to update embedding state: {error}")))
}

fn persist_terminal_state<E: EnvProvider>(
    env: &E,
    config: &EmbeddingRuntimeConfig,
    status: &str,
    pid: Option<u32>,
    last_error: Option<String>,
) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let endpoint = managed_endpoint(&config.daemon_url);
    let state = ProcessState {
        pid,
        status: status.to_string(),
        log_path: paths.logs_dir.join(LOG_FILE).to_string_lossy().into_owned(),
        updated_at: Some(process_lifecycle::now_timestamp()),
        last_error,
        command: Some(config.python.to_string_lossy().into_owned()),
        args: endpoint.map(|endpoint| daemon_args(config, &endpoint)),
        project_root: env.var("CONTEXT_STILL_PROJECT_ROOT"),
        sqlite_core_path: Some(paths.sqlite_core_path.to_string_lossy().into_owned()),
        ..ProcessState::default()
    };
    repository::write_state(&paths.run_dir, STATE_NAME, &state)
        .map_err(|error| CliError::io(format!("failed to write embedding state: {error}")))
}

fn managed_state<E: EnvProvider>(env: &E) -> Result<Option<ProcessState>, CliError> {
    let paths = resolve_paths(env);
    repository::read_state(&paths.run_dir, STATE_NAME)
        .map_err(|error| CliError::io(format!("failed to read embedding state: {error}")))
        .map(|state| state.filter(is_resident_managed_state))
}

fn is_resident_managed_state(state: &ProcessState) -> bool {
    state
        .args
        .as_ref()
        .is_some_and(|args| args.windows(2).any(|pair| pair == ["-m", "e5embed.daemon"]))
}

fn live_managed_pid<S: ProcessSupervisor>(state: &ProcessState, supervisor: &S) -> Option<u32> {
    if !is_resident_managed_state(state) {
        return None;
    }
    let pid = state.pid.filter(|pid| supervisor.is_alive(*pid))?;
    let command_line = supervisor.command_line(pid)?;
    let command_name = state
        .command
        .as_deref()
        .and_then(|command| Path::new(command).file_name())
        .and_then(|name| name.to_str());
    let command_line_lower = command_line.to_ascii_lowercase();
    if command_name.is_some_and(|name| !command_line_lower.contains(&name.to_ascii_lowercase())) {
        return None;
    }
    let args = state.args.as_deref()?;
    let signature_matches = args
        .iter()
        .filter(|argument| !argument.starts_with('-'))
        .all(|argument| command_line.contains(argument));
    signature_matches.then_some(pid)
}

fn clear_runtime_pid<E: EnvProvider>(env: &E) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    repository::clear_pid(&paths.run_dir, STATE_NAME)
        .map_err(|error| CliError::io(format!("failed to clear embedding pid: {error}")))
}

fn stop_previous_managed_process<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<(), CliError> {
    let Some(mut state) = managed_state(env)? else {
        return Ok(());
    };
    if let Some(pid) = live_managed_pid(&state, supervisor) {
        terminate_process(supervisor, pid);
    }
    clear_runtime_pid(env)?;
    state.pid = None;
    state.status = "stopped".to_string();
    state.updated_at = Some(process_lifecycle::now_timestamp());
    state.last_error = None;
    let paths = resolve_paths(env);
    repository::write_state(&paths.run_dir, STATE_NAME, &state)
        .map_err(|error| CliError::io(format!("failed to stop embedding state: {error}")))?;
    Ok(())
}

fn terminate_process<S: ProcessSupervisor>(supervisor: &S, pid: u32) {
    let _ = supervisor.kill(pid, "SIGTERM");
    let deadline = Instant::now() + Duration::from_secs(5);
    while supervisor.is_alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if supervisor.is_alive(pid) {
        let _ = supervisor.kill(pid, "SIGKILL");
    }
}

fn daemon_args(config: &EmbeddingRuntimeConfig, endpoint: &ManagedEndpoint) -> Vec<String> {
    vec![
        "-m".to_string(),
        "e5embed.daemon".to_string(),
        "--host".to_string(),
        endpoint.host.clone(),
        "--port".to_string(),
        endpoint.port.to_string(),
        "--model-dir".to_string(),
        config.model_dir.to_string_lossy().into_owned(),
        "--request-timeout".to_string(),
        config.request_timeout_seconds.to_string(),
    ]
}

fn managed_endpoint(url: &str) -> Option<ManagedEndpoint> {
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "http" || !matches!(parsed.path(), "" | "/") {
        return None;
    }
    let host = parsed.host_str()?;
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    Some(ManagedEndpoint {
        host: if host == "localhost" {
            "127.0.0.1".to_string()
        } else {
            host.to_string()
        },
        port: parsed.port_or_known_default()?,
    })
}

fn startup_timed_out(state: &ProcessState, timeout: Duration) -> bool {
    let Some(started_at) = state.started_at.as_deref() else {
        return false;
    };
    let Some(started_millis) = started_at
        .strip_prefix("unix-ms:")
        .and_then(|value| value.parse::<u128>().ok())
    else {
        return false;
    };
    let now_millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    now_millis.saturating_sub(started_millis) >= timeout.as_millis()
}

fn probe_health(url: &str, timeout: Duration) -> Result<(), String> {
    let endpoint = format!("{}/health", url.trim_end_matches('/'));
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(endpoint)
        .send()
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status()))
    }
}

fn cli_asset_error(config: &EmbeddingRuntimeConfig) -> Option<String> {
    if !config.python.is_file() {
        return Some(format!(
            "embedding Python is missing at {}",
            config.python.display()
        ));
    }
    if !config.embedding_root.is_dir() {
        return Some(format!(
            "embedding root is missing at {}",
            config.embedding_root.display()
        ));
    }
    if !config.model_dir.is_dir() {
        return Some(format!(
            "embedding model is missing at {}",
            config.model_dir.display()
        ));
    }
    None
}

fn read_runtime_settings(sqlite_path: &Path) -> Option<Value> {
    if !sqlite_path.exists() {
        return None;
    }
    let connection =
        Connection::open_with_flags(sqlite_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let raw = connection
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
        .ok()?;
    let document = serde_json::from_str::<Value>(&raw).ok()?;
    Some(document.get("settings").cloned().unwrap_or(document))
}

fn project_env<E: EnvProvider>(env: &E, suffix: &str) -> Option<String> {
    env.var(&format!("CONTEXT_STILL_{suffix}"))
        .or_else(|| env.var(&format!("MEMORY_ROUTER_{suffix}")))
}

fn env_flag_default<E: EnvProvider>(env: &E, key: &str, default: bool) -> bool {
    match env.var(key).as_deref() {
        Some("0") | Some("false") | Some("FALSE") | Some("no") | Some("off") => false,
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on") => true,
        Some(_) => default,
        None => default,
    }
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{config::MapEnv, process::MockSupervisor};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "context-still-embedding-{name}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn unused_loopback_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn serve_one_health_after(port: u16, delay: Duration) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            thread::sleep(delay);
            let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .unwrap();
        })
    }

    #[test]
    fn local_endpoint_accepts_loopback_root_only() {
        assert_eq!(
            managed_endpoint("http://127.0.0.1:44512"),
            Some(ManagedEndpoint {
                host: "127.0.0.1".to_string(),
                port: 44512
            })
        );
        assert!(managed_endpoint("https://127.0.0.1:44512").is_none());
        assert!(managed_endpoint("http://192.168.0.10:44512").is_none());
        assert!(managed_endpoint("http://127.0.0.1:44512/prefix").is_none());
    }

    #[test]
    fn managed_startup_timeout_uses_the_persisted_start_time() {
        let state = ProcessState {
            started_at: Some("unix-ms:0".to_string()),
            ..ProcessState::default()
        };
        assert!(startup_timed_out(&state, Duration::from_millis(1)));
        assert!(!startup_timed_out(
            &ProcessState::default(),
            Duration::from_millis(1)
        ));
    }

    #[test]
    fn disabled_provider_does_not_spawn() {
        let app_dir = temp_dir("disabled");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "disabled"),
        ]);
        let supervisor = MockSupervisor::new();
        let report = reconcile_report(&env, &supervisor).unwrap();
        assert_eq!(report.status, "disabled");
        assert!(supervisor.spawned.lock().unwrap().is_empty());
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn disabling_provider_clears_stale_managed_pid_state() {
        let app_dir = temp_dir("disabled-clears-managed");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "disabled"),
        ]);
        let supervisor = MockSupervisor::new();
        let pid = supervisor
            .spawn(
                "/usr/bin/python3",
                &["-m", "e5embed.daemon"],
                &app_dir.join(LOG_FILE),
                &app_dir,
            )
            .unwrap();
        repository::write_state(
            &app_dir.join("run"),
            STATE_NAME,
            &ProcessState {
                pid: Some(pid),
                status: "managed_ready".to_string(),
                log_path: app_dir.join(LOG_FILE).to_string_lossy().into_owned(),
                command: Some("/usr/bin/python3".to_string()),
                args: Some(vec!["-m".to_string(), "e5embed.daemon".to_string()]),
                ..ProcessState::default()
            },
        )
        .unwrap();
        repository::write_pid(&app_dir.join("run"), STATE_NAME, pid).unwrap();

        let report = reconcile_report(&env, &supervisor).unwrap();

        assert_eq!(report.status, "disabled");
        assert!(!supervisor.is_alive(pid));
        let state = repository::read_state(&app_dir.join("run"), STATE_NAME)
            .unwrap()
            .unwrap();
        assert_eq!(state.status, "stopped");
        assert!(state.pid.is_none());
        assert!(repository::read_pid(&app_dir.join("run"), STATE_NAME)
            .unwrap()
            .is_none());
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn stale_embedding_pid_never_kills_an_unrelated_process() {
        let app_dir = temp_dir("stale-pid-safety");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "disabled"),
        ]);
        let supervisor = MockSupervisor::new();
        let unrelated_pid = supervisor
            .spawn(
                "/usr/bin/sleep",
                &["100"],
                &app_dir.join("unrelated.log"),
                &app_dir,
            )
            .unwrap();
        repository::write_state(
            &app_dir.join("run"),
            STATE_NAME,
            &ProcessState {
                pid: Some(unrelated_pid),
                status: "managed_ready".to_string(),
                log_path: app_dir.join(LOG_FILE).to_string_lossy().into_owned(),
                command: Some("/usr/bin/python3".to_string()),
                args: Some(vec!["-m".to_string(), "e5embed.daemon".to_string()]),
                ..ProcessState::default()
            },
        )
        .unwrap();

        reconcile_report(&env, &supervisor).unwrap();

        assert!(supervisor.is_alive(unrelated_pid));
        let state = repository::read_state(&app_dir.join("run"), STATE_NAME)
            .unwrap()
            .unwrap();
        assert!(state.pid.is_none());
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn state_persistence_failure_terminates_the_spawned_daemon() {
        let asset_dir = temp_dir("persist-failure-assets");
        let embedding_root = asset_dir.join("embedding");
        let model_dir = embedding_root.join("model");
        fs::create_dir_all(&model_dir).unwrap();
        let python = embedding_root.join("python");
        fs::write(&python, "").unwrap();
        let app_data_file = asset_dir.join("app-data-is-a-file");
        fs::write(&app_data_file, "").unwrap();
        let port = unused_loopback_port();
        let daemon_url = format!("http://127.0.0.1:{port}");
        let env = MapEnv::from_pairs(vec![
            (
                "CONTEXT_STILL_APP_DATA_DIR",
                app_data_file.to_str().unwrap(),
            ),
            ("CONTEXT_STILL_PROJECT_ROOT", asset_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "daemon"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", &daemon_url),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_ROOT",
                embedding_root.to_str().unwrap(),
            ),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_PYTHON",
                python.to_str().unwrap(),
            ),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_MODEL_DIR",
                model_dir.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();

        let error = reconcile_report(&env, &supervisor).unwrap_err();

        assert!(error
            .to_string()
            .contains("failed to write embedding state"));
        let spawned = supervisor.spawned.lock().unwrap();
        assert_eq!(spawned.len(), 1);
        let pid = *spawned.keys().next().unwrap();
        drop(spawned);
        assert!(!supervisor.is_alive(pid));
        fs::remove_dir_all(asset_dir).unwrap();
    }

    #[test]
    fn missing_assets_use_cli_unavailable_without_spawning() {
        let app_dir = temp_dir("missing-assets");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "auto"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", "http://127.0.0.1:1"),
        ]);
        let supervisor = MockSupervisor::new();
        let report = reconcile_report(&env, &supervisor).unwrap();
        assert_eq!(report.status, "unavailable");
        assert!(supervisor.spawned.lock().unwrap().is_empty());
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn resident_starts_without_blocking_then_observes_health_and_stops_owned_daemon() {
        let app_dir = temp_dir("managed-roundtrip");
        let embedding_root = app_dir.join("embedding");
        let python = embedding_root.join(".venv/bin/python");
        let model_dir = embedding_root.join("models/multilingual-e5-small");
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::create_dir_all(&model_dir).unwrap();
        fs::write(&python, "test executable placeholder").unwrap();
        let port = unused_loopback_port();
        let env = MapEnv::from_pairs(vec![
            (
                "CONTEXT_STILL_APP_DATA_DIR".to_string(),
                app_dir.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_PROJECT_ROOT".to_string(),
                app_dir.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_EMBEDDING_PROVIDER".to_string(),
                "auto".to_string(),
            ),
            (
                "CONTEXT_STILL_EMBEDDING_DAEMON_URL".to_string(),
                format!("http://127.0.0.1:{port}"),
            ),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_ROOT".to_string(),
                embedding_root.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_PYTHON".to_string(),
                python.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_LOCAL_LLM_EMBEDDING_MODEL_DIR".to_string(),
                model_dir.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_EMBEDDING_READY_TIMEOUT_MS".to_string(),
                "3000".to_string(),
            ),
        ]);
        let supervisor = MockSupervisor::new();
        let server = serve_one_health_after(port, Duration::from_millis(150));

        let started = reconcile_report(&env, &supervisor).unwrap();
        assert_eq!(started.status, "starting");
        let pid = started.pid.expect("managed pid");
        assert!(supervisor.is_alive(pid));
        assert_eq!(supervisor.spawned.lock().unwrap().len(), 1);
        thread::sleep(Duration::from_millis(200));
        let ready = reconcile_report(&env, &supervisor).unwrap();
        assert_eq!(ready.status, "managed_ready");
        assert_eq!(ready.pid, Some(pid));
        server.join().unwrap();

        let stopped = stop_report(&env, &supervisor).unwrap();
        assert_eq!(stopped.status, "stopped");
        assert!(!supervisor.is_alive(pid));
        let state = managed_state(&env)
            .unwrap()
            .expect("persisted stopped state");
        assert_eq!(state.status, "stopped");
        assert!(state.pid.is_none());
        fs::remove_dir_all(app_dir).unwrap();
    }
}
