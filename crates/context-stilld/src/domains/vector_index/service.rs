use std::path::Path;
use std::sync::Once;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::{
    domains::{bootstrap::service::resolve_paths, runtime_identity},
    shared::{config::EnvProvider, process::ProcessSupervisor},
};

static SQLITE_VEC_REGISTER: Once = Once::new();

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorHealthReport {
    pub status: &'static str,
    pub engine: &'static str,
    pub sqlite_path: String,
    pub database_exists: bool,
    pub registered: bool,
    pub vec_usable: bool,
    pub vec_version: Option<String>,
    pub knowledge_vec_table: bool,
    pub source_fragments_vec_table: bool,
    pub knowledge_fallback_rows: Option<i64>,
    pub source_fragment_fallback_rows: Option<i64>,
    pub metadata_rows: Vec<VectorMetadataRow>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorSmokeReport {
    pub status: &'static str,
    pub engine: &'static str,
    pub registered: bool,
    pub vec_usable: bool,
    pub vec_version: Option<String>,
    pub top_rowid: Option<i64>,
    pub result_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorMetadataRow {
    pub name: String,
    pub dimension: i64,
    pub row_count: i64,
    pub uses_sqlite_vec: bool,
    pub rebuilt_at: Option<String>,
}

#[derive(Debug)]
struct SmokeHit {
    rowid: i64,
    _distance: f64,
}

pub fn register_sqlite_vec() {
    SQLITE_VEC_REGISTER.call_once(|| unsafe {
        let entrypoint = std::mem::transmute::<
            *const (),
            rusqlite::auto_extension::RawAutoExtension,
        >(
            sqlite_vec::sqlite3_vec_init as *const (),
        );
        let _ = rusqlite::auto_extension::register_auto_extension(entrypoint);
    });
}

pub fn health<E: EnvProvider, S: ProcessSupervisor>(env: &E, supervisor: &S) -> VectorHealthReport {
    let mut paths = resolve_paths(env);
    paths.sqlite_core_path = runtime_identity::resolve(env, supervisor).effective_path;
    let sqlite_path = paths.sqlite_core_path.display().to_string();
    let database_exists = paths.sqlite_core_path.exists();

    if !database_exists {
        return VectorHealthReport {
            status: "missing_db",
            engine: "rust_sqlite_vec",
            sqlite_path,
            database_exists,
            registered: false,
            vec_usable: false,
            vec_version: None,
            knowledge_vec_table: false,
            source_fragments_vec_table: false,
            knowledge_fallback_rows: None,
            source_fragment_fallback_rows: None,
            metadata_rows: Vec::new(),
            error: Some("SQLite core database does not exist".to_string()),
        };
    }

    register_sqlite_vec();
    match open_read_only(&paths.sqlite_core_path) {
        Ok(connection) => {
            let vec_version = query_vec_version(&connection).ok();
            let knowledge_vec_table = table_exists(&connection, "knowledge_items_vec");
            let source_fragments_vec_table = table_exists(&connection, "source_fragments_vec");
            let knowledge_fallback_rows = count_table(&connection, "knowledge_items_vec_fallback");
            let source_fragment_fallback_rows =
                count_table(&connection, "source_fragments_vec_fallback");
            let metadata_rows = read_metadata_rows(&connection).unwrap_or_default();
            VectorHealthReport {
                status: if vec_version.is_some() {
                    "ok"
                } else {
                    "degraded"
                },
                engine: "rust_sqlite_vec",
                sqlite_path,
                database_exists,
                registered: true,
                vec_usable: vec_version.is_some(),
                vec_version,
                knowledge_vec_table,
                source_fragments_vec_table,
                knowledge_fallback_rows,
                source_fragment_fallback_rows,
                metadata_rows,
                error: None,
            }
        }
        Err(error) => VectorHealthReport {
            status: "degraded",
            engine: "rust_sqlite_vec",
            sqlite_path,
            database_exists,
            registered: true,
            vec_usable: false,
            vec_version: None,
            knowledge_vec_table: false,
            source_fragments_vec_table: false,
            knowledge_fallback_rows: None,
            source_fragment_fallback_rows: None,
            metadata_rows: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

pub fn smoke() -> VectorSmokeReport {
    register_sqlite_vec();
    match run_smoke() {
        Ok((vec_version, hits)) => VectorSmokeReport {
            status: "ok",
            engine: "rust_sqlite_vec",
            registered: true,
            vec_usable: true,
            vec_version: Some(vec_version),
            top_rowid: hits.first().map(|hit| hit.rowid),
            result_count: hits.len(),
            error: None,
        },
        Err(error) => VectorSmokeReport {
            status: "degraded",
            engine: "rust_sqlite_vec",
            registered: true,
            vec_usable: false,
            vec_version: None,
            top_rowid: None,
            result_count: 0,
            error: Some(error.to_string()),
        },
    }
}

fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

fn query_vec_version(connection: &Connection) -> rusqlite::Result<String> {
    connection.query_row("select vec_version()", [], |row| row.get(0))
}

fn table_exists(connection: &Connection, table_name: &str) -> bool {
    connection
        .query_row(
            "select exists(select 1 from sqlite_schema where name = ?1) as found",
            [table_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value == 1)
        .unwrap_or(false)
}

fn count_table(connection: &Connection, table_name: &str) -> Option<i64> {
    if !table_exists(connection, table_name) {
        return None;
    }
    let sql = format!("select count(*) from {table_name}");
    connection.query_row(&sql, [], |row| row.get(0)).ok()
}

fn read_metadata_rows(connection: &Connection) -> rusqlite::Result<Vec<VectorMetadataRow>> {
    if !table_exists(connection, "core_vector_metadata") {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "
        select name, dimension, row_count, uses_sqlite_vec, rebuilt_at
        from core_vector_metadata
        order by name
        ",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(VectorMetadataRow {
            name: row.get(0)?,
            dimension: row.get(1)?,
            row_count: row.get(2)?,
            uses_sqlite_vec: row.get::<_, i64>(3)? != 0,
            rebuilt_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

fn run_smoke() -> rusqlite::Result<(String, Vec<SmokeHit>)> {
    let connection = Connection::open_in_memory()?;
    let vec_version = query_vec_version(&connection)?;
    connection.execute_batch(
        "
        create virtual table vec_smoke using vec0(embedding float[2]);
        insert into vec_smoke(rowid, embedding) values (1, '[1.0, 0.0]');
        insert into vec_smoke(rowid, embedding) values (2, '[0.0, 1.0]');
        ",
    )?;
    let mut statement = connection.prepare(
        "
        select rowid, distance
        from vec_smoke
        where embedding match ?1 and k = ?2
        order by distance
        ",
    )?;
    let rows = statement.query_map(("[1.0, 0.0]", 2_i64), |row| {
        Ok(SmokeHit {
            rowid: row.get(0)?,
            _distance: row.get(1)?,
        })
    })?;
    Ok((vec_version, rows.collect::<rusqlite::Result<Vec<_>>>()?))
}

impl VectorHealthReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("status={}", self.status),
            format!("engine={}", self.engine),
            format!("sqlitePath={}", self.sqlite_path),
            format!("databaseExists={}", self.database_exists),
            format!("vecUsable={}", self.vec_usable),
            format!(
                "vecVersion={}",
                self.vec_version.as_deref().unwrap_or("unknown")
            ),
            format!(
                "knowledgeFallbackRows={}",
                self.knowledge_fallback_rows
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            format!(
                "sourceFragmentFallbackRows={}",
                self.source_fragment_fallback_rows
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ]
        .join("\n")
    }
}

impl VectorSmokeReport {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn to_text(&self) -> String {
        [
            format!("status={}", self.status),
            format!("engine={}", self.engine),
            format!("vecUsable={}", self.vec_usable),
            format!(
                "vecVersion={}",
                self.vec_version.as_deref().unwrap_or("unknown")
            ),
            format!(
                "topRowid={}",
                self.top_rowid
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ),
            format!("resultCount={}", self.result_count),
        ]
        .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::{health, smoke};
    use crate::shared::config::MapEnv;
    use rusqlite::Connection;
    use std::time::SystemTime;

    #[test]
    fn smoke_registers_sqlite_vec_and_runs_match_query() {
        let report = smoke();

        assert_eq!(report.status, "ok");
        assert_eq!(report.engine, "rust_sqlite_vec");
        assert!(report.registered);
        assert!(report.vec_usable);
        assert!(report
            .vec_version
            .as_deref()
            .unwrap_or_default()
            .starts_with("v"));
        assert_eq!(report.top_rowid, Some(1));
        assert_eq!(report.result_count, 2);
    }

    #[test]
    fn health_reports_existing_fallback_rows_without_creating_vec_tables() {
        let temp_dir = std::env::temp_dir().join(format!(
            "context_still_vector_health_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let sqlite_path = temp_dir.join("context-still-core.sqlite");
        let connection = Connection::open(&sqlite_path).unwrap();
        connection
            .execute_batch(
                "
                create table knowledge_items_vec_fallback(
                  knowledge_id text primary key,
                  embedding_json text not null,
                  embedding_dimension integer not null,
                  content_hash text not null,
                  updated_at text not null
                ) strict;
                create table source_fragments_vec_fallback(
                  source_fragment_id text primary key,
                  embedding_json text not null,
                  embedding_dimension integer not null,
                  content_hash text not null,
                  updated_at text not null
                ) strict;
                create table core_vector_metadata(
                  name text primary key,
                  dimension integer not null,
                  provider text,
                  model text,
                  rebuilt_at text,
                  row_count integer not null default 0,
                  uses_sqlite_vec integer not null default 0
                ) strict;
                insert into knowledge_items_vec_fallback values
                  ('k1', '[1.0, 0.0]', 2, 'hash', '2026-01-01T00:00:00.000Z');
                insert into source_fragments_vec_fallback values
                  ('s1', '[0.0, 1.0]', 2, 'hash', '2026-01-01T00:00:00.000Z');
                insert into core_vector_metadata(name, dimension, row_count, uses_sqlite_vec, rebuilt_at)
                  values ('knowledge_items', 2, 1, 0, '2026-01-01T00:00:00.000Z');
                ",
            )
            .unwrap();
        drop(connection);

        let env = MapEnv::from_pairs(vec![(
            "CONTEXT_STILL_SQLITE_CORE_PATH",
            sqlite_path.to_str().unwrap(),
        )]);
        let supervisor = crate::shared::process::MockSupervisor::new();
        let report = health(&env, &supervisor);

        assert_eq!(report.status, "ok");
        assert!(report.database_exists);
        assert!(report.vec_usable);
        assert_eq!(report.knowledge_fallback_rows, Some(1));
        assert_eq!(report.source_fragment_fallback_rows, Some(1));
        assert!(!report.knowledge_vec_table);
        assert!(!report.source_fragments_vec_table);
        assert_eq!(report.metadata_rows.len(), 1);
        assert!(!report.metadata_rows[0].uses_sqlite_vec);

        std::fs::remove_dir_all(temp_dir).unwrap();
    }
}
