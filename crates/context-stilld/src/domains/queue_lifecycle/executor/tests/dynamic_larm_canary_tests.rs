use super::super::run_executor_tick_report;
use crate::domains::queue_lifecycle::test_support::temp_app_dir;
use crate::shared::config::MapEnv;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    let mut content_length = 0_usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.is_empty() || line == "\r\n" {
            break;
        }
        if let Some(value) = line
            .to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
        {
            content_length = value;
        }
        request.push_str(&line);
    }
    request.push_str("\r\n");
    if content_length > 0 {
        let mut body = vec![0_u8; content_length];
        reader.read_exact(&mut body).unwrap();
        request.push_str(&String::from_utf8(body).unwrap());
    }
    request
}

fn json_response(status: u16, body: Value) -> String {
    let body = body.to_string();
    let reason = if status == 201 { "Created" } else { "OK" };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn activity_response() -> String {
    json_response(
        200,
        json!({
            "contractVersion": "larm-service-activity.v1",
            "state": "idle",
            "activeWorkloads": 0,
            "observedAt": crate::domains::provider_connection::service::current_rfc3339_for_test(),
            "validForMs": 1_000,
            "retryAfterMs": 0,
            "reservationGuaranteed": false,
            "bootEpoch": "epoch-canary",
            "configRevision": "catalog-canary"
        }),
    )
}

fn profile_response() -> String {
    json_response(
        200,
        json!({
            "contractVersion": "agent-connection.v2",
            "catalogRevision": "catalog-canary",
            "defaultAgentProfile": "coding-default",
            "profiles": [{
                "id": "contextstill-background",
                "canonicalProfile": "contextstill-background",
                "description": "ContextStill background provider",
                "selectionPolicy": "explicit-only",
                "deprecated": false,
                "providers": [{
                    "name": "llm",
                    "capability": "llm.coding",
                    "supportedCapabilities": ["llm.coding", "llm.general", "llm.reasoning"],
                    "protocol": "openai.chat-completions.v1",
                    "model": "qwen-agent-worker"
                }]
            }],
            "audiences": ["saaa-desktop", "same-host"]
        }),
    )
}

fn connection_response() -> String {
    json_response(
        201,
        json!({
            "id": "aconn_canary",
            "allocationId": "alloc_canary",
            "bootEpoch": "epoch-canary",
            "catalogRevision": "catalog-canary",
            "agentProfile": "contextstill-background",
            "profileRevision": "1".repeat(64),
            "audience": "saaa-desktop",
            "audienceRevision": "2".repeat(64),
            "status": "ready",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "route": "llm-agent-worker",
                "protocol": "openai.chat-completions.v1",
                "publicModel": "qwen-agent-worker",
                "readiness": "ready",
                "claimable": true
            }],
            "createdAt": "2026-09-06T12:00:00.000Z",
            "expiresAt": "2099-09-06T12:15:00.000Z",
            "releasedAt": null,
            "error": null
        }),
    )
}

fn claim_response(provider_origin: &str, provider_port: u16) -> String {
    json_response(
        200,
        json!({
            "id": "aconn_canary",
            "allocationId": "alloc_canary",
            "status": "ready",
            "audience": "saaa-desktop",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "apiStyle": "openai",
                "protocol": "openai.chat-completions.v1",
                "scheme": "http",
                "host": "127.0.0.1",
                "port": provider_port,
                "baseUrl": format!("{provider_origin}/v1"),
                "model": "qwen-agent-worker",
                "health": {
                    "url": format!("{provider_origin}/v1/agent-connections/aconn_canary/providers/llm/health"),
                    "kind": "semantic-inference",
                    "maxAgeMs": 10_000
                },
                "credential": {
                    "type": "bearer",
                    "token": "larm_conn_v1.canary",
                    "expiresAt": "2099-09-06T12:15:00.000Z"
                },
                "configuration": {
                    "kind": "openai-provider-v1",
                    "fields": {
                        "baseURL": format!("{provider_origin}/v1"),
                        "model": "qwen-agent-worker"
                    },
                    "secretFields": {"apiKey": "credential.token"}
                }
            }],
            "expiresAt": "2099-09-06T12:15:00.000Z"
        }),
    )
}

