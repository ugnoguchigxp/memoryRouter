use std::{
    collections::BTreeSet,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;

use crate::domains::{bootstrap::service::resolve_paths, daemon::repository, runtime_identity};
use crate::shared::{
    config::EnvProvider,
    errors::CliError,
    process::{self, ProcessSupervisor},
};

use super::executor::rust_executor_supports_queue;
use super::service::status_report;
use super::types::{
    ActiveProviderLease, EpisodeDistillerProgressInspect, QueueFeatureFlagsInspect,
    QueueInspectReport, QueueStatusCount, QueueTableInspect, UnsupportedQueueBacklog,
    QUEUE_SUPERVISOR, QUEUE_TABLES,
};

pub fn inspect_report<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Result<QueueInspectReport, CliError> {
    let lifecycle = status_report(env, supervisor)?;
    let sqlite_path = runtime_identity::resolve(env, supervisor).effective_path;
    let sqlite_core_path = process::path_to_string(&sqlite_path);
    if !sqlite_path.exists() {
        return Ok(QueueInspectReport {
            process: QUEUE_SUPERVISOR.state_name,
            action: "inspect",
            status: lifecycle.status,
            worker_pid: lifecycle.pid,
            executor_mode: "missing_sqlite".to_string(),
            executor_running: false,
            executor_pid: None,
            runnable_pending_count: 0,
            unsupported_runnable_count: 0,
            unsupported_queues: Vec::new(),
            blocked_reason: Some("SQLite core database is missing".to_string()),
            sqlite_status: "missing",
            sqlite_core_path,
            queues: Vec::new(),
            active_lease_count: 0,
            active_target_ids: Vec::new(),
            active_leases: Vec::new(),
            last_heartbeat_at: None,
            feature_flags: queue_feature_flags(env),
        });
    }

    let connection = Connection::open_with_flags(&sqlite_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| {
            CliError::io(format!(
                "failed to open SQLite core database read-only: {error}"
            ))
        })?;
    let feature_flags = queue_feature_flags(env);
    let queues = inspect_queue_tables(&connection)?;
    let active_leases = inspect_active_leases(&connection)?;
    let active_target_ids = active_leases
        .iter()
        .map(|lease| lease.target_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let runnable_pending_count = queues.iter().map(|queue| queue.runnable_pending).sum();
    let mut unsupported_queues = Vec::new();
    for queue in queues.iter().filter(|queue| queue.runnable_pending > 0) {
        let runnable_pending = unsupported_runnable_for_queue(
            &connection,
            queue.queue_name,
            queue.runnable_pending,
            &feature_flags.rust_covering_mode,
        )?;
        if runnable_pending > 0 {
            unsupported_queues.push(UnsupportedQueueBacklog {
                queue_name: queue.queue_name,
                runnable_pending,
                reason: if queue.queue_name == "coveringEvidence"
                    && feature_flags.rust_covering_mode == "negative"
                {
                    "rust_native_executor_partial_support"
                } else {
                    "rust_native_executor_not_implemented"
                },
            });
        }
    }
    let unsupported_runnable_count = unsupported_queues
        .iter()
        .map(|queue| queue.runnable_pending)
        .sum();
    let rust_executor_pid = active_leases
        .iter()
        .filter_map(ActiveProviderLease::rust_executor_pid)
        .find(|pid| supervisor.is_alive(*pid))
        .or_else(|| persisted_rust_executor_pid(env, supervisor));
    let rust_executor_running = rust_executor_pid.is_some();
    let external_worker_running = active_leases.iter().any(|lease| !lease.is_rust_executor());
    let executor_running =
        lifecycle.pid.is_some() || rust_executor_running || external_worker_running;
    let executor_mode = if lifecycle.pid.is_some() {
        "legacy_process".to_string()
    } else if rust_executor_running {
        "rust_native".to_string()
    } else if external_worker_running {
        "external_worker".to_string()
    } else if runnable_pending_count > 0 {
        "maintenance_only".to_string()
    } else {
        "idle".to_string()
    };
    let blocked_reason =
        if unsupported_runnable_count > 0 && lifecycle.pid.is_none() && !external_worker_running {
            Some(format!(
                "runnable jobs exist for queues unsupported by the Rust native executor: {}",
                unsupported_queues
                    .iter()
                    .map(|queue| format!("{}={}", queue.queue_name, queue.runnable_pending))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        } else if executor_mode == "maintenance_only" {
            Some("runnable queue jobs exist but no executor is active".to_string())
        } else {
            None
        };
    let last_heartbeat_at = latest_timestamp(
        queues
            .iter()
            .filter_map(|queue| queue.last_heartbeat_at.clone())
            .chain(active_leases.iter().map(|lease| lease.heartbeat_at.clone())),
    );

    Ok(QueueInspectReport {
        process: QUEUE_SUPERVISOR.state_name,
        action: "inspect",
        status: lifecycle.status,
        worker_pid: lifecycle.pid,
        executor_mode,
        executor_running,
        executor_pid: lifecycle.pid.or(rust_executor_pid),
        runnable_pending_count,
        unsupported_runnable_count,
        unsupported_queues,
        blocked_reason,
        sqlite_status: "ok",
        sqlite_core_path,
        queues,
        active_lease_count: active_leases.len() as u64,
        active_target_ids,
        active_leases,
        last_heartbeat_at,
        feature_flags,
    })
}

fn persisted_rust_executor_pid<E: EnvProvider, S: ProcessSupervisor>(
    env: &E,
    supervisor: &S,
) -> Option<u32> {
    repository::read_state(&resolve_paths(env).run_dir, QUEUE_SUPERVISOR.state_name)
        .ok()
        .flatten()
        .and_then(|state| state.metadata)
        .and_then(|metadata| {
            metadata
                .get("executorEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true)
                .then(|| metadata.get("residentPid").and_then(Value::as_u64))
                .flatten()
        })
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| supervisor.is_alive(*pid))
}

fn queue_feature_flags<E: EnvProvider>(env: &E) -> QueueFeatureFlagsInspect {
    let persisted_covering_mode =
        repository::read_state(&resolve_paths(env).run_dir, QUEUE_SUPERVISOR.state_name)
            .ok()
            .flatten()
            .and_then(|state| state.metadata)
            .and_then(|metadata| {
                metadata
                    .get("rustCoveringMode")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
    QueueFeatureFlagsInspect {
        internal_chunked_distillation: env_bool(env, "CONTEXT_STILL_INTERNAL_CHUNKED_DISTILLATION")
            .unwrap_or_else(|| env_bool(env, "INTERNAL_CHUNKED_DISTILLATION").unwrap_or(false)),
        rust_covering_mode: env
            .var("CONTEXT_STILL_RUST_COVERING_MODE")
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .or(persisted_covering_mode)
            .unwrap_or_else(|| "off".to_string()),
    }
}

fn unsupported_runnable_for_queue(
    connection: &Connection,
    queue_name: &str,
    runnable_pending: u64,
    rust_covering_mode: &str,
) -> Result<u64, CliError> {
    if rust_executor_supports_queue(queue_name) {
        return Ok(0);
    }
    if queue_name != "coveringEvidence" || rust_covering_mode != "negative" {
        return Ok(runnable_pending);
    }
    if !table_exists(connection, "found_candidates")?
        || !table_has_column(connection, "covering_evidence_queue", "found_candidate_id")?
    {
        return Ok(runnable_pending);
    }
    connection
        .query_row(
            "
            select count(*)
            from covering_evidence_queue cq
            left join found_candidates fc on fc.id = cq.found_candidate_id
            where cq.status in ('pending', 'paused')
              and (cq.next_run_at is null or datetime(cq.next_run_at) <= CURRENT_TIMESTAMP)
              and coalesce(json_extract(fc.origin, '$.polarity'), '') != 'negative'
            ",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as u64)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect unsupported covering backlog: {error}"
            ))
        })
}

fn env_bool<E: EnvProvider>(env: &E, name: &str) -> Option<bool> {
    let value = env.var(name)?;
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" | "" => Some(false),
        _ => None,
    }
}

fn inspect_queue_tables(connection: &Connection) -> Result<Vec<QueueTableInspect>, CliError> {
    let mut queues = Vec::new();
    for (queue_name, table_name) in QUEUE_TABLES {
        if !table_exists(connection, table_name)? {
            queues.push(QueueTableInspect {
                queue_name,
                table_name,
                table_status: "missing",
                status_counts: Vec::new(),
                oldest_pending_at: None,
                runnable_pending: 0,
                running: 0,
                last_heartbeat_at: None,
                episode_distiller_progress: None,
            });
            continue;
        }
        let status_counts = status_counts(connection, table_name)?;
        let running = status_counts
            .iter()
            .find(|count| count.status == "running")
            .map(|count| count.count)
            .unwrap_or(0);
        queues.push(QueueTableInspect {
            queue_name,
            table_name,
            table_status: "ok",
            oldest_pending_at: scalar_string(
                connection,
                &format!(
                    "select min(created_at) from {table_name} where status in ('pending', 'paused')"
                ),
            )?,
            runnable_pending: runnable_pending(connection, queue_name, table_name)?,
            last_heartbeat_at: scalar_string(
                connection,
                &format!(
                    "select max(heartbeat_at) from {table_name} where heartbeat_at is not null"
                ),
            )?,
            status_counts,
            running,
            episode_distiller_progress: if *queue_name == "episodeDistiller" {
                inspect_episode_distiller_progress(connection, table_name)?
            } else {
                None
            },
        });
    }
    Ok(queues)
}

fn inspect_episode_distiller_progress(
    connection: &Connection,
    table_name: &str,
) -> Result<Option<EpisodeDistillerProgressInspect>, CliError> {
    if !table_has_column(connection, table_name, "metadata")? {
        return Ok(None);
    }
    let row = connection
        .query_row(
            &format!(
                "
                select id, coalesce(metadata, '{{}}')
                from {table_name}
                where status = 'running'
                order by locked_at desc, updated_at desc, id asc
                limit 1
                "
            ),
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect episode distiller progress metadata: {error}"
            ))
        })?;
    let Some((running_job_id, raw_metadata)) = row else {
        return Ok(None);
    };
    let metadata: Value = serde_json::from_str(&raw_metadata).unwrap_or(Value::Null);
    let current_segment = metadata_u64_at(&metadata, "/episodeDistiller/currentSegment");
    let segment_count = metadata_u64_at(&metadata, "/episodeDistiller/segmentCount");
    let pipeline_version = metadata_string_at(&metadata, "/episodeDistiller/pipelineVersion");
    let source_window_count = metadata_u64_at(&metadata, "/episodeDistiller/sourceWindowCount");
    let semantic_chunk_count = metadata_u64_at(&metadata, "/episodeDistiller/semanticChunkCount");
    let last_segment_started_at =
        metadata_string_at(&metadata, "/episodeDistiller/lastSegmentStartedAt");
    let last_segment_completed_at =
        metadata_string_at(&metadata, "/episodeDistiller/lastSegmentCompletedAt");
    let last_episode_created_at =
        metadata_string_at(&metadata, "/episodeDistiller/lastEpisodeCreatedAt");
    let output_gap_seconds = latest_unix_ms_age_seconds([
        last_episode_created_at.as_deref(),
        last_segment_completed_at.as_deref(),
        last_segment_started_at.as_deref(),
    ]);
    let output_watchdog_status = output_gap_seconds.map(|age| {
        if age <= 10 * 60 {
            "fresh"
        } else if age <= 20 * 60 {
            "watch"
        } else {
            "force_stop_candidate"
        }
        .to_string()
    });
    let saved_episode_count = metadata
        .pointer("/episodeDistiller/savedEpisodeIds")
        .and_then(Value::as_array)
        .map(|items| items.len() as u64)
        .unwrap_or(0);
    Ok(Some(EpisodeDistillerProgressInspect {
        running_job_id,
        current_segment,
        segment_count,
        pipeline_version,
        source_window_count,
        semantic_chunk_count,
        last_segment_started_at,
        last_segment_completed_at,
        last_episode_created_at,
        output_gap_seconds,
        output_watchdog_status,
        saved_episode_count,
    }))
}

