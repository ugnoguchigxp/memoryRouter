use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::Connection;
use serde_json::json;

use crate::domains::mcp_lifecycle::endpoint_server::{start_in_process, RunningEndpoint};
use crate::domains::sqlite_writer::{
    clear_global_writer, install_global_writer, SqliteWriterRuntime,
};
use crate::shared::config::MapEnv;

fn get_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind to dynamic port");
    listener
        .local_addr()
        .expect("Failed to get local address")
        .port()
}

fn make_test_env(port: u16, app_data_dir: PathBuf) -> MapEnv {
    make_test_env_with_host(port, app_data_dir, "127.0.0.1")
}

fn make_test_env_with_host(port: u16, app_data_dir: PathBuf, host: &str) -> MapEnv {
    let mut vars = HashMap::new();
    vars.insert("CONTEXT_STILL_MCP_HOST".to_string(), host.to_string());
    vars.insert("CONTEXT_STILL_MCP_PORT".to_string(), port.to_string());
    vars.insert(
        "CONTEXT_STILL_APP_DATA_DIR".to_string(),
        app_data_dir.to_string_lossy().to_string(),
    );
    vars.insert(
        "CONTEXT_STILL_SQLITE_CORE_PATH".to_string(),
        app_data_dir
            .join("test.sqlite")
            .to_string_lossy()
            .to_string(),
    );
    vars.insert(
        "CONTEXT_STILL_PROJECT_ROOT".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
    );
    MapEnv::new(vars)
}

#[test]
fn test_endpoint_rejects_non_loopback_bind_host() {
    let port = get_free_port();
    let temp_dir = create_temp_dir();
    let env = make_test_env_with_host(port, temp_dir.clone(), "0.0.0.0");

    let error = start_in_process(&env)
        .err()
        .expect("Non-loopback MCP host should be rejected");
    assert!(error.to_string().contains("must be a loopback IP address"));

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[test]
fn dynamic_port_is_persisted_as_the_bound_endpoint() {
    let temp_dir = create_temp_dir();
    let env = make_test_env(0, temp_dir.clone());
    let endpoint = start_in_process(&env).expect("Failed to start dynamic-port endpoint");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(temp_dir.join("run/mcp-endpoint.json")).unwrap(),
    )
    .unwrap();
    let url = manifest["url"].as_str().unwrap();
    assert!(!url.contains(":0/"), "{url}");
    wait_for_health(url.strip_suffix("/mcp").unwrap());
    let report = super::service::endpoint_report(&env);
    assert_eq!(report.url, url);
    assert!(report.ready);
    endpoint.stop();
    let _ = std::fs::remove_dir_all(temp_dir);
}

fn create_temp_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("test_endpoint_{}_{}", now, count));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

struct TestServer {
    endpoint: Option<RunningEndpoint>,
    writer: Option<SqliteWriterRuntime>,
    url: String,
    temp_dir: PathBuf,
}

impl TestServer {
    fn start() -> Self {
        let port = get_free_port();
        let temp_dir = create_temp_dir();
        let env = make_test_env(port, temp_dir.clone());
        let sqlite_path = temp_dir.join("test.sqlite");
        let writer = SqliteWriterRuntime::start(&sqlite_path, 16, 8)
            .expect("Failed to start test SQLite writer");
        install_global_writer(writer.handle()).expect("Failed to install test SQLite writer");
        let endpoint = start_in_process(&env).expect("Failed to start endpoint");
        let url = format!("http://127.0.0.1:{}", port);
        wait_for_health(&url);
        Self {
            endpoint: Some(endpoint),
            writer: Some(writer),
            url,
            temp_dir,
        }
    }

    fn writer_token(&self) -> String {
        std::fs::read_to_string(self.temp_dir.join("run/sqlite-writer.token"))
            .expect("Failed to read writer token")
            .trim()
            .to_string()
    }
}

fn wait_for_health(url: &str) {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("Failed to build health client");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let attempt_error = match client.get(format!("{url}/mcp/health")).send() {
            Ok(response) if response.status() == reqwest::StatusCode::OK => return,
            Ok(response) => format!("unexpected status {}", response.status()),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            panic!("Endpoint did not become healthy: {attempt_error}");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(ep) = self.endpoint.take() {
            ep.stop();
        }
        clear_global_writer(&self.temp_dir.join("test.sqlite"));
        if let Some(writer) = self.writer.take() {
            writer
                .shutdown()
                .expect("Failed to stop test SQLite writer");
        }
    }
}

