use super::native_tools::tool_owner_inventory;
use super::service::*;
use crate::shared::config::MapEnv;
use crate::shared::process::MockSupervisor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn temp_app_dir() -> std::path::PathBuf {
    let rand_num = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!(
        "context_still_mcp_test_{}_{}_{}",
        std::process::id(),
        rand_num,
        temp_id
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn cleanup_temp_app_dir(path: &std::path::Path) {
    let _ = std::fs::remove_dir_all(path);
}

#[test]
fn mcp_lifecycle_spawns_rust_http_endpoint_worker() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
    ]);
    let supervisor = MockSupervisor::new();

    let start_res = start(&env, &supervisor).unwrap();
    assert!(start_res.contains("mcp-endpoint started"));

    let spawned = supervisor.spawned.lock().unwrap();
    let call = spawned.values().next().unwrap();
    assert!(call.command.ends_with("context_stilld") || call.command.contains("context_stilld"));
    assert_eq!(call.args, vec!["mcp", "serve"]);

    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn endpoint_report_uses_loopback_streamable_http_url() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_PORT", "45678"),
    ]);

    let report = endpoint_report(&env);

    assert_eq!(report.url, "http://127.0.0.1:45678/mcp");
    assert_eq!(report.transport, "streamable-http");
    assert_eq!(report.auth, "none");
    assert!(!report.ready);
    assert!(report.metadata_path.ends_with("mcp-endpoint.json"));
    assert!(report.session_state_path.ends_with("mcp-sessions.json"));

    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn endpoint_report_brackets_ipv6_loopback_url() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_HOST", "::1"),
        ("CONTEXT_STILL_MCP_PORT", "45678"),
    ]);

    let report = endpoint_report(&env);

    assert_eq!(report.url, "http://[::1]:45678/mcp");
    assert!(report
        .warnings
        .iter()
        .all(|warning| !warning.contains("Invalid")));

    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn endpoint_report_describes_typed_memory_auth() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_TOOL_PROFILE", "typed-memory"),
        ("CONTEXT_STILL_MCP_PORT", "45678"),
    ]);

    let report = endpoint_report(&env);

    assert_eq!(report.auth, "bearer-token-file");
    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn endpoint_report_surfaces_invalid_tool_profile() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_TOOL_PROFILE", " typed-memory"),
        ("CONTEXT_STILL_MCP_PORT", "45678"),
    ]);

    let report = endpoint_report(&env);

    assert!(!report.ready);
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("must be default or typed-memory")));
    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn endpoint_report_does_not_probe_non_loopback_configuration() {
    let app_dir = temp_app_dir();
    let env = MapEnv::from_pairs(vec![
        ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
        ("CONTEXT_STILL_MCP_HOST", "192.0.2.1"),
    ]);

    let report = endpoint_report(&env);

    assert_eq!(report.url, "unavailable");
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("must be a loopback IP address")));

    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn sessions_report_reads_daemon_session_state() {
    let app_dir = temp_app_dir();
    let run_dir = app_dir.join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    let session_file = run_dir.join("mcp-sessions.json");
    std::fs::write(
        &session_file,
        r#"[{
          "sessionId": "s1",
          "clientName": "codex",
          "clientVersion": "1.0",
          "remoteAddress": "127.0.0.1",
          "createdAt": "2026-06-22T00:00:00.000Z",
          "lastActivityAt": "2026-06-22T00:01:00.000Z",
          "inFlightRequestCount": 0,
          "workerId": "typescript-mcp-worker",
          "route": "typescript-mcp-server",
          "closeReason": null
        }]"#,
    )
    .unwrap();
    let env = MapEnv::from_pairs(vec![(
        "CONTEXT_STILL_APP_DATA_DIR",
        app_dir.to_str().unwrap(),
    )]);

    let report = sessions_report(&env).unwrap();

    assert_eq!(report.active_session_count, 1);
    assert_eq!(report.sessions[0].session_id, "s1");

    cleanup_temp_app_dir(&app_dir);
}

#[test]
fn tool_owner_inventory_tracks_rust_native_migration() {
    let inventory = tool_owner_inventory();

    assert_eq!(inventory["counts"]["rustNative"], 12);
    assert_eq!(inventory["counts"]["tsSidecar"], 0);
    assert!(inventory["rustNative"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool == "compile_eval"));
    assert!(inventory["rustNative"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool == "doctor"));
    assert!(inventory["rustNative"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool == "search_knowledge"));
}
