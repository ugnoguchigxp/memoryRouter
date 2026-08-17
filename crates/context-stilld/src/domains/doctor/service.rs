use serde::Serialize;

use crate::domains::{
    bootstrap::service::{preflight, BootstrapPreflightReport},
    daemon::service::{status_with_supervisor, RuntimeStatus},
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
