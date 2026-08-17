use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::domains::vector_index;

// `user_version` represents the minimum binary compatibility level. Repository identity is an
// additive schema revision, so keeping this at v1 allows a v1 binary to open a database after a
// rollback. Additive revisions are tracked independently in `schema_migrations`.
pub const CURRENT_SCHEMA_VERSION: i64 = 1;
pub const CURRENT_SCHEMA_REVISION: i64 = 6;

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
    let existing_revision = schema_revision(connection)?;
    if existing_version > CURRENT_SCHEMA_REVISION {
        return Err(format!(
            "SQLite schema version {existing_version} is newer than supported revision {CURRENT_SCHEMA_REVISION}"
        ));
    }
    if existing_revision > CURRENT_SCHEMA_REVISION {
        return Err(format!(
            "SQLite schema revision {existing_revision} is newer than supported revision {CURRENT_SCHEMA_REVISION}"
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
            VALUES (1, 'rust_single_writer_baseline');
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES (2, 'repository_identity_contract_v1');
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES (3, 'security_intelligence_ingress_v1');
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES (4, 'repository_identity_backfill_audit_v1');
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES (5, 'security_candidate_item_provenance_v1');
            INSERT OR IGNORE INTO schema_migrations(version, name)
            VALUES ({CURRENT_SCHEMA_REVISION}, 'finalize_retry_schedule_v1');
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

pub fn schema_revision(connection: &Connection) -> Result<i64, String> {
    if !table_exists(connection, "schema_migrations")? {
        return Ok(0);
    }
    connection
        .query_row(
            "SELECT coalesce(max(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to read SQLite schema revision: {error}"))
}

pub fn read_schema_revision(path: &Path) -> Result<i64, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("failed to open SQLite schema read-only: {error}"))?;
    schema_revision(&connection)
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
    apply_repository_identity_contract(connection)?;

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
    if table_exists(connection, "security_candidate_batch_items")? {
        add_column_if_missing(
            connection,
            "security_candidate_batch_items",
            "provenance_json",
            "ALTER TABLE security_candidate_batch_items ADD COLUMN provenance_json TEXT",
        )?;
    }
    if table_exists(connection, "finalize_distille_queue")? {
        add_column_if_missing(
            connection,
            "finalize_distille_queue",
            "max_attempts",
            "ALTER TABLE finalize_distille_queue ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5",
        )?;
        add_column_if_missing(
            connection,
            "finalize_distille_queue",
            "next_run_at",
            "ALTER TABLE finalize_distille_queue ADD COLUMN next_run_at TEXT",
        )?;
    }
    Ok(())
}

