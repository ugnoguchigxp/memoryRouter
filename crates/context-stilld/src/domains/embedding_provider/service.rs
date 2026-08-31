use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

use crate::{domains::bootstrap::service::resolve_paths, shared::config::EnvProvider};

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:44512";

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct EmbeddingProviderConfig {
    pub provider: String,
    pub daemon_url: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingDaemonHealth {
    pub url: String,
    pub reachable: bool,
    pub status: String,
    pub managed_by: String,
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
}

pub fn resolve_config<E: EnvProvider>(env: &E) -> EmbeddingProviderConfig {
    let paths = resolve_paths(env);
    let settings = read_runtime_settings(&paths.sqlite_core_path);
    let provider = settings
        .as_ref()
        .and_then(|value| value.pointer("/embedding/provider"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| project_env(env, "EMBEDDING_PROVIDER"))
        .unwrap_or_else(|| "auto".to_string())
        .trim()
        .to_ascii_lowercase();
    let provider = match provider.as_str() {
        "auto" | "daemon" | "openai" | "disabled" => provider,
        _ => "auto".to_string(),
    };
    let daemon_url = settings
        .as_ref()
        .and_then(|value| value.pointer("/embedding/daemonUrl"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| project_env(env, "EMBEDDING_DAEMON_URL"))
        .unwrap_or_else(|| DEFAULT_DAEMON_URL.to_string())
        .trim_end_matches('/')
        .to_string();

    EmbeddingProviderConfig {
        provider,
        daemon_url,
    }
}

pub fn health_report<E: EnvProvider>(env: &E) -> EmbeddingHealthReport {
    let config = resolve_config(env);
    let probe = probe_health(&config.daemon_url, Duration::from_millis(1_500));
    let reachable = probe.is_ok();
    let configured = config.provider != "disabled";
    let daemon_status = if !configured || config.provider == "openai" {
        "not_required"
    } else if reachable {
        "external_ready"
    } else {
        "offline"
    };
    let effective_mode = if !configured {
        "disabled"
    } else if config.provider == "openai" {
        "openai"
    } else if reachable {
        "daemon"
    } else {
        "unavailable"
    };

    EmbeddingHealthReport {
        configured,
        provider: config.provider,
        effective_mode: effective_mode.to_string(),
        daemon: EmbeddingDaemonHealth {
            url: config.daemon_url,
            reachable,
            status: daemon_status.to_string(),
            managed_by: if reachable { "external" } else { "none" }.to_string(),
            error: probe.err(),
        },
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::config::MapEnv;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "context-still-embedding-provider-{name}-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn disabled_provider_is_not_required() {
        let app_dir = temp_dir("disabled");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "disabled"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", "http://127.0.0.1:1"),
        ]);

        let report = health_report(&env);

        assert!(!report.configured);
        assert_eq!(report.effective_mode, "disabled");
        assert_eq!(report.daemon.status, "not_required");
        assert_eq!(report.daemon.managed_by, "none");
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn reachable_daemon_is_always_reported_as_external() {
        let app_dir = temp_dir("external");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .unwrap();
        });
        let daemon_url = format!("http://127.0.0.1:{port}");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_PROJECT_ROOT", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "daemon"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", &daemon_url),
        ]);

        let report = health_report(&env);

        assert_eq!(report.effective_mode, "daemon");
        assert_eq!(report.daemon.status, "external_ready");
        assert_eq!(report.daemon.managed_by, "external");
        server.join().unwrap();
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn auto_provider_is_unavailable_when_external_daemon_is_offline() {
        let app_dir = temp_dir("offline");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_EMBEDDING_PROVIDER", "auto"),
            ("CONTEXT_STILL_EMBEDDING_DAEMON_URL", "http://127.0.0.1:1"),
        ]);

        let report = health_report(&env);

        assert_eq!(report.effective_mode, "unavailable");
        assert_eq!(report.daemon.status, "offline");
        assert_eq!(report.daemon.managed_by, "none");
        fs::remove_dir_all(app_dir).unwrap();
    }
}
