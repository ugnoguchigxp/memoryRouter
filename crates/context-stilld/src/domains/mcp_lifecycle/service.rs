use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::{self, ProcessState},
    process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec, CURRENT_EXE_COMMAND},
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};

use super::endpoint_server::{configured_endpoint_url, RunningEndpoint};

const MCP_ENDPOINT: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "mcp-server",
    display_name: "mcp-endpoint",
    command: CURRENT_EXE_COMMAND,
    args: &["mcp", "serve"],
    log_file: "mcp-endpoint.log",
};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointReport {
    pub server: &'static str,
    pub url: String,
    pub transport: &'static str,
    pub ready: bool,
    pub auth: &'static str,
    pub active_session_count: usize,
    pub metadata_path: String,
    pub session_state_path: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSession {
    pub session_id: String,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub remote_address: Option<String>,
    pub created_at: String,
    pub last_activity_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_unix_seconds: Option<u64>,
    pub in_flight_request_count: u32,
    pub worker_id: Option<String>,
    pub route: String,
    pub close_reason: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsReport {
    pub sessions: Vec<McpSession>,
    pub active_session_count: usize,
    pub session_state_path: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub ok: bool,
    pub endpoint: EndpointReport,
    pub tool_count: usize,
    pub tool_owners: Value,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    tool_count: Option<usize>,
    tool_owners: Option<Value>,
}

pub struct InProcessMcpEndpoint {
    endpoint: RunningEndpoint,
}

impl InProcessMcpEndpoint {
    pub fn is_finished(&self) -> bool {
        self.endpoint.is_finished()
    }

    pub fn stop(self) {
        self.endpoint.stop();
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
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::start_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(stop_report(env, supervisor)?.to_text())
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    if let Some(report) = resident_managed_stop_report(env)? {
        return Ok(report);
    }
    service::stop_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(status_report(env, supervisor)?.to_text())
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&MCP_ENDPOINT, env, supervisor)
}

pub fn serve<E: EnvProvider>(env: &E) -> Result<String, CliError> {
    super::endpoint_server::serve(env)?;
    Ok("mcp-endpoint stopped".to_string())
}

pub fn start_in_process_report<E: EnvProvider>(
    env: &E,
) -> Result<(LifecycleReport, InProcessMcpEndpoint), CliError> {
    let paths = resolve_paths(env);
    let endpoint = super::endpoint_server::start_in_process(env)?;
    let now = service::now_timestamp();
    let state = ProcessState {
        pid: Some(std::process::id()),
        status: "running".to_string(),
        log_path: paths
            .logs_dir
            .join(MCP_ENDPOINT.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at: Some(now.clone()),
        updated_at: Some(now),
        command: Some("context-stilld".to_string()),
        args: Some(vec!["run".to_string(), "mcp-in-process".to_string()]),
        project_root: env.var("CONTEXT_STILL_PROJECT_ROOT"),
        sqlite_core_path: Some(paths.sqlite_core_path.to_string_lossy().into_owned()),
        ..ProcessState::default()
    };
    service::write_process_state(&MCP_ENDPOINT, &paths.run_dir, &state)?;
    repository::write_pid(&paths.run_dir, MCP_ENDPOINT.state_name, std::process::id())
        .map_err(|error| CliError::io(format!("failed to write MCP endpoint pid: {error}")))?;
    let report = service::report_from_state(
        &MCP_ENDPOINT,
        "start",
        "running",
        format!(
            "mcp-endpoint running in context-stilld pid={}",
            std::process::id()
        ),
        state,
    );
    Ok((report, InProcessMcpEndpoint { endpoint }))
}

pub fn stop_in_process_report<E: EnvProvider>(
    env: &E,
    endpoint: InProcessMcpEndpoint,
) -> Result<LifecycleReport, CliError> {
    endpoint.stop();
    let paths = resolve_paths(env);
    let state = repository::read_state(&paths.run_dir, MCP_ENDPOINT.state_name)
        .ok()
        .flatten();
    let _ = repository::clear_pid(&paths.run_dir, MCP_ENDPOINT.state_name);
    let _ = repository::clear_state(&paths.run_dir, MCP_ENDPOINT.state_name);
    Ok(LifecycleReport {
        process: MCP_ENDPOINT.state_name,
        action: "stop".to_string(),
        status: "stopped".to_string(),
        message: "mcp-endpoint in-process listener stopped".to_string(),
        pid: Some(std::process::id()),
        log_path: state.as_ref().map(|state| state.log_path.clone()),
        started_at: state.as_ref().and_then(|state| state.started_at.clone()),
        updated_at: Some(service::now_timestamp()),
        exit_code: None,
        exit_signal: None,
        last_error: None,
        command: Some("context-stilld".to_string()),
        args: Some(vec!["run".to_string(), "mcp-in-process".to_string()]),
    })
}

fn resident_managed_stop_report<E: EnvProvider>(
    env: &E,
) -> Result<Option<LifecycleReport>, CliError> {
    let paths = resolve_paths(env);
    let Some(state) = repository::read_state(&paths.run_dir, MCP_ENDPOINT.state_name)
        .map_err(|error| CliError::io(format!("failed to read MCP endpoint state: {error}")))?
    else {
        return Ok(None);
    };
    let args = state.args.clone().unwrap_or_default();
    if !args.iter().any(|arg| arg == "mcp-in-process") {
        return Ok(None);
    }
    Ok(Some(LifecycleReport {
        process: MCP_ENDPOINT.state_name,
        action: "stop".to_string(),
        status: "managed_by_resident".to_string(),
        message:
            "mcp-endpoint is running inside context-stilld; stop the resident daemon to stop it"
                .to_string(),
        pid: state.pid,
        log_path: if state.log_path.is_empty() {
            None
        } else {
            Some(state.log_path)
        },
        started_at: state.started_at,
        updated_at: Some(service::now_timestamp()),
        exit_code: state.exit_code,
        exit_signal: state.exit_signal,
        last_error: state.last_error,
        command: state.command,
        args: state.args,
    }))
}

pub fn endpoint_report<E: EnvProvider>(env: &E) -> EndpointReport {
    let paths = resolve_paths(env);
    let (url, configuration_error) = match configured_endpoint_url(env) {
        Ok(url) => (url, None),
        Err(error) => ("unavailable".to_string(), Some(error.to_string())),
    };
    let metadata_path = paths.run_dir.join("mcp-endpoint.json");
    let session_state_path = paths.run_dir.join("mcp-sessions.json");
    let sessions = read_sessions_file(&session_state_path).unwrap_or_default();
    let active_session_count = sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count();
    let health = if configuration_error.is_none() {
        read_health(&url).ok()
    } else {
        None
    };
    let mut warnings = Vec::new();

    if let Some(error) = configuration_error {
        warnings.push(format!("Invalid MCP endpoint configuration: {error}"));
    } else if health.as_ref().is_none_or(|health| !health.ok) {
        warnings.push("MCP endpoint is not reachable; start context-stilld managed endpoint before registering clients.".to_string());
    }

    EndpointReport {
        server: "context-still",
        url,
        transport: "streamable-http",
        ready: health.is_some_and(|health| health.ok),
        auth: "none",
        active_session_count,
        metadata_path: path_to_string(&metadata_path),
        session_state_path: path_to_string(&session_state_path),
        warnings,
    }
}

pub fn sessions_report<E: EnvProvider>(env: &E) -> Result<SessionsReport, CliError> {
    let paths = resolve_paths(env);
    let session_state_path = paths.run_dir.join("mcp-sessions.json");
    let sessions = read_sessions_file(&session_state_path)?;
    let active_session_count = sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count();

    Ok(SessionsReport {
        sessions,
        active_session_count,
        session_state_path: path_to_string(&session_state_path),
    })
}

pub fn smoke_report<E: EnvProvider>(env: &E) -> SmokeReport {
    let endpoint = endpoint_report(env);
    let health = read_health(&endpoint.url);
    match health {
        Ok(health) if health.ok => SmokeReport {
            ok: true,
            endpoint,
            tool_count: health.tool_count.unwrap_or(0),
            tool_owners: health.tool_owners.unwrap_or_else(default_tool_owners),
            message: "MCP endpoint health check passed; tool list is available.".to_string(),
        },
        Ok(_) => SmokeReport {
            ok: false,
            endpoint,
            tool_count: 0,
            tool_owners: default_tool_owners(),
            message: "MCP endpoint responded but is not ready.".to_string(),
        },
        Err(error) => SmokeReport {
            ok: false,
            endpoint,
            tool_count: 0,
            tool_owners: default_tool_owners(),
            message: format!("MCP endpoint is not reachable: {error}"),
        },
    }
}

fn default_tool_owners() -> Value {
    json!({
        "rustNative": [],
        "tsSidecar": [],
        "disabled": [],
        "counts": {
            "rustNative": 0,
            "tsSidecar": 0,
            "disabled": 0
        }
    })
}

fn read_sessions_file(path: &Path) -> Result<Vec<McpSession>, CliError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| CliError::io(format!("failed to read MCP sessions: {e}")))?;
    serde_json::from_str(&content)
        .map_err(|e| CliError::io(format!("failed to parse MCP sessions: {e}")))
}

fn read_health(endpoint_url: &str) -> Result<HealthResponse, String> {
    let (host, port) = parse_http_endpoint(endpoint_url)?;
    let mut addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("could not resolve {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;

    let host_header = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!(
        "GET /mcp/health HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return Err("invalid HTTP response".to_string());
    };
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Err(headers
            .lines()
            .next()
            .unwrap_or("non-200 response")
            .to_string());
    }
    serde_json::from_str(body.trim()).map_err(|error| error.to_string())
}

fn parse_http_endpoint(endpoint_url: &str) -> Result<(String, u16), String> {
    let without_scheme = endpoint_url
        .strip_prefix("http://")
        .ok_or_else(|| "only http:// MCP endpoints are supported locally".to_string())?;
    let host_port = without_scheme
        .split('/')
        .next()
        .ok_or_else(|| "missing endpoint host".to_string())?;
    let (host, port) = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (host, suffix) = bracketed
            .split_once(']')
            .ok_or_else(|| "invalid bracketed endpoint host".to_string())?;
        let port = suffix
            .strip_prefix(':')
            .ok_or_else(|| "missing endpoint port".to_string())?;
        (host, port)
    } else {
        host_port
            .rsplit_once(':')
            .ok_or_else(|| "missing endpoint port".to_string())?
    };
    let parsed_port = port
        .parse::<u16>()
        .map_err(|error| format!("invalid endpoint port: {error}"))?;
    Ok((host.to_string(), parsed_port))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl EndpointReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        let mut lines = vec![
            format!("server={}", self.server),
            format!("url={}", self.url),
            format!("transport={}", self.transport),
            format!("ready={}", self.ready),
            format!("auth={}", self.auth),
            format!("activeSessionCount={}", self.active_session_count),
            format!("metadataPath={}", self.metadata_path),
            format!("sessionStatePath={}", self.session_state_path),
        ];
        lines.extend(
            self.warnings
                .iter()
                .map(|warning| format!("warning={warning}")),
        );
        lines.join("\n")
    }
}

impl SessionsReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        if self.sessions.is_empty() {
            return format!(
                "activeSessionCount=0\nsessionStatePath={}",
                self.session_state_path
            );
        }

        let mut lines = vec![
            format!("activeSessionCount={}", self.active_session_count),
            format!("sessionStatePath={}", self.session_state_path),
        ];
        lines.extend(self.sessions.iter().map(|session| {
            format!(
                "session={} route={} inFlight={} closeReason={}",
                session.session_id,
                session.route,
                session.in_flight_request_count,
                session
                    .close_reason
                    .clone()
                    .unwrap_or_else(|| "active".to_string())
            )
        }));
        lines.join("\n")
    }
}

impl SmokeReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("ok={}", self.ok),
            format!("url={}", self.endpoint.url),
            format!("toolCount={}", self.tool_count),
            format!("toolOwners={}", self.tool_owners),
            format!("message={}", self.message),
        ]
        .join("\n")
    }
}