#[test]
fn test_writer_endpoint_requires_token_and_reports_status() {
    let server = TestServer::start();
    let client = reqwest::blocking::Client::new();

    let unauthorized = client
        .get(format!("{}/writer/health", server.url))
        .send()
        .expect("Failed to send unauthorized writer request");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let authorized = client
        .get(format!("{}/writer/health", server.url))
        .bearer_auth(server.writer_token())
        .send()
        .expect("Failed to send authorized writer request");
    assert_eq!(authorized.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = authorized.json().expect("Failed to parse writer health");
    assert_eq!(body["ok"], true);
    assert_eq!(body["writer"]["ready"], true);
    assert_eq!(body["writer"]["pid"], std::process::id());
}

#[test]
fn test_server_health() {
    let server = TestServer::start();
    let client = reqwest::blocking::Client::new();
    let res = client
        .get(format!("{}/mcp/health", server.url))
        .send()
        .expect("Failed to send request");

    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = res.json().expect("Failed to parse JSON");
    assert!(body["ok"].as_bool().unwrap_or(false));
    assert_eq!(body["server"].as_str().unwrap_or(""), "context-still");
    assert_eq!(body["transport"].as_str().unwrap_or(""), "streamable-http");
    assert!(body["toolCount"].is_number());
    assert!(body["toolOwners"].is_object());
    assert!(body["activeSessionCount"].is_number());
}

#[test]
fn test_server_not_found() {
    let server = TestServer::start();
    let client = reqwest::blocking::Client::new();
    let res = client
        .get(format!("{}/invalid", server.url))
        .send()
        .expect("Failed to send request");

    assert_eq!(res.status(), reqwest::StatusCode::NOT_FOUND);
    let body: serde_json::Value = res.json().expect("Failed to parse JSON");
    assert!(!body["ok"].as_bool().unwrap_or(true));
    assert_eq!(body["error"].as_str().unwrap_or(""), "not_found");
}

#[test]
fn test_server_mcp_methods() {
    let server = TestServer::start();
    let client = reqwest::blocking::Client::new();

    // GET /mcp is 405 Method Not Allowed
    let res_get = client
        .get(format!("{}/mcp", server.url))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_get.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
    let headers_get = res_get.headers();
    assert_eq!(
        headers_get.get("Allow").unwrap().to_str().unwrap(),
        "POST, DELETE"
    );

    // PUT /mcp is 405 Method Not Allowed (fallback match _)
    let res_put = client
        .put(format!("{}/mcp", server.url))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_put.status(), reqwest::StatusCode::METHOD_NOT_ALLOWED);
    let headers_put = res_put.headers();
    assert_eq!(
        headers_put.get("Allow").unwrap().to_str().unwrap(),
        "GET, POST, DELETE"
    );
}

