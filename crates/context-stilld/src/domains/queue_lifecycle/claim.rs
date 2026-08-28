use rusqlite::{Connection, OptionalExtension};

use crate::shared::errors::CliError;

use super::common::queue_table_name;
use super::types::ClaimedQueueJob;

pub fn claim_next_queue_job_for_connection(
    connection: &mut Connection,
    queue_name: &str,
    worker_id: &str,
    stale_seconds: u64,
) -> Result<Option<ClaimedQueueJob>, CliError> {
    let table_name = queue_table_name(queue_name)?;
    let stale_seconds = stale_seconds.clamp(30, 120);
    let tx = connection.transaction().map_err(|error| {
        CliError::io(format!("failed to begin queue claim transaction: {error}"))
    })?;

    let stale_sql = stale_recovery_sql(queue_name, table_name);
    tx.execute(&stale_sql, [stale_seconds as i64])
        .map_err(|error| CliError::io(format!("failed to recover stale queue jobs: {error}")))?;

    let running = tx
        .query_row(
            &format!("select id from {table_name} where status = 'running' limit 1"),
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to inspect running queue jobs: {error}")))?;
    if running.is_some() {
        tx.commit()
            .map_err(|error| CliError::io(format!("failed to commit queue claim: {error}")))?;
        return Ok(None);
    }

    let picked = tx
        .query_row(&pick_next_sql(queue_name, table_name), [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| CliError::io(format!("failed to pick next queue job: {error}")))?;
    let Some(id) = picked else {
        tx.commit()
            .map_err(|error| CliError::io(format!("failed to commit queue claim: {error}")))?;
        return Ok(None);
    };

    let changed = tx
        .execute(
            &format!(
                "
                update {table_name}
                set
                  status = 'running',
                  locked_by = ?1,
                  locked_at = CURRENT_TIMESTAMP,
                  heartbeat_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
                where id = ?2
                  and (
                    (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
                    or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
                  )
                "
            ),
            (&worker_id, &id),
        )
        .map_err(|error| CliError::io(format!("failed to mark queue job running: {error}")))?;
    tx.commit()
        .map_err(|error| CliError::io(format!("failed to commit queue claim: {error}")))?;

    if changed == 0 {
        return Ok(None);
    }

    Ok(Some(ClaimedQueueJob {
        queue_name: queue_name.to_string(),
        table_name,
        id,
        worker_id: worker_id.to_string(),
    }))
}

pub(crate) fn stale_recovery_sql(queue_name: &str, table_name: &str) -> String {
    let _ = queue_name;
    format!(
        "
        update {table_name}
        set
          status = 'paused',
          next_run_at = CURRENT_TIMESTAMP,
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          last_error = coalesce(last_error, 'stale_running_recovered'),
          last_outcome_kind = 'stale_recovered',
          updated_at = CURRENT_TIMESTAMP
        where status = 'running'
          and coalesce(heartbeat_at, locked_at, updated_at) < datetime(CURRENT_TIMESTAMP, '-' || ?1 || ' seconds')
        "
    )
}

fn pick_next_sql(queue_name: &str, table_name: &str) -> String {
    let _ = queue_name;
    format!(
        "
        select id
        from {table_name}
        where (
          (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
          or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
        )
        order by priority desc, created_at asc, id asc
        limit 1
        "
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::queue_lifecycle::test_support::*;
    use rusqlite::Connection;

    #[test]
    fn rust_claim_picks_highest_priority_ready_job() {
        let app_dir = temp_app_dir("claim_priority");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (id, status, priority, created_at, updated_at, next_run_at)
              values ('job-low', 'pending', 1, '2026-06-22 01:00:00', '2026-06-22 01:00:00', null);
            insert into finding_candidate_queue (id, status, priority, created_at, updated_at, next_run_at)
              values ('job-high', 'pending', 10, '2026-06-22 02:00:00', '2026-06-22 02:00:00', null);
            insert into finding_candidate_queue (id, status, priority, created_at, updated_at, next_run_at)
              values ('job-future', 'pending', 20, '2026-06-22 00:00:00', '2026-06-22 00:00:00', datetime(CURRENT_TIMESTAMP, '+1 day'));
            "#,
        )
        .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "findingCandidate",
            "worker-1",
            90,
        )
        .unwrap()
        .unwrap();

        assert_eq!(claimed.id, "job-high");
        assert_eq!(claimed.table_name, "finding_candidate_queue");
        let row = connection
            .query_row(
                "select status, locked_by from finding_candidate_queue where id = 'job-high'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("running".to_string(), "worker-1".to_string()));

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_claim_accepts_iso8601_next_run_at() {
        let app_dir = temp_app_dir("claim_iso8601_next_run_at");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
            .execute_batch(
                r#"
                insert into finding_candidate_queue (
                  id, status, priority, created_at, updated_at, next_run_at
                ) values (
                  'job-iso-ready', 'pending', 10, '2026-06-22 01:00:00', '2026-06-22 01:00:00',
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute')
                );
                "#,
            )
            .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "findingCandidate",
            "worker-iso",
            90,
        )
        .unwrap()
        .unwrap();

        assert_eq!(claimed.id, "job-iso-ready");

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_claim_does_not_run_an_indefinitely_paused_job() {
        let app_dir = temp_app_dir("claim_indefinite_pause");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
            .execute_batch(
                r#"
                insert into finding_candidate_queue (
                  id, status, priority, created_at, updated_at, next_run_at
                ) values (
                  'job-paused', 'paused', 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, null
                );
                "#,
            )
            .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "findingCandidate",
            "worker-paused",
            90,
        )
        .unwrap();

        assert_eq!(claimed, None);
        let status: String = connection
            .query_row(
                "select status from finding_candidate_queue where id = 'job-paused'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "paused");
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_claim_blocks_when_non_stale_job_is_running() {
        let app_dir = temp_app_dir("claim_running");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, locked_by, locked_at, heartbeat_at
            ) values (
              'job-running', 'running', 10, '2026-06-22 01:00:00', CURRENT_TIMESTAMP, null,
              'worker-old', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
            insert into finding_candidate_queue (id, status, priority, created_at, updated_at, next_run_at)
              values ('job-pending', 'pending', 20, '2026-06-22 02:00:00', '2026-06-22 02:00:00', null);
            "#,
        )
        .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "findingCandidate",
            "worker-1",
            90,
        )
        .unwrap();

        assert_eq!(claimed, None);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_claim_recovers_stale_running_job_before_picking() {
        let app_dir = temp_app_dir("claim_stale");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finding_candidate_queue");
        connection
        .execute_batch(
            r#"
            insert into finding_candidate_queue (
              id, status, priority, created_at, updated_at, next_run_at, locked_by, locked_at, heartbeat_at
            ) values (
              'job-stale', 'running', 10, '2026-06-22 01:00:00', '2000-01-01 00:00:00', null,
              'worker-old', '2000-01-01 00:00:00', '2000-01-01 00:00:00'
            );
            "#,
        )
        .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "findingCandidate",
            "worker-1",
            90,
        )
        .unwrap()
        .unwrap();

        assert_eq!(claimed.id, "job-stale");
        let row = connection
        .query_row(
            "select status, locked_by, last_outcome_kind from finding_candidate_queue where id = 'job-stale'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
        assert_eq!(
            row,
            (
                "running".to_string(),
                "worker-1".to_string(),
                "stale_recovered".to_string()
            )
        );

        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    #[test]
    fn rust_claim_finalize_distille_respects_next_run_at() {
        let app_dir = temp_app_dir("claim_finalize");
        let sqlite_path = app_dir.join("queue.sqlite");
        let mut connection = Connection::open(&sqlite_path).unwrap();
        create_claim_queue_table(&connection, "finalize_distille_queue");
        connection
        .execute_batch(
            r#"
            insert into finalize_distille_queue (id, status, priority, created_at, updated_at, next_run_at)
              values ('job-finalize', 'pending', 1, '2026-06-22 01:00:00', '2026-06-22 01:00:00', datetime(CURRENT_TIMESTAMP, '+1 day'));
            "#,
        )
        .unwrap();

        let claimed = claim_next_queue_job_for_connection(
            &mut connection,
            "finalizeDistille",
            "worker-1",
            90,
        )
        .unwrap();

        assert_eq!(claimed, None);

        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
