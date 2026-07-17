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
            let action_str =
                required_action(&mut args, "queue", "start, stop, status, or inspect")?;
            let action = match action_str.as_str() {
                "start" => QueueAction::Start,
                "stop" => QueueAction::Stop,
                "status" => QueueAction::Status,
                "inspect" => QueueAction::Inspect,
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
            let action_str = required_action(&mut args, "backup", "preflight")?;
            let options = parse_backup_options(args)?;
            let action = match action_str.as_str() {
                "preflight" => BackupAction::Preflight {
                    require_idle: options.require_idle,
                },
                "create" if !options.require_idle => BackupAction::Create,
                "create" => {
                    return Err(CliError::invalid_arguments(
                        "--require-idle is only valid for backup preflight",
                    ))
                }
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
        _ => Err(CliError::invalid_arguments(format!(
            "unknown command: {command}"
        ))),
    }
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
}

fn parse_backup_options<I>(args: I) -> Result<BackupOptions, CliError>
where
    I: IntoIterator<Item = String>,
{
    let mut options = BackupOptions {
        json: false,
        require_idle: false,
    };
    for arg in args {
        match arg.as_str() {
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
