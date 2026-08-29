use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{IpAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde_json::{json, Value};

use crate::{
    domains::{
        bootstrap::service::resolve_paths,
        context_compile::runtime::{CompileFoundationMode, CompileRuntimeContext},
        runtime_identity,
    },
    shared::{config::EnvProvider, errors::CliError, process::OsSupervisor},
    VERSION,
};

use super::dispatch::DispatchConfig;
use super::endpoint_sessions::{
    active_session_count, close_session, create_session, is_active_session, is_initialized,
    mark_initialized, new_state, now_timestamp, persist_sessions, prune_sessions, touch_session,
    CreateSessionError, SessionPruneConfig, SharedServerState,
};
use super::native_tools::{exposed_tool_count, handle_native_dispatch, tool_owner_inventory};
use super::{
    memory_profile::{
        memory_context_from_env, ToolProfile, MEMORY_CONTRACT_VERSION, MEMORY_PROTOCOL_VERSION,
    },
    memory_profile_auth::{
        constant_time_bearer_matches, create_bearer_token, protect_owner_only_directory,
        write_owner_only,
    },
    memory_recall_contract,
    native_memory_recall::{self, MemoryRecallError},
};

pub struct RunningEndpoint {
    running: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
    endpoint_path: PathBuf,
    secret_paths: Vec<PathBuf>,
}

impl RunningEndpoint {
    pub fn is_finished(&self) -> bool {
        self.join_handle
            .as_ref()
            .is_some_and(|handle| handle.is_finished())
    }

    fn shutdown(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_file(&self.endpoint_path);
        for path in &self.secret_paths {
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn stop(mut self) {
        self.shutdown();
    }
}

impl Drop for RunningEndpoint {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Debug, Clone)]
struct EndpointConfig {
    host: String,
    port: u16,
    url: String,
    host_header: String,
}

impl EndpointConfig {
    fn set_port(&mut self, port: u16) {
        let url_host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        self.port = port;
        self.url = format!("http://{url_host}:{port}/mcp");
        self.host_header = format!("{url_host}:{port}");
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: String,
    content_length: Option<usize>,
}

enum ReadRequestOutcome {
    Request(HttpRequest),
    Response(String),
}

struct AdmissionState {
    in_flight: AtomicUsize,
    bucket: Mutex<TokenBucket>,
}

struct TokenBucket {
    tokens: f64,
    updated_at: std::time::Instant,
}

struct AdmissionPermit {
    admission: Arc<AdmissionState>,
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        self.admission.leave();
    }
}

impl AdmissionState {
    fn new() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            bucket: Mutex::new(TokenBucket {
                tokens: 10.0,
                updated_at: std::time::Instant::now(),
            }),
        }
    }

    fn try_enter(&self) -> bool {
        self.in_flight
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                (current < 4).then_some(current + 1)
            })
            .is_ok()
    }

    fn leave(&self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }

    fn rate_allowed(&self, units: usize) -> bool {
        let mut bucket = self
            .bucket
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(bucket.updated_at).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed).min(10.0);
        bucket.updated_at = now;
        let required = units as f64;
        if bucket.tokens < required {
            return false;
        }
        bucket.tokens -= required;
        true
    }
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
    let profile = ToolProfile::from_env(env)?;
    let mut paths = resolve_paths(env);
    let mut endpoint = endpoint_config(env)?;
    std::fs::create_dir_all(&paths.run_dir)
        .map_err(|error| CliError::io(format!("failed to create MCP run dir: {error}")))?;
    if profile == ToolProfile::TypedMemory {
        protect_owner_only_directory(&paths.run_dir, "typed-memory MCP run directory")?;
    }

    let listener = TcpListener::bind((endpoint.host.as_str(), endpoint.port))
        .map_err(|error| CliError::io(format!("failed to bind MCP endpoint: {error}")))?;
    if endpoint.port == 0 {
        let bound_port = listener
            .local_addr()
            .map_err(|error| CliError::io(format!("failed to resolve MCP endpoint: {error}")))?
            .port();
        endpoint.set_port(bound_port);
    }
    listener
        .set_nonblocking(true)
        .map_err(|error| CliError::io(format!("failed to configure MCP listener: {error}")))?;

    let endpoint_path = paths.run_dir.join("mcp-endpoint.json");
    let mut secret_paths = Vec::new();
    let (dispatch, writer_token_path, auth_token_path) = match profile {
        ToolProfile::Default => {
            let supervisor = OsSupervisor;
            let database_identity = runtime_identity::resolve(env, &supervisor);
            paths.sqlite_core_path = database_identity.effective_path.clone();
            let mode = CompileFoundationMode::from_env(env).map_err(CliError::invalid_arguments)?;
            let compile_runtime = Arc::new(
                CompileRuntimeContext::new(mode, &database_identity, paths.logs_dir.clone())
                    .map_err(CliError::invalid_arguments)?,
            );
            let token_path = paths.run_dir.join("sqlite-writer.token");
            let writer_token = create_writer_token(&token_path, &paths.sqlite_core_path)?;
            secret_paths.push(token_path.clone());
            (
                DispatchConfig::Default {
                    project_root: env
                        .var("CONTEXT_STILL_PROJECT_ROOT")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| {
                            std::env::current_dir()
                                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                        }),
                    sqlite_core_path: paths.sqlite_core_path.clone(),
                    writer_token,
                    compile_runtime,
                },
                Some(token_path),
                None,
            )
        }
        ToolProfile::TypedMemory => {
            let context = memory_context_from_env(env)?;
            let token_path = paths.run_dir.join("mcp-memory-bearer.token");
            let bearer_token = create_bearer_token(&token_path)?;
            secret_paths.push(token_path.clone());
            (
                DispatchConfig::TypedMemory {
                    context,
                    bearer_token,
                    expected_host: endpoint.host_header.clone(),
                },
                None,
                Some(token_path),
            )
        }
    };
    let dispatch = Arc::new(dispatch);
    let sessions_path = paths.run_dir.join("mcp-sessions.json");
    let prune_config = if profile == ToolProfile::TypedMemory {
        SessionPruneConfig::typed_memory()
    } else {
        SessionPruneConfig::from_env(env)
    };
    let state = new_state(
        sessions_path.clone(),
        prune_config,
        profile == ToolProfile::TypedMemory,
    );
    if let Err(error) = persist_sessions(&state) {
        cleanup_startup_files(&endpoint_path, &secret_paths);
        return Err(error);
    }
    if let Err(error) = persist_endpoint(
        &endpoint_path,
        &endpoint,
        &sessions_path,
        writer_token_path.as_deref(),
        auth_token_path.as_deref(),
        profile,
    ) {
        cleanup_startup_files(&endpoint_path, &secret_paths);
        return Err(error);
    }

    let running = Arc::new(AtomicBool::new(true));
    let thread_running = Arc::clone(&running);
    let thread_endpoint_path = endpoint_path.clone();
    let thread_secret_paths = secret_paths.clone();
    let admission = Arc::new(AdmissionState::new());
    let join_handle = thread::spawn(move || {
        accept_loop(listener, state, dispatch, thread_running, admission);
        let _ = std::fs::remove_file(thread_endpoint_path);
        for path in thread_secret_paths {
            let _ = std::fs::remove_file(path);
        }
    });

    Ok(RunningEndpoint {
        running,
        join_handle: Some(join_handle),
        endpoint_path,
        secret_paths,
    })
}

