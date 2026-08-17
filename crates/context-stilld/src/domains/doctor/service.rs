use serde::Serialize;

use crate::domains::{
    bootstrap::service::{preflight, BootstrapPreflightReport},
    daemon::service::{status_with_supervisor, RuntimeStatus},
    queue_lifecycle::service::inspect_report as inspect_queue,
    vector_index::service::{health as vector_health, VectorHealthReport},
};
use crate::shared::{config::EnvProvider, process::ProcessSupervisor};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorSummary {
    pub overall_status: &'static str,
    pub desktop_blockers: Vec<String>,
    pub server_warnings: Vec<String>,
    pub bootstrap: BootstrapPreflightReport,
    pub runtime: RuntimeStatus,
    pub vector: VectorHealthReport,
    pub readiness_check: &'static str,
}

pub fn summary<E: EnvProvider, S: ProcessSupervisor>(env: &E, supervisor: &S) -> DoctorSummary {
    let bootstrap = preflight(env);
    let runtime = status_with_supervisor(env, supervisor);
    let vector = vector_health(env, supervisor);
    let mut desktop_blockers = Vec::new();
    let mut server_warnings = Vec::new();

    for check in &bootstrap.checks {
        match (check.key, check.status) {
            ("app_data_dir", "missing") | ("sqlite_core_path", "missing") => {
                desktop_blockers.push(check.message.clone())
            }
            (_, "unknown") => server_warnings.push(check.message.clone()),
            _ => {}
        }
    }

    match inspect_queue(env, supervisor) {
        Ok(queue) if queue.unsupported_runnable_count > 0 => {
            server_warnings.push(format!(
                "QUEUE_EXECUTOR_UNSUPPORTED_BACKLOG: {}",
                queue
                    .unsupported_queues
                    .iter()
                    .map(|item| format!("{}={}", item.queue_name, item.runnable_pending))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        Err(error) => server_warnings.push(format!("queue inspection failed: {error}")),
        _ => {}
    }

    let overall_status = if desktop_blockers.is_empty() {
        "ok"
    } else {
        "needs_setup"
    };

    DoctorSummary {
        overall_status,
        desktop_blockers,
        server_warnings,
        bootstrap,
        runtime,
        vector,
        readiness_check: "context-stilld doctor summary --json",
    }
}

impl DoctorSummary {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("overallStatus={}", self.overall_status),
            format!("desktopBlockers={}", self.desktop_blockers.join(" | ")),
            format!("serverWarnings={}", self.server_warnings.join(" | ")),
            format!("readinessCheck={}", self.readiness_check),
            format!("vectorStatus={}", self.vector.status),
            format!("vectorEngine={}", self.vector.engine),
            format!("vectorUsable={}", self.vector.vec_usable),
            self.runtime.to_text(),
        ]
        .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{config::MapEnv, process::MockSupervisor};
    use rusqlite::Connection;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_app_dir(name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "context-still-doctor-{name}-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn doctor_warns_when_covering_backlog_has_no_rust_executor() {
        let app_dir = temp_app_dir("doctor_unsupported_covering");
        let sqlite_path = app_dir.join("context-still-core.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
                create table covering_evidence_queue (
                  id text primary key,
                  status text not null,
                  created_at text not null,
                  heartbeat_at text,
                  next_run_at text
                );
                insert into covering_evidence_queue (
                  id, status, created_at, heartbeat_at, next_run_at
                ) values ('cover-1', 'pending', '2026-08-17T01:00:00.000Z', null, null);
                "#,
            )
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let report = summary(&env, &MockSupervisor::new());

        assert!(report.server_warnings.iter().any(|warning| {
            warning == "QUEUE_EXECUTOR_UNSUPPORTED_BACKLOG: coveringEvidence=1"
        }));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