#[test]
fn test_server_mcp_initialize_and_flow() {
    let server = TestServer::start();
    let client = reqwest::blocking::Client::new();

    // 1. Send POST to /mcp with JSON parsing error
    let res_parse_err = client
        .post(format!("{}/mcp", server.url))
        .body("invalid json")
        .send()
        .expect("Failed to send request");
    assert_eq!(res_parse_err.status(), reqwest::StatusCode::BAD_REQUEST);
    let body_parse_err: serde_json::Value = res_parse_err.json().expect("Failed to parse JSON");
    assert!(body_parse_err["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Parse error"));

    // 2. Send POST to /mcp without session_id (initialize required)
    let res_no_sess = client
        .post(format!("{}/mcp", server.url))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_no_sess.status(), reqwest::StatusCode::BAD_REQUEST);
    let body_no_sess: serde_json::Value = res_no_sess.json().expect("Failed to parse");
    assert!(body_no_sess["error"]["message"]
        .as_str()
        .unwrap()
        .contains("initialize is required"));

    // 3. Send POST with invalid/non-existent session ID
    let res_invalid_sess = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", "non-existent-session-id")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_invalid_sess.status(), reqwest::StatusCode::NOT_FOUND);
    let body_invalid_sess: serde_json::Value = res_invalid_sess.json().expect("Failed to parse");
    assert!(body_invalid_sess["error"]["message"]
        .as_str()
        .unwrap()
        .contains("session is not active"));

    // 4. Initialize session
    let res_init = client
        .post(format!("{}/mcp", server.url))
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05"
            }
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_init.status(), reqwest::StatusCode::OK);

    let headers_init = res_init.headers();
    let session_id_header = headers_init
        .get("Mcp-Session-Id")
        .expect("Missing Mcp-Session-Id header");
    let session_id = session_id_header.to_str().unwrap().to_string();
    assert!(!session_id.is_empty());

    let body_init: serde_json::Value = res_init.json().expect("Failed to parse");
    assert_eq!(
        body_init["result"]["protocolVersion"].as_str().unwrap(),
        "2024-11-05"
    );

    // 5. Call tools/list with session ID
    let res_tools = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_tools.status(), reqwest::StatusCode::OK);
    let body_tools: serde_json::Value = res_tools.json().expect("Failed to parse");
    assert!(body_tools["result"]["tools"].is_array());
    assert_eq!(body_tools["result"]["tools"].as_array().unwrap().len(), 12);

    // 6. Call resources/list with session ID
    let res_res = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "resources/list",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_res.status(), reqwest::StatusCode::OK);
    let body_res: serde_json::Value = res_res.json().expect("Failed to parse");
    assert!(body_res["result"]["resources"].is_array());

    // 7. Call unknown tool with tools/call
    let res_call_unknown = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "non_existent_tool"
            }
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_call_unknown.status(), reqwest::StatusCode::OK);
    let body_call_unknown: serde_json::Value = res_call_unknown.json().expect("Failed to parse");
    assert!(body_call_unknown["result"]["isError"].as_bool().unwrap());
    assert!(body_call_unknown["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Unknown MCP tool"));

    // 8. Call resources/read
    let res_read = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "resources/read",
            "params": {
                "uri": "context-still://health/doctor"
            }
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_read.status(), reqwest::StatusCode::OK);
    let body_read: serde_json::Value = res_read.json().expect("Failed to parse");
    assert!(body_read["result"]["contents"].is_array());

    // 9. Call unknown method
    let res_unknown_method = client
        .post(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "some/unknown/method",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_unknown_method.status(), reqwest::StatusCode::OK);
    let body_unknown_method: serde_json::Value =
        res_unknown_method.json().expect("Failed to parse");
    assert!(body_unknown_method["result"]["isError"].as_bool().unwrap());
    assert!(body_unknown_method["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Unknown MCP method"));

    // 10. Call notification (id is None) - returns 202 Accepted with empty response
    let res_notif = client
        .post(format!("{}/mcp", server.url))
        .json(&json!({
            "jsonrpc": "2.0",
            "method": "some/notification",
            "params": {}
        }))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_notif.status(), reqwest::StatusCode::ACCEPTED);
    assert_eq!(res_notif.text().expect("Failed to read"), "");

    // 11. Delete session (DELETE /mcp)
    let res_del = client
        .delete(format!("{}/mcp", server.url))
        .header("mcp-session-id", &session_id)
        .send()
        .expect("Failed to send request");
    assert_eq!(res_del.status(), reqwest::StatusCode::OK);
    let body_del: serde_json::Value = res_del.json().expect("Failed to parse");
    assert!(body_del["ok"].as_bool().unwrap());
    assert_eq!(body_del["sessionId"].as_str().unwrap(), session_id);

    // 12. Delete session with invalid id
    let res_del_invalid = client
        .delete(format!("{}/mcp", server.url))
        .header("mcp-session-id", "non-existent")
        .send()
        .expect("Failed to send request");
    assert_eq!(res_del_invalid.status(), reqwest::StatusCode::NOT_FOUND);

    // 13. Delete session without session-id header
    let res_del_no_id = client
        .delete(format!("{}/mcp", server.url))
        .send()
        .expect("Failed to send request");
    assert_eq!(res_del_no_id.status(), reqwest::StatusCode::NOT_FOUND);
}

