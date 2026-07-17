use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::domains::{
    bootstrap::service::resolve_paths,
    daemon::repository::{self, ProcessState},
    process_lifecycle::service::{self, LifecycleReport, ManagedProcessSpec},
    sqlite_writer,
};
use crate::shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::{
    ingest::{ingest_codex_paths, ingest_source},
    roots::build_sources,
    store::{read_cursor, store_source_result},
    types::{
        AgentLogSourceId, AgentLogSourceSyncSummary, AgentLogSyncSummary, IngestCursor,
        IngestCursorEntry,
    },
};

const AGENT_LOG_SYNC: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "agent-log-sync",
    display_name: "agent-log-sync",
    command: "context-stilld",
    args: &["agent-log-sync", "run", "--wait"],
    log_file: "agent-log-sync.log",
};
const CODEX_HISTORICAL_BACKFILL_STATE_ID: &str = "codex_logs_historical_backfill";

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CodexHistoricalBackfillOptions {
    pub dry_run: bool,
    pub limit: usize,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoricalBackfillFile {
    pub path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoricalBackfillReport {
    pub mode: String,
    pub candidate_files: usize,
    pub candidate_bytes: u64,
    pub selected_files: usize,
    pub selected_bytes: u64,
    pub skipped_processed_files: usize,
    pub cutoff_ms: u64,
    pub imported: u64,
    pub inserted_diffs: u64,
    pub warnings: Vec<String>,
    pub files: Vec<CodexHistoricalBackfillFile>,
}

impl CodexHistoricalBackfillReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        format!(
            "codex historical backfill mode={} candidates={} selected={} selectedBytes={} skippedProcessed={} imported={} insertedDiffs={}",
            self.mode,
            self.candidate_files,
            self.selected_files,
            self.selected_bytes,
            self.skipped_processed_files,
            self.imported,
            self.inserted_diffs
        )
    }
}

pub fn run<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(run_report(env, supervisor)?.to_text())
}

pub fn run_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    run_and_wait_report(env, supervisor, Duration::from_secs(300))
}

pub fn run_and_wait_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    _supervisor: &S,
    timeout: Duration,
) -> Result<LifecycleReport, CliError> {
    let paths = resolve_paths(env);
    let started_at = service::now_timestamp();
    let pid = std::process::id();
    write_state(env, Some(pid), "running", Some(started_at.clone()), None)?;

    let started = Instant::now();
    let result = run_sync(env);
    let updated_at = service::now_timestamp();
    let timed_out = started.elapsed() > timeout;
    let status = if result.as_ref().is_ok_and(|summary| summary.ok) && !timed_out {
        "exited"
    } else {
        "failed"
    };
    let last_error = if timed_out {
        Some("agent-log-sync exceeded requested timeout".to_string())
    } else {
        result.as_ref().err().map(ToString::to_string)
    };
    let exit_code = if status == "exited" { Some(0) } else { Some(1) };
    let state = ProcessState {
        pid: None,
        status: status.to_string(),
        log_path: paths
            .logs_dir
            .join(AGENT_LOG_SYNC.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at: Some(started_at),
        updated_at: Some(updated_at),
        exit_code,
        last_error: last_error.clone(),
        command: Some("context-stilld".to_string()),
        args: Some(vec![
            "agent-log-sync".to_string(),
            "run".to_string(),
            "--wait".to_string(),
        ]),
        ..ProcessState::default()
    };
    service::write_process_state(&AGENT_LOG_SYNC, &paths.run_dir, &state)?;
    let _ = repository::clear_pid(&paths.run_dir, AGENT_LOG_SYNC.state_name);

    let message = match result {
        Ok(summary) if status == "exited" => format!(
            "agent-log-sync completed in Rust (imported={}, insertedDiffs={})",
            summary.imported, summary.inserted_diffs
        ),
        Ok(_) => "agent-log-sync failed in Rust".to_string(),
        Err(error) => format!("agent-log-sync failed in Rust: {error}"),
    };
    Ok(service::report_from_state(
        &AGENT_LOG_SYNC,
        "run",
        status,
        message,
        state,
    ))
}

pub fn stop<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    Ok(stop_report(env, supervisor)?.to_text())
}

