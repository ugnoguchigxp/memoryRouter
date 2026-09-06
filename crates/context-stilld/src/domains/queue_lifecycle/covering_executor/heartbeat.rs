use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use rusqlite::params;

use crate::shared::errors::CliError;

use super::types::NegativeCoveringExecution;

pub(crate) struct NegativeCoveringHeartbeatGuard {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) handle: Option<JoinHandle<()>>,
}

impl NegativeCoveringHeartbeatGuard {
    pub(crate) fn start(
        sqlite_path: &Path,
        execution: &NegativeCoveringExecution,
    ) -> Result<Self, CliError> {
        let stop = Arc::new(AtomicBool::new(false));
        let Ok(writer) = crate::domains::sqlite_writer::global_writer_for_path(sqlite_path) else {
            // One-shot test execution uses a short-lived writer per operation. There is no
            // concurrent resident maintenance loop in that mode, so a heartbeat is unnecessary.
            return Ok(Self { stop, handle: None });
        };
        let thread_stop = Arc::clone(&stop);
        let job_id = execution.job_id.clone();
        let lease_id = execution.provider_lease.id.clone();
        let worker_id = execution.provider_lease.worker_id.clone();
        let handle = thread::Builder::new()
            .name("context-still-covering-heartbeat".to_string())
            .spawn(move || {
                while !thread_stop.load(Ordering::SeqCst) {
                    for _ in 0..80 {
                        if thread_stop.load(Ordering::SeqCst) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(250));
                    }
                    if thread_stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let queue_job_id = job_id.clone();
                    let provider_lease_id = lease_id.clone();
                    let provider_worker_id = worker_id.clone();
                    let owned = writer.execute("queue.covering_heartbeat", move |connection| {
                        let tx = connection.transaction().map_err(|error| {
                            format!("failed to begin covering heartbeat: {error}")
                        })?;
                        let queue_changed = tx
                            .execute(
                                "update covering_evidence_queue
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
                                       and lease.queue_name = 'coveringEvidence'
                                       and lease.queue_job_id = ?1
                                       and lease.worker_id = ?2
                                   )",
                                params![queue_job_id, provider_worker_id, provider_lease_id],
                            )
                            .map_err(|error| {
                                format!("failed to heartbeat covering job: {error}")
                            })?;
                        let lease_changed = tx
                            .execute(
                                "update llm_provider_leases
                                 set heartbeat_at = CURRENT_TIMESTAMP,
                                     expires_at = datetime(CURRENT_TIMESTAMP, '+120 seconds'),
                                     updated_at = CURRENT_TIMESTAMP
                                 where id = ?1
                                   and status = 'active'
                                   and queue_name = 'coveringEvidence'
                                   and queue_job_id = ?2
                                   and worker_id = ?3",
                                params![provider_lease_id, queue_job_id, provider_worker_id],
                            )
                            .map_err(|error| {
                                format!("failed to heartbeat covering lease: {error}")
                            })?;
                        tx.commit().map_err(|error| {
                            format!("failed to commit covering heartbeat: {error}")
                        })?;
                        Ok(queue_changed == 1 && lease_changed == 1)
                    });
                    if owned != Ok(true) {
                        return;
                    }
                }
            })
            .map_err(|error| {
                CliError::io(format!("failed to start covering heartbeat: {error}"))
            })?;
        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for NegativeCoveringHeartbeatGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
