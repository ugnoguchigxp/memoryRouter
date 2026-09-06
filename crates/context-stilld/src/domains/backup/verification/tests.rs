#![cfg(test)]

use super::*;
use crate::domains::sqlite_writer::{create_offline_backup, SqliteWriterRuntime};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "context-still-backup-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn backup(&self) -> std::path::PathBuf {
        let source = self.0.join("source.sqlite");
        let writer = SqliteWriterRuntime::start(&source, 4, 8).unwrap();
        writer.handle().execute("test.seed", |connection| {
            connection.execute("INSERT INTO knowledge_items(id, type, status, title, body) VALUES('restore-test', 'rule', 'active', 'Restore fixture', 'Preserve this knowledge through backup')", [])
                .map(|_| ()).map_err(|error| error.to_string())
        }).unwrap();
        writer.shutdown().unwrap();
        let backup = self.0.join("backup #日本語.sqlite");
        create_offline_backup(&source, &backup).unwrap();
        backup
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn verifies_and_restores_a_real_backup_without_mutating_it() {
    let fixture = Fixture::new();
    let backup = fixture.backup();
    let before = std::fs::read(&backup).unwrap();
    let verified = verify(&backup).unwrap();
    assert_eq!(verified.status, "verified");
    assert_eq!(verified.knowledge_items, 1);
    assert_eq!(verified.schema_revision, CURRENT_SCHEMA_REVISION);
    assert_eq!(verified.bytes, before.len() as u64);
    assert_eq!(std::fs::read(&backup).unwrap(), before);
    assert!(!std::path::PathBuf::from(format!("{}-wal", backup.display())).exists());
    let restored = fixture.0.join("restored.sqlite");
    std::fs::copy(&backup, &restored).unwrap();
    let restored_report = verify(&restored).unwrap();
    assert_eq!(restored_report.sha256, verified.sha256);
    let writer = SqliteWriterRuntime::start(&restored, 4, 8).unwrap();
    let body: String = writer
        .handle()
        .execute("test.restored", |connection| {
            connection
                .query_row(
                    "SELECT body FROM knowledge_items WHERE id = 'restore-test'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(body, "Preserve this knowledge through backup");
    writer.shutdown().unwrap();
}

#[test]
fn rejects_missing_corrupt_unrelated_and_incomplete_files() {
    let fixture = Fixture::new();
    let missing = fixture.0.join("missing.sqlite");
    assert!(verify(&missing).is_err());
    assert!(!missing.exists());
    std::fs::write(&missing, b"not a database").unwrap();
    assert!(verify(&missing).is_err());
    let unrelated = fixture.0.join("unrelated.sqlite");
    Connection::open(&unrelated)
        .unwrap()
        .execute_batch("CREATE TABLE unrelated(id TEXT);")
        .unwrap();
    assert!(verify(&unrelated).is_err());
    let backup = fixture.backup();
    std::fs::write(format!("{}-wal", backup.display()), b"pending changes").unwrap();
    assert!(verify(&backup).is_err());
}

#[test]
fn rejects_broken_foreign_keys_and_future_schemas() {
    let fixture = Fixture::new();
    let backup = fixture.backup();
    let connection = Connection::open(&backup).unwrap();
    connection.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(999);").unwrap();
    drop(connection);
    assert!(verify_inner(&backup)
        .unwrap_err()
        .contains("foreign_key_check"));
    let connection = Connection::open(&backup).unwrap();
    connection
        .execute_batch("DROP TABLE child; PRAGMA user_version=999;")
        .unwrap();
    drop(connection);
    assert!(verify_inner(&backup)
        .unwrap_err()
        .contains("unsupported schema"));
}
