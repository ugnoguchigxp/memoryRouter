use rusqlite::{params, Connection, OptionalExtension};

use crate::shared::errors::CliError;

use super::common::queue_table_name;
use super::types::QueueStateRow;

pub fn pause_queue_job_for_connection(
    connection: &Connection,
    queue_name: &str,
    id: &str,
    reason: &str,
) -> Result<Option<QueueStateRow>, CliError> {
    let table_name = queue_table_name(queue_name)?;
    update_queue_state(
        connection,
        &format!(
            "
            update {table_name}
            set
              status = 'paused',
              last_error = ?1,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              updated_at = CURRENT_TIMESTAMP
            where id = ?2
              and status in ('pending', 'running')
            returning id, status
            "
        ),
        params![reason, id],
    )
}

pub fn heartbeat_queue_job_for_connection(
    connection: &Connection,
    queue_name: &str,
    id: &str,
) -> Result<u64, CliError> {
    let table_name = queue_table_name(queue_name)?;
    let changed = connection
        .execute(
            &format!(
                "
                update {table_name}
                set heartbeat_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                where id = ?1
                  and status = 'running'
                "
            ),
            params![id],
        )
        .map_err(|error| CliError::io(format!("failed to heartbeat queue job: {error}")))?;
    Ok(changed as u64)
}

pub fn keep_queue_job_waiting_for_worker_for_connection(
    connection: &Connection,
    queue_name: &str,
    id: &str,
    reason: &str,
) -> Result<Option<QueueStateRow>, CliError> {
    let table_name = queue_table_name(queue_name)?;
    update_queue_state(
        connection,
        &format!(
            "
            update {table_name}
            set
              status = 'pending',
              next_run_at = datetime('now', '+30 seconds'),
              last_error = ?1,
              last_outcome_kind = 'worker_unavailable',
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              updated_at = CURRENT_TIMESTAMP
            where id = ?2
              and status = 'running'
            returning id, status
            "
        ),
        params![reason, id],
    )
}

pub fn resume_queue_job_for_connection(
    connection: &Connection,
    queue_name: &str,
    id: &str,
) -> Result<Option<QueueStateRow>, CliError> {
    let table_name = queue_table_name(queue_name)?;
    update_queue_state(
        connection,
        &format!(
            "
            update {table_name}
            set
              status = 'pending',
              next_run_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              completed_at = null,
              updated_at = CURRENT_TIMESTAMP
            where id = ?1
              and status in ('paused', 'failed', 'skipped', 'completed')
            returning id, status
            "
        ),
        params![id],
    )
}

pub fn retry_queue_job_for_connection(
    connection: &Connection,
    queue_name: &str,
    id: &str,
    mode: &str,
    force_refresh_evidence: bool,
    reason: Option<&str>,
) -> Result<Option<QueueStateRow>, CliError> {
    let table_name = queue_table_name(queue_name)?;
    if queue_name == "coveringEvidence" {
        return update_queue_state(
            connection,
            &format!(
                "
                update {table_name}
                set
                  status = 'pending',
                  attempt_count = 0,
                  next_run_at = null,
                  completed_at = null,
                  locked_by = null,
                  locked_at = null,
                  heartbeat_at = null,
                  last_error = ?1,
                  provider_policy = case
                    when ?2 = 'cloud_api' then 'cloud_api'
                    else coalesce(provider_policy, 'default')
                  end,
                  payload = json_set(
                    coalesce(nullif(payload, ''), '{{}}'),
                    '$.forceRefreshEvidence', json(?3),
                    '$.retryMode', ?4,
                    '$.retryReason', ?5,
                    '$.retryRequestedAt', CURRENT_TIMESTAMP
                  ),
                  updated_at = CURRENT_TIMESTAMP
                where id = ?6
                  and status <> 'running'
                returning id, status
                "
            ),
            params![
                reason,
                mode,
                if force_refresh_evidence {
                    "true"
                } else {
                    "false"
                },
                mode,
                reason,
                id
            ],
        );
    }

    update_queue_state(
        connection,
        &format!(
            "
            update {table_name}
            set
              status = 'pending',
              attempt_count = 0,
              next_run_at = null,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              last_error = ?1,
              updated_at = CURRENT_TIMESTAMP
            where id = ?2
              and status <> 'running'
            returning id, status
            "
        ),
        params![reason, id],
    )
}

pub fn pause_running_queue_jobs_for_connection(
    connection: &Connection,
    queue_name: &str,
    reason: &str,
) -> Result<u64, CliError> {
    let table_name = queue_table_name(queue_name)?;
    let changed = connection
        .execute(
            &format!(
                "
                update {table_name}
                set
                  status = 'paused',
                  last_error = ?1,
                  next_run_at = CURRENT_TIMESTAMP,
                  locked_by = null,
                  locked_at = null,
                  heartbeat_at = null,
                  updated_at = CURRENT_TIMESTAMP
                where status = 'running'
                "
            ),
            params![reason],
        )
        .map_err(|error| CliError::io(format!("failed to pause running queue jobs: {error}")))?;
    Ok(changed as u64)
}

