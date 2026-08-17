use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::VERSION;

pub fn runtime_version() -> &'static str {
    VERSION
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessState {
    pub pid: Option<u32>,
    pub status: String,
    pub log_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sqlite_core_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

pub fn write_state(run_dir: &Path, name: &str, state: &ProcessState) -> io::Result<()> {
    fs::create_dir_all(run_dir)?;
    let state_file = run_dir.join(format!("{}-state.json", name));
    let content =
        serde_json::to_string(state).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(state_file, content)
}

pub fn read_state(run_dir: &Path, name: &str) -> io::Result<Option<ProcessState>> {
    let state_file = run_dir.join(format!("{}-state.json", name));
    if !state_file.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(state_file)?;
    let state = serde_json::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(state))
}

pub fn write_pid(run_dir: &Path, name: &str, pid: u32) -> io::Result<()> {
    fs::create_dir_all(run_dir)?;
    let pid_file = run_dir.join(format!("{}.pid", name));
    fs::write(pid_file, pid.to_string())
}

pub fn read_pid(run_dir: &Path, name: &str) -> io::Result<Option<u32>> {
    let pid_file = run_dir.join(format!("{}.pid", name));
    if !pid_file.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(pid_file)?;
    let pid = content
        .trim()
        .parse::<u32>()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(pid))
}

pub fn clear_pid(run_dir: &Path, name: &str) -> io::Result<()> {
    let pid_file = run_dir.join(format!("{}.pid", name));
    if pid_file.exists() {
        fs::remove_file(pid_file)?;
    }
    Ok(())
}

pub fn clear_state(run_dir: &Path, name: &str) -> io::Result<()> {
    let state_file = run_dir.join(format!("{}-state.json", name));
    if state_file.exists() {
        fs::remove_file(state_file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_run_dir() -> PathBuf {
        let rand_num = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "context_still_test_{}_{}_{}",
            std::process::id(),
            rand_num,
            temp_id
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_pid_file_lifecycle() {
        let run_dir = temp_run_dir();
        let name = "test_mcp";

        // Originally not present
        assert_eq!(read_pid(&run_dir, name).unwrap(), None);

        // Write PID
        write_pid(&run_dir, name, 1234).unwrap();
        assert_eq!(read_pid(&run_dir, name).unwrap(), Some(1234));

        // Clear PID
        clear_pid(&run_dir, name).unwrap();
        assert_eq!(read_pid(&run_dir, name).unwrap(), None);

        // Clean up
        fs::remove_dir_all(&run_dir).unwrap();
    }

    #[test]
    fn test_process_state_file_lifecycle() {
        let run_dir = temp_run_dir();
        let name = "test_queue";

        // Originally not present
        assert_eq!(read_state(&run_dir, name).unwrap(), None);

        // Write state
        let state = ProcessState {
            pid: Some(5678),
            status: "running".to_string(),
            log_path: "/var/log/queue.log".to_string(),
            ..ProcessState::default()
        };
        write_state(&run_dir, name, &state).unwrap();

        let loaded = read_state(&run_dir, name).unwrap().unwrap();
        assert_eq!(loaded, state);

        // Clean up
        fs::remove_dir_all(&run_dir).unwrap();
    }
}
