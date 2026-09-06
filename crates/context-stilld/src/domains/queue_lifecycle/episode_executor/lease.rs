use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
#[cfg(test)]
use std::thread;
use std::thread::JoinHandle;
#[cfg(test)]
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::shared::errors::CliError;

use super::super::events::append_queue_event_for_connection;
use super::super::types::ProviderLeaseAssignment;

pub(super) fn append_episode_superseded_event(
    connection: &Connection,
    job_id: &str,
    provider_lease: &ProviderLeaseAssignment,
) -> Result<(), String> {
    let event_id = stable_episode_event_id(job_id, &provider_lease.id, "superseded");
    let exists = connection
        .query_row(
            "select exists(select 1 from distillation_queue_events where id = ?1)",
            [&event_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("failed to inspect superseded episode event: {error}"))?
        != 0;
    if !exists {
        append_queue_event_for_connection(
            connection,
            &event_id,
            "episodeDistiller",
            job_id,
            "discarded",
            Some("stale episode result discarded after claim ownership changed"),
            Some(
                &json!({
                    "executor": "rust",
                    "reason": "claim_ownership_changed",
                    "workerId": provider_lease.worker_id,
                    "providerLeaseId": provider_lease.id
                })
                .to_string(),
            ),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn release_split_episode_lease(
    connection: &Connection,
    provider_lease: &ProviderLeaseAssignment,
    reason: &str,
) -> Result<usize, String> {
    connection
        .execute(
            "update llm_provider_leases
             set status = 'released',
                 released_at = CURRENT_TIMESTAMP,
                 release_reason = ?2,
                 updated_at = CURRENT_TIMESTAMP
             where id = ?1
               and status = 'active'
               and queue_name = 'episodeDistiller'
               and queue_job_id = ?3
               and worker_id = ?4",
            params![
                provider_lease.id,
                reason,
                provider_lease.queue_job_id,
                provider_lease.worker_id
            ],
        )
        .map_err(|error| format!("failed to release split episode lease: {error}"))
}

pub(super) fn stable_episode_event_id(job_id: &str, lease_id: &str, event_type: &str) -> String {
    let digest = Sha256::digest(format!("episode-event:{job_id}:{lease_id}:{event_type}"));
    format!("episode-event-{digest:x}")[..56].to_string()
}

pub(super) fn episode_provider_backoff_seconds(attempt_count: i64) -> i64 {
    match attempt_count.max(0) {
        0 => 60,
        1 => 120,
        2 => 300,
        3 => 600,
        4 => 1_200,
        _ => 3_600,
    }
}

pub(super) struct HeartbeatGuard {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) handle: Option<JoinHandle<()>>,
}

impl HeartbeatGuard {
    pub(super) fn start(
        connection: &Connection,
        job_id: &str,
        worker_id: &str,
    ) -> Result<Self, CliError> {
        #[cfg(not(test))]
        let _ = (job_id, worker_id);
        let Some(db_path) = main_database_path(connection)? else {
            return Ok(Self {
                stop: Arc::new(AtomicBool::new(true)),
                handle: None,
            });
        };
        // The resident executor itself runs on the single SQLite writer thread. Starting a
        // second heartbeat connection here would violate that ownership, while enqueueing a
        // heartbeat back to the same blocked writer would deadlock on guard drop. The executor
        // result transaction refreshes/releases the lease when the provider call returns.
        if crate::domains::sqlite_writer::global_writer_for_path(std::path::Path::new(&db_path))
            .is_ok()
        {
            return Ok(Self {
                stop: Arc::new(AtomicBool::new(true)),
                handle: None,
            });
        }
        #[cfg(not(test))]
        return Ok(Self {
            stop: Arc::new(AtomicBool::new(true)),
            handle: None,
        });
        #[cfg(test)]
        {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let job_id = job_id.to_string();
            let worker_id = worker_id.to_string();
            let handle = thread::spawn(move || {
                while !thread_stop.load(Ordering::SeqCst) {
                    for _ in 0..20 {
                        if thread_stop.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_secs(1));
                    }
                    if thread_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    // sqlite-writer-guard: test-only-direct-open
                    if let Ok(connection) = Connection::open(&db_path) {
                        let _ = connection.execute(
                            "
                        update episode_distiller_queue
                        set heartbeat_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        where id = ?1
                          and status = 'running'
                        ",
                            [&job_id],
                        );
                        let _ = connection.execute(
                            "
                        update llm_provider_leases
                        set heartbeat_at = CURRENT_TIMESTAMP,
                            expires_at = datetime(CURRENT_TIMESTAMP, '+120 seconds'),
                            updated_at = CURRENT_TIMESTAMP
                        where queue_name = 'episodeDistiller'
                          and queue_job_id = ?1
                          and worker_id = ?2
                          and status = 'active'
                        ",
                            (&job_id, &worker_id),
                        );
                    }
                }
            });
            Ok(Self {
                stop,
                handle: Some(handle),
            })
        }
    }
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub(super) fn main_database_path(connection: &Connection) -> Result<Option<String>, CliError> {
    let mut statement = connection
        .prepare("pragma database_list")
        .map_err(|error| {
            CliError::io(format!("failed to inspect SQLite database path: {error}"))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        })
        .map_err(|error| CliError::io(format!("failed to query SQLite database path: {error}")))?;
    for row in rows {
        let (name, path) =
            row.map_err(|error| CliError::io(format!("failed to read SQLite path: {error}")))?;
        if name == "main" {
            return Ok(path.filter(|value| !value.trim().is_empty()));
        }
    }
    Ok(None)
}
