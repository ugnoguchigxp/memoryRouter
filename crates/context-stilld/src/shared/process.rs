use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
#[cfg(test)]
use std::sync::Mutex;

pub fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub trait ProcessSupervisor {
    fn spawn(&self, command: &str, args: &[&str], log_path: &Path, cwd: &Path) -> io::Result<u32>;
    fn run_and_wait(
        &self,
        command: &str,
        args: &[&str],
        log_path: &Path,
        cwd: &Path,
        timeout: Duration,
    ) -> io::Result<WaitOutcome>;
    fn kill(&self, pid: u32, signal: &str) -> io::Result<()>;
    fn is_alive(&self, pid: u32) -> bool;
    fn command_line(&self, pid: u32) -> Option<String>;
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WaitOutcome {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub timed_out: bool,
}

pub struct OsSupervisor;

impl ProcessSupervisor for OsSupervisor {
    fn spawn(&self, command: &str, args: &[&str], log_path: &Path, cwd: &Path) -> io::Result<u32> {
        use std::fs::File;
        use std::process::Stdio;

        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let log_file = File::options().create(true).append(true).open(log_path)?;

        let mut child = std::process::Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file.try_clone()?))
            .stderr(Stdio::from(log_file))
            .with_detached_process_group()
            .spawn()?;
        let pid = child.id();
        std::thread::spawn(move || {
            let _ = child.wait();
        });

        Ok(pid)
    }

    fn run_and_wait(
        &self,
        command: &str,
        args: &[&str],
        log_path: &Path,
        cwd: &Path,
        timeout: Duration,
    ) -> io::Result<WaitOutcome> {
        use std::fs::File;
        use std::process::Stdio;

        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let log_file = File::options().create(true).append(true).open(log_path)?;
        let mut child = std::process::Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file.try_clone()?))
            .stderr(Stdio::from(log_file))
            .spawn()?;
        let pid = child.id();
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(WaitOutcome {
                    pid,
                    exit_code: status.code(),
                    exit_signal: exit_signal(&status),
                    timed_out: false,
                });
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let status = child.wait()?;
                return Ok(WaitOutcome {
                    pid,
                    exit_code: status.code(),
                    exit_signal: exit_signal(&status),
                    timed_out: true,
                });
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn kill(&self, pid: u32, signal: &str) -> io::Result<()> {
        if cfg!(target_os = "windows") {
            let status = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .status()?;
            if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("taskkill failed"))
            }
        } else {
            let sig = match signal {
                "SIGKILL" => "-9",
                "SIGTERM" => "-15",
                "SIGINT" => "-2",
                _ => "-15",
            };
            let status = std::process::Command::new("kill")
                .args([sig, &pid.to_string()])
                .status()?;
            if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("kill command failed"))
            }
        }
    }

    fn is_alive(&self, pid: u32) -> bool {
        if cfg!(target_os = "windows") {
            if let Ok(output) = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", pid)])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(&pid.to_string())
            } else {
                false
            }
        } else {
            if let Ok(output) = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
            {
                let process_state = String::from_utf8_lossy(&output.stdout);
                if process_state.trim_start().starts_with('Z') {
                    return false;
                }
            }
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        }
    }

    fn command_line(&self, pid: u32) -> Option<String> {
        let output = if cfg!(target_os = "windows") {
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\").CommandLine"
                    ),
                ])
                .output()
                .ok()?
        } else {
            std::process::Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .ok()?
        };
        if !output.status.success() {
            return None;
        }
        let command_line = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!command_line.is_empty()).then_some(command_line)
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| format!("SIG{signal}"))
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<String> {
    None
}

trait DetachedProcessGroup {
    fn with_detached_process_group(&mut self) -> &mut Self;
}

impl DetachedProcessGroup for std::process::Command {
    #[cfg(unix)]
    fn with_detached_process_group(&mut self) -> &mut Self {
        use std::os::unix::process::CommandExt;
        self.process_group(0)
    }

