use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde_json::{json, Value};

use crate::{
    domains::bootstrap::service::resolve_paths,
    shared::{config::EnvProvider, errors::CliError},
    VERSION,
};

use super::dispatch::DispatchConfig;
use super::endpoint_sessions::{
    active_session_count, close_session, create_session, is_active_session, new_state,
    now_timestamp, persist_sessions, prune_sessions, touch_session, SessionPruneConfig,
    SharedServerState,
};
use super::native_tools::{
    exposed_tool_count, handle_native_dispatch, tool_owner_inventory, NativeToolContext,
};

pub struct RunningEndpoint {
    running: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
    endpoint_path: PathBuf,
    writer_token_path: PathBuf,
}

impl RunningEndpoint {
    pub fn is_finished(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|handle| handle.is_finished())
    }

    pub fn stop(mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(&self.endpoint_path);
        let _ = std::fs::remove_file(&self.writer_token_path);
    }
}

#[derive(Debug, Clone)]
struct EndpointConfig {
    host: String,
    port: u16,
    url: String,
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
}

pub fn serve<E: EnvProvider>(env: &E) -> Result<(), CliError> {
    let endpoint = start_in_process(env)?;
    let signal_running = Arc::clone(&endpoint.running);
    ctrlc::set_handler(move || {
        signal_running.store(false, Ordering::SeqCst);
    })
    .map_err(|error| CliError::io(format!("failed to install MCP signal handler: {error}")))?;
    while endpoint.running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(100));
    }
    endpoint.stop();
    Ok(())
}

