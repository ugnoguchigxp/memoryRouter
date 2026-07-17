use std::collections::HashMap;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

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
    let mut vars = HashMap::new();
    vars.insert(
        "CONTEXT_STILL_MCP_HOST".to_string(),
        "127.0.0.1".to_string(),
    );
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

fn create_temp_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("test_endpoint_{}_{}", now, count));
    std::fs::create_dir_all(&dir).unwrap();
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
    assert!(res.contains("400 Bad Request") || res.contains("too large") || res.is_empty());
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