fn apply_repository_identity_contract(connection: &Connection) -> Result<(), String> {
    if table_exists(connection, "knowledge_items")? {
        add_column_if_missing(
            connection,
            "knowledge_items",
            "classification_status",
            "ALTER TABLE knowledge_items ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unresolved'",
        )?;
        add_column_if_missing(
            connection,
            "knowledge_items",
            "project_ref",
            "ALTER TABLE knowledge_items ADD COLUMN project_ref TEXT",
        )?;
        add_column_if_missing(
            connection,
            "knowledge_items",
            "repo_key",
            "ALTER TABLE knowledge_items ADD COLUMN repo_key TEXT",
        )?;
        add_column_if_missing(
            connection,
            "knowledge_items",
            "repo_path",
            "ALTER TABLE knowledge_items ADD COLUMN repo_path TEXT",
        )?;
    }
    if table_exists(connection, "sources")? {
        add_column_if_missing(
            connection,
            "sources",
            "classification_status",
            "ALTER TABLE sources ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unresolved'",
        )?;
        add_column_if_missing(
            connection,
            "sources",
            "scope",
            "ALTER TABLE sources ADD COLUMN scope TEXT NOT NULL DEFAULT 'repo'",
        )?;
        add_column_if_missing(
            connection,
            "sources",
            "project_ref",
            "ALTER TABLE sources ADD COLUMN project_ref TEXT",
        )?;
        add_column_if_missing(
            connection,
            "sources",
            "repo_key",
            "ALTER TABLE sources ADD COLUMN repo_key TEXT",
        )?;
        add_column_if_missing(
            connection,
            "sources",
            "repo_path",
            "ALTER TABLE sources ADD COLUMN repo_path TEXT",
        )?;
    }
    if table_exists(connection, "episode_cards")? {
        add_column_if_missing(
            connection,
            "episode_cards",
            "classification_status",
            "ALTER TABLE episode_cards ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unresolved'",
        )?;
        add_column_if_missing(
            connection,
            "episode_cards",
            "scope",
            "ALTER TABLE episode_cards ADD COLUMN scope TEXT NOT NULL DEFAULT 'repo'",
        )?;
        add_column_if_missing(
            connection,
            "episode_cards",
            "project_ref",
            "ALTER TABLE episode_cards ADD COLUMN project_ref TEXT",
        )?;
    }
    if table_exists(connection, "context_compile_runs")? {
        add_column_if_missing(
            connection,
            "context_compile_runs",
            "project_ref",
            "ALTER TABLE context_compile_runs ADD COLUMN project_ref TEXT",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_runs",
            "repo_key",
            "ALTER TABLE context_compile_runs ADD COLUMN repo_key TEXT",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_runs",
            "match_basis",
            "ALTER TABLE context_compile_runs ADD COLUMN match_basis TEXT NOT NULL DEFAULT 'none'",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_runs",
            "identity_contract_version",
            "ALTER TABLE context_compile_runs ADD COLUMN identity_contract_version INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_runs",
            "scope_mode",
            "ALTER TABLE context_compile_runs ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'global_only'",
        )?;
    }
    if table_exists(connection, "context_compile_task_traces")? {
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "project_ref",
            "ALTER TABLE context_compile_task_traces ADD COLUMN project_ref TEXT",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "match_basis",
            "ALTER TABLE context_compile_task_traces ADD COLUMN match_basis TEXT NOT NULL DEFAULT 'none'",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "identity_contract_version",
            "ALTER TABLE context_compile_task_traces ADD COLUMN identity_contract_version INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "scope_mode",
            "ALTER TABLE context_compile_task_traces ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'global_only'",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "identity_fingerprint",
            "ALTER TABLE context_compile_task_traces ADD COLUMN identity_fingerprint TEXT",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "identity_trust",
            "ALTER TABLE context_compile_task_traces ADD COLUMN identity_trust TEXT NOT NULL DEFAULT 'request_hint'",
        )?;
        add_column_if_missing(
            connection,
            "context_compile_task_traces",
            "binding_status",
            "ALTER TABLE context_compile_task_traces ADD COLUMN binding_status TEXT NOT NULL DEFAULT 'not_applicable'",
        )?;
    }
    if table_exists(connection, "context_pack_items")? {
        add_column_if_missing(
            connection,
            "context_pack_items",
            "scope_snapshot",
            "ALTER TABLE context_pack_items ADD COLUMN scope_snapshot TEXT NOT NULL DEFAULT '{}'",
        )?;
    }

    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS project_identity_aliases (
              id TEXT PRIMARY KEY,
              project_ref TEXT NOT NULL,
              alias_kind TEXT NOT NULL,
              normalized_value TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active',
              source TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(project_ref, alias_kind, normalized_value)
            ) STRICT;
            CREATE UNIQUE INDEX IF NOT EXISTS project_identity_aliases_active_alias_unique
              ON project_identity_aliases(alias_kind, normalized_value)
              WHERE status = 'active';
            CREATE INDEX IF NOT EXISTS project_identity_aliases_project_status_idx
              ON project_identity_aliases(project_ref, status);

            CREATE INDEX IF NOT EXISTS knowledge_items_classification_status_idx
              ON knowledge_items(classification_status);
            CREATE INDEX IF NOT EXISTS knowledge_items_status_scope_project_ref_idx
              ON knowledge_items(status, scope, project_ref);
            CREATE INDEX IF NOT EXISTS knowledge_items_status_scope_repo_key_idx
              ON knowledge_items(status, scope, repo_key);
            CREATE INDEX IF NOT EXISTS knowledge_items_status_scope_repo_path_idx
              ON knowledge_items(status, scope, repo_path);
            CREATE INDEX IF NOT EXISTS sources_classification_status_idx
              ON sources(classification_status);
            CREATE INDEX IF NOT EXISTS sources_scope_project_ref_idx
              ON sources(scope, project_ref);
            CREATE INDEX IF NOT EXISTS sources_scope_repo_key_idx
              ON sources(scope, repo_key);
            CREATE INDEX IF NOT EXISTS sources_scope_repo_path_idx
              ON sources(scope, repo_path);
            CREATE INDEX IF NOT EXISTS episode_cards_classification_status_idx
              ON episode_cards(classification_status);
            CREATE INDEX IF NOT EXISTS episode_cards_scope_project_ref_idx
              ON episode_cards(scope, project_ref);
            CREATE INDEX IF NOT EXISTS context_compile_runs_project_ref_idx
              ON context_compile_runs(project_ref);
            CREATE INDEX IF NOT EXISTS context_compile_runs_repo_key_idx
              ON context_compile_runs(repo_key);
            CREATE INDEX IF NOT EXISTS context_compile_runs_repo_path_idx
              ON context_compile_runs(repo_path);
            CREATE INDEX IF NOT EXISTS context_compile_task_traces_project_ref_idx
              ON context_compile_task_traces(project_ref);
            "#,
        )
        .map_err(|error| format!("failed to create repository identity indexes: {error}"))?;
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
        assert!(table_exists(&connection, "project_identity_aliases").unwrap());
        assert!(table_exists(&connection, "knowledge_items_vec").unwrap());
        assert!(column_exists(&connection, "knowledge_items", "classification_status").unwrap());
        assert!(column_exists(&connection, "sources", "project_ref").unwrap());
        assert!(column_exists(&connection, "episode_cards", "scope").unwrap());
        assert!(column_exists(&connection, "context_compile_runs", "match_basis").unwrap());
        assert!(column_exists(
            &connection,
            "context_compile_task_traces",
            "identity_fingerprint"
        )
        .unwrap());
        for index_name in [
            "knowledge_items_status_scope_project_ref_idx",
            "sources_scope_project_ref_idx",
            "episode_cards_scope_project_ref_idx",
            "context_compile_runs_project_ref_idx",
            "context_compile_task_traces_project_ref_idx",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
                    [index_name],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1, "missing identity index {index_name}");
        }
        connection
            .execute(
                "INSERT INTO knowledge_items (id, type, status, title, body) VALUES ('legacy-write', 'rule', 'active', 'legacy', 'legacy')",
                [],
            )
            .unwrap();
        let classification: String = connection
            .query_row(
                "SELECT classification_status FROM knowledge_items WHERE id = 'legacy-write'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(classification, "unresolved");
        assert_eq!(schema_version(&connection).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn active_project_alias_cannot_bind_to_multiple_projects() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();
        migrate(&mut connection, 8).unwrap();

        connection
            .execute(
                "INSERT INTO project_identity_aliases (id, project_ref, alias_kind, normalized_value, status, source) VALUES ('alias-a', 'project-A', 'repo_path', '/work/repo', 'active', 'test')",
                [],
            )
            .unwrap();
        let conflict = connection.execute(
            "INSERT INTO project_identity_aliases (id, project_ref, alias_kind, normalized_value, status, source) VALUES ('alias-b', 'project-B', 'repo_path', '/work/repo', 'active', 'test')",
            [],
        );
        assert!(conflict.is_err());
        connection
            .execute(
                "INSERT INTO project_identity_aliases (id, project_ref, alias_kind, normalized_value, status, source) VALUES ('alias-revoked', 'project-B', 'repo_path', '/work/repo', 'revoked', 'test')",
                [],
            )
            .unwrap();
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
        assert_eq!(count, CURRENT_SCHEMA_REVISION);
    }

    #[test]
    fn additive_identity_revision_preserves_version_one_binary_compatibility() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();
        migrate(&mut connection, 8).unwrap();

        assert_eq!(schema_version(&connection).unwrap(), 1);
        let identity_revision: String = connection
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(identity_revision, "repository_identity_contract_v1");

        connection.execute_batch("PRAGMA user_version = 2").unwrap();
        migrate(&mut connection, 8).unwrap();
        assert_eq!(schema_version(&connection).unwrap(), 1);
    }

    #[test]
    fn version_one_database_upgrades_additively() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();
        migrate(&mut connection, 8).unwrap();

        connection
            .execute_batch(
                r#"
                DROP INDEX IF EXISTS knowledge_items_classification_status_idx;
                DROP INDEX IF EXISTS knowledge_items_status_scope_project_ref_idx;
                DROP INDEX IF EXISTS knowledge_items_status_scope_repo_key_idx;
                DROP INDEX IF EXISTS knowledge_items_status_scope_repo_path_idx;
                DROP INDEX IF EXISTS sources_classification_status_idx;
                DROP INDEX IF EXISTS sources_scope_project_ref_idx;
                DROP INDEX IF EXISTS sources_scope_repo_key_idx;
                DROP INDEX IF EXISTS sources_scope_repo_path_idx;
                DROP INDEX IF EXISTS episode_cards_classification_status_idx;
                DROP INDEX IF EXISTS episode_cards_scope_project_ref_idx;
                DROP INDEX IF EXISTS context_compile_runs_project_ref_idx;
                DROP INDEX IF EXISTS context_compile_runs_repo_key_idx;
                DROP INDEX IF EXISTS context_compile_runs_repo_path_idx;
                DROP INDEX IF EXISTS context_compile_task_traces_project_ref_idx;
                DROP TABLE project_identity_aliases;
                ALTER TABLE knowledge_items DROP COLUMN classification_status;
                ALTER TABLE knowledge_items DROP COLUMN project_ref;
                ALTER TABLE knowledge_items DROP COLUMN repo_key;
                ALTER TABLE knowledge_items DROP COLUMN repo_path;
                ALTER TABLE sources DROP COLUMN classification_status;
                ALTER TABLE sources DROP COLUMN scope;
                ALTER TABLE sources DROP COLUMN project_ref;
                ALTER TABLE sources DROP COLUMN repo_key;
                ALTER TABLE sources DROP COLUMN repo_path;
                ALTER TABLE episode_cards DROP COLUMN classification_status;
                ALTER TABLE episode_cards DROP COLUMN scope;
                ALTER TABLE episode_cards DROP COLUMN project_ref;
                ALTER TABLE context_compile_runs DROP COLUMN project_ref;
                ALTER TABLE context_compile_runs DROP COLUMN repo_key;
                ALTER TABLE context_compile_runs DROP COLUMN match_basis;
                ALTER TABLE context_compile_runs DROP COLUMN identity_contract_version;
                ALTER TABLE context_compile_runs DROP COLUMN scope_mode;
                ALTER TABLE context_compile_task_traces DROP COLUMN project_ref;
                ALTER TABLE context_compile_task_traces DROP COLUMN match_basis;
                ALTER TABLE context_compile_task_traces DROP COLUMN identity_contract_version;
                ALTER TABLE context_compile_task_traces DROP COLUMN scope_mode;
                ALTER TABLE context_compile_task_traces DROP COLUMN identity_fingerprint;
                ALTER TABLE context_compile_task_traces DROP COLUMN identity_trust;
                ALTER TABLE context_compile_task_traces DROP COLUMN binding_status;
                ALTER TABLE context_pack_items DROP COLUMN scope_snapshot;
                DELETE FROM schema_migrations;
                INSERT INTO schema_migrations(version, name) VALUES (1, 'rust_single_writer_baseline');
                PRAGMA user_version = 1;
                "#,
            )
            .unwrap();

        let version = migrate(&mut connection, 8).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert!(column_exists(&connection, "knowledge_items", "project_ref").unwrap());
        assert!(column_exists(&connection, "sources", "classification_status").unwrap());
        assert!(column_exists(&connection, "episode_cards", "project_ref").unwrap());
        assert!(column_exists(&connection, "context_compile_runs", "scope_mode").unwrap());
        assert!(
            column_exists(&connection, "context_compile_task_traces", "binding_status").unwrap()
        );
        assert!(column_exists(&connection, "context_pack_items", "scope_snapshot").unwrap());
        assert!(table_exists(&connection, "project_identity_aliases").unwrap());
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

    #[test]
    fn migration_rejects_newer_additive_revision() {
        vector_index::service::register_sqlite_vec();
        let mut connection = Connection::open_in_memory().unwrap();
        configure_writer_connection(&connection).unwrap();
        migrate(&mut connection, 8).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, name) VALUES (99, 'future_revision')",
                [],
            )
            .unwrap();

        let error = migrate(&mut connection, 8).unwrap_err();
        assert!(error.contains(&format!(
            "revision 99 is newer than supported revision {CURRENT_SCHEMA_REVISION}"
        )));
        assert_eq!(schema_version(&connection).unwrap(), 1);
    }
}