fn table_exists(connection: &Connection, table_name: &str) -> Result<bool, CliError> {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to inspect SQLite table {table_name}: {error}"
            ))
        })
}

fn status_counts(
    connection: &Connection,
    table_name: &str,
) -> Result<Vec<QueueStatusCount>, CliError> {
    let mut statement = connection
        .prepare(&format!(
            "select status, count(*) from {table_name} group by status order by status"
        ))
        .map_err(|error| {
            CliError::io(format!(
                "failed to prepare queue status count query: {error}"
            ))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok(QueueStatusCount {
                status: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| CliError::io(format!("failed to query queue status counts: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read queue status counts: {error}")))
}

fn scalar_string(connection: &Connection, sql: &str) -> Result<Option<String>, CliError> {
    connection
        .query_row(sql, [], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| CliError::io(format!("failed to query queue timestamp: {error}")))
}

fn runnable_pending(
    connection: &Connection,
    _queue_name: &str,
    table_name: &str,
) -> Result<u64, CliError> {
    let next_run_condition = if !table_has_column(connection, table_name, "next_run_at")? {
        ""
    } else {
        "and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP)"
    };
    connection
        .query_row(
            &format!(
                "
                select count(*)
                from {table_name}
                where status in ('pending', 'paused')
                  {next_run_condition}
                "
            ),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count as u64)
        .map_err(|error| CliError::io(format!("failed to count runnable queue jobs: {error}")))
}

fn table_has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, CliError> {
    let mut statement = connection
        .prepare(&format!("pragma table_info({table_name})"))
        .map_err(|error| CliError::io(format!("failed to inspect table columns: {error}")))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| CliError::io(format!("failed to query table columns: {error}")))?;
    let columns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read table columns: {error}")))?;
    Ok(columns.iter().any(|column| column == column_name))
}

fn inspect_active_leases(connection: &Connection) -> Result<Vec<ActiveProviderLease>, CliError> {
    if !table_exists(connection, "llm_provider_leases")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "select pool_id, target_id, queue_name, queue_job_id, worker_id, heartbeat_at, expires_at \
             from llm_provider_leases \
             where status = 'active' \
             order by pool_id, target_id, queue_name, queue_job_id",
        )
        .map_err(|error| CliError::io(format!("failed to prepare active lease query: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ActiveProviderLease {
                pool_id: row.get(0)?,
                target_id: row.get(1)?,
                queue_name: row.get(2)?,
                queue_job_id: row.get(3)?,
                worker_id: row.get(4)?,
                heartbeat_at: row.get(5)?,
                expires_at: row.get(6)?,
            })
        })
        .map_err(|error| CliError::io(format!("failed to query active leases: {error}")))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read active leases: {error}")))
}

