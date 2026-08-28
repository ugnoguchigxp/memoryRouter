use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags};

use crate::shared::errors::CliError;

use super::common::queue_table_name;
use super::types::ProviderLeaseAssignment;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);

pub(crate) fn open_query_only_connection(path: &Path) -> Result<Connection, CliError> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            CliError::io(format!(
                "failed to open queue SQLite database read-only: {error}"
            ))
        })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| CliError::io(format!("failed to set queue read timeout: {error}")))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| CliError::io(format!("failed to enable sqlite query_only: {error}")))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| CliError::io(format!("failed to enable sqlite foreign_keys: {error}")))?;
    Ok(connection)
}

pub(crate) fn owns_provider_execution(
    connection: &Connection,
    assignment: &ProviderLeaseAssignment,
) -> Result<bool, CliError> {
    let table_name = queue_table_name(&assignment.queue_name)?;
    connection
        .query_row(
            &format!(
                "select exists(
                   select 1
                   from {table_name} queue_job
                   join llm_provider_leases lease
                     on lease.id = ?3
                    and lease.queue_name = ?4
                    and lease.queue_job_id = queue_job.id
                    and lease.worker_id = ?2
                   where queue_job.id = ?1
                     and queue_job.status = 'running'
                     and queue_job.locked_by = ?2
                     and lease.status = 'active'
                 )"
            ),
            params![
                assignment.queue_job_id,
                assignment.worker_id,
                assignment.id,
                assignment.queue_name
            ],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            CliError::io(format!(
                "failed to verify {} claim ownership: {error}",
                assignment.queue_name
            ))
        })
}

pub(crate) struct ProviderExecutionHeartbeatGuard {
    stop: Arc<(Mutex<bool>, Condvar)>,
    handle: Option<JoinHandle<()>>,
}

impl ProviderExecutionHeartbeatGuard {
    pub(crate) fn start(
        sqlite_path: &Path,
        assignment: &ProviderLeaseAssignment,
    ) -> Result<Self, CliError> {
        Self::start_with_interval(sqlite_path, assignment, HEARTBEAT_INTERVAL)
    }