fn update_queue_state<P>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Option<QueueStateRow>, CliError>
where
    P: rusqlite::Params,
{
    connection
        .query_row(sql, params, |row| {
            Ok(QueueStateRow {
                id: row.get(0)?,
                status: row.get(1)?,
            })
        })
        .optional()
        .map_err(|error| CliError::io(format!("failed to update queue state: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use rusqlite::Connection;

    #[test]
    fn rust_queue_state_pauses_and_resumes_job() {
        let app_dir = temp_app_dir("state_pause_resume");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
            .execute_batch(
                r#"
            insert into finding_candidate_queue (
              id, status, priority, attempt_count, created_at, updated_at, completed_at,
              next_run_at, locked_by, locked_at, heartbeat_at
            ) values (
              'job-1', 'running', 1, 2, '2026-06-22 01:00:00', CURRENT_TIMESTAMP,
              '2026-06-22 01:05:00', null, 'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
            )
            .unwrap();

        let paused = pause_queue_job_for_connection(
            &connection,
            "findingCandidate",
            "job-1",
            "manual pause",
        )
        .unwrap()
        .unwrap();
        assert_eq!(paused.status, "paused");
        let paused_row = connection
            .query_row(
                "select last_error, locked_by from finding_candidate_queue where id = 'job-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap();
        assert_eq!(paused_row, ("manual pause".to_string(), None));

        let resumed = resume_queue_job_for_connection(&connection, "findingCandidate", "job-1")
            .unwrap()
            .unwrap();
        assert_eq!(resumed.status, "pending");
        let resumed_row = connection
            .query_row(
                "select completed_at, next_run_at from finding_candidate_queue where id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(resumed_row, (None, None));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_queue_state_keeps_job_waiting_for_worker() {
        let app_dir = temp_app_dir("state_waiting");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
            .execute_batch(
                r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at,
              locked_by, locked_at, heartbeat_at
            ) values (
              'job-1', 'running', 1, '2026-06-22 01:00:00', CURRENT_TIMESTAMP,
              null, 'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
            )
            .unwrap();

        let waiting = keep_queue_job_waiting_for_worker_for_connection(
            &connection,
            "findingCandidate",
            "job-1",
            "worker unavailable",
        )
        .unwrap()
        .unwrap();

        assert_eq!(waiting.status, "pending");
        let row = connection
        .query_row(
            "select last_error, last_outcome_kind, next_run_at, locked_by from finding_candidate_queue where id = 'job-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .unwrap();
        assert_eq!(row.0, "worker unavailable");
        assert_eq!(row.1, "worker_unavailable");
        assert!(row.2.is_some());
        assert_eq!(row.3, None);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_queue_state_retries_covering_evidence_with_metadata() {
        let app_dir = temp_app_dir("state_retry_covering");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "covering_evidence_queue");
        connection
            .execute_batch(
                r#"
            insert into covering_evidence_queue (
              id, status, priority, attempt_count, created_at, updated_at,
              next_run_at, completed_at, provider_policy, payload
            ) values (
              'job-1', 'failed', 1, 3, '2026-06-22 01:00:00', CURRENT_TIMESTAMP,
              '2026-06-22 02:00:00', '2026-06-22 02:05:00', null, '{}'
            );
            "#,
            )
            .unwrap();

        let retried = retry_queue_job_for_connection(
            &connection,
            "coveringEvidence",
            "job-1",
            "cloud_api",
            true,
            Some("manual retry"),
        )
        .unwrap()
        .unwrap();

        assert_eq!(retried.status, "pending");
        let row = connection
        .query_row(
            "select attempt_count, provider_policy, json_extract(payload, '$.forceRefreshEvidence'), json_extract(payload, '$.retryMode'), json_extract(payload, '$.retryReason') from covering_evidence_queue where id = 'job-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
        assert_eq!(
            row,
            (
                0,
                "cloud_api".to_string(),
                1,
                "cloud_api".to_string(),
                "manual retry".to_string()
            )
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_queue_state_pauses_running_finalize_with_immediate_next_run_at() {
        let app_dir = temp_app_dir("state_pause_running_finalize");
        let sqlite_path = app_dir.join("queue.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finalize_distille_queue");
        connection
            .execute_batch(
                r#"
            insert into finalize_distille_queue (
              id, status, priority, created_at, updated_at, next_run_at,
              locked_by, locked_at, heartbeat_at
            ) values (
              'job-1', 'running', 1, '2026-06-22 01:00:00', CURRENT_TIMESTAMP,
              null, 'worker-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            "#,
            )
            .unwrap();

        let changed = pause_running_queue_jobs_for_connection(
            &connection,
            "finalizeDistille",
            "global pause",
        )
        .unwrap();

        assert_eq!(changed, 1);
        let row = connection
        .query_row(
            "select status, last_error, next_run_at from finalize_distille_queue where id = 'job-1'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .unwrap();
        assert_eq!(row.0, "paused");
        assert_eq!(row.1, "global pause");
        assert!(row.2.is_some());

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