fn metadata_string_at(metadata: &Value, pointer: &str) -> Option<String> {
    metadata
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn metadata_u64_at(metadata: &Value, pointer: &str) -> Option<u64> {
    metadata.pointer(pointer).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
    })
}

fn latest_unix_ms_age_seconds<const N: usize>(timestamps: [Option<&str>; N]) -> Option<u64> {
    let latest = timestamps
        .into_iter()
        .flatten()
        .filter_map(unix_ms_value)
        .max()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(now.saturating_sub(latest).div_ceil(1000) as u64)
}

fn unix_ms_value(timestamp: &str) -> Option<u128> {
    timestamp.strip_prefix("unix-ms:")?.parse::<u128>().ok()
}

fn latest_timestamp(values: impl Iterator<Item = String>) -> Option<String> {
    values.max()
}

impl QueueInspectReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        format!(
            "queue-supervisor inspect: {} sqlite={} activeLeases={} internalChunkedDistillation={} rustCoveringMode={}",
            self.status,
            self.sqlite_status,
            self.active_lease_count,
            self.feature_flags.internal_chunked_distillation,
            self.feature_flags.rust_covering_mode
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use crate::shared::config::MapEnv;
    use crate::shared::process::{MockSupervisor, ProcessSupervisor};

    #[test]
    fn inspect_reports_missing_sqlite_without_creating_database() {
        let app_dir = temp_app_dir("missing");
        let sqlite_path = app_dir.join("missing.sqlite");
        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "missing");
        assert_eq!(report.status, "stopped");
        assert!(report.queues.is_empty());
        assert!(!sqlite_path.exists());

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reads_queue_counts_and_active_leases() {
        let app_dir = temp_app_dir("active");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
        .execute_batch(
            r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null,
              heartbeat_at text not null,
              expires_at text not null
            );
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'pending', '2026-06-22T01:00:00.000Z', null);
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-2', 'running', '2026-06-22T02:00:00.000Z', '2026-06-22T02:01:00.000Z');
            insert into episode_distiller_queue (id, status, created_at, heartbeat_at)
              values ('job-3', 'completed', '2026-06-22T03:00:00.000Z', '2026-06-22T03:01:00.000Z');
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status, heartbeat_at, expires_at
            ) values (
              'lease-1', 'local-llm-default', 'local-llm:qwen-a', 'findingCandidate', 'job-2',
              'worker-1', 'active', '2026-06-22T04:00:00.000Z', '2026-06-22T04:05:00.000Z'
            );
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
        let supervisor = MockSupervisor::new();
        let queue_pid = supervisor
            .spawn(
                "bun",
                &[
                    "run",
                    "src/cli/queue-supervisor.ts",
                    "--continuous",
                    "--limit",
                    "1",
                ],
                &app_dir.join("logs/queue-supervisor.log"),
                &app_dir,
            )
            .unwrap();
        crate::domains::daemon::repository::write_pid(
            &app_dir.join("run"),
            "queue-supervisor",
            queue_pid,
        )
        .unwrap();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "ok");
        assert_eq!(report.status, "running");
        assert_eq!(report.worker_pid, Some(queue_pid));
        assert_eq!(report.active_lease_count, 1);
        assert_eq!(
            report.active_target_ids,
            vec!["local-llm:qwen-a".to_string()]
        );
        assert_eq!(
            report.last_heartbeat_at,
            Some("2026-06-22T04:00:00.000Z".to_string())
        );
        let finding = report
            .queues
            .iter()
            .find(|queue| queue.queue_name == "findingCandidate")
            .unwrap();
        assert_eq!(finding.table_status, "ok");
        assert_eq!(finding.running, 1);
        assert_eq!(
            finding.oldest_pending_at,
            Some("2026-06-22T01:00:00.000Z".to_string())
        );
        assert!(
            report
                .queues
                .iter()
                .any(|queue| queue.queue_name == "coveringEvidence"
                    && queue.table_status == "missing")
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_surfaces_runnable_backlog_for_unsupported_rust_queue() {
        let app_dir = temp_app_dir("unsupported_backlog");
        let sqlite_path = app_dir.join("queue.sqlite");
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
                ) values
                  ('cover-1', 'pending', '2026-08-17T01:00:00.000Z', null, null),
                  ('cover-2', 'pending', '2026-08-17T02:00:00.000Z', null, null);
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
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.runnable_pending_count, 2);
        assert_eq!(report.unsupported_runnable_count, 2);
        assert_eq!(report.unsupported_queues.len(), 1);
        assert_eq!(report.unsupported_queues[0].queue_name, "coveringEvidence");
        assert_eq!(report.unsupported_queues[0].runnable_pending, 2);
        assert_eq!(
            report.unsupported_queues[0].reason,
            "rust_native_executor_not_implemented"
        );
        assert!(report
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("coveringEvidence=2")));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_counts_only_non_negative_covering_as_unsupported_when_mode_is_enabled() {
        let app_dir = temp_app_dir("negative_covering_mode");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
                create table found_candidates (
                  id text primary key,
                  origin text
                );
                create table covering_evidence_queue (
                  id text primary key,
                  found_candidate_id text not null,
                  status text not null,
                  created_at text not null,
                  heartbeat_at text,
                  next_run_at text
                );
                insert into found_candidates (id, origin) values
                  ('candidate-negative', '{"polarity":"negative"}'),
                  ('candidate-positive', '{"polarity":"positive"}');
                insert into covering_evidence_queue (
                  id, found_candidate_id, status, created_at, heartbeat_at, next_run_at
                ) values
                  ('cover-negative', 'candidate-negative', 'pending', CURRENT_TIMESTAMP, null, null),
                  ('cover-positive', 'candidate-positive', 'pending', CURRENT_TIMESTAMP, null, null);
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
            ("CONTEXT_STILL_RUST_COVERING_MODE", "negative"),
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.runnable_pending_count, 2);
        assert_eq!(report.unsupported_runnable_count, 1);
        assert_eq!(report.feature_flags.rust_covering_mode, "negative");
        assert_eq!(report.unsupported_queues.len(), 1);
        assert_eq!(report.unsupported_queues[0].runnable_pending, 1);
        assert_eq!(
            report.unsupported_queues[0].reason,
            "rust_native_executor_partial_support"
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reports_episode_distiller_output_watchdog_progress() {
        let app_dir = temp_app_dir("episode_progress");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        let old_output = unix_ms_ago(25 * 60);
        connection
            .execute_batch(&format!(
                r#"
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              updated_at text not null,
              locked_at text,
              heartbeat_at text,
              metadata text
            );
            insert into episode_distiller_queue (
              id, status, created_at, updated_at, locked_at, heartbeat_at, metadata
            ) values (
              'episode-job-1', 'running', '2026-06-22T01:00:00.000Z',
              '2026-06-22T01:10:00.000Z', '2026-06-22T01:01:00.000Z',
              '2026-06-22T01:09:00.000Z',
              '{{
                "episodeDistiller": {{
                  "pipelineVersion": "internal-chunked-v1",
                  "sourceWindowCount": 3,
                  "semanticChunkCount": 4,
                  "currentSegment": 2,
                  "segmentCount": 5,
                  "lastSegmentStartedAt": "{old_output}",
                  "lastSegmentCompletedAt": "{old_output}",
                  "lastEpisodeCreatedAt": "{old_output}",
                  "savedEpisodeIds": ["episode-1", "episode-2"]
                }}
              }}'
            );
            "#
            ))
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![
            ("CONTEXT_STILL_APP_DATA_DIR", app_dir.to_str().unwrap()),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH",
                sqlite_path.to_str().unwrap(),
            ),
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        let episode = report
            .queues
            .iter()
            .find(|queue| queue.queue_name == "episodeDistiller")
            .unwrap();
        let progress = episode.episode_distiller_progress.as_ref().unwrap();
        assert_eq!(progress.running_job_id, "episode-job-1");
        assert_eq!(progress.current_segment, Some(2));
        assert_eq!(progress.segment_count, Some(5));
        assert_eq!(
            progress.pipeline_version.as_deref(),
            Some("internal-chunked-v1")
        );
        assert_eq!(progress.source_window_count, Some(3));
        assert_eq!(progress.semantic_chunk_count, Some(4));
        assert_eq!(progress.saved_episode_count, 2);
        assert_eq!(
            progress.output_watchdog_status.as_deref(),
            Some("force_stop_candidate")
        );
        assert!(progress.output_gap_seconds.unwrap() >= 20 * 60);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reports_internal_chunked_distillation_feature_flag() {
        let app_dir = temp_app_dir("feature_flags");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
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
            ("CONTEXT_STILL_INTERNAL_CHUNKED_DISTILLATION", "true"),
        ]);
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert!(report.feature_flags.internal_chunked_distillation);
        assert!(report
            .to_text()
            .contains("internalChunkedDistillation=true"));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_watchdog_uses_latest_episode_or_segment_progress_timestamp() {
        let old_episode = unix_ms_ago(25 * 60);
        let fresh_segment = unix_ms_ago(2 * 60);

        let age = latest_unix_ms_age_seconds([
            Some(old_episode.as_str()),
            None,
            Some(fresh_segment.as_str()),
        ])
        .unwrap();

        assert!(age < 10 * 60);
    }

    #[test]
    fn inspect_uses_live_resident_sqlite_path_when_shell_env_omits_it() {
        let app_dir = temp_app_dir("resident_path");
        let live_sqlite_path = app_dir.join("live.sqlite");
        let connection = Connection::open(&live_sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
            create table finding_candidate_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            insert into finding_candidate_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'pending', '2026-06-22T01:00:00.000Z', null);
            "#,
            )
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_dir.to_str().unwrap(),
        )]);
        let supervisor = MockSupervisor::new();
        let resident_pid = supervisor
            .spawn(
                "context-stilld",
                &["run"],
                &app_dir.join("logs/context-stilld.log"),
                &app_dir,
            )
            .unwrap();
        std::fs::create_dir_all(app_dir.join("run")).unwrap();
        crate::domains::daemon::repository::write_state(
            &app_dir.join("run"),
            "context-stilld",
            &crate::domains::daemon::repository::ProcessState {
                pid: Some(resident_pid),
                status: "running".to_string(),
                log_path: app_dir
                    .join("logs/context-stilld.log")
                    .to_string_lossy()
                    .into_owned(),
                sqlite_core_path: Some(live_sqlite_path.to_string_lossy().into_owned()),
                ..crate::domains::daemon::repository::ProcessState::default()
            },
        )
        .unwrap();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.sqlite_status, "ok");
        assert_eq!(report.sqlite_core_path, live_sqlite_path.to_string_lossy());
        assert_eq!(
            report
                .queues
                .iter()
                .find(|queue| queue.queue_name == "findingCandidate")
                .unwrap()
                .oldest_pending_at,
            Some("2026-06-22T01:00:00.000Z".to_string())
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_reports_rust_executor_pid_from_active_lease_worker_id() {
        let app_dir = temp_app_dir("rust_executor_pid");
        let sqlite_path = app_dir.join("queue.sqlite");
        let supervisor = MockSupervisor::new();
        let rust_pid = supervisor
            .spawn(
                "context-stilld",
                &["run"],
                &app_dir.join("logs/context-stilld.log"),
                &app_dir,
            )
            .unwrap();
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                &format!(
                    r#"
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null,
              heartbeat_at text not null,
              expires_at text not null
            );
            insert into episode_distiller_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'running', '2026-06-22T01:00:00.000Z', '2026-06-22T01:01:00.000Z');
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status, heartbeat_at, expires_at
            ) values (
              'lease-1', 'local-llm-default', 'local-llm:qwen-a', 'episodeDistiller', 'job-1',
              'context-stilld-rust-executor:local-llm-default:{rust_pid}-123456789', 'active',
              '2026-06-22T01:01:00.000Z', '2026-06-22T01:03:00.000Z'
            );
            "#,
                ),
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

        let report = inspect_report(&env, &supervisor).unwrap();

        assert_eq!(report.executor_mode, "rust_native");
        assert!(report.executor_running);
        assert_eq!(report.executor_pid, Some(rust_pid));
        assert_eq!(report.worker_pid, None);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn inspect_does_not_report_dead_rust_lease_as_running_executor() {
        let app_dir = temp_app_dir("dead_rust_executor_pid");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                r#"
            create table episode_distiller_queue (
              id text primary key,
              status text not null,
              created_at text not null,
              heartbeat_at text
            );
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null,
              heartbeat_at text not null,
              expires_at text not null
            );
            insert into episode_distiller_queue (id, status, created_at, heartbeat_at)
              values ('job-1', 'running', '2026-06-22T01:00:00.000Z', '2026-06-22T01:01:00.000Z');
            insert into llm_provider_leases (
              id, pool_id, target_id, queue_name, queue_job_id, worker_id, status, heartbeat_at, expires_at
            ) values (
              'lease-1', 'local-llm-default', 'local-llm:qwen-a', 'episodeDistiller', 'job-1',
              'context-stilld-rust-executor:local-llm-default:4242-123456789', 'active',
              '2026-06-22T01:01:00.000Z', '2026-06-22T01:03:00.000Z'
            );
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
        let supervisor = MockSupervisor::new();

        let report = inspect_report(&env, &supervisor).unwrap();

        assert!(!report.executor_running);
        assert_eq!(report.executor_pid, None);
        assert_eq!(report.executor_mode, "idle");
        assert_eq!(report.active_lease_count, 1);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn persisted_maintenance_pid_is_not_an_active_executor_when_disabled() {
        let app_dir = temp_app_dir("maintenance_only_pid");
        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_APP_DATA_DIR",
            app_dir.to_str().unwrap(),
        )]);
        let supervisor = MockSupervisor::new();
        let pid = 42_424;
        supervisor.alive.lock().unwrap().insert(pid, true);
        repository::write_state(
            &app_dir.join("run"),
            QUEUE_SUPERVISOR.state_name,
            &crate::domains::daemon::repository::ProcessState {
                status: "scheduled".to_string(),
                log_path: String::new(),
                metadata: Some(serde_json::json!({
                    "executor":"maintenance_only",
                    "executorEnabled":false,
                    "residentPid":pid
                })),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(persisted_rust_executor_pid(&env, &supervisor), None);
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    fn unix_ms_ago(seconds: u64) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        format!("unix-ms:{}", now.saturating_sub(u128::from(seconds) * 1000))
    }
}