pub fn start_in_process<E: EnvProvider>(env: &E) -> Result<RunningEndpoint, CliError> {
    let paths = resolve_paths(env);
    let endpoint = endpoint_config(env)?;
    std::fs::create_dir_all(&paths.run_dir)
        .map_err(|error| CliError::io(format!("failed to create MCP run dir: {error}")))?;

    let endpoint_path = paths.run_dir.join("mcp-endpoint.json");
    let writer_token_path = paths.run_dir.join("sqlite-writer.token");
    let writer_token = create_writer_token(&writer_token_path, &paths.sqlite_core_path)?;
    let dispatch = Arc::new(dispatch_config(env, writer_token));
    let sessions_path = paths.run_dir.join("mcp-sessions.json");
    let state = new_state(sessions_path.clone(), SessionPruneConfig::from_env(env));
    persist_sessions(&state)?;
    persist_endpoint(
        &endpoint_path,
        &endpoint,
        &sessions_path,
        &writer_token_path,
    )?;

    let listener = TcpListener::bind((endpoint.host.as_str(), endpoint.port))
        .map_err(|error| CliError::io(format!("failed to bind MCP endpoint: {error}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| CliError::io(format!("failed to configure MCP listener: {error}")))?;

    let running = Arc::new(AtomicBool::new(true));
    let thread_running = Arc::clone(&running);
    let thread_endpoint_path = endpoint_path.clone();
    let thread_writer_token_path = writer_token_path.clone();
    let join_handle = thread::spawn(move || {
        accept_loop(listener, state, dispatch, thread_running);
        let _ = std::fs::remove_file(thread_endpoint_path);
        let _ = std::fs::remove_file(thread_writer_token_path);
    });

    Ok(RunningEndpoint {
        running,
        join_handle: Some(join_handle),
        endpoint_path,
        writer_token_path,
    })
}

fn accept_loop(
    listener: TcpListener,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        prune_sessions(&state, false);
        match listener.accept() {
            Ok((stream, _)) => {
                let state = Arc::clone(&state);
                let dispatch = Arc::clone(&dispatch);
                thread::spawn(move || {
                    let _ = handle_stream(stream, state, dispatch);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

fn dispatch_config<E: EnvProvider>(env: &E, writer_token: String) -> DispatchConfig {
    let paths = resolve_paths(env);
    DispatchConfig {
        project_root: env
            .var("CONTEXT_STILL_PROJECT_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
            }),
        sqlite_core_path: paths.sqlite_core_path,
        writer_token,
    }
}

fn endpoint_config<E: EnvProvider>(env: &E) -> Result<EndpointConfig, CliError> {
    let configured_host = env
        .var("CONTEXT_STILL_MCP_HOST")
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let address = configured_host.parse::<IpAddr>().map_err(|_| {
        CliError::invalid_arguments(
            "CONTEXT_STILL_MCP_HOST must be a loopback IP address (127.0.0.1 or ::1)",
        )
    })?;
    if !address.is_loopback() {
        return Err(CliError::invalid_arguments(
            "CONTEXT_STILL_MCP_HOST must be a loopback IP address (127.0.0.1 or ::1)",
        ));
    }
    let host = address.to_string();
    let url_host = match address {
        IpAddr::V4(_) => host.clone(),
        IpAddr::V6(_) => format!("[{host}]"),
    };
    let port = env
        .var("CONTEXT_STILL_MCP_PORT")
        .unwrap_or_else(|| "39172".to_string())
        .parse::<u16>()
        .map_err(|error| CliError::invalid_arguments(format!("invalid MCP port: {error}")))?;
    Ok(EndpointConfig {
        url: format!("http://{url_host}:{port}/mcp"),
        host,
        port,
    })
}

pub(super) fn configured_endpoint_url<E: EnvProvider>(env: &E) -> Result<String, CliError> {
    Ok(endpoint_config(env)?.url)
}

fn persist_endpoint(
    path: &std::path::Path,
    endpoint: &EndpointConfig,
    sessions_path: &std::path::Path,
    writer_token_path: &std::path::Path,
) -> Result<(), CliError> {
    let value = json!({
        "server": "context-still",
        "url": endpoint.url,
        "transport": "streamable-http",
        "auth": "none",
        "pid": std::process::id(),
        "workerId": format!("rust-mcp-worker-{}", std::process::id()),
        "startedAt": now_timestamp(),
        "sessionStatePath": sessions_path.to_string_lossy(),
        "writerUrl": endpoint.url.replace("/mcp", "/writer/query"),
        "writerTokenPath": writer_token_path.to_string_lossy(),
    });
    std::fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .map_err(|error| CliError::io(format!("failed to write MCP endpoint metadata: {error}")))
}

fn create_writer_token(
    path: &std::path::Path,
    _sqlite_path: &std::path::Path,
) -> Result<String, CliError> {
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|error| {
        CliError::io(format!("failed to generate SQLite writer token: {error}"))
    })?;
    let token = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::fs::write(path, format!("{token}\n"))
        .map_err(|error| CliError::io(format!("failed to write SQLite writer token: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| CliError::io(format!("failed to protect SQLite writer token: {error}")),
        )?;
    }
    Ok(token)
}

fn handle_stream(
    mut stream: TcpStream,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
) -> Result<(), CliError> {
    let peer_is_loopback = stream
        .peer_addr()
        .map(|address| address.ip().is_loopback())
        .unwrap_or(false);
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| CliError::io(format!("failed to set MCP read timeout: {error}")))?;
    let request = read_request(&mut stream)?;
    let response = handle_request(request, state, dispatch, peer_is_loopback);
    stream
        .write_all(response.as_bytes())
        .map_err(|error| CliError::io(format!("failed to write MCP response: {error}")))?;
    Ok(())
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, CliError> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end;
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| CliError::io(format!("failed to read MCP request: {error}")))?;
        if read == 0 {
            return Err(CliError::io("empty MCP request"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = find_header_end(&buffer) {
            header_end = index;
            break;
        }
        if buffer.len() > 128 * 1024 {
            return Err(CliError::invalid_arguments(
                "MCP request headers are too large",
            ));
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| CliError::invalid_arguments("missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > 16 * 1024 * 1024 {
        return Err(CliError::invalid_arguments(
            "HTTP request body exceeds 16 MiB",
        ));
    }
    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| CliError::io(format!("failed to read MCP request body: {error}")))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(
        &buffer[body_start..std::cmp::min(buffer.len(), body_start + content_length)],
    )
    .to_string();

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn handle_request(
    request: HttpRequest,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
    peer_is_loopback: bool,
) -> String {
    if !peer_is_loopback {
        return json_response(403, json!({"ok": false, "error": "mcp_loopback_only"}), &[]);
    }
    if request.path == "/writer/health" || request.path == "/writer/query" {
        return handle_writer_request(request, &dispatch);
    }
    if request.path == "/mcp/health" && request.method == "GET" {
        prune_sessions(&state, false);
        let active_session_count = active_session_count(&state);
        let tool_count = exposed_tool_count();
        let tool_owners = tool_owner_inventory();
        return json_response(
            200,
            json!({
                "ok": true,
                "server": "context-still",
                "transport": "streamable-http",
                "toolCount": tool_count,
                "toolOwners": tool_owners,
                "activeSessionCount": active_session_count,
            }),
            &[],
        );
    }

    if request.path != "/mcp" {
        return json_response(404, json!({ "ok": false, "error": "not_found" }), &[]);
    }

    match request.method.as_str() {
        "POST" => handle_mcp_post(request, state, dispatch),
        "GET" => json_response(
            405,
            json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "Method not allowed without an active session" },
                "id": null,
            }),
            &[("Allow", "POST, DELETE".to_string())],
        ),
        "DELETE" => handle_mcp_delete(request, state),
        _ => json_response(
            405,
            json!({ "ok": false, "error": "method_not_allowed" }),
            &[("Allow", "GET, POST, DELETE".to_string())],
        ),
    }
}

fn handle_writer_request(request: HttpRequest, dispatch: &DispatchConfig) -> String {
    let supplied_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied_token.as_bytes(), dispatch.writer_token.as_bytes()) {
        return json_response(
            401,
            json!({"ok": false, "error": "writer_unauthorized"}),
            &[],
        );
    }
    if request.path == "/writer/health" && request.method == "GET" {
        return match crate::domains::sqlite_writer::global_writer_for_path(
            &dispatch.sqlite_core_path,
        ) {
            Ok(writer) => json_response(200, json!({"ok": true, "writer": writer.status()}), &[]),
            Err(error) => json_response(503, json!({"ok": false, "error": error}), &[]),
        };
    }
    if request.path != "/writer/query" || request.method != "POST" {
        return json_response(
            405,
            json!({"ok": false, "error": "method_not_allowed"}),
            &[("Allow", "POST".to_string())],
        );
    }
    let writer_request = match serde_json::from_str::<
        crate::domains::sqlite_writer::protocol::SqliteWriterRequest,
    >(&request.body)
    {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                400,
                json!({"ok": false, "error": format!("invalid writer request: {error}")}),
                &[],
            )
        }
    };
    match crate::domains::sqlite_writer::protocol::execute_request(
        &dispatch.sqlite_core_path,
        writer_request,
    ) {
        Ok(response) => json_response(200, json!(response), &[]),
        Err(error) => json_response(500, json!({"ok": false, "error": error}), &[]),
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn handle_mcp_post(
    request: HttpRequest,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
) -> String {
    prune_sessions(&state, false);
    let body = match serde_json::from_str::<Value>(&request.body) {
        Ok(body) => body,
        Err(error) => return rpc_error(400, None, -32700, &format!("Parse error: {error}")),
    };
    let id = body.get("id").cloned();
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if method == "initialize" {
        let session_id = create_session(&state, &body, None);
        let result = json!({
            "protocolVersion": body
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .cloned()
                .unwrap_or_else(|| json!("2024-11-05")),
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": "context-still", "version": VERSION },
        });
        return rpc_response_with_headers(200, id, result, &[("Mcp-Session-Id", session_id)]);
    }

    if id.is_none() {
        return empty_response(202);
    }

    let Some(session_id) = session_id(&request) else {
        return rpc_error(
            400,
            id,
            -32000,
            "Bad Request: initialize is required before session requests",
        );
    };
    if !is_active_session(&state, &session_id) {
        return rpc_error(
            404,
            id,
            -32000,
            "MCP session is not active; initialize a new session",
        );
    }

    touch_session(&state, &session_id, 1);
    let result: Result<Value, String> = match method.as_str() {
        "tools/list" => {
            Ok(
                handle_native_dispatch("tools/list", &json!({}), &native_context(&dispatch))
                    .unwrap_or_else(|| {
                        json!({
                            "tools": []
                        })
                    }),
            )
        }
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            Ok(handle_native_dispatch("tools/call", &params, &native_context(&dispatch))
                .unwrap_or_else(|| {
                    let name = params
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("<missing>");
                    json!({
                        "content": [{ "type": "text", "text": format!("[TOOL_ERROR] Unknown MCP tool: {name}") }],
                        "isError": true
                    })
                }))
        }
        "resources/list" => {
            Ok(
                handle_native_dispatch("resources/list", &json!({}), &native_context(&dispatch))
                    .unwrap_or_else(|| json!({"resources": []})),
            )
        }
        "resources/read" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            Ok(
                handle_native_dispatch("resources/read", &params, &native_context(&dispatch))
                    .unwrap_or_else(|| json!({"contents": []})),
            )
        }
        _ => Ok(json!({
            "content": [{ "type": "text", "text": format!("[TOOL_ERROR] Unknown MCP method: {method}") }],
            "isError": true,
        })),
    };
    touch_session(&state, &session_id, -1);

    match result {
        Ok(result) => rpc_response(200, id, result),
        Err(error) => rpc_error(500, id, -32603, &error),
    }
}

fn native_context(dispatch: &DispatchConfig) -> NativeToolContext {
    NativeToolContext {
        project_root: dispatch.project_root.clone(),
        sqlite_core_path: dispatch.sqlite_core_path.clone(),
    }
}

fn handle_mcp_delete(request: HttpRequest, state: SharedServerState) -> String {
    let Some(session_id) = session_id(&request) else {
        return rpc_error(404, None, -32000, "MCP session not found");
    };
    if !close_session(&state, &session_id) {
        return rpc_error(404, None, -32000, "MCP session not found");
    }
    prune_sessions(&state, true);
    json_response(200, json!({ "ok": true, "sessionId": session_id }), &[])
}

fn session_id(request: &HttpRequest) -> Option<String> {
    request
        .headers
        .get("mcp-session-id")
        .filter(|value| !value.trim().is_empty())
        .cloned()
}

fn rpc_response(status: u16, id: Option<Value>, result: Value) -> String {
    rpc_response_with_headers(status, id, result, &[])
}

fn rpc_response_with_headers(
    status: u16,
    id: Option<Value>,
    result: Value,
    headers: &[(&str, String)],
) -> String {
    json_response(
        status,
        json!({ "jsonrpc": "2.0", "id": id.unwrap_or(Value::Null), "result": result }),
        headers,
    )
}

fn rpc_error(status: u16, id: Option<Value>, code: i64, message: &str) -> String {
    json_response(
        status,
        json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": { "code": code, "message": message },
        }),
        &[],
    )
}

fn json_response(status: u16, value: Value, headers: &[(&str, String)]) -> String {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let mut response = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&body);
    response
}

fn empty_response(status: u16) -> String {
    let reason = if status == 202 { "Accepted" } else { "OK" };
    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
}