fn cleanup_startup_files(endpoint_path: &Path, secret_paths: &[PathBuf]) {
    let _ = std::fs::remove_file(endpoint_path);
    for path in secret_paths {
        let _ = std::fs::remove_file(path);
    }
}

fn accept_loop(
    listener: TcpListener,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
    running: Arc<AtomicBool>,
    admission: Arc<AdmissionState>,
) {
    let mut workers = Vec::new();
    while running.load(Ordering::SeqCst) {
        reap_finished_workers(&mut workers);
        prune_sessions(&state, false);
        match listener.accept() {
            Ok((mut stream, _)) => {
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let entered = !dispatch.is_typed_memory() || admission.try_enter();
                if !entered {
                    let response = json_response(
                        429,
                        json!({"ok":false,"error":"too_many_in_flight_requests"}),
                        &[],
                    );
                    let _ = stream.write_all(response.as_bytes());
                    continue;
                }
                let state = Arc::clone(&state);
                let dispatch = Arc::clone(&dispatch);
                let admission = Arc::clone(&admission);
                let permit = dispatch.is_typed_memory().then(|| AdmissionPermit {
                    admission: Arc::clone(&admission),
                });
                if let Ok(worker) = thread::Builder::new().spawn(move || {
                    let _permit = permit;
                    let _ = handle_stream(stream, state, dispatch, Arc::clone(&admission));
                }) {
                    workers.push(worker);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
}

fn reap_finished_workers(workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
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
        host_header: format!("{url_host}:{port}"),
    })
}

pub(crate) fn configured_endpoint_url<E: EnvProvider>(env: &E) -> Result<String, CliError> {
    Ok(endpoint_config(env)?.url)
}

fn persist_endpoint(
    path: &std::path::Path,
    endpoint: &EndpointConfig,
    sessions_path: &std::path::Path,
    writer_token_path: Option<&std::path::Path>,
    auth_token_path: Option<&std::path::Path>,
    profile: ToolProfile,
) -> Result<(), CliError> {
    let value = match profile {
        ToolProfile::Default => json!({
            "server": "context-still",
            "url": endpoint.url,
            "transport": "streamable-http",
            "auth": "none",
            "pid": std::process::id(),
            "workerId": format!("rust-mcp-worker-{}", std::process::id()),
            "startedAt": now_timestamp(),
            "sessionStatePath": sessions_path.to_string_lossy(),
            "writerUrl": endpoint.url.replace("/mcp", "/writer/query"),
            "writerTokenPath": writer_token_path.unwrap_or(Path::new("")).to_string_lossy(),
        }),
        ToolProfile::TypedMemory => json!({
            "server": "context-still",
            "url": endpoint.url,
            "transport": "streamable-http",
            "protocolVersion": MEMORY_PROTOCOL_VERSION,
            "auth": "bearer-token-file",
            "authTokenPath": auth_token_path.unwrap_or(Path::new("")).to_string_lossy(),
            "toolProfile": profile.as_str(),
            "contractVersion": MEMORY_CONTRACT_VERSION,
            "startedAt": now_timestamp(),
        }),
    };
    let content = format!("{}\n", serde_json::to_string_pretty(&value).unwrap());
    if profile == ToolProfile::TypedMemory {
        write_owner_only(path, &content, "MCP endpoint metadata")?;
    } else {
        std::fs::write(path, content).map_err(|error| {
            CliError::io(format!("failed to write MCP endpoint metadata: {error}"))
        })?;
    }
    Ok(())
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
    admission: Arc<AdmissionState>,
) -> Result<(), CliError> {
    let peer_is_loopback = stream
        .peer_addr()
        .map(|address| address.ip().is_loopback())
        .unwrap_or(false);
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| CliError::io(format!("failed to set MCP read timeout: {error}")))?;
    let request = match read_request(&mut stream, &dispatch, &admission)? {
        ReadRequestOutcome::Request(request) => request,
        ReadRequestOutcome::Response(response) => {
            stream
                .write_all(response.as_bytes())
                .map_err(|error| CliError::io(format!("failed to write MCP response: {error}")))?;
            return Ok(());
        }
    };
    let response = handle_request(request, state, dispatch, peer_is_loopback, &admission);
    stream
        .write_all(response.as_bytes())
        .map_err(|error| CliError::io(format!("failed to write MCP response: {error}")))?;
    Ok(())
}

fn read_request(
    stream: &mut TcpStream,
    dispatch: &DispatchConfig,
    admission: &AdmissionState,
) -> Result<ReadRequestOutcome, CliError> {
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
        let header_limit = if dispatch.is_typed_memory() {
            32 * 1024
        } else {
            128 * 1024
        };
        if buffer.len() > header_limit {
            return Ok(ReadRequestOutcome::Response(json_response(
                413,
                json!({"ok":false,"error":"request_headers_too_large"}),
                &[],
            )));
        }
    }

    let header_limit = if dispatch.is_typed_memory() {
        32 * 1024
    } else {
        128 * 1024
    };
    if header_end > header_limit {
        return Ok(ReadRequestOutcome::Response(json_response(
            413,
            json!({"ok":false,"error":"request_headers_too_large"}),
            &[],
        )));
    }

    let header_text = match std::str::from_utf8(&buffer[..header_end]) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ReadRequestOutcome::Response(json_response(
                400,
                json!({"ok":false,"error":"invalid_request_headers"}),
                &[],
            )))
        }
    };
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| CliError::invalid_arguments("missing request line"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default();
    if method.is_empty()
        || path.is_empty()
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || parts.next().is_some()
    {
        return Ok(ReadRequestOutcome::Response(json_response(
            400,
            json!({"ok":false,"error":"invalid_request_line"}),
            &[],
        )));
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Ok(ReadRequestOutcome::Response(json_response(
                400,
                json!({"ok":false,"error":"malformed_header"}),
                &[],
            )));
        };
        let name = name.trim();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value
                .chars()
                .any(|character| character.is_control() && character != '\t')
        {
            return Ok(ReadRequestOutcome::Response(json_response(
                400,
                json!({"ok":false,"error":"malformed_header"}),
                &[],
            )));
        }
        let name = name.to_ascii_lowercase();
        if headers.insert(name, value.trim().to_string()).is_some() {
            return Ok(ReadRequestOutcome::Response(json_response(
                400,
                json!({"ok":false,"error":"duplicate_header"}),
                &[],
            )));
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok());
    let mut request = HttpRequest {
        method,
        path,
        headers,
        body: String::new(),
        content_length,
    };
    if let Some(response) = typed_header_rejection(&request, dispatch) {
        return Ok(ReadRequestOutcome::Response(response));
    }
    if dispatch.is_typed_memory() && request.path == "/mcp" && !admission.rate_allowed(1) {
        return Ok(ReadRequestOutcome::Response(json_response(
            429,
            json!({"ok":false,"error":"rate_limit_exceeded"}),
            &[],
        )));
    }
    let content_length = content_length.unwrap_or(0);
    let body_limit = if dispatch.is_typed_memory() {
        32 * 1024
    } else {
        16 * 1024 * 1024
    };
    if content_length > body_limit {
        return Ok(ReadRequestOutcome::Response(json_response(
            413,
            json!({"ok":false,"error":"request_body_too_large"}),
            &[],
        )));
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
    if buffer.len().saturating_sub(body_start) < content_length {
        return Ok(ReadRequestOutcome::Response(json_response(
            400,
            json!({"ok":false,"error":"incomplete_request_body"}),
            &[],
        )));
    }
    request.body = match std::str::from_utf8(
        &buffer[body_start..std::cmp::min(buffer.len(), body_start + content_length)],
    ) {
        Ok(value) => value.to_string(),
        Err(_) => {
            return Ok(ReadRequestOutcome::Response(json_response(
                400,
                json!({"ok":false,"error":"request_body_must_be_utf8"}),
                &[],
            )))
        }
    };
    Ok(ReadRequestOutcome::Request(request))
}

fn typed_header_rejection(request: &HttpRequest, dispatch: &DispatchConfig) -> Option<String> {
    let (bearer_token, expected_host) = dispatch.bearer_auth()?;
    if request.path != "/mcp" {
        return None;
    }
    if request.headers.contains_key("origin") {
        return Some(json_response(
            403,
            json!({"ok":false,"error":"origin_forbidden"}),
            &[],
        ));
    }
    if request.headers.get("host").map(String::as_str) != Some(expected_host) {
        return Some(json_response(
            400,
            json!({"ok":false,"error":"host_mismatch"}),
            &[],
        ));
    }
    if !constant_time_bearer_matches(
        request.headers.get("authorization").map(String::as_str),
        bearer_token,
    ) {
        return Some(json_response(
            401,
            json!({"ok":false,"error":"unauthorized"}),
            &[("WWW-Authenticate", "Bearer".to_string())],
        ));
    }
    if request.method == "POST" {
        if request.headers.contains_key("transfer-encoding") || request.content_length.is_none() {
            return Some(json_response(
                411,
                json!({"ok":false,"error":"content_length_required"}),
                &[],
            ));
        }
        let content_type_ok = request.headers.get("content-type").is_some_and(|value| {
            value.eq_ignore_ascii_case("application/json")
                || value.to_ascii_lowercase().starts_with("application/json;")
        });
        if !content_type_ok {
            return Some(json_response(
                415,
                json!({"ok":false,"error":"unsupported_media_type"}),
                &[],
            ));
        }
        let accept = request
            .headers
            .get("accept")
            .map(String::as_str)
            .unwrap_or("");
        if !accepts_media_type(accept, "application/json")
            || !accepts_media_type(accept, "text/event-stream")
        {
            return Some(json_response(
                406,
                json!({"ok":false,"error":"not_acceptable"}),
                &[],
            ));
        }
    }
    None
}

fn accepts_media_type(accept: &str, expected: &str) -> bool {
    accept.split(',').any(|entry| {
        let mut parts = entry.split(';');
        if !parts
            .next()
            .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case(expected))
        {
            return false;
        }
        parts.all(|parameter| {
            let parameter = parameter.trim();
            let Some((name, value)) = parameter.split_once('=') else {
                return false;
            };
            !name.trim().eq_ignore_ascii_case("q")
                || value
                    .trim()
                    .parse::<f32>()
                    .is_ok_and(|quality| quality > 0.0 && quality <= 1.0)
        })
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
    admission: &AdmissionState,
) -> String {
    if !peer_is_loopback {
        return json_response(403, json!({"ok": false, "error": "mcp_loopback_only"}), &[]);
    }
    if !dispatch.is_typed_memory()
        && (request.path == "/writer/health" || request.path == "/writer/query")
    {
        return handle_writer_request(request, &dispatch);
    }
    if request.path == "/mcp/health" && request.method == "GET" {
        if dispatch.is_typed_memory() {
            return json_response(200, json!({"ok": true}), &[]);
        }
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
        "POST" => handle_mcp_post(request, state, dispatch, admission),
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
    let Some((sqlite_core_path, writer_token)) = dispatch.writer() else {
        return json_response(404, json!({"ok":false,"error":"not_found"}), &[]);
    };
    let supplied_token = request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied_token.as_bytes(), writer_token.as_bytes()) {
        return json_response(
            401,
            json!({"ok": false, "error": "writer_unauthorized"}),
            &[],
        );
    }
    if request.path == "/writer/health" && request.method == "GET" {
        return match crate::domains::sqlite_writer::global_writer_for_path(sqlite_core_path) {
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
    match crate::domains::sqlite_writer::protocol::execute_request(sqlite_core_path, writer_request)
    {
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
    admission: &AdmissionState,
) -> String {
    if dispatch.is_typed_memory() {
        return handle_typed_memory_post(request, state, dispatch, admission);
    }
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
        let session_id = match create_session(&state, &body, None, None) {
            Ok(value) => value,
            Err(_) => return rpc_error(500, id, -32603, "Internal error"),
        };
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
        "tools/list" => Ok(handle_native_dispatch(
            "tools/list",
            &json!({}),
            &dispatch
                .native_context()
                .expect("default profile native context"),
        )
        .unwrap_or_else(|| {
            json!({
                "tools": []
            })
        })),
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            Ok(handle_native_dispatch(
                "tools/call",
                &params,
                &dispatch.native_context().expect("default profile native context"),
            )
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
        "resources/list" => Ok(handle_native_dispatch(
            "resources/list",
            &json!({}),
            &dispatch
                .native_context()
                .expect("default profile native context"),
        )
        .unwrap_or_else(|| json!({"resources": []}))),
        "resources/read" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            Ok(handle_native_dispatch(
                "resources/read",
                &params,
                &dispatch
                    .native_context()
                    .expect("default profile native context"),
            )
            .unwrap_or_else(|| json!({"contents": []})))
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

fn handle_typed_memory_post(
    request: HttpRequest,
    state: SharedServerState,
    dispatch: Arc<DispatchConfig>,
    admission: &AdmissionState,
) -> String {
    prune_sessions(&state, false);
    let body = match serde_json::from_str::<Value>(&request.body) {
        Ok(body) => body,
        Err(_) => return rpc_error(400, None, -32700, "Parse error"),
    };

    if let Some(batch) = body.as_array() {
        if batch.is_empty() || batch.len() > 10 {
            return rpc_error(
                400,
                None,
                -32600,
                "Invalid Request: batch must contain 1-10 messages",
            );
        }
        if batch.len() > 1 && !admission.rate_allowed(batch.len() - 1) {
            return json_response(429, json!({"ok":false,"error":"rate_limit_exceeded"}), &[]);
        }
        if batch
            .iter()
            .any(|message| message.get("method").and_then(Value::as_str) == Some("initialize"))
        {
            return rpc_error(
                400,
                None,
                -32600,
                "Invalid Request: initialize is not allowed in a batch",
            );
        }
        if batch
            .iter()
            .filter(|message| message.get("method").and_then(Value::as_str) == Some("tools/call"))
            .count()
            > 1
        {
            return rpc_error(
                400,
                None,
                -32602,
                "Invalid Request: at most one tools/call is allowed per batch",
            );
        }
        let Some(session_id) = valid_typed_session(&request, &state) else {
            return typed_missing_session_error(&request, None);
        };
        let mut responses = Vec::new();
        for message in batch {
            if let Some(response) = typed_message(message, &state, &session_id, &dispatch) {
                responses.push(response);
            }
        }
        return if responses.is_empty() {
            empty_response(202)
        } else {
            json_response(200, Value::Array(responses), &[])
        };
    }

    let Some(message) = body.as_object() else {
        return rpc_error(400, None, -32600, "Invalid Request");
    };
    let id = valid_rpc_id(message.get("id"));
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "initialize" {
        if !valid_json_rpc_message(message) || id.is_none() {
            return rpc_error(400, None, -32600, "Invalid Request");
        }
        if request.headers.contains_key("mcp-session-id") {
            return rpc_error(400, id, -32600, "Invalid Request: duplicate initialize");
        }
        let params = message
            .get("params")
            .and_then(Value::as_object)
            .expect("validated initialize params");
        if let Err(error) = validate_initialize_params(params) {
            return rpc_error(400, id, -32602, &error);
        }
        let session_id = match create_session(&state, &body, None, Some(8)) {
            Ok(value) => value,
            Err(CreateSessionError::Capacity) => {
                return json_response(
                    429,
                    json!({"ok":false,"error":"session_capacity_exceeded"}),
                    &[],
                )
            }
            Err(CreateSessionError::Entropy | CreateSessionError::Persistence) => {
                return rpc_error(500, id, -32603, "Internal error")
            }
        };
        return rpc_response_with_headers(
            200,
            id,
            json!({
                "protocolVersion": MEMORY_PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name":"context-still","version":VERSION},
                "instructions": memory_recall_contract::MEMORY_USAGE_INSTRUCTIONS
            }),
            &[("Mcp-Session-Id", session_id)],
        );
    }

    let Some(session_id) = valid_typed_session(&request, &state) else {
        return typed_missing_session_error(&request, id);
    };
    match typed_message(&body, &state, &session_id, &dispatch) {
        Some(response) => json_response(200, response, &[]),
        None => empty_response(202),
    }
}

fn valid_typed_session(request: &HttpRequest, state: &SharedServerState) -> Option<String> {
    let session_id = session_id(request)?;
    is_active_session(state, &session_id).then_some(session_id)
}

fn typed_missing_session_error(request: &HttpRequest, id: Option<Value>) -> String {
    if request.headers.contains_key("mcp-session-id") {
        rpc_error(404, id, -32000, "MCP session is not active")
    } else {
        rpc_error(400, id, -32000, "Bad Request: initialize is required")
    }
}

fn typed_message(
    message: &Value,
    state: &SharedServerState,
    session_id: &str,
    dispatch: &DispatchConfig,
) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(rpc_error_value(None, -32600, "Invalid Request"));
    };
    if valid_json_rpc_response(object) {
        return None;
    }
    let id = valid_rpc_id(object.get("id"));
    if !valid_json_rpc_message(object) {
        return Some(rpc_error_value(None, -32600, "Invalid Request"));
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "notifications/initialized" {
        if id.is_some() || is_initialized(state, session_id) {
            return id.map(|id| {
                rpc_error_value(
                    Some(id),
                    -32600,
                    "Invalid Request: duplicate initialized notification",
                )
            });
        }
        mark_initialized(state, session_id);
        touch_session(state, session_id, 0);
        return None;
    }
    id.as_ref()?;
    if !is_initialized(state, session_id) {
        return Some(rpc_error_value(
            id,
            -32000,
            "initialized notification is required",
        ));
    }
    touch_session(state, session_id, 1);
    let result = match method {
        "tools/list" => {
            let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
            match validate_tools_list_params(&params) {
                Ok(()) => Ok(json!({"tools":memory_recall_contract::exposed_tools()})),
                Err(error) => Err((-32602, error)),
            }
        }
        "tools/call" => {
            let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
            match dispatch.memory_context() {
                Some(context) => match native_memory_recall::call(&params, context) {
                    Ok(value) => Ok(value),
                    Err(MemoryRecallError::InvalidArguments(error)) => Err((-32602, error)),
                    Err(MemoryRecallError::Internal) => Err((-32603, "Internal error".to_string())),
                },
                None => Err((-32603, "Internal error".to_string())),
            }
        }
        "initialize" => Err((-32600, "Invalid Request: duplicate initialize".to_string())),
        _ => Err((-32601, "Method not found".to_string())),
    };
    touch_session(state, session_id, -1);
    Some(match result {
        Ok(result) => rpc_result_value(id, result),
        Err((code, message)) => rpc_error_value(id, code, &message),
    })
}

fn validate_tools_list_params(params: &Value) -> Result<(), String> {
    let params = params
        .as_object()
        .ok_or_else(|| "Invalid params: tools/list params must be an object".to_string())?;
    if params.keys().any(|key| key != "_meta") {
        return Err("Invalid params: tools/list does not accept a cursor".to_string());
    }
    if params.get("_meta").is_some_and(|meta| !meta.is_object()) {
        return Err("Invalid params: tools/list _meta must be an object".to_string());
    }
    Ok(())
}

fn valid_json_rpc_message(object: &serde_json::Map<String, Value>) -> bool {
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object.get("method").and_then(Value::as_str).is_none()
        || object
            .get("params")
            .is_some_and(|params| !params.is_object())
    {
        return false;
    }
    matches!(
        object.get("id"),
        None | Some(Value::Null) | Some(Value::String(_)) | Some(Value::Number(_))
    )
}

fn valid_rpc_id(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|value| matches!(value, Value::Null | Value::String(_) | Value::Number(_)))
        .cloned()
}

fn valid_json_rpc_response(object: &serde_json::Map<String, Value>) -> bool {
    object.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && object.get("method").is_none()
        && object.get("params").is_none()
        && matches!(
            object.get("id"),
            Some(Value::Null | Value::String(_) | Value::Number(_))
        )
        && matches!(
            (object.get("result"), object.get("error")),
            (Some(_), None) | (None, Some(Value::Object(_)))
        )
}

fn validate_initialize_params(params: &serde_json::Map<String, Value>) -> Result<(), String> {
    let protocol = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid params: protocolVersion must be a string".to_string())?;
    validate_protocol_text(protocol, 64, "protocolVersion")?;
    if !params.get("capabilities").is_some_and(Value::is_object) {
        return Err("Invalid params: capabilities must be an object".to_string());
    }
    let client_info = params
        .get("clientInfo")
        .and_then(Value::as_object)
        .ok_or_else(|| "Invalid params: clientInfo must be an object".to_string())?;
    for key in ["name", "version"] {
        let value = client_info
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Invalid params: clientInfo.{key} must be a string"))?;
        validate_protocol_text(value, 128, &format!("clientInfo.{key}"))?;
    }
    Ok(())
}

fn validate_protocol_text(value: &str, max: usize, field: &str) -> Result<(), String> {
    let count = value.chars().count();
    if count == 0 || count > max || value.chars().any(char::is_control) {
        return Err(format!(
            "Invalid params: {field} must contain 1-{max} Unicode scalars without control characters"
        ));
    }
    Ok(())
}

fn rpc_result_value(id: Option<Value>, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id.unwrap_or(Value::Null),"result":result})
}

fn rpc_error_value(id: Option<Value>, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc":"2.0",
        "id":id.unwrap_or(Value::Null),
        "error":{"code":code,"message":message}
    })
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
        406 => "Not Acceptable",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
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
    format!("HTTP/1.1 {status} {reason}\r\ncache-control: no-store\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
}