    #[cfg(not(unix))]
    fn with_detached_process_group(&mut self) -> &mut Self {
        self
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct MockSpawnCall {
    pub command: String,
    pub args: Vec<String>,
    pub log_path: PathBuf,
    pub cwd: PathBuf,
}

#[cfg(test)]
pub struct MockSupervisor {
    pub spawned: Mutex<HashMap<u32, MockSpawnCall>>,
    pub alive: Mutex<HashMap<u32, bool>>,
    pub next_pid: Mutex<u32>,
    pub wait_outcomes: Mutex<Vec<WaitOutcome>>,
}

#[cfg(test)]
impl MockSupervisor {
    pub fn new() -> Self {
        Self {
            spawned: Mutex::new(HashMap::new()),
            alive: Mutex::new(HashMap::new()),
            next_pid: Mutex::new(1000),
            wait_outcomes: Mutex::new(Vec::new()),
        }
    }

    pub fn push_wait_outcome(&self, outcome: WaitOutcome) {
        self.wait_outcomes.lock().unwrap().push(outcome);
    }
}

#[cfg(test)]
impl Default for MockSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl ProcessSupervisor for MockSupervisor {
    fn spawn(&self, command: &str, args: &[&str], log_path: &Path, cwd: &Path) -> io::Result<u32> {
        let mut next_pid = self.next_pid.lock().unwrap();
        let pid = *next_pid;
        *next_pid += 1;

        let call = MockSpawnCall {
            command: command.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            log_path: log_path.to_path_buf(),
            cwd: cwd.to_path_buf(),
        };

        self.spawned.lock().unwrap().insert(pid, call);
        self.alive.lock().unwrap().insert(pid, true);

        Ok(pid)
    }

    fn run_and_wait(
        &self,
        command: &str,
        args: &[&str],
        log_path: &Path,
        cwd: &Path,
        _timeout: Duration,
    ) -> io::Result<WaitOutcome> {
        let pid = self.spawn(command, args, log_path, cwd)?;
        self.alive.lock().unwrap().insert(pid, false);
        let mut outcomes = self.wait_outcomes.lock().unwrap();
        if outcomes.is_empty() {
            return Ok(WaitOutcome {
                pid,
                exit_code: Some(0),
                exit_signal: None,
                timed_out: false,
            });
        }
        let mut outcome = outcomes.remove(0);
        outcome.pid = pid;
        Ok(outcome)
    }

    fn kill(&self, pid: u32, _signal: &str) -> io::Result<()> {
        let mut alive = self.alive.lock().unwrap();
        if let std::collections::hash_map::Entry::Occupied(mut entry) = alive.entry(pid) {
            entry.insert(false);
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::NotFound, "Process not found"))
        }
    }

    fn is_alive(&self, pid: u32) -> bool {
        *self.alive.lock().unwrap().get(&pid).unwrap_or(&false)
    }

    fn command_line(&self, pid: u32) -> Option<String> {
        self.spawned.lock().unwrap().get(&pid).map(|call| {
            std::iter::once(call.command.as_str())
                .chain(call.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mock_supervisor_spawn_and_kill() {
        let supervisor = MockSupervisor::new();
        let log_path = Path::new("/tmp/test.log");
        let cwd = Path::new("/tmp");

        let pid = supervisor
            .spawn("bun", &["run", "index.ts"], log_path, cwd)
            .unwrap();
        assert_eq!(pid, 1000);
        assert!(supervisor.is_alive(pid));

        let spawned = supervisor.spawned.lock().unwrap();
        let call = spawned.get(&pid).unwrap();
        assert_eq!(call.command, "bun");
        assert_eq!(call.args, vec!["run".to_string(), "index.ts".to_string()]);
        assert_eq!(call.log_path, log_path.to_path_buf());
        assert_eq!(call.cwd, cwd.to_path_buf());

        drop(spawned);
        supervisor.kill(pid, "SIGTERM").unwrap();
        assert!(!supervisor.is_alive(pid));
    }

    #[test]
    fn test_mock_supervisor_run_and_wait() {
        let supervisor = MockSupervisor::new();
        supervisor.push_wait_outcome(WaitOutcome {
            pid: 0,
            exit_code: Some(2),
            exit_signal: None,
            timed_out: false,
        });

        let outcome = supervisor
            .run_and_wait(
                "bun",
                &["run", "one-shot.ts"],
                Path::new("/tmp/test.log"),
                Path::new("/tmp"),
                Duration::from_secs(1),
            )
            .unwrap();

        assert_eq!(outcome.pid, 1000);
        assert_eq!(outcome.exit_code, Some(2));
        assert!(!supervisor.is_alive(outcome.pid));
    }
}
