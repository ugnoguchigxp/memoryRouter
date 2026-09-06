use std::path::PathBuf;

use crate::shared::errors::CliError;

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum McpAction {
    Start,
    Stop,
    Status,
    Endpoint,
    Sessions,
    Smoke,
    Serve,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum QueueAction {
    Start,
    Stop,
    Status,
    Inspect,
    ExecutorTick,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum AgentLogSyncAction {
    Run {
        wait: bool,
        timeout_ms: u64,
    },
    BackfillCodex {
        dry_run: bool,
        limit: usize,
        max_bytes: u64,
    },
    Stop,
    Status,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum AdminApiAction {
    Start,
    Stop,
    Status,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum RuntimeAction {
    Sidecars,
    AssertRustOnly,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum VectorAction {
    Health,
    Smoke,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum BootstrapAction {
    Preflight,
    Init,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum DoctorAction {
    Summary,
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum BackupAction {
    Preflight { require_idle: bool },
    Create,
    Verify { path: PathBuf },
}

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum ContextCompileAction {
    Capabilities {
        out: Option<PathBuf>,
    },
    Baseline {
        manifest: PathBuf,
        out: PathBuf,
        probe: Option<PathBuf>,
    },
    Compare {
        manifest: PathBuf,
        baseline: PathBuf,
        candidate: PathBuf,
        out: PathBuf,
    },
    Experiment {
        manifest: PathBuf,
        out: PathBuf,
        allow_provider_calls: bool,
    },
    Probe {
        manifest: PathBuf,
        entry_report: PathBuf,
        out: PathBuf,
        calls: usize,
        allow_live_writes: bool,
    },
}

#[derive(Debug, Eq, PartialEq)]
pub enum CliCommand {
    Help,
    Version,
    Run {
        json: bool,
        once: bool,
    },
    Paths {
        json: bool,
    },
    Status {
        json: bool,
    },
    Mcp {
        action: McpAction,
        json: bool,
    },
    Queue {
        action: QueueAction,
        json: bool,
    },
    AgentLogSync {
        action: AgentLogSyncAction,
        json: bool,
    },
    AdminApi {
        action: AdminApiAction,
        json: bool,
    },
    Runtime {
        action: RuntimeAction,
        json: bool,
    },
    Vector {
        action: VectorAction,
        json: bool,
    },
    Bootstrap {
        action: BootstrapAction,
        json: bool,
    },
    Doctor {
        action: DoctorAction,
        json: bool,
    },
    Backup {
        action: BackupAction,
        json: bool,
    },
    ContextCompile {
        action: ContextCompileAction,
        json: bool,
    },
}

pub fn parse_args<I, S>(args: I) -> Result<CliCommand, CliError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    let Some(command) = args.next() else {
        return Ok(CliCommand::Help);
    };

    match command.as_str() {
        "-h" | "--help" | "help" => Ok(CliCommand::Help),
        "-V" | "--version" | "version" => Ok(CliCommand::Version),
        "run" => {
            let options = parse_run_options(args)?;
            Ok(CliCommand::Run {
                json: options.json,
                once: options.once,
            })
        }
        "paths" => Ok(CliCommand::Paths {
            json: parse_json_flag(args)?,
        }),
        "status" => Ok(CliCommand::Status {
            json: parse_json_flag(args)?,
        }),
        "mcp" => {
            let action_str = args.next().ok_or_else(|| {
                CliError::invalid_arguments(
                    "mcp requires an action: start, stop, status, endpoint, sessions, smoke, or serve",
                )
            })?;
            let action = match action_str.as_str() {
                "start" => McpAction::Start,
                "stop" => McpAction::Stop,
                "status" => McpAction::Status,
                "endpoint" => McpAction::Endpoint,
                "sessions" => McpAction::Sessions,
                "smoke" => McpAction::Smoke,
                "serve" => McpAction::Serve,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown mcp action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Mcp {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "queue" => {
            let action_str = required_action(
                &mut args,
                "queue",
                "start, stop, status, inspect, or executor-tick",
            )?;
            let action = match action_str.as_str() {
                "start" => QueueAction::Start,
                "stop" => QueueAction::Stop,
                "status" => QueueAction::Status,
                "inspect" => QueueAction::Inspect,
                "executor-tick" => QueueAction::ExecutorTick,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown queue action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Queue {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "agent-log-sync" => {
            let action_str = required_action(
                &mut args,
                "agent-log-sync",
                "run, backfill-codex, stop, or status",
            )?;
            let action = match action_str.as_str() {
                "run" => {
                    let options = parse_wait_options(args)?;
                    return Ok(CliCommand::AgentLogSync {
                        action: AgentLogSyncAction::Run {
                            wait: options.wait,
                            timeout_ms: options.timeout_ms,
                        },
                        json: options.json,
                    });
                }
                "backfill-codex" => {
                    let options = parse_codex_backfill_options(args)?;
                    return Ok(CliCommand::AgentLogSync {
                        action: AgentLogSyncAction::BackfillCodex {
                            dry_run: options.dry_run,
                            limit: options.limit,
                            max_bytes: options.max_bytes,
                        },
                        json: options.json,
                    });
                }
                "stop" => AgentLogSyncAction::Stop,
                "status" => AgentLogSyncAction::Status,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown agent-log-sync action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::AgentLogSync {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "admin-api" => {
            let action_str = required_action(&mut args, "admin-api", "start, stop, or status")?;
            let action = match action_str.as_str() {
                "start" => AdminApiAction::Start,
                "stop" => AdminApiAction::Stop,
                "status" => AdminApiAction::Status,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown admin-api action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::AdminApi {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "runtime" => {
            let action_str = required_action(&mut args, "runtime", "sidecars or assert-rust-only")?;
            let action = match action_str.as_str() {
                "sidecars" => RuntimeAction::Sidecars,
                "assert-rust-only" => RuntimeAction::AssertRustOnly,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown runtime action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Runtime {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "vector" => {
            let action_str = required_action(&mut args, "vector", "health or smoke")?;
            let action = match action_str.as_str() {
                "health" => VectorAction::Health,
                "smoke" => VectorAction::Smoke,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown vector action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Vector {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "bootstrap" => {
            let action_str = required_action(&mut args, "bootstrap", "preflight or init")?;
            let action = match action_str.as_str() {
                "preflight" => BootstrapAction::Preflight,
                "init" => BootstrapAction::Init,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown bootstrap action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Bootstrap {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "doctor" => {
            let Some(action_str) = args.next() else {
                return Ok(CliCommand::Doctor {
                    action: DoctorAction::Summary,
                    json: false,
                });
            };
            if action_str == "--json" {
                let json = parse_json_flag(std::iter::once(action_str).chain(args))?;
                return Ok(CliCommand::Doctor {
                    action: DoctorAction::Summary,
                    json,
                });
            }
            let action = match action_str.as_str() {
                "summary" => DoctorAction::Summary,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown doctor action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Doctor {
                action,
                json: parse_json_flag(args)?,
            })
        }
        "backup" => {
            let action_str = required_action(&mut args, "backup", "preflight, create or verify")?;
            let options = parse_backup_options(args)?;
            if options.require_idle && action_str != "preflight" {
                return Err(CliError::invalid_arguments(
                    "--require-idle is only valid for backup preflight",
                ));
            }
            if options.path.is_some() && action_str != "verify" {
                return Err(CliError::invalid_arguments(
                    "--path is only valid for backup verify",
                ));
            }
            let action = match action_str.as_str() {
                "verify" => BackupAction::Verify {
                    path: options.path.ok_or_else(|| {
                        CliError::invalid_arguments("backup verify requires --path <backup.sqlite>")
                    })?,
                },
                "preflight" => BackupAction::Preflight {
                    require_idle: options.require_idle,
                },
                "create" => BackupAction::Create,
                _ => {
                    return Err(CliError::invalid_arguments(format!(
                        "unknown backup action: {action_str}"
                    )))
                }
            };
            Ok(CliCommand::Backup {
                action,
                json: options.json,
            })
        }
        "context-compile" => parse_context_compile_command(args),
        _ => Err(CliError::invalid_arguments(format!(
            "unknown command: {command}"
        ))),
    }
}

fn parse_context_compile_command<I>(mut args: I) -> Result<CliCommand, CliError>
where
    I: Iterator<Item = String>,
{
    let action_name = required_action(
        &mut args,
        "context-compile",
        "capabilities, baseline, compare, experiment, or probe",
    )?;
    let options = parse_context_compile_options(args)?;
    let action = match action_name.as_str() {
        "capabilities" => {
            reject_context_compile_options(&options, &["out"])?;
            ContextCompileAction::Capabilities { out: options.out }
        }
        "baseline" => {
            reject_context_compile_options(&options, &["manifest", "out", "probe"])?;
            ContextCompileAction::Baseline {
                manifest: required_path(&options.manifest, "--manifest")?,
                out: required_path(&options.out, "--out")?,
                probe: options.probe,
            }
        }
        "compare" => {
            reject_context_compile_options(
                &options,
                &["manifest", "baseline", "candidate", "out"],
            )?;
            ContextCompileAction::Compare {
                manifest: required_path(&options.manifest, "--manifest")?,
                baseline: required_path(&options.baseline, "--baseline")?,
                candidate: required_path(&options.candidate, "--candidate")?,
                out: required_path(&options.out, "--out")?,
            }
        }
        "experiment" => {
            reject_context_compile_options(&options, &["manifest", "out", "allow-provider-calls"])?;
            ContextCompileAction::Experiment {
                manifest: required_path(&options.manifest, "--manifest")?,
                out: required_path(&options.out, "--out")?,
                allow_provider_calls: options.allow_provider_calls,
            }
        }
        "probe" => {
            reject_context_compile_options(
                &options,
                &[
                    "manifest",
                    "entry-report",
                    "out",
                    "calls",
                    "allow-live-writes",
                ],
            )?;
            ContextCompileAction::Probe {
                manifest: required_path(&options.manifest, "--manifest")?,
                entry_report: required_path(&options.entry_report, "--entry-report")?,
                out: required_path(&options.out, "--out")?,
                calls: options.calls.ok_or_else(|| {
                    CliError::invalid_arguments("probe requires --calls <positive-integer>")
                })?,
                allow_live_writes: options.allow_live_writes,
            }
        }
        _ => {
            return Err(CliError::invalid_arguments(format!(
                "unknown context-compile action: {action_name}"
            )))
        }
    };
    Ok(CliCommand::ContextCompile {
        action,
        json: options.json,
    })
}

#[derive(Debug, Default)]
struct ContextCompileOptions {
    json: bool,
    out: Option<PathBuf>,
    manifest: Option<PathBuf>,
    probe: Option<PathBuf>,
    baseline: Option<PathBuf>,
    candidate: Option<PathBuf>,
    entry_report: Option<PathBuf>,
    calls: Option<usize>,
    allow_provider_calls: bool,
    allow_live_writes: bool,
    supplied: Vec<&'static str>,
}

fn parse_context_compile_options<I>(args: I) -> Result<ContextCompileOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = ContextCompileOptions::default();
    let mut args = args.into_iter();
    while let Some(option) = args.next() {
        match option.as_str() {
            "--json" => {
                set_context_compile_flag(&mut options, "json", |options| options.json = true)?
            }
            "--allow-provider-calls" => {
                set_context_compile_flag(&mut options, "allow-provider-calls", |options| {
                    options.allow_provider_calls = true
                })?
            }
            "--allow-live-writes" => {
                set_context_compile_flag(&mut options, "allow-live-writes", |options| {
                    options.allow_live_writes = true
                })?
            }
            "--out" => {
                set_context_compile_path(&mut options, "out", args.next(), |options, value| {
                    options.out = Some(value)
                })?
            }
            "--manifest" => set_context_compile_path(
                &mut options,
                "manifest",
                args.next(),
                |options, value| options.manifest = Some(value),
            )?,
            "--probe" => {
                set_context_compile_path(&mut options, "probe", args.next(), |options, value| {
                    options.probe = Some(value)
                })?
            }
            "--baseline" => set_context_compile_path(
                &mut options,
                "baseline",
                args.next(),
                |options, value| options.baseline = Some(value),
            )?,
            "--candidate" => set_context_compile_path(
                &mut options,
                "candidate",
                args.next(),
                |options, value| options.candidate = Some(value),
            )?,
            "--entry-report" => set_context_compile_path(
                &mut options,
                "entry-report",
                args.next(),
                |options, value| options.entry_report = Some(value),
            )?,
            "--calls" => {
                if !options.supplied.iter().all(|name| *name != "calls") {
                    return Err(CliError::invalid_arguments("repeated option: --calls"));
                }
                let value = args.next().ok_or_else(|| {
                    CliError::invalid_arguments("--calls requires a positive integer")
                })?;
                options.calls = Some(parse_positive_usize("--calls", &value)?);
                options.supplied.push("calls");
            }
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {option}"
                )))
            }
        }
    }
    Ok(options)
}

fn set_context_compile_flag(
    options: &mut ContextCompileOptions,
    name: &'static str,
    set: impl FnOnce(&mut ContextCompileOptions),
) -> Result<(), CliError> {
    if options.supplied.contains(&name) {
        return Err(CliError::invalid_arguments(format!(
            "repeated option: --{name}"
        )));
    }
    set(options);
    options.supplied.push(name);
    Ok(())
}

fn set_context_compile_path(
    options: &mut ContextCompileOptions,
    name: &'static str,
    value: Option<String>,
    set: impl FnOnce(&mut ContextCompileOptions, PathBuf),
) -> Result<(), CliError> {
    if options.supplied.contains(&name) {
        return Err(CliError::invalid_arguments(format!(
            "repeated option: --{name}"
        )));
    }
    let value =
        value.ok_or_else(|| CliError::invalid_arguments(format!("--{name} requires a path")))?;
    if value.is_empty() {
        return Err(CliError::invalid_arguments(format!(
            "--{name} requires a non-empty path"
        )));
    }
    set(options, PathBuf::from(value));
    options.supplied.push(name);
    Ok(())
}

fn reject_context_compile_options(
    options: &ContextCompileOptions,
    allowed: &[&str],
) -> Result<(), CliError> {
    if let Some(name) = options
        .supplied
        .iter()
        .find(|name| name != &&"json" && !allowed.contains(name))
    {
        return Err(CliError::invalid_arguments(format!(
            "--{name} is not valid for this context-compile action"
        )));
    }
    Ok(())
}

fn required_path(value: &Option<PathBuf>, option: &str) -> Result<PathBuf, CliError> {
    value
        .clone()
        .ok_or_else(|| CliError::invalid_arguments(format!("context-compile requires {option}")))
}

#[derive(Debug, Eq, PartialEq)]
struct RunOptions {
    json: bool,
    once: bool,
}

fn parse_run_options<I>(args: I) -> Result<RunOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = RunOptions {
        json: false,
        once: false,
    };
    for arg in args {
        match arg.as_str() {
            "--json" => options.json = true,
            "--once" => options.once = true,
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(options)
}

fn required_action<I>(args: &mut I, command: &str, expected: &str) -> Result<String, CliError>
where
    I: Iterator<Item = String>,
{
    args.next().ok_or_else(|| {
        CliError::invalid_arguments(format!("{command} requires an action: {expected}"))
    })
}

fn parse_json_flag<I>(args: I) -> Result<bool, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            "-h" | "--help" => {
                return Err(CliError::invalid_arguments(
                    "help is only available at top level",
                ))
            }
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(json)
}

#[derive(Debug, Eq, PartialEq)]
struct WaitOptions {
    json: bool,
    wait: bool,
    timeout_ms: u64,
}

fn parse_wait_options<I>(args: I) -> Result<WaitOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = WaitOptions {
        json: false,
        wait: false,
        timeout_ms: 60_000,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => options.json = true,
            "--wait" => options.wait = true,
            "--timeout-ms" => {
                let value = args.next().ok_or_else(|| {
                    CliError::invalid_arguments("--timeout-ms requires a numeric value")
                })?;
                options.timeout_ms = value.parse::<u64>().map_err(|error| {
                    CliError::invalid_arguments(format!("invalid --timeout-ms value: {error}"))
                })?;
            }
            _ if arg.starts_with("--timeout-ms=") => {
                let value = arg.trim_start_matches("--timeout-ms=");
                options.timeout_ms = value.parse::<u64>().map_err(|error| {
                    CliError::invalid_arguments(format!("invalid --timeout-ms value: {error}"))
                })?;
            }
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(options)
}

#[derive(Debug, Eq, PartialEq)]
struct CodexBackfillOptions {
    json: bool,
    dry_run: bool,
    limit: usize,
    max_bytes: u64,
}

fn parse_codex_backfill_options<I>(args: I) -> Result<CodexBackfillOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = CodexBackfillOptions {
        json: false,
        dry_run: true,
        limit: 10,
        max_bytes: 128 * 1024 * 1024,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => options.json = true,
            "--dry-run" => options.dry_run = true,
            "--write" => options.dry_run = false,
            "--limit" => {
                let value = args.next().ok_or_else(|| {
                    CliError::invalid_arguments("--limit requires a numeric value")
                })?;
                options.limit = parse_positive_usize("--limit", &value)?;
            }
            "--max-bytes" => {
                let value = args.next().ok_or_else(|| {
                    CliError::invalid_arguments("--max-bytes requires a numeric value")
                })?;
                options.max_bytes = parse_positive_u64("--max-bytes", &value)?;
            }
            _ if arg.starts_with("--limit=") => {
                options.limit = parse_positive_usize("--limit", arg.trim_start_matches("--limit="))?
            }
            _ if arg.starts_with("--max-bytes=") => {
                options.max_bytes =
                    parse_positive_u64("--max-bytes", arg.trim_start_matches("--max-bytes="))?
            }
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(options)
}

fn parse_positive_usize(name: &str, value: &str) -> Result<usize, CliError> {
    let parsed = value
        .parse::<usize>()
        .map_err(|error| CliError::invalid_arguments(format!("invalid {name} value: {error}")))?;
    if parsed == 0 {
        return Err(CliError::invalid_arguments(format!("{name} must be >= 1")));
    }
    Ok(parsed)
}

fn parse_positive_u64(name: &str, value: &str) -> Result<u64, CliError> {
    let parsed = value
        .parse::<u64>()
        .map_err(|error| CliError::invalid_arguments(format!("invalid {name} value: {error}")))?;
    if parsed == 0 {
        return Err(CliError::invalid_arguments(format!("{name} must be >= 1")));
    }
    Ok(parsed)
}

#[derive(Debug, Eq, PartialEq)]
struct BackupOptions {
    json: bool,
    require_idle: bool,
    path: Option<PathBuf>,
}

fn parse_backup_options<I>(args: I) -> Result<BackupOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = BackupOptions {
        json: false,
        require_idle: false,
        path: None,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--path" => {
                let value = args
                    .next()
                    .filter(|value| !value.is_empty() && !value.starts_with("--"))
                    .ok_or_else(|| CliError::invalid_arguments("--path requires a file path"))?;
                if options.path.replace(PathBuf::from(value)).is_some() {
                    return Err(CliError::invalid_arguments("--path must be specified once"));
                }
            }
            "--json" => options.json = true,
            "--require-idle" => options.require_idle = true,
            _ => {
                return Err(CliError::invalid_arguments(format!(
                    "unknown argument: {arg}"
                )))
            }
        }
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::{parse_args, CliCommand};
    use crate::shared::errors::CliErrorCategory;

    #[test]
    fn validates_backup_verify_arguments() {
        use super::BackupAction;
        assert_eq!(
            parse_args(["backup", "verify", "--path", "/tmp/backup.sqlite", "--json"]).unwrap(),
            CliCommand::Backup {
                action: BackupAction::Verify {
                    path: "/tmp/backup.sqlite".into()
                },
                json: true
            }
        );
        for args in [
            vec!["backup", "verify"],
            vec!["backup", "verify", "--path", "--json"],
            vec!["backup", "create", "--path", "x"],
            vec!["backup", "verify", "--require-idle", "--path", "x"],
            vec!["backup", "verify", "--path", "x", "--path", "y"],
        ] {
            assert!(parse_args(args).is_err());
        }
    }

    #[test]
    fn parses_status_json() {
        assert_eq!(
            parse_args(["status", "--json"]).expect("parsed"),
            CliCommand::Status { json: true },
        );
    }

    #[test]
    fn parses_mcp_commands() {
        use super::McpAction;
        assert_eq!(
            parse_args(["mcp", "start"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Start,
                json: false,
            },
        );
        assert_eq!(
            parse_args(["mcp", "stop"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Stop,
                json: false,
            },
        );
        assert_eq!(
            parse_args(["mcp", "status", "--json"]).expect("parsed"),
            CliCommand::Mcp {
                action: McpAction::Status,
                json: true,
            },
        );
    }

    #[test]
    fn parses_queue_inspect_json() {
        use super::QueueAction;
        assert_eq!(
            parse_args(["queue", "inspect", "--json"]).expect("parsed"),
            CliCommand::Queue {
                action: QueueAction::Inspect,
                json: true,
            },
        );
    }

    #[test]
    fn parses_queue_executor_tick_json() {
        use super::QueueAction;
        assert_eq!(
            parse_args(["queue", "executor-tick", "--json"]).expect("parsed"),
            CliCommand::Queue {
                action: QueueAction::ExecutorTick,
                json: true,
            },
        );
    }

    #[test]
    fn parses_agent_log_sync_backfill_codex_options() {
        use super::AgentLogSyncAction;
        assert_eq!(
            parse_args([
                "agent-log-sync",
                "backfill-codex",
                "--write",
                "--limit=7",
                "--max-bytes",
                "4096",
                "--json"
            ])
            .expect("parsed"),
            CliCommand::AgentLogSync {
                action: AgentLogSyncAction::BackfillCodex {
                    dry_run: false,
                    limit: 7,
                    max_bytes: 4096,
                },
                json: true,
            },
        );
    }

    #[test]
    fn parses_runtime_sidecars_json() {
        use super::RuntimeAction;
        assert_eq!(
            parse_args(["runtime", "sidecars", "--json"]).expect("parsed"),
            CliCommand::Runtime {
                action: RuntimeAction::Sidecars,
                json: true,
            },
        );
    }

    #[test]
    fn parses_runtime_assert_rust_only_json() {
        use super::RuntimeAction;
        assert_eq!(
            parse_args(["runtime", "assert-rust-only", "--json"]).expect("parsed"),
            CliCommand::Runtime {
                action: RuntimeAction::AssertRustOnly,
                json: true,
            },
        );
    }

    #[test]
    fn parses_vector_health_json() {
        use super::VectorAction;
        assert_eq!(
            parse_args(["vector", "health", "--json"]).expect("parsed"),
            CliCommand::Vector {
                action: VectorAction::Health,
                json: true,
            },
        );
        assert_eq!(
            parse_args(["vector", "smoke"]).expect("parsed"),
            CliCommand::Vector {
                action: VectorAction::Smoke,
                json: false,
            },
        );
    }

    #[test]
    fn parses_context_compile_actions_with_exact_option_sets() {
        use super::ContextCompileAction;
        assert_eq!(
            parse_args([
                "context-compile",
                "capabilities",
                "--out",
                "report.json",
                "--json"
            ])
            .expect("capabilities command parsed"),
            CliCommand::ContextCompile {
                action: ContextCompileAction::Capabilities {
                    out: Some("report.json".into()),
                },
                json: true,
            }
        );
        assert_eq!(
            parse_args([
                "context-compile",
                "compare",
                "--candidate",
                "candidate.json",
                "--out",
                "compare.json",
                "--manifest",
                "manifest.json",
                "--baseline",
                "baseline.json",
            ])
            .expect("compare command parsed"),
            CliCommand::ContextCompile {
                action: ContextCompileAction::Compare {
                    manifest: "manifest.json".into(),
                    baseline: "baseline.json".into(),
                    candidate: "candidate.json".into(),
                    out: "compare.json".into(),
                },
                json: false,
            }
        );
    }

    #[test]
    fn context_compile_rejects_repeated_or_wrong_action_options() {
        let repeated = parse_args([
            "context-compile",
            "baseline",
            "--manifest",
            "one.json",
            "--manifest",
            "two.json",
            "--out",
            "out.json",
        ])
        .expect_err("repeated option must fail");
        assert!(repeated.to_string().contains("repeated option"));
        let wrong_action = parse_args(["context-compile", "capabilities", "--allow-live-writes"])
            .expect_err("wrong action option must fail");
        assert!(wrong_action.to_string().contains("not valid"));
    }

    #[test]
    fn unknown_commands_are_invalid_arguments() {
        let error = parse_args(["unknown"]).expect_err("unknown command should fail");

        assert_eq!(error.category(), &CliErrorCategory::InvalidArguments);
        assert_eq!(error.category_code(), "invalid_arguments");
        assert_ne!(error.exit_code(), 0);
        assert!(error.to_string().contains("unknown command"));
    }

    #[test]
    fn json_commands_fail_before_output_on_invalid_arguments() {
        let error = parse_args(["paths", "--json", "--unexpected"])
            .expect_err("invalid json command arguments should fail");

        assert_eq!(error.category(), &CliErrorCategory::InvalidArguments);
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains("unknown argument"));
    }
}