#[test]
fn test_server_request_headers_too_large() {
    let server = TestServer::start();
    use std::io::Write;
    let addr = server.url.strip_prefix("http://").unwrap();
    let mut stream = std::net::TcpStream::connect(addr).expect("Failed to connect");

    let huge_header = vec![b'A'; 130 * 1024];
    let _ = stream.write_all(&huge_header);

    let mut res = String::new();
    let _ = std::io::Read::read_to_string(&mut stream, &mut res);
    assert!(
        res.contains("400 Bad Request")
            || res.contains("413 Content Too Large")
            || res.contains("too large")
            || res.is_empty()
    );
}

#[test]
fn test_server_empty_request() {
    let server = TestServer::start();
    let addr = server.url.strip_prefix("http://").unwrap();
    let stream = std::net::TcpStream::connect(addr).expect("Failed to connect");
    drop(stream);
}

#[test]
fn test_running_endpoint_is_finished() {
    let server = TestServer::start();
    let ep = server.endpoint.as_ref().unwrap();
    assert!(!ep.is_finished());
}

struct TypedMemoryServer {
    endpoint: Option<RunningEndpoint>,
    env: MapEnv,
    url: String,
    token: String,
    temp_dir: PathBuf,
}

impl TypedMemoryServer {
    fn start() -> Self {
        let port = get_free_port();
        let temp_dir = create_temp_dir();
        let sqlite_path = temp_dir.join("typed-memory.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
                create table knowledge_items (
                  id text primary key, type text not null, status text not null default 'active',
                  classification_status text not null default 'classified', scope text not null default 'repo',
                  project_ref text, title text not null, body text not null, polarity text not null default 'positive',
                  intent_tags text not null default '[]', applies_to text not null default '{}',
                  importance real not null default 70, dynamic_score real not null default 0,
                  created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP
                );
                insert into knowledge_items (id,type,project_ref,title,body,polarity)
                values ('rule-1','rule','project-a','Rust release rule','Run cargo test before release.','positive');
                "#,
            )
            .unwrap();
        drop(connection);
        let env = MapEnv::new(HashMap::from([
            (
                "CONTEXT_STILL_MCP_HOST".to_string(),
                "127.0.0.1".to_string(),
            ),
            ("CONTEXT_STILL_MCP_PORT".to_string(), port.to_string()),
            (
                "CONTEXT_STILL_APP_DATA_DIR".to_string(),
                temp_dir.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH".to_string(),
                sqlite_path.to_string_lossy().into_owned(),
            ),
            (
                "CONTEXT_STILL_MCP_TOOL_PROFILE".to_string(),
                "typed-memory".to_string(),
            ),
            (
                "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF".to_string(),
                "project-a".to_string(),
            ),
        ]));
        let endpoint = start_in_process(&env).expect("Failed to start typed-memory endpoint");
        let url = format!("http://127.0.0.1:{port}");
        wait_for_health(&url);
        let token = std::fs::read_to_string(temp_dir.join("run/mcp-memory-bearer.token"))
            .unwrap()
            .trim()
            .to_string();
        Self {
            endpoint: Some(endpoint),
            env,
            url,
            token,
            temp_dir,
        }
    }

    fn post(
        &self,
        client: &reqwest::blocking::Client,
        body: serde_json::Value,
    ) -> reqwest::blocking::Response {
        client
            .post(format!("{}/mcp", self.url))
            .bearer_auth(&self.token)
            .header("Accept", "application/json, text/event-stream")
            .json(&body)
            .send()
            .unwrap()
    }

    fn initialize(&self, client: &reqwest::blocking::Client) -> String {
        let response = self.post(
            client,
            json!({
                "jsonrpc":"2.0","id":1,"method":"initialize",
                "params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}
            }),
        );
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let session_id = response.headers()["Mcp-Session-Id"]
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(session_id.len(), 32);
        assert!(session_id
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        let body: serde_json::Value = response.json().unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(body["result"]["capabilities"], json!({"tools":{}}));
        let instructions = body["result"]["instructions"].as_str().unwrap();
        assert!(instructions.contains("untrusted evidence"));
        assert!(instructions.contains("current user instructions"));
        session_id
    }

    fn post_session(
        &self,
        client: &reqwest::blocking::Client,
        session_id: &str,
        body: serde_json::Value,
    ) -> reqwest::blocking::Response {
        client
            .post(format!("{}/mcp", self.url))
            .bearer_auth(&self.token)
            .header("Accept", "application/json, text/event-stream")
            .header("Mcp-Session-Id", session_id)
            .json(&body)
            .send()
            .unwrap()
    }
}

impl Drop for TypedMemoryServer {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.stop();
        }
        let _ = std::fs::remove_dir_all(&self.temp_dir);
    }
}

