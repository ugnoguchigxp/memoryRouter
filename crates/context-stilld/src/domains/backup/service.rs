use serde::Serialize;

use crate::domains::{bootstrap::service::resolve_paths, runtime_identity, sqlite_writer};
use crate::shared::{config::EnvProvider, errors::CliError, process, process::ProcessSupervisor};

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreflight {
    pub status: &'static str,
    pub sqlite_core_path: String,
    pub backup_dir: String,
    pub active_managed_writers: Vec<&'static str>,
    pub active_managed_writer_details: Vec<ActiveManagedWriter>,
    pub writer_lock_held: bool,
    pub delegated_backup_command: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCreateReport {
    pub status: &'static str,
    pub source: String,
    pub output: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveManagedWriter {
    pub name: &'static str,
    pub status: String,
    pub pid: Option<u32>,
    pub log_path: Option<String>,
}

pub fn preflight<E: EnvProvider, S: ProcessSupervisor>(env: &E, supervisor: &S) -> BackupPreflight {
    let mut paths = resolve_paths(env);
    paths.sqlite_core_path = runtime_identity::resolve(env, supervisor).effective_path;
    let _ = supervisor;
    let mut active_managed_writers = Vec::new();
    let mut active_managed_writer_details = Vec::new();
    let writer_lock_held = sqlite_writer::is_writer_lock_held(&paths.sqlite_core_path)
        .unwrap_or(paths.sqlite_core_path.exists());

    if writer_lock_held {
        active_managed_writers.push("sqlite-writer");
        active_managed_writer_details.push(ActiveManagedWriter {
            name: "sqlite-writer",
            status: "locked".to_string(),
            pid: None,
            log_path: None,
        });
    }

    let status = if !paths.sqlite_core_path.exists() {
        "sqlite_missing"
    } else if active_managed_writers.is_empty() {
        "ready"
    } else {
        "managed_writers_active"
    };

    BackupPreflight {
        status,
        sqlite_core_path: process::path_to_string(&paths.sqlite_core_path),
        backup_dir: process::path_to_string(&paths.backup_dir),
        active_managed_writers,
        active_managed_writer_details,
        writer_lock_held,
        delegated_backup_command: "cargo run -q -p context-stilld -- backup create",
    }
}

pub fn create<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<BackupCreateReport, CliError> {
    let mut paths = resolve_paths(env);
    paths.sqlite_core_path = runtime_identity::resolve(env, supervisor).effective_path;
    let filename = format!(
        "core-{}.sqlite",
        crate::domains::process_lifecycle::service::now_timestamp().replace([':', '.'], "-")
    );
    let output = paths.backup_dir.join(filename);
    let bytes = sqlite_writer::create_offline_backup(&paths.sqlite_core_path, &output)
        .map_err(CliError::runtime)?;
    Ok(BackupCreateReport {
        status: "created",
        source: process::path_to_string(&paths.sqlite_core_path),
        output: process::path_to_string(&output),
        bytes,
    })
}

impl BackupPreflight {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("status={}", self.status),
            format!("sqliteCorePath={}", self.sqlite_core_path),
            format!("backupDir={}", self.backup_dir),
            format!(
                "activeManagedWriters={}",
                self.active_managed_writers.join(",")
            ),
            format!("writerLockHeld={}", self.writer_lock_held),
            format!("delegatedBackupCommand={}", self.delegated_backup_command),
        ]
        .join("\n")
    }
}

impl BackupCreateReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        format!(
            "SQLite backup written: {} ({} bytes)",
            self.output, self.bytes
        )
    }
}