pub fn stop_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::stop_report(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<String, CliError> {
    service::status(&AGENT_LOG_SYNC, env, supervisor)
}

pub fn status_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<LifecycleReport, CliError> {
    service::status_report(&AGENT_LOG_SYNC, env, supervisor)
}

pub(crate) fn run_sync<E: EnvProvider>(env: &E) -> Result<AgentLogSyncSummary, CliError> {
    let started_at = service::now_timestamp();
    let paths = resolve_paths(env);
    let sources = build_sources(env);
    let min_distillable_chars = env
        .var("AGENT_LOG_MIN_DISTILLABLE_CHARS")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(2000);
    let mut summary = AgentLogSyncSummary {
        ok: true,
        started_at: started_at.clone(),
        finished_at: started_at,
        imported: 0,
        inserted_diffs: 0,
        sources: Vec::new(),
    };
    for source in sources {
        let source_id = source.id.id().to_string();
        let cursor = sqlite_writer::execute_for_path(
            &paths.sqlite_core_path,
            "agent_log_sync.read_cursor",
            move |connection| {
                #[cfg(test)]
                super::store::ensure_test_schema(connection).map_err(|error| error.to_string())?;
                read_cursor(connection, &source_id).map_err(|error| error.to_string())
            },
        )
        .map_err(|error| CliError::io(format!("SQLite writer cursor read failed: {error}")))?;

        // Filesystem discovery and parsing intentionally happen outside the Writer thread.
        let ingest = ingest_source(&source, cursor).map_err(CliError::runtime)?;
        if !ingest.ok {
            summary.ok = false;
            summary.sources.push(AgentLogSourceSyncSummary {
                id: source.id.id().to_string(),
                label: source.id.label().to_string(),
                ok: false,
                skipped: ingest.skipped,
                checked_files: ingest.checked_files,
                messages: 0,
                inserted_memories: 0,
                inserted_diffs: 0,
                warnings: ingest.warnings,
                errors: ingest.errors,
                last_synced_at: None,
            });
            continue;
        }

        let checked_files = ingest.checked_files;
        let message_count = ingest.messages.len();
        let warnings = ingest.warnings.clone();
        let skipped = ingest.skipped;
        let summary_id = source.id.id().to_string();
        let summary_label = source.id.label().to_string();
        let stored = sqlite_writer::execute_for_path(
            &paths.sqlite_core_path,
            "agent_log_sync.persist_source",
            move |connection| {
                store_source_result(connection, &source, ingest, min_distillable_chars)
                    .map_err(|error| error.to_string())
            },
        )
        .map_err(|error| CliError::io(format!("SQLite writer source persist failed: {error}")))?;
        summary.imported += stored.inserted_memories;
        summary.inserted_diffs += stored.inserted_diffs;
        summary.sources.push(AgentLogSourceSyncSummary {
            id: summary_id,
            label: summary_label,
            ok: true,
            skipped,
            checked_files,
            messages: message_count,
            inserted_memories: stored.inserted_memories,
            inserted_diffs: stored.inserted_diffs,
            warnings,
            errors: Vec::new(),
            last_synced_at: stored.last_synced_at,
        });
    }

    summary.finished_at = service::now_timestamp();
    Ok(summary)
}

pub fn backfill_codex_historical_report<E: EnvProvider>(
    env: &E,
    options: CodexHistoricalBackfillOptions,
) -> Result<CodexHistoricalBackfillReport, CliError> {
    let paths = resolve_paths(env);
    let mut sources = build_sources(env);
    let min_distillable_chars = env
        .var("AGENT_LOG_MIN_DISTILLABLE_CHARS")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(2000);
    let Some(source) = sources
        .drain(..)
        .find(|source| source.id == AgentLogSourceId::Codex)
    else {
        return Err(CliError::runtime("Codex log source is not configured"));
    };

    let initial_lookback_hours = source.initial_lookback_hours;
    let (main_cursor, processed_cursor, cutoff_ms) = sqlite_writer::execute_for_path(
        &paths.sqlite_core_path,
        "agent_log_sync.backfill_snapshot",
        move |connection| {
            #[cfg(test)]
            super::store::ensure_test_schema(connection).map_err(|error| error.to_string())?;
            Ok((
                read_cursor(connection, AgentLogSourceId::Codex.id())
                    .map_err(|error| error.to_string())?,
                read_cursor(connection, CODEX_HISTORICAL_BACKFILL_STATE_ID)
                    .map_err(|error| error.to_string())?,
                historical_cutoff_ms(connection, initial_lookback_hours)
                    .map_err(|error| error.to_string())?,
            ))
        },
    )
    .map_err(|error| CliError::io(format!("SQLite writer backfill snapshot failed: {error}")))?;

    // Directory traversal, stat calls, and JSONL parsing stay outside the Writer thread.
    let files = list_jsonl_files(&source.roots)?;
    let processed_paths = processed_cursor
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();

    let mut skipped_processed_files = 0;
    let mut candidates = Vec::new();
    for path in files {
        let stat = match fs::metadata(&path) {
            Ok(stat) => stat,
            Err(error) => {
                return Err(CliError::io(format!(
                    "failed to stat Codex log {}: {error}",
                    path.to_string_lossy()
                )))
            }
        };
        let mtime_ms = mtime_ms(&stat);
        if mtime_ms >= cutoff_ms {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        if processed_paths.contains(&key) {
            skipped_processed_files += 1;
            continue;
        }
        if main_cursor
            .get(&key)
            .is_some_and(|entry| entry.offset < stat.len())
        {
            continue;
        }
        candidates.push(CodexHistoricalBackfillFile {
            path: key,
            size_bytes: stat.len(),
            mtime_ms,
        });
    }
    candidates.sort_by(|a, b| a.mtime_ms.cmp(&b.mtime_ms).then(a.path.cmp(&b.path)));

    let candidate_files = candidates.len();
    let candidate_bytes = candidates.iter().map(|file| file.size_bytes).sum();
    let selected = select_backfill_files(&candidates, options.limit, options.max_bytes);
    let selected_files = selected.len();
    let selected_bytes = selected.iter().map(|file| file.size_bytes).sum();
    let mut report = CodexHistoricalBackfillReport {
        mode: if options.dry_run {
            "dry-run".to_string()
        } else {
            "write".to_string()
        },
        candidate_files,
        candidate_bytes,
        selected_files,
        selected_bytes,
        skipped_processed_files,
        cutoff_ms,
        imported: 0,
        inserted_diffs: 0,
        warnings: Vec::new(),
        files: selected.clone(),
    };

    if options.dry_run || selected.is_empty() {
        return Ok(report);
    }

    let mut forced_cursor = main_cursor;
    for file in &selected {
        forced_cursor.insert(
            file.path.clone(),
            IngestCursorEntry {
                offset: 0,
                mtime_ms: file.mtime_ms,
            },
        );
    }
    let selected_paths = selected
        .iter()
        .map(|file| PathBuf::from(&file.path))
        .collect::<Vec<_>>();
    let ingest = ingest_codex_paths(forced_cursor, &selected_paths).map_err(CliError::runtime)?;
    report.warnings.extend(ingest.warnings.clone());
    if !ingest.ok {
        return Err(CliError::runtime(format!(
            "Codex historical backfill ingest failed: {:?}",
            ingest.errors
        )));
    }

    let mut next_processed_cursor = processed_cursor;
    for file in &selected {
        next_processed_cursor.insert(
            file.path.clone(),
            IngestCursorEntry {
                offset: file.size_bytes,
                mtime_ms: file.mtime_ms,
            },
        );
    }
    let report_mode = report.mode.clone();
    let stored = sqlite_writer::execute_for_path(
        &paths.sqlite_core_path,
        "agent_log_sync.backfill_persist",
        move |connection| {
            let stored = store_source_result(connection, &source, ingest, min_distillable_chars)
                .map_err(|error| error.to_string())?;
            write_backfill_state(
                connection,
                &next_processed_cursor,
                &json!({
                    "sourceId": AgentLogSourceId::Codex.id(),
                    "formatVersion": "rust-1.0",
                    "lastSelectedFiles": selected_files,
                    "lastSelectedBytes": selected_bytes,
                    "lastImported": stored.inserted_memories,
                    "lastRunMode": report_mode
                }),
            )
            .map_err(|error| error.to_string())?;
            Ok(stored)
        },
    )
    .map_err(|error| {
        CliError::io(format!(
            "SQLite writer Codex backfill persist failed: {error}"
        ))
    })?;
    report.imported = stored.inserted_memories;
    report.inserted_diffs = stored.inserted_diffs;
    Ok(report)
}

fn historical_cutoff_ms(
    connection: &rusqlite::Connection,
    initial_lookback_hours: u64,
) -> Result<u64, CliError> {
    let created_at: Option<String> = connection
        .query_row(
            "select created_at from sync_states where id = 'codex_logs'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let Some(created_at) = created_at else {
        return Ok(now_ms().saturating_sub(initial_lookback_hours * 60 * 60 * 1000));
    };
    let Some(created_ms) = parse_timestamp_ms(&created_at) else {
        return Ok(now_ms().saturating_sub(initial_lookback_hours * 60 * 60 * 1000));
    };
    Ok(created_ms.saturating_sub(initial_lookback_hours * 60 * 60 * 1000))
}

fn select_backfill_files(
    candidates: &[CodexHistoricalBackfillFile],
    limit: usize,
    max_bytes: u64,
) -> Vec<CodexHistoricalBackfillFile> {
    let mut selected = Vec::new();
    let mut total = 0_u64;
    for candidate in candidates {
        if selected.len() >= limit {
            break;
        }
        if !selected.is_empty() && total.saturating_add(candidate.size_bytes) > max_bytes {
            break;
        }
        total = total.saturating_add(candidate.size_bytes);
        selected.push(candidate.clone());
    }
    selected
}

fn list_jsonl_files(roots: &[PathBuf]) -> Result<Vec<PathBuf>, CliError> {
    let mut files = Vec::new();
    for root in roots {
        collect_jsonl_files(root, &mut files)?;
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn collect_jsonl_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), CliError> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(CliError::io(format!(
                "failed to read Codex log dir {}: {error}",
                path.to_string_lossy()
            )))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|error| {
            CliError::io(format!(
                "failed to read Codex log dir entry {}: {error}",
                path.to_string_lossy()
            ))
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            CliError::io(format!(
                "failed to read Codex log file type {}: {error}",
                path.to_string_lossy()
            ))
        })?;
        if file_type.is_dir() {
            collect_jsonl_files(&path, files)?;
        } else if file_type.is_file()
            && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn write_backfill_state(
    connection: &rusqlite::Connection,
    cursor: &IngestCursor,
    metadata: &Value,
) -> Result<(), CliError> {
    let now = service::now_timestamp();
    connection
        .execute(
            "
            insert into sync_states (id, last_synced_at, cursor, metadata, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              last_synced_at = excluded.last_synced_at,
              cursor = excluded.cursor,
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
            ",
            params![
                CODEX_HISTORICAL_BACKFILL_STATE_ID,
                now,
                cursor_to_json(cursor).to_string(),
                metadata.to_string(),
                now,
                now
            ],
        )
        .map_err(sql_error)?;
    Ok(())
}

fn cursor_to_json(cursor: &IngestCursor) -> Value {
    Value::Object(
        cursor
            .iter()
            .map(|(path, entry)| {
                (
                    path.clone(),
                    json!({"offset": entry.offset, "mtimeMs": entry.mtime_ms}),
                )
            })
            .collect(),
    )
}

fn parse_timestamp_ms(value: &str) -> Option<u64> {
    if let Some(raw) = value.strip_prefix("unix-ms:") {
        return raw.parse::<u64>().ok();
    }
    parse_rfc3339_utc_ms(value)
}

fn parse_rfc3339_utc_ms(value: &str) -> Option<u64> {
    let date_time = value.strip_suffix('Z')?;
    let (date, time) = date_time.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_raw = time_parts.next()?;
    let (second_str, millis_str) = second_raw.split_once('.').unwrap_or((second_raw, "0"));
    let second = second_str.parse::<u32>().ok()?;
    let millis_raw = millis_str.chars().take(3).collect::<String>();
    let millis = format!("{millis_raw:0<3}").parse::<u32>().unwrap_or(0);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(
        days as u64 * 86_400_000
            + hour as u64 * 3_600_000
            + minute as u64 * 60_000
            + second as u64 * 1000
            + millis as u64,
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - (month <= 2) as i32;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146097 + doe - 719468) as i64
}

fn mtime_ms(stat: &fs::Metadata) -> u64 {
    stat.modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn write_state<E: EnvProvider>(
    env: &E,
    pid: Option<u32>,
    status: &str,
    started_at: Option<String>,
    last_error: Option<String>,
) -> Result<(), CliError> {
    let paths = resolve_paths(env);
    let state = ProcessState {
        pid,
        status: status.to_string(),
        log_path: paths
            .logs_dir
            .join(AGENT_LOG_SYNC.log_file)
            .to_string_lossy()
            .into_owned(),
        started_at,
        updated_at: Some(service::now_timestamp()),
        last_error,
        command: Some("context-stilld".to_string()),
        args: Some(vec![
            "agent-log-sync".to_string(),
            "run".to_string(),
            "--wait".to_string(),
        ]),
        ..ProcessState::default()
    };
    repository::write_state(&paths.run_dir, AGENT_LOG_SYNC.state_name, &state)
        .map_err(|error| CliError::io(format!("failed to write agent-log-sync state: {error}")))
}

fn sql_error(error: rusqlite::Error) -> CliError {
    CliError::runtime(format!("sqlite agent-log-sync failed: {error}"))
}