#[test]
fn typed_memory_profile_has_minimal_manifest_health_and_routes() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let health = client
        .get(format!("{}/mcp/health", server.url))
        .send()
        .unwrap();
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    assert_eq!(health.text().unwrap(), "{\"ok\":true}");

    let writer = client
        .get(format!("{}/writer/health", server.url))
        .send()
        .unwrap();
    assert_eq!(writer.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(!server.temp_dir.join("run/sqlite-writer.token").exists());

    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(server.temp_dir.join("run/mcp-endpoint.json")).unwrap(),
    )
    .unwrap();
    let keys = manifest
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            "auth",
            "authTokenPath",
            "contractVersion",
            "protocolVersion",
            "server",
            "startedAt",
            "toolProfile",
            "transport",
            "url"
        ]
    );
    assert_eq!(manifest["toolProfile"], "typed-memory");
    assert!(manifest.get("projectRef").is_none());
    assert!(manifest.get("writerTokenPath").is_none());

    let smoke = super::service::smoke_report(&server.env);
    assert!(smoke.ok, "{}", smoke.message);
    assert_eq!(smoke.tool_count, 3);
    assert_eq!(
        smoke.tool_owners["rustNative"],
        json!(["recall_experience", "recall_rule", "recall_skill"])
    );
    let sessions = super::service::sessions_report(&server.env).unwrap();
    assert_eq!(sessions.active_session_count, 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(server.temp_dir.join("run"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for path in [
            server.temp_dir.join("run/mcp-endpoint.json"),
            server.temp_dir.join("run/mcp-memory-bearer.token"),
            server.temp_dir.join("run/mcp-sessions.json"),
        ] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn typed_memory_profile_enforces_auth_origin_host_and_accept() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let initialize = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}});

    let unauthorized = client
        .post(format!("{}/mcp", server.url))
        .header("Accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let origin = client
        .post(format!("{}/mcp", server.url))
        .bearer_auth(&server.token)
        .header("Origin", "https://example.invalid")
        .header("Accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .unwrap();
    assert_eq!(origin.status(), reqwest::StatusCode::FORBIDDEN);

    let bad_accept = client
        .post(format!("{}/mcp", server.url))
        .bearer_auth(&server.token)
        .header("Accept", "application/json")
        .json(&initialize)
        .send()
        .unwrap();
    assert_eq!(bad_accept.status(), reqwest::StatusCode::NOT_ACCEPTABLE);

    for invalid_accept in [
        "application/json-patch+json, text/event-streaming",
        "application/json;q=0, text/event-stream",
        "application/json;broken, text/event-stream",
    ] {
        let response = client
            .post(format!("{}/mcp", server.url))
            .bearer_auth(&server.token)
            .header("Accept", invalid_accept)
            .json(&initialize)
            .send()
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_ACCEPTABLE);
    }

    let host = client
        .post(format!("{}/mcp", server.url))
        .bearer_auth(&server.token)
        .header("Host", "localhost.invalid")
        .header("Accept", "application/json, text/event-stream")
        .json(&initialize)
        .send()
        .unwrap();
    assert_eq!(host.status(), reqwest::StatusCode::BAD_REQUEST);
}