    fn start_with_interval(
        sqlite_path: &Path,
        assignment: &ProviderLeaseAssignment,
        interval: Duration,
    ) -> Result<Self, CliError> {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = match crate::domains::sqlite_writer::global_writer_for_path(sqlite_path) {
            Ok(writer) => writer,
            #[cfg(test)]
            Err(_) => {
                // Focused tests can execute against a short-lived writer with no concurrent stale
                // recovery loop. Production always installs the resident writer before queue work.
                return Ok(Self { stop, handle: None });
            }
            #[cfg(not(test))]
            Err(error) => return Err(CliError::io(error)),
        };
        let thread_stop = Arc::clone(&stop);
        let assignment = assignment.clone();
        let handle = thread::Builder::new()
            .name(format!("context-still-{}-heartbeat", assignment.queue_name))
            .spawn(move || loop {
                let (stop_lock, stop_changed) = &*thread_stop;
                let Ok(stopped) = stop_lock.lock() else {
                    return;
                };
                let Ok((stopped, _)) =
                    stop_changed.wait_timeout_while(stopped, interval, |stopped| !*stopped)
                else {
                    return;
                };
                if *stopped {
                    return;
                }
                drop(stopped);
                let assignment = assignment.clone();
                let queue_name = assignment.queue_name.clone();
                let operation = match queue_name.as_str() {
                    "findingCandidate" => "queue.finding_heartbeat",
                    "episodeDistiller" => "queue.episode_heartbeat",
                    _ => "queue.provider_heartbeat",
                };
                let owned = writer.execute(operation, move |connection| {
                    let table_name = queue_table_name(&assignment.queue_name)
                        .map_err(|error| error.to_string())?;
                    let tx = connection.transaction().map_err(|error| {
                        format!("failed to begin provider execution heartbeat: {error}")
                    })?;
                    let queue_changed = tx
                        .execute(
                            &format!(
                                "update {table_name}
                                     set heartbeat_at = CURRENT_TIMESTAMP,
                                         updated_at = CURRENT_TIMESTAMP
                                     where id = ?1
                                       and status = 'running'
                                       and locked_by = ?2
                                       and exists (
                                         select 1
                                         from llm_provider_leases lease
                                         where lease.id = ?3
                                           and lease.status = 'active'
                                           and lease.queue_name = ?4
                                           and lease.queue_job_id = ?1
                                           and lease.worker_id = ?2
                                       )"
                            ),
                            params![
                                assignment.queue_job_id,
                                assignment.worker_id,
                                assignment.id,
                                assignment.queue_name
                            ],
                        )
                        .map_err(|error| {
                            format!("failed to heartbeat provider queue job: {error}")
                        })?;
                    let lease_changed = tx
                        .execute(
                            "update llm_provider_leases
                                 set heartbeat_at = CURRENT_TIMESTAMP,
                                     expires_at = datetime(CURRENT_TIMESTAMP, '+120 seconds'),
                                     updated_at = CURRENT_TIMESTAMP
                                 where id = ?1
                                   and status = 'active'
                                   and queue_name = ?2
                                   and queue_job_id = ?3
                                   and worker_id = ?4",
                            params![
                                assignment.id,
                                assignment.queue_name,
                                assignment.queue_job_id,
                                assignment.worker_id
                            ],
                        )
                        .map_err(|error| format!("failed to heartbeat provider lease: {error}"))?;
                    if queue_changed != 1 || lease_changed != 1 {
                        return Err(
                            "provider execution ownership changed before heartbeat".to_string()
                        );
                    }
                    tx.commit().map_err(|error| {
                        format!("failed to commit provider execution heartbeat: {error}")
                    })?;
                    Ok(true)
                });
                if owned != Ok(true) {
                    return;
                }
            })
            .map_err(|error| {
                CliError::io(format!(
                    "failed to start provider execution heartbeat: {error}"
                ))
            })?;
        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for ProviderExecutionHeartbeatGuard {
    fn drop(&mut self) {
        let (stop_lock, stop_changed) = &*self.stop;
        if let Ok(mut stopped) = stop_lock.lock() {
            *stopped = true;
            stop_changed.notify_all();
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::{
        create_provider_claim_queue_table, create_provider_lease_table, temp_app_dir,
    };
    use crate::domains::queue_lifecycle::types::ProviderLeaseAssignment;
    use crate::domains::sqlite_writer::{
        clear_global_writer, install_global_writer, SqliteWriterRuntime,
    };

    #[test]
    fn query_only_connection_rejects_mutation() {
        let path = std::env::temp_dir().join(format!(
            "context-still-query-only-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "create table sample (id text primary key); insert into sample values ('a');",
            )
            .unwrap();
        drop(writer);

        let reader = open_query_only_connection(&path).unwrap();
        assert_eq!(
            reader
                .query_row("select count(*) from sample", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(reader
            .execute("insert into sample values ('b')", [])
            .is_err());
        drop(reader);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn provider_heartbeat_uses_writer_and_stops_without_waiting_for_interval() {
        let app_dir = temp_app_dir("provider_execution_heartbeat");
        let path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&path).unwrap();
        create_provider_claim_queue_table(&connection, "finding_candidate_queue");
        create_provider_lease_table(&connection);
        connection
            .execute_batch(
                r#"
                insert into finding_candidate_queue (
                  id, status, priority, created_at, updated_at,
                  locked_by, locked_at, heartbeat_at
                ) values (
                  'job-heartbeat', 'running', 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                  'worker-heartbeat', CURRENT_TIMESTAMP, '2000-01-01 00:00:00'
                );
                insert into llm_provider_leases (
                  id, pool_id, target_id, queue_name, queue_job_id, worker_id,
                  status, heartbeat_at, expires_at
                ) values (
                  'lease-heartbeat', 'pool-1', 'target-1', 'findingCandidate',
                  'job-heartbeat', 'worker-heartbeat', 'active',
                  '2000-01-01 00:00:00', '2000-01-01 00:02:00'
                );
                "#,
            )
            .unwrap();
        drop(connection);
        let runtime = SqliteWriterRuntime::start_existing_for_test(&path, 16).unwrap();
        install_global_writer(runtime.handle()).unwrap();
        let assignment = ProviderLeaseAssignment {
            id: "lease-heartbeat".to_string(),
            pool_id: "pool-1".to_string(),
            target_id: "target-1".to_string(),
            queue_name: "findingCandidate".to_string(),
            queue_job_id: "job-heartbeat".to_string(),
            worker_id: "worker-heartbeat".to_string(),
        };

        let guard = ProviderExecutionHeartbeatGuard::start_with_interval(
            &path,
            &assignment,
            Duration::from_millis(10),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(40));
        drop(guard);
        let reader = open_query_only_connection(&path).unwrap();
        let heartbeats = reader
            .query_row(
                "select heartbeat_at, (select heartbeat_at from llm_provider_leases where id = 'lease-heartbeat') from finding_candidate_queue where id = 'job-heartbeat'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_ne!(heartbeats.0, "2000-01-01 00:00:00");
        assert_ne!(heartbeats.1, "2000-01-01 00:00:00");
        drop(reader);

        let guard = ProviderExecutionHeartbeatGuard::start_with_interval(
            &path,
            &assignment,
            Duration::from_secs(60),
        )
        .unwrap();
        let started = std::time::Instant::now();
        drop(guard);
        assert!(started.elapsed() < Duration::from_secs(1));

        clear_global_writer(&path);
        runtime.shutdown().unwrap();
        std::fs::remove_dir_all(app_dir).unwrap();
    }
}
