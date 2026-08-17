pub mod domains;
pub mod shared;

use domains::cli::routing::{parse_args, CliCommand};
use shared::config::EnvProvider;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run<I, S, E, P>(args: I, env: &E, supervisor: &P) -> Result<String, shared::errors::CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
    E: EnvProvider,
    P: crate::shared::process::ProcessSupervisor,
{
    match parse_args(args)? {
        CliCommand::Help => Ok(domains::cli::service::help_text()),
        CliCommand::Version => Ok(VERSION.to_string()),
        CliCommand::Run { json, once } => {
            let report = domains::resident_runtime::service::run(env, supervisor, once)?;
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        CliCommand::Paths { json } => {
            let report = domains::bootstrap::service::resolve_paths(env);
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        CliCommand::Status { json } => {
            let report = domains::daemon::service::status_with_supervisor(env, supervisor);
            if json {
                Ok(report.to_json())
            } else {
                Ok(report.to_text())
            }
        }
        CliCommand::Mcp { action, json } => {
            domains::mcp_lifecycle::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::Queue { action, json } => {
            domains::queue_lifecycle::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::AgentLogSync { action, json } => {
            domains::agent_log_sync::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::AdminApi { action, json } => {
            domains::admin_api_lifecycle::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::Runtime { action, json } => match action {
            domains::cli::routing::RuntimeAction::Sidecars => {
                let report = domains::runtime_sidecars::service::sidecars_report(env, supervisor);
                if json {
                    Ok(report.to_json())
                } else {
                    Ok(report.to_text())
                }
            }
            domains::cli::routing::RuntimeAction::AssertRustOnly => {
                let report =
                    domains::runtime_sidecars::service::assert_rust_only_report(env, supervisor);
                if json {
                    Ok(report.to_json())
                } else {
                    Ok(report.to_text())
                }
            }
        },
        CliCommand::Vector { action, json } => {
            domains::vector_index::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::Bootstrap { action, json } => match action {
            domains::cli::routing::BootstrapAction::Preflight => {
                let report = domains::bootstrap::service::preflight(env);
                if json {
                    Ok(report.to_json())
                } else {
                    Ok(report.to_text())
                }
            }
            domains::cli::routing::BootstrapAction::Init => {
                let report = domains::bootstrap::service::init(env)?;
                if json {
                    Ok(report.to_json())
                } else {
                    Ok(report.to_text())
                }
            }
        },
        CliCommand::Doctor { action, json } => {
            domains::doctor::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::Backup { action, json } => {
            domains::backup::routing::handle_command(action, json, env, supervisor)
        }
        CliCommand::ContextCompile { action, json } => {
            domains::context_compile::routing::handle_command(action, json, env, supervisor)
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::shared::config::MapEnv;

    fn run_test_cmd<I, S>(
        args: I,
        vars: Vec<(&str, &str)>,
    ) -> Result<String, crate::shared::errors::CliError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let env = MapEnv::from_pairs(vars);
        let supervisor = crate::shared::process::MockSupervisor::new();
        crate::run(args, &env, &supervisor)
    }

    #[test]
    fn paths_json_uses_overrides_without_mutating_filesystem() {
        let output = run_test_cmd(
            ["paths", "--json"],
            vec![
                ("CONTEXT_STILL_APP_DATA_DIR", "/tmp/contextStill"),
                (
                    "CONTEXT_STILL_SQLITE_CORE_PATH",
                    "/tmp/contextStill/custom.sqlite",
                ),
            ],
        )
        .expect("paths command");

        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");

        assert_eq!(json["appDataDir"], "/tmp/contextStill");
        assert_eq!(json["sqliteCorePath"], "/tmp/contextStill/custom.sqlite");
        assert_eq!(json["logsDir"], "/tmp/contextStill/logs");
        assert_eq!(json["runDir"], "/tmp/contextStill/run");
        assert_eq!(json["backupDir"], "/tmp/contextStill/backup");

        let obj = json.as_object().expect("JSON must be an object");
        assert_eq!(obj.len(), 5);
    }

    #[test]
    fn status_json_reports_resident_runtime_contract() {
        let output = run_test_cmd(
            ["status", "--json"],
            vec![("CONTEXT_STILL_APP_DATA_DIR", "/tmp/contextStill")],
        )
        .expect("status command");

        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");

        assert_eq!(json["runtimeHost"], "rust-resident");
        assert_eq!(json["residentSupervisor"], "stopped");
        assert_eq!(json["honoAdminApi"], "stopped");
        assert_eq!(json["mcpServer"], "stopped");
        assert_eq!(json["queueSupervisor"], "stopped");
        assert_eq!(json["agentLogSync"], "stopped");
        assert_eq!(json["embeddingDaemon"], "stopped");
        assert_eq!(json["managedDefaultFlags"]["mcp"], true);
        assert_eq!(json["managedDefaultFlags"]["queue"], true);
        assert_eq!(json["managedDefaultFlags"]["agentLogSync"], true);
        assert_eq!(json["managedDefaultFlags"]["embedding"], true);
        assert_eq!(json["managedDefaultFlags"]["adminApi"], false);
        assert!(json["version"].is_string());

        let paths = &json["paths"];
        assert_eq!(paths["appDataDir"], "/tmp/contextStill");
        assert_eq!(paths["logsDir"], "/tmp/contextStill/logs");
        assert_eq!(paths["runDir"], "/tmp/contextStill/run");
        assert_eq!(paths["backupDir"], "/tmp/contextStill/backup");
        assert_eq!(
            paths["sqliteCorePath"],
            "/tmp/contextStill/context-still-core.sqlite"
        );

        let obj = json.as_object().expect("JSON must be an object");
        assert_eq!(obj.len(), 10);
    }

    #[test]
    fn resident_run_once_starts_mcp_and_runs_queue_tick() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_resident_run_{}_{}",
            std::process::id(),
            rand_num
        ));
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_MCP_PORT", "0"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", "http://127.0.0.1:1"),
        ]);
        let supervisor = MockSupervisor::new();

        let output = crate::run(["run", "--once", "--json"], &env, &supervisor).unwrap();
        let report: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(report["action"], "run");
        assert_eq!(report["status"], "exited");
        assert_eq!(report["surfaces"].as_array().unwrap().len(), 6);
        assert_eq!(report["surfaces"][0]["name"], "sqlite-writer");
        assert_eq!(report["surfaces"][0]["status"], "running");
        assert_eq!(report["surfaces"][1]["name"], "embedding-daemon");
        assert_eq!(report["surfaces"][1]["status"], "unavailable");
        assert_eq!(report["surfaces"][2]["name"], "mcp-server");
        assert_eq!(report["surfaces"][2]["status"], "running");
        assert_eq!(report["surfaces"][3]["name"], "queue-supervisor");
        assert_eq!(report["surfaces"][3]["status"], "executor_unconfigured");
        assert_eq!(report["surfaces"][4]["name"], "agent-log-sync");
        assert_eq!(report["surfaces"][4]["status"], "scheduled");
        assert_eq!(report["surfaces"][5]["name"], "mcp-server");
        assert_eq!(report["surfaces"][5]["status"], "stopped");

        let status_json = crate::run(["status", "--json"], &env, &supervisor).unwrap();
        let status: serde_json::Value = serde_json::from_str(&status_json).unwrap();
        assert_eq!(status["residentSupervisor"], "exited");
        assert_eq!(status["mcpServer"], "stopped");
        assert_eq!(status["queueSupervisor"], "executor_unconfigured");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn resident_run_once_allows_rust_surfaces_when_rust_only_required() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_resident_rust_only_{}_{}",
            std::process::id(),
            rand_num
        ));
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_MCP_PORT", "0"),
            ("CONTEXT_STILL_RESIDENT_REQUIRE_RUST_ONLY", "1"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", "http://127.0.0.1:1"),
        ]);
        let supervisor = MockSupervisor::new();

        let output = crate::run(["run", "--once", "--json"], &env, &supervisor).unwrap();
        let report: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");

        assert_eq!(report["status"], "exited");
        assert_eq!(report["surfaces"].as_array().unwrap().len(), 6);
        assert_eq!(report["surfaces"][0]["name"], "sqlite-writer");
        assert_eq!(report["surfaces"][0]["status"], "running");
        assert_eq!(report["surfaces"][1]["name"], "embedding-daemon");
        assert_eq!(report["surfaces"][1]["status"], "unavailable");
        assert_eq!(report["surfaces"][2]["name"], "mcp-server");
        assert_eq!(report["surfaces"][2]["status"], "running");
        assert_eq!(report["surfaces"][3]["name"], "queue-supervisor");
        assert_eq!(report["surfaces"][3]["status"], "executor_unconfigured");
        assert_eq!(report["surfaces"][4]["name"], "agent-log-sync");
        assert_eq!(report["surfaces"][4]["status"], "scheduled");
        assert_eq!(report["surfaces"][5]["name"], "mcp-server");
        assert_eq!(report["surfaces"][5]["status"], "stopped");
        assert!(!supervisor
            .spawned
            .lock()
            .unwrap()
            .values()
            .any(|call| call.args == vec!["mcp", "serve"]));
        assert!(supervisor
            .spawned
            .lock()
            .unwrap()
            .values()
            .all(|call| call.command != "bun"));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn status_resolves_running_and_custom_states_dynamically() {
        use crate::domains::daemon::repository::{self, ProcessState};
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use crate::shared::process::ProcessSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "context_still_status_test_{}_{}",
            std::process::id(),
            rand_num
        ));
        let run_dir = app_data_dir.join("run");
        std::fs::create_dir_all(&run_dir).unwrap();

        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_data_dir.to_str().unwrap(),
        )]);

        let supervisor = MockSupervisor::new();

        // 1. Simulate Hono API running (via PID file)
        let hono_pid = supervisor
            .spawn(
                "bun",
                &["run", "api/index.ts"],
                &app_data_dir.join("logs/admin-api.log"),
                &app_data_dir,
            )
            .unwrap();
        repository::write_pid(&run_dir, "admin-api", hono_pid).unwrap();

        // 2. Simulate MCP endpoint degraded (via JSON state file)
        let mcp_pid = supervisor
            .spawn(
                "context-stilld",
                &["mcp", "serve"],
                &app_data_dir.join("logs/mcp.log"),
                &app_data_dir,
            )
            .unwrap();
        let mcp_state = ProcessState {
            pid: Some(mcp_pid),
            status: "degraded".to_string(),
            log_path: app_data_dir
                .join("logs/mcp.log")
                .to_str()
                .unwrap()
                .to_string(),
            ..ProcessState::default()
        };
        repository::write_state(&run_dir, "mcp-server", &mcp_state).unwrap();

        // 3. Simulate Queue supervisor stopped (state file exists but pid process is dead)
        let dead_pid = 9999;
        let queue_state = ProcessState {
            pid: Some(dead_pid),
            status: "running".to_string(),
            log_path: app_data_dir
                .join("logs/queue.log")
                .to_str()
                .unwrap()
                .to_string(),
            ..ProcessState::default()
        };
        repository::write_state(&run_dir, "queue-supervisor", &queue_state).unwrap();

        let status = crate::domains::daemon::service::status_with_supervisor(&env, &supervisor);

        assert_eq!(status.resident_supervisor, "stopped");
        assert_eq!(status.hono_admin_api, "running");
        assert_eq!(status.mcp_server, "degraded");
        assert_eq!(status.queue_supervisor, "stopped");
        assert_eq!(status.agent_log_sync, "stopped");

        std::fs::remove_dir_all(&app_data_dir).unwrap();
    }

    #[test]
    fn test_mcp_command_execution() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_mcp_cmd_{}_{}",
            std::process::id(),
            rand_num
        ));
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_ADMIN_API_SKIP_READINESS", "1"),
        ]);
        let supervisor = MockSupervisor::new();

        // status
        let res = crate::run(["mcp", "status"], &env, &supervisor).unwrap();
        assert_eq!(res, "mcp-endpoint status: stopped");

        // start delegates to the daemon-owned streamable HTTP endpoint worker
        let start_res = crate::run(["mcp", "start"], &env, &supervisor).unwrap();
        assert!(start_res.contains("mcp-endpoint started"));

        let res = crate::run(["mcp", "status"], &env, &supervisor).unwrap();
        assert!(res.contains("mcp-endpoint status: running"));

        let endpoint_json = crate::run(["mcp", "endpoint", "--json"], &env, &supervisor).unwrap();
        let endpoint: serde_json::Value = serde_json::from_str(&endpoint_json).unwrap();
        assert_eq!(endpoint["url"], "http://127.0.0.1:39172/mcp");
        assert_eq!(endpoint["transport"], "streamable-http");

        let sessions_json = crate::run(["mcp", "sessions", "--json"], &env, &supervisor).unwrap();
        let sessions: serde_json::Value = serde_json::from_str(&sessions_json).unwrap();
        assert_eq!(sessions["activeSessionCount"], 0);

        // stop
        let stop_res = crate::run(["mcp", "stop"], &env, &supervisor).unwrap();
        assert_eq!(stop_res, "mcp-endpoint stopped");

        let res = crate::run(["mcp", "status"], &env, &supervisor).unwrap();
        assert_eq!(res, "mcp-endpoint status: stopped");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn delegated_lifecycle_commands_use_expected_state_names() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_lifecycle_cmd_{}_{}",
            std::process::id(),
            rand_num
        ));
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_ADMIN_API_SKIP_READINESS", "1"),
        ]);
        let supervisor = MockSupervisor::new();

        assert_eq!(
            crate::run(["queue", "status"], &env, &supervisor).unwrap(),
            "queue-supervisor status: stopped"
        );
        assert!(crate::run(["queue", "start"], &env, &supervisor)
            .unwrap()
            .contains("queue-supervisor Rust maintenance"));
        assert_eq!(
            crate::run(["admin-api", "status"], &env, &supervisor).unwrap(),
            "admin-api status: stopped"
        );
        assert!(crate::run(["admin-api", "start"], &env, &supervisor)
            .unwrap()
            .contains("admin-api started"));
        assert_eq!(
            crate::run(["agent-log-sync", "status"], &env, &supervisor).unwrap(),
            "agent-log-sync status: stopped"
        );
        assert!(crate::run(["agent-log-sync", "run"], &env, &supervisor)
            .unwrap()
            .contains("agent-log-sync completed in Rust"));

        let status_json = crate::run(["status", "--json"], &env, &supervisor).unwrap();
        let status: serde_json::Value = serde_json::from_str(&status_json).unwrap();
        assert_eq!(status["queueSupervisor"], "stopped");
        assert_eq!(status["honoAdminApi"], "running");
        assert_eq!(status["agentLogSync"], "exited");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn delegated_lifecycle_commands_honor_json_flag() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_lifecycle_json_{}_{}",
            std::process::id(),
            rand_num
        ));
        std::fs::create_dir_all(&app_dir).unwrap();
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
        ]);
        let supervisor = MockSupervisor::new();

        let output = crate::run(["queue", "status", "--json"], &env, &supervisor).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(json["process"], "queue-supervisor");
        assert_eq!(json["action"], "status");
        assert_eq!(json["status"], "stopped");

        let output = crate::run(["mcp", "status", "--json"], &env, &supervisor).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(json["process"], "mcp-server");

        let output = crate::run(["mcp", "endpoint", "--json"], &env, &supervisor).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(json["server"], "context-still");
        assert_eq!(json["transport"], "streamable-http");

        let output = crate::run(["runtime", "sidecars", "--json"], &env, &supervisor).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(json["action"], "sidecars");
        assert_eq!(json["runtimeHost"], "rust-resident");
        assert!(!json["sidecars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["id"] == "mcp-endpoint-bun-http-server" }));
        assert!(!json["sidecars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["id"] == "mcp-tool-dispatch-typescript-one-shot" }));

        let output =
            crate::run(["runtime", "assert-rust-only", "--json"], &env, &supervisor).unwrap();
        let json: serde_json::Value = serde_json::from_str(&output).expect("valid JSON");
        assert_eq!(json["action"], "assertRustOnly");
        assert_eq!(json["ok"], true);
        assert_eq!(json["daemonDebtCount"], 0);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn bootstrap_doctor_and_backup_json_reports_are_stable() {
        use crate::shared::config::MapEnv;
        use crate::shared::process::MockSupervisor;
        use std::time::SystemTime;

        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let app_dir = std::env::temp_dir().join(format!(
            "context_still_preflight_cmd_{}_{}",
            std::process::id(),
            rand_num
        ));
        let sqlite_path = app_dir.join("context-still-core.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();

        let preflight_json =
            crate::run(["bootstrap", "preflight", "--json"], &env, &supervisor).expect("preflight");
        let preflight: serde_json::Value = serde_json::from_str(&preflight_json).unwrap();
        assert_eq!(preflight["overallStatus"], "needs_init");
        assert!(preflight["checks"].is_array());

        let init_json =
            crate::run(["bootstrap", "init", "--json"], &env, &supervisor).expect("init");
        let init: serde_json::Value = serde_json::from_str(&init_json).unwrap();
        assert!(init["createdPaths"].is_array());
        assert!(app_dir.join("logs").exists());
        assert!(app_dir.join("run").exists());
        assert!(app_dir.join("backup").exists());

        let doctor_json =
            crate::run(["doctor", "summary", "--json"], &env, &supervisor).expect("doctor");
        let doctor: serde_json::Value = serde_json::from_str(&doctor_json).unwrap();
        assert_eq!(
            doctor["readinessCheck"],
            "context-stilld doctor summary --json"
        );

        let backup_json =
            crate::run(["backup", "preflight", "--json"], &env, &supervisor).expect("backup");
        let backup: serde_json::Value = serde_json::from_str(&backup_json).unwrap();
        assert_eq!(backup["status"], "sqlite_missing");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn unknown_argument_fails_before_runtime_work() {
        let error = run_test_cmd(["paths", "--unexpected"], vec![]).expect_err("invalid args");

        assert!(error.to_string().contains("unknown argument"));
        assert_eq!(error.category_code(), "invalid_arguments");
        assert_eq!(error.exit_code(), 2);
    }

    #[test]
    fn json_command_with_invalid_arguments_returns_error_without_output() {
        let error = run_test_cmd(["status", "--json", "--unexpected"], vec![])
            .expect_err("invalid json args");

        assert!(error.to_string().contains("unknown argument"));
        assert_eq!(error.category_code(), "invalid_arguments");
        assert_eq!(error.exit_code(), 2);
    }
}