#[test]
fn typed_memory_profile_enforces_header_and_body_limits() {
    let server = TypedMemoryServer::start();
    let address = server.url.strip_prefix("http://").unwrap();
    let mut stream = std::net::TcpStream::connect(address).unwrap();
    let oversized_header = "A".repeat(33 * 1024);
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 2\r\nX-Oversized: {oversized_header}\r\nConnection: close\r\n\r\n{{}}",
        server.token
    );
    std::io::Write::write_all(&mut stream, request.as_bytes()).unwrap();
    let mut response = String::new();
    let _ = std::io::Read::read_to_string(&mut stream, &mut response);
    assert!(response.starts_with("HTTP/1.1 413"), "{response:?}");

    let oversized_body = "x".repeat(32 * 1024 + 1);
    let body = reqwest::blocking::Client::new()
        .post(format!("{}/mcp", server.url))
        .bearer_auth(&server.token)
        .header("Accept", "application/json, text/event-stream")
        .header("Content-Type", "application/json")
        .body(oversized_body)
        .send()
        .unwrap();
    assert_eq!(body.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

    let mut stream = std::net::TcpStream::connect(address).unwrap();
    let mut invalid_utf8 = format!(
        "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
        server.token
    )
    .into_bytes();
    invalid_utf8.push(0xff);
    std::io::Write::write_all(&mut stream, &invalid_utf8).unwrap();
    let mut response = String::new();
    let _ = std::io::Read::read_to_string(&mut stream, &mut response);
    assert!(response.starts_with("HTTP/1.1 400"), "{response:?}");
}

#[test]
fn typed_memory_profile_validates_initialize_and_negotiates_protocol() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();

    let missing_capabilities = server.post(
        &client,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1"}}}),
    );
    let missing_capabilities: serde_json::Value = missing_capabilities.json().unwrap();
    assert_eq!(missing_capabilities["error"]["code"], -32602);

    let oversized_name = "x".repeat(129);
    let oversized_client = server.post(
        &client,
        json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":oversized_name,"version":"1"}}}),
    );
    let oversized_client: serde_json::Value = oversized_client.json().unwrap();
    assert_eq!(oversized_client["error"]["code"], -32602);

    let negotiated = server.post(
        &client,
        json!({"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
    );
    assert_eq!(negotiated.status(), reqwest::StatusCode::OK);
    let negotiated: serde_json::Value = negotiated.json().unwrap();
    assert_eq!(negotiated["result"]["protocolVersion"], "2025-03-26");
}

#[test]
fn typed_memory_profile_enforces_lifecycle_allowlist_and_output_contract() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let session_id = server.initialize(&client);
    let ledger: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(server.temp_dir.join("run/mcp-sessions.json")).unwrap(),
    )
    .unwrap();
    let ledger_keys = ledger[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert_eq!(
        ledger_keys,
        [
            "closeReason",
            "createdAt",
            "inFlightRequestCount",
            "lastActivityAt",
            "lastActivityUnixSeconds",
            "sessionId"
        ]
    );

    let before_initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    );
    let body: serde_json::Value = before_initialized.json().unwrap();
    assert_eq!(body["error"]["code"], -32000);

    let initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    );
    assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);
    assert_eq!(initialized.headers()["cache-control"], "no-store");
    assert_eq!(initialized.text().unwrap(), "");

    let response_only = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":99,"result":{}}),
    );
    assert_eq!(response_only.status(), reqwest::StatusCode::ACCEPTED);
    assert_eq!(response_only.text().unwrap(), "");

    let scalar_params = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":100,"method":"tools/list","params":[]}),
    );
    let scalar_params: serde_json::Value = scalar_params.json().unwrap();
    assert_eq!(scalar_params["error"]["code"], -32600);

    let invalid_id = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":true,"method":"tools/list","params":{}}),
    );
    let invalid_id: serde_json::Value = invalid_id.json().unwrap();
    assert_eq!(invalid_id["error"]["code"], -32600);
    assert_eq!(invalid_id["id"], serde_json::Value::Null);

    let tools = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"progressToken":"smoke"}}}),
    );
    let tools: serde_json::Value = tools.json().unwrap();
    let names = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["recall_experience", "recall_rule", "recall_skill"]);

    let recall = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall_rule","arguments":{"query":"cargo test"}}}),
    );
    let recall: serde_json::Value = recall.json().unwrap();
    assert!(recall["result"].get("isError").is_none());
    let envelope: serde_json::Value =
        serde_json::from_str(recall["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(envelope["contractVersion"], "memory-recall-v1");
    assert_eq!(envelope["trust"]["instructionAuthority"], "none");
    assert_eq!(envelope["items"].as_array().unwrap().len(), 1);
    assert!(envelope["items"][0].get("id").is_none());

    let unknown_tool = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"x"}}}),
    );
    let unknown_tool: serde_json::Value = unknown_tool.json().unwrap();
    assert_eq!(unknown_tool["error"]["code"], -32602);

    let resources = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":6,"method":"resources/list","params":{}}),
    );
    let resources: serde_json::Value = resources.json().unwrap();
    assert_eq!(resources["error"]["code"], -32601);
}

