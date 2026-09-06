use std::{fs::File, io::Read, path::Path};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    domains::sqlite_writer::schema::{CURRENT_SCHEMA_REVISION, CURRENT_SCHEMA_VERSION},
    shared::errors::CliError,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupVerification {
    pub status: &'static str,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub schema_version: i64,
    pub schema_revision: i64,
    pub knowledge_items: i64,
    pub sources: i64,
}

/// Verify an offline standalone backup without opening a writer or creating sidecars.
pub fn verify(path: &Path) -> Result<BackupVerification, CliError> {
    verify_inner(path)
        .map_err(|error| CliError::runtime(format!("backup verification failed: {error}")))
}

fn verify_inner(path: &Path) -> Result<BackupVerification, String> {
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.is_file() {
        return Err("backup path must be a regular file".to_string());
    }
    ensure_standalone(&path)?;
    let bytes = path.metadata().map_err(|error| error.to_string())?.len();
    let sha256 = digest(&path)?;
    crate::domains::vector_index::service::register_sqlite_vec();
    let uri_path: String = path
        .to_string_lossy()
        .bytes()
        .map(|byte| match byte {
            b'/' | b':' | b'-' | b'_' | b'.' | b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect();
    let connection = Connection::open_with_flags(
        format!("file:{uri_path}?immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|error| error.to_string())?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!("integrity_check: {integrity}"));
    }
    let has_invalid_foreign_keys = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?
        .exists([])
        .map_err(|error| error.to_string())?;
    if has_invalid_foreign_keys {
        return Err("foreign_key_check found invalid references".to_string());
    }
    let scalar = |sql: &str| -> Result<i64, String> {
        connection
            .query_row(sql, [], |row| row.get(0))
            .map_err(|error| error.to_string())
    };
    let schema_version = scalar("PRAGMA user_version")?;
    let schema_revision = scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")?;
    if schema_version != CURRENT_SCHEMA_VERSION
        || !(1..=CURRENT_SCHEMA_REVISION).contains(&schema_revision)
    {
        return Err(format!(
            "unsupported schema version {schema_version}, revision {schema_revision}"
        ));
    }
    let knowledge_items = scalar("SELECT COUNT(*) FROM knowledge_items")?;
    let sources = scalar("SELECT COUNT(*) FROM sources")?;
    // These are required for serving the restored application, even when empty.
    scalar("SELECT COUNT(*) FROM settings")?;
    scalar("SELECT COUNT(*) FROM context_compile_runs")?;
    drop(connection);
    ensure_standalone(&path)?;
    if sha256 != digest(&path)? {
        return Err("backup changed during verification; stop its writer and retry".to_string());
    }
    Ok(BackupVerification {
        status: "verified",
        path: path.to_string_lossy().into_owned(),
        bytes,
        sha256,
        schema_version,
        schema_revision,
        knowledge_items,
        sources,
    })
}

fn ensure_standalone(path: &Path) -> Result<(), String> {
    for suffix in ["-wal", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        match std::fs::metadata(&sidecar) {
            Ok(metadata) if metadata.len() > 0 => {
                return Err(format!(
                    "backup has a {suffix} sidecar; create an offline backup first"
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

mod tests;
