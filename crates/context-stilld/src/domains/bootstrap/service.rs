use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::shared::{config::EnvProvider, errors::CliError, process};

use super::repository;

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathReport {
    #[serde(serialize_with = "serialize_path")]
    pub app_data_dir: PathBuf,
    #[serde(serialize_with = "serialize_path")]
    pub logs_dir: PathBuf,
    #[serde(serialize_with = "serialize_path")]
    pub run_dir: PathBuf,
    #[serde(serialize_with = "serialize_path")]
    pub backup_dir: PathBuf,
    #[serde(serialize_with = "serialize_path")]
    pub sqlite_core_path: PathBuf,
}

fn serialize_path<S>(path: &Path, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&process::path_to_string(path))
}

pub fn resolve_paths<E: EnvProvider>(env: &E) -> PathReport {
    let app_data_dir = repository::read_app_data_dir(env);
    PathReport {
        logs_dir: app_data_dir.join("logs"),
        run_dir: app_data_dir.join("run"),
        backup_dir: app_data_dir.join("backup"),
        sqlite_core_path: repository::read_sqlite_core_path(env, &app_data_dir),
        app_data_dir,
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapCheck {
    pub key: &'static str,
    pub status: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPreflightReport {
    pub overall_status: &'static str,
    pub checks: Vec<BootstrapCheck>,
    pub paths: PathReport,
    pub readiness_check: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInitReport {
    pub created_paths: Vec<String>,
    pub existing_paths: Vec<String>,
    pub paths: PathReport,
}

pub fn preflight<E: EnvProvider>(env: &E) -> BootstrapPreflightReport {
    preflight_with_paths(resolve_paths(env))
}

pub fn preflight_with_supervisor<E: EnvProvider, S: crate::shared::process::ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> BootstrapPreflightReport {
    let mut paths = resolve_paths(env);
    paths.sqlite_core_path =
        crate::domains::runtime_identity::resolve(env, supervisor).effective_path;
    preflight_with_paths(paths)
}

fn preflight_with_paths(paths: PathReport) -> BootstrapPreflightReport {
    let mut checks = Vec::new();

    push_path_check(
        &mut checks,
        "app_data_dir",
        paths.app_data_dir.exists(),
        format!(
            "appDataDir exists at {}",
            process::path_to_string(&paths.app_data_dir)
        ),
        format!(
            "appDataDir is missing at {}",
            process::path_to_string(&paths.app_data_dir)
        ),
    );
    push_path_check(
        &mut checks,
        "sqlite_core_path",
        paths.sqlite_core_path.exists(),
        format!(
            "SQLite DB exists at {}",
            process::path_to_string(&paths.sqlite_core_path)
        ),
        format!(
            "SQLite DB is missing at {}",
            process::path_to_string(&paths.sqlite_core_path)
        ),
    );

    checks.push(migration_check(&paths.sqlite_core_path));
    checks.push(BootstrapCheck {
        key: "settings_document",
        status: "ok",
        message: "Runtime settings are read from the configured SQLite path.".to_string(),
    });
    checks.push(BootstrapCheck {
        key: "mcp_registration",
        status: "ok",
        message: "MCP clients should register the daemon-owned streamable HTTP endpoint."
            .to_string(),
    });
    checks.push(BootstrapCheck {
        key: "optional_embedding",
        status: "info",
        message: "Embedding is optional; the resident runtime manages an available local provider and preserves CLI fallback."
            .to_string(),
    });

    let overall_status = if checks
        .iter()
        .any(|check| matches!(check.status, "missing" | "outdated" | "incompatible"))
    {
        "needs_init"
    } else {
        "ready"
    };

    BootstrapPreflightReport {
        overall_status,
        checks,
        paths,
        readiness_check: "context-stilld doctor summary --json",
    }
}

fn migration_check(sqlite_path: &Path) -> BootstrapCheck {
    use crate::domains::sqlite_writer::schema::{
        read_schema_revision, read_schema_version, CURRENT_SCHEMA_REVISION, CURRENT_SCHEMA_VERSION,
    };

    if !sqlite_path.exists() {
        return BootstrapCheck {
            key: "migration_state",
            status: "missing",
            message: format!(
                "SQLite schema is missing; resident Writer will create compatibility version {CURRENT_SCHEMA_VERSION}, revision {CURRENT_SCHEMA_REVISION}"
            ),
        };
    }
    match (
        read_schema_version(sqlite_path),
        read_schema_revision(sqlite_path),
    ) {
        (Ok(version), Ok(revision))
            if version > CURRENT_SCHEMA_REVISION || revision > CURRENT_SCHEMA_REVISION =>
        {
            BootstrapCheck {
                key: "migration_state",
                status: "incompatible",
                message: format!(
                    "SQLite compatibility version {version}, revision {revision} is newer than supported revision {CURRENT_SCHEMA_REVISION}"
                ),
            }
        }
        (Ok(version), Ok(revision))
            if version == CURRENT_SCHEMA_VERSION && revision == CURRENT_SCHEMA_REVISION =>
        {
            BootstrapCheck {
                key: "migration_state",
                status: "ok",
                message: format!(
                    "Rust-owned SQLite compatibility version {version}, revision {revision} is current"
                ),
            }
        }
        (Ok(version), Ok(revision))
            if version <= CURRENT_SCHEMA_REVISION && revision < CURRENT_SCHEMA_REVISION =>
        {
            BootstrapCheck {
                key: "migration_state",
                status: "outdated",
                message: format!(
                    "SQLite compatibility version {version}, revision {revision} requires Rust Writer migration to revision {CURRENT_SCHEMA_REVISION}"
                ),
            }
        }
        (Ok(version), Ok(revision)) => BootstrapCheck {
            key: "migration_state",
            status: "outdated",
            message: format!(
                "SQLite compatibility version {version}, revision {revision} requires normalization to compatibility version {CURRENT_SCHEMA_VERSION}"
            ),
        },
        (Err(error), _) | (_, Err(error)) => BootstrapCheck {
            key: "migration_state",
            status: "unknown",
            message: error,
        },
    }
}

pub fn init<E: EnvProvider>(env: &E) -> Result<BootstrapInitReport, CliError> {
    let paths = resolve_paths(env);
    let dirs = [
        &paths.app_data_dir,
        &paths.logs_dir,
        &paths.run_dir,
        &paths.backup_dir,
    ];
    let mut created_paths = Vec::new();
    let mut existing_paths = Vec::new();

    for dir in dirs {
        let path_text = process::path_to_string(dir);
        if dir.exists() {
            existing_paths.push(path_text);
            continue;
        }
        std::fs::create_dir_all(dir)
            .map_err(|e| CliError::io(format!("failed to create {path_text}: {e}")))?;
        created_paths.push(path_text);
    }

    Ok(BootstrapInitReport {
        created_paths,
        existing_paths,
        paths,
    })
}

fn push_path_check(
    checks: &mut Vec<BootstrapCheck>,
    key: &'static str,
    exists: bool,
    ok_message: String,
    missing_message: String,
) {
    checks.push(BootstrapCheck {
        key,
        status: if exists { "ok" } else { "missing" },
        message: if exists { ok_message } else { missing_message },
    });
}

impl PathReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("appDataDir={}", process::path_to_string(&self.app_data_dir)),
            format!("logsDir={}", process::path_to_string(&self.logs_dir)),
            format!("runDir={}", process::path_to_string(&self.run_dir)),
            format!("backupDir={}", process::path_to_string(&self.backup_dir)),
            format!(
                "sqliteCorePath={}",
                process::path_to_string(&self.sqlite_core_path)
            ),
        ]
        .join("\n")
    }
}

impl BootstrapPreflightReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        let mut lines = vec![
            format!("overallStatus={}", self.overall_status),
            format!("readinessCheck={}", self.readiness_check),
        ];
        lines.extend(
            self.checks
                .iter()
                .map(|check| format!("{}={}: {}", check.key, check.status, check.message)),
        );
        lines.push(self.paths.to_text());
        lines.join("\n")
    }
}

impl BootstrapInitReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("createdPaths={}", self.created_paths.join(",")),
            format!("existingPaths={}", self.existing_paths.join(",")),
            self.paths.to_text(),
        ]
        .join("\n")
    }
}