#[test]
fn typed_memory_profile_rejects_unissued_tools_cursor() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let session_id = server.initialize(&client);
    let initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    );
    assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);

    let unsupported_cursor = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":32,"method":"tools/list","params":{"cursor":"not-issued"}}),
    );
    let unsupported_cursor: serde_json::Value = unsupported_cursor.json().unwrap();
    assert_eq!(unsupported_cursor["error"]["code"], -32602);
}

#[test]
fn typed_memory_profile_denies_every_resource_and_prompt_method() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let session_id = server.initialize(&client);
    let initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    );
    assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);

    let denied = server.post_session(
        &client,
        &session_id,
        json!([
            {"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}},
            {"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"context-still://memory"}},
            {"jsonrpc":"2.0","id":3,"method":"prompts/list","params":{}},
            {"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"memory"}}
        ]),
    );
    let denied: serde_json::Value = denied.json().unwrap();
    assert_eq!(denied.as_array().unwrap().len(), 4);
    assert!(denied
        .as_array()
        .unwrap()
        .iter()
        .all(|response| response["error"]["code"] == -32601));
}

#[test]
fn typed_memory_profile_caps_active_sessions() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    for _ in 0..8 {
        let response = server.post(
            &client,
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
        );
        assert_eq!(response.status(), reqwest::StatusCode::OK);
    }
    let rejected = server.post(
        &client,
        json!({"jsonrpc":"2.0","id":9,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
    );
    assert_eq!(rejected.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
}

#[test]
fn typed_memory_profile_enforces_batch_limits() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let session_id = server.initialize(&client);
    let initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    );
    assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);

    let oversized = (0..11)
        .map(|id| json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{}}))
        .collect::<Vec<_>>();
    let response = server.post_session(&client, &session_id, json!(oversized));
    let response: serde_json::Value = response.json().unwrap();
    assert_eq!(response["error"]["code"], -32600);

    let response = server.post_session(
        &client,
        &session_id,
        json!([
            {"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"recall_rule","arguments":{"query":"rust"}}},
            {"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"recall_rule","arguments":{"query":"cargo"}}}
        ]),
    );
    let response: serde_json::Value = response.json().unwrap();
    assert_eq!(response["error"]["code"], -32602);
}

#[test]
fn typed_memory_profile_counts_each_batch_element_against_rate_limit() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let session_id = server.initialize(&client);
    let initialized = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}}),
    );
    assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);

    let batch = (0..8)
        .map(|id| json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":{}}))
        .collect::<Vec<_>>();
    let response = server.post_session(&client, &session_id, json!(batch));
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let exhausted = server.post_session(
        &client,
        &session_id,
        json!({"jsonrpc":"2.0","id":20,"method":"tools/list","params":{}}),
    );
    assert_eq!(exhausted.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
}

#[test]
fn typed_memory_profile_enforces_rate_and_in_flight_limits() {
    let server = TypedMemoryServer::start();
    let client = reqwest::blocking::Client::new();
    let mut rate_limited = false;
    for index in 0..20 {
        let response = server.post(&client, json!({}));
        if index < 10 {
            assert_ne!(response.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
        }
        rate_limited |= response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS;
    }
    assert!(rate_limited);

    drop(server);
    let server = TypedMemoryServer::start();
    let address = server.url.strip_prefix("http://").unwrap();
    let blockers = (0..8)
        .map(|_| std::net::TcpStream::connect(address).unwrap())
        .collect::<Vec<_>>();
    std::thread::sleep(Duration::from_millis(500));
    let mut rejected = std::net::TcpStream::connect(address).unwrap();
    rejected
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    std::io::Write::write_all(
        &mut rejected,
        format!("GET /mcp/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let mut response = String::new();
    let _ = std::io::Read::read_to_string(&mut rejected, &mut response);
    assert!(response.starts_with("HTTP/1.1 429"), "{response:?}");
    drop(blockers);
}
