use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::domains::vector_index;

pub const CURRENT_SCHEMA_VERSION: i64 = 1;

const TYPESCRIPT_SCHEMA_SOURCE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../src/db/sqlite/core-schema.ts"
));

pub fn configure_writer_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            "#,
        )
        .map_err(|error| format!("failed to configure SQLite writer connection: {error}"))
}

pub fn migrate(connection: &mut Connection, vector_dimension: usize) -> Result<i64, String> {
    vector_index::service::register_sqlite_vec();
    let existing_version = schema_version(connection)?;
    if existing_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "SQLite schema version {existing_version} is newer than supported version {CURRENT_SCHEMA_VERSION}"
        ));
    }
    let dimension = vector_dimension.max(1);
    let schema_sql = rendered_core_schema(dimension)?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to start SQLite schema migration: {error}"))?;
    transaction
        .execute_batch(&schema_sql)
        .map_err(|error| format!("failed to apply SQLite core schema: {error}"))?;
    apply_legacy_migrations(&transaction)?;
    transaction
        .execute_batch(&format!(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) STRICT;
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES ({CURRENT_SCHEMA_VERSION}, 'rust_single_writer_baseline');
            PRAGMA user_version = {CURRENT_SCHEMA_VERSION};
            "#
        ))
        .map_err(|error| format!("failed to record SQLite schema migration: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit SQLite schema migration: {error}"))?;

    create_vec_tables(connection, dimension)?;
    Ok(CURRENT_SCHEMA_VERSION)
}

pub fn schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("failed to read SQLite schema version: {error}"))
}

pub fn read_schema_version(path: &Path) -> Result<i64, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("failed to open SQLite schema read-only: {error}"))?;
    schema_version(&connection)
}

fn rendered_core_schema(vector_dimension: usize) -> Result<String, String> {
    let start_marker = "  return `\n";
    let end_marker = "\n`;\n}";
    let start = TYPESCRIPT_SCHEMA_SOURCE
        .find(start_marker)
        .map(|index| index + start_marker.len())
        .ok_or_else(|| "failed to locate SQLite schema template start".to_string())?;
    let end = TYPESCRIPT_SCHEMA_SOURCE[start..]
        .find(end_marker)
        .map(|index| start + index)
        .ok_or_else(|| "failed to locate SQLite schema template end".to_string())?;
    Ok(TYPESCRIPT_SCHEMA_SOURCE[start..end].replace("${dimension}", &vector_dimension.to_string()))
}

fn apply_legacy_migrations(connection: &Connection) -> Result<(), String> {
    if table_exists(connection, "episode_cards")? {
        connection
            .execute(
                "UPDATE episode_cards SET status = 'active' WHERE status = 'draft'",
                [],
            )
            .map_err(|error| format!("failed to normalize episode card status: {error}"))?;
        add_column_if_missing(
            connection,
            "episode_cards",
            "importance",
            "ALTER TABLE episode_cards ADD COLUMN importance INTEGER NOT NULL DEFAULT 50",
        )?;
        add_column_if_missing(
            connection,
            "episode_cards",
            "compile_use_count",
            "ALTER TABLE episode_cards ADD COLUMN compile_use_count INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            connection,
            "episode_cards",
            "decision_use_count",
            "ALTER TABLE episode_cards ADD COLUMN decision_use_count INTEGER NOT NULL DEFAULT 0",
        )?;
        if column_exists(connection, "episode_cards", "evidence_status")? {
            connection
                .execute_batch(
                    r#"
                    DROP INDEX IF EXISTS episode_cards_evidence_status_idx;
                    ALTER TABLE episode_cards DROP COLUMN evidence_status;
                    "#,
                )
                .map_err(|error| {
                    format!("failed to remove legacy episode evidence_status: {error}")
                })?;
        }
    }

    if table_exists(connection, "finding_candidate_escalations")? {
        add_column_if_missing(
            connection,
            "finding_candidate_escalations",
            "distillation_version",
            "ALTER TABLE finding_candidate_escalations ADD COLUMN distillation_version TEXT NOT NULL DEFAULT 'v1'",
        )?;
        connection
            .execute_batch(
                r#"
                DROP INDEX IF EXISTS finding_candidate_escalations_source_provider_model_unique_idx;
                CREATE UNIQUE INDEX IF NOT EXISTS finding_candidate_escalations_source_provider_model_unique_idx
                  ON finding_candidate_escalations(
                    source_kind,
                    source_key,
                    distillation_version,
                    escalation_provider,
                    escalation_model
                  );
                "#,
            )
            .map_err(|error| format!("failed to migrate escalation uniqueness index: {error}"))?;
    }
    Ok(())
}

fn create_vec_tables(connection: &Connection, dimension: usize) -> Result<(), String> {
    connection
        .execute_batch(&format!(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_vec USING vec0(
              embedding float[{dimension}]
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS source_fragments_vec USING vec0(
              embedding float[{dimension}]
            );
            "#
        ))
        .map_err(|error| format!("failed to create sqlite-vec tables: {error}"))
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    sql: &str,
) -> Result<(), String> {
    if !column_exists(connection, table, column)? {
        connection
            .execute(sql, [])
            .map_err(|error| format!("failed to add {table}.{column}: {error}"))?;
    }
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?1 LIMIT 1",
            [table],
            |_| Ok(true),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(|error| format!("failed to inspect SQLite table {table}: {error}"))
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("failed to inspect SQLite table {table}: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("failed to inspect SQLite table {table}: {error}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("failed to inspect SQLite table {table}: {error}"))?
    {
        let name: String = row
            .get(1)
            .map_err(|error| format!("failed to read SQLite column metadata: {error}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_schema_bootstraps_current_core_database() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();

        let version = migrate(&mut connection, 8).unwrap();

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(&connection, "knowledge_items").unwrap());
        assert!(table_exists(&connection, "context_compile_runs").unwrap());
        assert!(table_exists(&connection, "episode_cards").unwrap());
        assert!(table_exists(&connection, "knowledge_items_vec").unwrap());
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migration_is_idempotent() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();
        migrate(&mut connection, 8).unwrap();
        migrate(&mut connection, 8).unwrap();

        let count: i64 = connection
            .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migration_rejects_newer_schema_version() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA user_version = 99")
            .unwrap();
        let error = migrate(&mut connection, 8).unwrap_err();
        assert!(error.contains("newer than supported"));
        assert_eq!(schema_version(&connection).unwrap(), 99);
    }
}
