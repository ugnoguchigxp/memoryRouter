use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    domains::{bootstrap::service::resolve_paths, daemon::repository},
    shared::{config::EnvProvider, process::ProcessSupervisor},
    VERSION,
};

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseIdentitySource {
    ExplicitEnvironment,
    LiveResidentState,
    AppDataDefault,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveDatabaseIdentity {
    pub configured_path: PathBuf,
    pub resident_path: Option<PathBuf>,
    pub effective_path: PathBuf,
    pub source: DatabaseIdentitySource,
    pub resident_pid: Option<u32>,
    pub resident_running: bool,
    pub mismatch: bool,
    pub fingerprint: String,
}

pub fn build_id() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-stilld-build-v1\n");
    hasher.update(VERSION.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn resolve<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> EffectiveDatabaseIdentity {
    let paths = resolve_paths(env);
    let configured_path = normalize_path(&paths.sqlite_core_path);
    let explicit = env
        .var("CONTEXT_STILL_SQLITE_CORE_PATH")
        .is_some_and(|value| !value.trim().is_empty());
    let resident = repository::read_state(&paths.run_dir, "context-stilld")
        .ok()
        .flatten()
        .and_then(|state| {
            let pid = state.pid?;
            if !supervisor.is_alive(pid) {
                return None;
            }
            let path = state.sqlite_core_path?;
            if path.trim().is_empty() {
                return None;
            }
            Some((pid, normalize_path(Path::new(&path))))
        });
    let resident_path = resident.as_ref().map(|(_, path)| path.clone());
    let resident_pid = resident.as_ref().map(|(pid, _)| *pid);
    let resident_running = resident.is_some();
    let mismatch = resident_path
        .as_ref()
        .is_some_and(|path| path != &configured_path);
    let (effective_path, source) = if explicit {
        (
            configured_path.clone(),
            DatabaseIdentitySource::ExplicitEnvironment,
        )
    } else if let Some(path) = resident_path.as_ref() {
        (path.clone(), DatabaseIdentitySource::LiveResidentState)
    } else {
        (
            configured_path.clone(),
            DatabaseIdentitySource::AppDataDefault,
        )
    };
    EffectiveDatabaseIdentity {
        fingerprint: fingerprint(&effective_path),
        configured_path,
        resident_path,
        effective_path,
        source,
        resident_pid,
        resident_running,
        mismatch,
    }
}

pub fn fingerprint(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"context-stilld-effective-db-v1\n");
    hasher.update(path.to_string_lossy().as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn normalize_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use crate::{
        domains::daemon::repository::{self, ProcessState},
        shared::{config::MapEnv, process::MockSupervisor},
    };

    use super::{resolve, DatabaseIdentitySource};

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "context_still_runtime_identity_{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn uses_live_resident_path_without_explicit_override() {
        let app_dir = temp_dir("resident");
        let live_path = app_dir.join("live.sqlite");
        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_dir.to_str().unwrap(),
        )]);
        let supervisor = MockSupervisor::new();
        supervisor.alive.lock().unwrap().insert(41, true);
        repository::write_state(
            &app_dir.join("run"),
            "context-stilld",
            &ProcessState {
                pid: Some(41),
                status: "running".to_string(),
                sqlite_core_path: Some(live_path.to_string_lossy().into_owned()),
                ..ProcessState::default()
            },
        )
        .unwrap();

        let identity = resolve(&env, &supervisor);
        assert_eq!(identity.source, DatabaseIdentitySource::LiveResidentState);
        assert_eq!(identity.effective_path, live_path);
        assert!(identity.resident_running);
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn explicit_path_wins_and_marks_live_mismatch() {
        let app_dir = temp_dir("explicit");
        let configured = app_dir.join("configured.sqlite");
        let resident = app_dir.join("resident.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                configured.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();
        supervisor.alive.lock().unwrap().insert(42, true);
        repository::write_state(
            &app_dir.join("run"),
            "context-stilld",
            &ProcessState {
                pid: Some(42),
                status: "running".to_string(),
                sqlite_core_path: Some(resident.to_string_lossy().into_owned()),
                ..ProcessState::default()
            },
        )
        .unwrap();

        let identity = resolve(&env, &supervisor);
        assert_eq!(identity.source, DatabaseIdentitySource::ExplicitEnvironment);
        assert_eq!(identity.effective_path, configured);
        assert!(identity.mismatch);
        fs::remove_dir_all(app_dir).unwrap();
    }

    #[test]
    fn blank_explicit_path_is_ignored_instead_of_resolving_to_the_working_directory() {
        let app_dir = temp_dir("blank-explicit");
        let live_path = app_dir.join("live.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            ("CONTEXT_STILL_SQLITE_CORE_PATH", "   "),
        ]);
        let supervisor = MockSupervisor::new();
        supervisor.alive.lock().unwrap().insert(43, true);
        repository::write_state(
            &app_dir.join("run"),
            "context-stilld",
            &ProcessState {
                pid: Some(43),
                status: "running".to_string(),
                sqlite_core_path: Some(live_path.to_string_lossy().into_owned()),
                ..ProcessState::default()
            },
        )
        .unwrap();

        let identity = resolve(&env, &supervisor);
        assert_eq!(identity.source, DatabaseIdentitySource::LiveResidentState);
        assert_eq!(identity.effective_path, live_path);
        fs::remove_dir_all(app_dir).unwrap();
    }
}