#[test]
fn dynamic_larm_canary_uses_claimed_json_target_and_releases_connection() {
    let provider_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provider_address = provider_listener.local_addr().unwrap();
    let provider_origin = format!("http://{provider_address}");
    let (provider_request_tx, provider_request_rx) = mpsc::channel();
    let provider_server = thread::spawn(move || {
        let (mut stream, _) = provider_listener.accept().unwrap();
        provider_request_tx.send(read_request(&mut stream)).unwrap();
        let content = json!([{
            "type": "rule",
            "polarity": "positive",
            "title": "Use the claimed Provider",
            "content": "Use only the endpoint and credential returned by the active claim."
        }])
        .to_string();
        stream
            .write_all(
                json_response(200, json!({"choices": [{"message": {"content": content}}]}))
                    .as_bytes(),
            )
            .unwrap();
    });

    let control_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let control_origin = format!("http://{}", control_listener.local_addr().unwrap());
    let (control_requests_tx, control_requests_rx) = mpsc::channel();
    let claimed_origin = provider_origin.clone();
    let control_server = thread::spawn(move || {
        for index in 0..5 {
            let (mut stream, _) = control_listener.accept().unwrap();
            control_requests_tx.send(read_request(&mut stream)).unwrap();
            let response = match index {
                0 => activity_response(),
                1 => profile_response(),
                2 => connection_response(),
                3 => claim_response(&claimed_origin, provider_address.port()),
                4 => "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
                _ => unreachable!(),
            };
            stream.write_all(response.as_bytes()).unwrap();
        }
    });

    let app_dir = temp_app_dir("dynamic_larm_canary");
    let sqlite_path = app_dir.join("queue.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open(&sqlite_path).unwrap();
    crate::domains::sqlite_writer::schema::configure_writer_connection(&connection).unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut connection, 3).unwrap();
    let settings = json!({"settings": {
        "providerPools": [],
        "providers": {
            "local-llm": {"enabled": true, "models": [{
                "id": "legacy-static", "apiBaseUrl": "http://127.0.0.1:44448",
                "apiPath": "/v1/chat/completions", "model": "legacy-static"
            }]},
            "larm-agent-connection": {"enabled": true, "connections": [{
                "id": "contextstill-background-canary", "controlBaseUrl": control_origin,
                "agentProfile": "contextstill-background", "audience": "saaa-desktop",
                "availabilityPollMs": 1_000, "availabilityTimeoutMs": 2_000,
                "controlTimeoutMs": 5_000, "readyTimeoutMs": 30_000,
                "ttlSeconds": 900, "requestTimeoutMs": 300_000
            }]}
        },
        "taskRouting": {
            "findCandidate": {
                "source": {"kind": "larm-agent-connection", "connectionId": "contextstill-background-canary"},
                "vibe": {"kind": "larm-agent-connection", "connectionId": "contextstill-background-canary"}
            },
            "episodeDistiller": {"kind": "larm-agent-connection", "connectionId": "contextstill-background-canary"}
        }
    }});
    connection.execute(
        "insert into settings (id,namespace,key,value,value_kind,is_secret,schema_version,created_at,updated_at) values ('settings-larm-canary','runtime','settings.v1',?1,'json',0,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        [settings.to_string()],
    ).unwrap();
    connection.execute_batch(r#"
        insert into vibe_memories (id,session_id,content,memory_type,metadata,created_at)
        values ('memory-larm-canary','session-larm-canary','Use only the active dynamic Provider claim.','chat','{"rustAgentLogSync":true,"projectRoot":"/work/project"}',CURRENT_TIMESTAMP);
        insert into finding_candidate_queue (
          id,input_kind,source_kind,source_key,source_uri,distillation_version,status,
          priority,attempt_count,metadata,created_at,updated_at
        ) values ('finding-larm-canary','source_target','vibe_memory','memory-larm-canary',
          'vibe_memory:memory-larm-canary','v1','pending',100,0,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    "#).unwrap();
    drop(connection);

    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        (
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        ),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_RUST_QUEUE_EXECUTOR_MAX_CLAIMS", "1"),
    ]);
    let first = run_executor_tick_report(&env).unwrap();
    let second = run_executor_tick_report(&env).unwrap();
    provider_server.join().unwrap();
    control_server.join().unwrap();

    assert_eq!(
        (first.status.as_str(), first.claimed, first.completed),
        ("executed", 1, 1)
    );
    assert_eq!(second.status, "waiting_for_dynamic_provider");
    let provider_request = provider_request_rx.recv().unwrap();
    assert!(provider_request.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(provider_request
        .to_ascii_lowercase()
        .contains("authorization: bearer larm_conn_v1.canary"));
    let provider_json: Value =
        serde_json::from_str(provider_request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(provider_json["model"], "qwen-agent-worker");
    assert_eq!(provider_json["stream"], false);
    assert!(!provider_request.contains("44448"));

    let control_requests = control_requests_rx.try_iter().collect::<Vec<_>>();
    assert_eq!(control_requests.len(), 5);
    assert!(control_requests[0].starts_with("GET /v1/activity HTTP/1.1"));
    assert!(control_requests[1].starts_with("GET /v2/agent-profiles HTTP/1.1"));
    assert!(control_requests[2].starts_with("POST /v1/agent-connections HTTP/1.1"));
    assert!(control_requests[3].contains("/claim HTTP/1.1"));
    assert!(control_requests[4].starts_with("DELETE /v1/agent-connections/aconn_canary"));
    assert!(control_requests
        .iter()
        .all(|request| !request.contains("44448")));

    let connection = Connection::open(&sqlite_path).unwrap();
    let status: String = connection
        .query_row(
            "select status from finding_candidate_queue where id='finding-larm-canary'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let candidates: i64 = connection
        .query_row(
            "select count(*) from found_candidates where finding_job_id='finding-larm-canary'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let active_leases: i64 = connection
        .query_row(
            "select count(*) from llm_provider_leases where status='active'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");
    assert_eq!(candidates, 1);
    assert_eq!(active_leases, 0);
    std::fs::remove_dir_all(app_dir).unwrap();
}
