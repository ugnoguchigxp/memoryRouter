use std::any::Any;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::Connection;
use serde::Serialize;

use super::schema;

type BoxedResult = Result<Box<dyn Any + Send>, String>;
type WriterJob = Box<dyn FnOnce(&mut Connection) -> BoxedResult + Send + 'static>;

enum Command {
    Execute {
        owner: Option<String>,
        transaction_control: TransactionControl,
        operation: String,
        job: WriterJob,
        response: mpsc::Sender<BoxedResult>,
    },
    Shutdown {
        response: mpsc::Sender<()>,
    },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum TransactionControl {
    None,
    Begin,
    End,
}

#[derive(Debug, Default)]
struct WriterStats {
    ready: AtomicBool,
    queue_depth: AtomicUsize,
    committed: AtomicU64,
    failed: AtomicU64,
    last_committed_at_ms: AtomicU64,
    active_operation: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    schema_version: AtomicU64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteWriterStatus {
    pub ready: bool,
    pub pid: u32,
    pub sqlite_path: String,
    pub queue_depth: usize,
    pub queue_capacity: usize,
    pub committed: u64,
    pub failed: u64,
    pub schema_version: u64,
    pub active_operation: Option<String>,
    pub last_committed_at_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct SqliteWriterHandle {
    sender: mpsc::SyncSender<Command>,
    stats: Arc<WriterStats>,
    sqlite_path: Arc<PathBuf>,
    queue_capacity: usize,
}

impl SqliteWriterHandle {
    pub fn execute<T, F>(&self, operation: impl Into<String>, job: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        let (response_tx, response_rx) = mpsc::channel();
        self.stats.queue_depth.fetch_add(1, Ordering::SeqCst);
        let send_result = self.sender.send(Command::Execute {
            owner: None,
            transaction_control: TransactionControl::None,
            operation: operation.into(),
            job: Box::new(move |connection| {
                job(connection).map(|value| Box::new(value) as Box<dyn Any + Send>)
            }),
            response: response_tx,
        });
        if send_result.is_err() {
            self.stats.queue_depth.fetch_sub(1, Ordering::SeqCst);
            return Err("SQLite writer is not running".to_string());
        }
        let boxed = response_rx
            .recv()
            .map_err(|_| "SQLite writer stopped before returning a result".to_string())??;
        boxed
            .downcast::<T>()
            .map(|value| *value)
            .map_err(|_| "SQLite writer returned an unexpected result type".to_string())
    }

    pub fn execute_for_client<T, F>(
        &self,
        client_id: String,
        transaction_control: TransactionControl,
        operation: impl Into<String>,
        job: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        let (response_tx, response_rx) = mpsc::channel();
        self.stats.queue_depth.fetch_add(1, Ordering::SeqCst);
        let send_result = self.sender.send(Command::Execute {
            owner: Some(client_id),
            transaction_control,
            operation: operation.into(),
            job: Box::new(move |connection| {
                job(connection).map(|value| Box::new(value) as Box<dyn Any + Send>)
            }),
            response: response_tx,
        });
        if send_result.is_err() {
            self.stats.queue_depth.fetch_sub(1, Ordering::SeqCst);
            return Err("SQLite writer is not running".to_string());
        }
        let boxed = response_rx
            .recv()
            .map_err(|_| "SQLite writer stopped before returning a result".to_string())??;
        boxed
            .downcast::<T>()
            .map(|value| *value)
            .map_err(|_| "SQLite writer returned an unexpected result type".to_string())
    }

    pub fn status(&self) -> SqliteWriterStatus {
        let last_committed_at_ms = self.stats.last_committed_at_ms.load(Ordering::SeqCst);
        SqliteWriterStatus {
            ready: self.stats.ready.load(Ordering::SeqCst),
            pid: std::process::id(),
            sqlite_path: self.sqlite_path.to_string_lossy().into_owned(),
            queue_depth: self.stats.queue_depth.load(Ordering::SeqCst),
            queue_capacity: self.queue_capacity,
            committed: self.stats.committed.load(Ordering::SeqCst),
            failed: self.stats.failed.load(Ordering::SeqCst),
            schema_version: self.stats.schema_version.load(Ordering::SeqCst),
            active_operation: self.stats.active_operation.lock().unwrap().clone(),
            last_committed_at_ms: (last_committed_at_ms > 0).then_some(last_committed_at_ms),
            last_error: self.stats.last_error.lock().unwrap().clone(),
        }
    }
}

pub struct SqliteWriterRuntime {
    handle: SqliteWriterHandle,
    join_handle: Option<JoinHandle<()>>,
    lock_file: File,
}

impl SqliteWriterRuntime {
    pub fn start(
        sqlite_path: impl AsRef<Path>,
        queue_capacity: usize,
        vector_dimension: usize,
    ) -> Result<Self, String> {
        Self::start_inner(sqlite_path.as_ref(), queue_capacity, vector_dimension, true)
    }

    #[cfg(test)]
    pub(crate) fn start_existing_for_test(
        sqlite_path: impl AsRef<Path>,
        queue_capacity: usize,
    ) -> Result<Self, String> {
        Self::start_inner(sqlite_path.as_ref(), queue_capacity, 1, false)
    }

    fn start_inner(
        sqlite_path: &Path,
        queue_capacity: usize,
        vector_dimension: usize,
        migrate_schema: bool,
    ) -> Result<Self, String> {
        let sqlite_path = sqlite_path.to_path_buf();
        if let Some(parent) = sqlite_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create SQLite directory: {error}"))?;
        }
        let lock_path = writer_lock_path(&sqlite_path);
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|error| format!("failed to open SQLite writer lock: {error}"))?;
        lock_file.try_lock_exclusive().map_err(|error| {
            format!(
                "another SQLite writer owns {}: {error}",
                lock_path.display()
            )
        })?;

        let queue_capacity = queue_capacity.max(1);
        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let (startup_tx, startup_rx) = mpsc::channel();
        let stats = Arc::new(WriterStats::default());
        let thread_stats = Arc::clone(&stats);
        let thread_path = sqlite_path.clone();
        let join_handle = thread::Builder::new()
            .name("context-still-sqlite-writer".to_string())
            .spawn(move || {
                let startup = if migrate_schema {
                    open_writer_connection(&thread_path, vector_dimension)
                } else {
                    open_existing_writer_connection(&thread_path)
                };
                match startup {
                    Ok(mut connection) => {
                        thread_stats.ready.store(true, Ordering::SeqCst);
                        if let Ok(version) = schema::schema_version(&connection) {
                            thread_stats
                                .schema_version
                                .store(version.max(0) as u64, Ordering::SeqCst);
                        }
                        let _ = startup_tx.send(Ok(()));
                        run_loop(&mut connection, receiver, &thread_stats);
                        thread_stats.ready.store(false, Ordering::SeqCst);
                    }
                    Err(error) => {
                        let _ = startup_tx.send(Err(error));
                    }
                }
            })
            .map_err(|error| format!("failed to spawn SQLite writer thread: {error}"))?;

        startup_rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "timed out starting SQLite writer".to_string())??;
        let handle = SqliteWriterHandle {
            sender,
            stats,
            sqlite_path: Arc::new(sqlite_path),
            queue_capacity,
        };
        Ok(Self {
            handle,
            join_handle: Some(join_handle),
            lock_file,
        })
    }

    pub fn handle(&self) -> SqliteWriterHandle {
        self.handle.clone()
    }

    pub fn shutdown(mut self) -> Result<(), String> {
        self.shutdown_inner()
    }

    fn shutdown_inner(&mut self) -> Result<(), String> {
        if self.join_handle.is_none() {
            return Ok(());
        }
        let (response_tx, response_rx) = mpsc::channel();
        let _ = self.handle.sender.send(Command::Shutdown {
            response: response_tx,
        });
        let _ = response_rx.recv_timeout(Duration::from_secs(30));
        if let Some(join_handle) = self.join_handle.take() {
            join_handle
                .join()
                .map_err(|_| "SQLite writer thread panicked during shutdown".to_string())?;
        }
        self.lock_file
            .unlock()
            .map_err(|error| format!("failed to release SQLite writer lock: {error}"))
    }
}

impl Drop for SqliteWriterRuntime {
    fn drop(&mut self) {
        let _ = self.shutdown_inner();
    }
}

static GLOBAL_WRITERS: OnceLock<Mutex<BTreeMap<PathBuf, SqliteWriterHandle>>> = OnceLock::new();

pub fn install_global_writer(handle: SqliteWriterHandle) -> Result<(), String> {
    let slot = GLOBAL_WRITERS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut guard = slot
        .lock()
        .map_err(|_| "SQLite writer registry is poisoned")?;
    if guard.contains_key(handle.sqlite_path.as_path()) {
        return Err(format!(
            "SQLite writer is already installed for {}",
            handle.sqlite_path.display()
        ));
    }
    guard.insert(handle.sqlite_path.as_ref().clone(), handle);
    Ok(())
}

pub fn clear_global_writer(path: &Path) {
    if let Some(slot) = GLOBAL_WRITERS.get() {
        if let Ok(mut guard) = slot.lock() {
            guard.remove(path);
        }
    }
}

pub fn global_writer() -> Result<SqliteWriterHandle, String> {
    let writers = GLOBAL_WRITERS
        .get()
        .and_then(|slot| slot.lock().ok())
        .map(|guard| guard.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    match writers.as_slice() {
        [writer] => Ok(writer.clone()),
        [] => Err(
            "SQLite writes require the resident context-stilld writer; start context-stilld run"
                .to_string(),
        ),
        _ => Err("multiple SQLite writers are registered; resolve by database path".to_string()),
    }
}

pub fn global_writer_for_path(path: &Path) -> Result<SqliteWriterHandle, String> {
    GLOBAL_WRITERS
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|guard| guard.get(path).cloned()))
        .ok_or_else(|| {
            format!(
                "SQLite writes for {} require the resident context-stilld writer",
                path.display()
            )
        })
}

pub fn execute_for_path<T, F>(path: &Path, operation: &'static str, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
{
    match global_writer_for_path(path) {
        Ok(writer) => writer.execute(operation, job),
        #[cfg(test)]
        Err(_) => {
            let runtime = SqliteWriterRuntime::start_existing_for_test(path, 16)?;
            let result = runtime.handle().execute(operation, job);
            runtime.shutdown()?;
            result
        }
        #[cfg(not(test))]
        Err(error) => Err(error),
    }
}

pub fn is_writer_lock_held(sqlite_path: &Path) -> Result<bool, String> {
    let lock_path = writer_lock_path(sqlite_path);
    if !lock_path.exists() {
        return Ok(false);
    }
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("failed to inspect SQLite writer lock: {error}"))?;
    match lock_file.try_lock_exclusive() {
        Ok(()) => {
            lock_file.unlock().map_err(|error| {
                format!("failed to release inspected SQLite writer lock: {error}")
            })?;
            Ok(false)
        }
        Err(_) => Ok(true),
    }
}

pub fn create_offline_backup(sqlite_path: &Path, output_path: &Path) -> Result<u64, String> {
    if !sqlite_path.is_file() {
        return Err(format!(
            "SQLite source database not found: {}",
            sqlite_path.display()
        ));
    }
    if output_path.exists() {
        return Err(format!(
            "SQLite backup output already exists: {}",
            output_path.display()
        ));
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create SQLite backup directory: {error}"))?;
    }

    let lock_path = writer_lock_path(sqlite_path);
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| format!("failed to open SQLite writer lock: {error}"))?;
    lock_file.try_lock_exclusive().map_err(|error| {
        format!(
            "offline backup requires the resident Writer to be stopped; {} is locked: {error}",
            lock_path.display()
        )
    })?;

    crate::domains::vector_index::service::register_sqlite_vec();
    let connection = Connection::open(sqlite_path)
        .map_err(|error| format!("failed to open SQLite for offline backup: {error}"))?;
    schema::configure_writer_connection(&connection)?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| format!("failed to checkpoint SQLite before backup: {error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("failed to check SQLite integrity: {error}"))?;
    if integrity != "ok" {
        return Err(format!("SQLite integrity_check failed: {integrity}"));
    }
    connection
        .execute("VACUUM INTO ?1", [output_path.to_string_lossy().as_ref()])
        .map_err(|error| format!("failed to create SQLite backup: {error}"))?;
    drop(connection);
    lock_file
        .unlock()
        .map_err(|error| format!("failed to release SQLite writer lock: {error}"))?;
    std::fs::metadata(output_path)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("failed to inspect SQLite backup: {error}"))
}

fn open_writer_connection(path: &Path, vector_dimension: usize) -> Result<Connection, String> {
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open(path)
        .map_err(|error| format!("failed to open SQLite writer database: {error}"))?;
    schema::configure_writer_connection(&connection)?;
    schema::migrate(&mut connection, vector_dimension)?;
    Ok(connection)
}

fn open_existing_writer_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("failed to open SQLite writer database: {error}"))?;
    schema::configure_writer_connection(&connection)?;
    Ok(connection)
}

fn run_loop(
    connection: &mut Connection,
    receiver: mpsc::Receiver<Command>,
    stats: &Arc<WriterStats>,
) {
    let mut transaction_owner: Option<String> = None;
    let mut transaction_started_at: Option<std::time::Instant> = None;
    let mut deferred = VecDeque::new();
    loop {
        if transaction_started_at.is_some_and(|started| started.elapsed() > Duration::from_secs(30))
        {
            let _ = connection.execute_batch("ROLLBACK");
            transaction_owner = None;
            transaction_started_at = None;
            stats.failed.fetch_add(1, Ordering::SeqCst);
            *stats.last_error.lock().unwrap() =
                Some("remote SQLite transaction exceeded 30 second ownership deadline".to_string());
        }
        let command = if transaction_owner.is_none() {
            deferred.pop_front().or_else(|| receiver.recv().ok())
        } else {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => None,
            }
        };
        let Some(command) = command else {
            return;
        };
        if let Some(active_owner) = transaction_owner.as_deref() {
            let command_owner = match &command {
                Command::Execute { owner, .. } => owner.as_deref(),
                Command::Shutdown { .. } => None,
            };
            if command_owner != Some(active_owner) {
                deferred.push_back(command);
                continue;
            }
        }
        match command {
            Command::Execute {
                owner,
                transaction_control,
                operation,
                job,
                response,
            } => {
                stats.queue_depth.fetch_sub(1, Ordering::SeqCst);
                *stats.active_operation.lock().unwrap() = Some(operation);
                let result = job(connection);
                if result.is_ok() {
                    match transaction_control {
                        TransactionControl::Begin => {
                            transaction_owner = owner;
                            transaction_started_at = Some(std::time::Instant::now());
                        }
                        TransactionControl::End => {
                            transaction_owner = None;
                            transaction_started_at = None;
                        }
                        TransactionControl::None => {}
                    }
                } else if transaction_control == TransactionControl::End {
                    let _ = connection.execute_batch("ROLLBACK");
                    transaction_owner = None;
                    transaction_started_at = None;
                }
                if result.is_ok() {
                    stats.committed.fetch_add(1, Ordering::SeqCst);
                    stats
                        .last_committed_at_ms
                        .store(unix_time_ms(), Ordering::SeqCst);
                } else {
                    stats.failed.fetch_add(1, Ordering::SeqCst);
                    *stats.last_error.lock().unwrap() = result.as_ref().err().cloned();
                }
                *stats.active_operation.lock().unwrap() = None;
                let _ = response.send(result);
            }
            Command::Shutdown { response } => {
                let _ = response.send(());
                return;
            }
        }
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn writer_lock_path(sqlite_path: &Path) -> PathBuf {
    let mut value = sqlite_path.as_os_str().to_os_string();
    value.push(".writer.lock");
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "context_still_writer_{}_{}_{}.sqlite",
            name,
            std::process::id(),
            unix_time_ms()
        ))
    }

    #[test]
    fn concurrent_callers_are_serialized_on_one_connection() {
        let path = temp_path("serialize");
        let runtime = SqliteWriterRuntime::start(&path, 16, 8).unwrap();
        let handle = Arc::new(runtime.handle());
        handle
            .execute("test.create", |connection| {
                connection
                    .execute_batch("CREATE TABLE writer_test(value INTEGER NOT NULL);")
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let mut threads = Vec::new();
        for value in 0..16_i64 {
            let handle = Arc::clone(&handle);
            threads.push(thread::spawn(move || {
                handle.execute("test.insert", move |connection| {
                    connection
                        .execute("INSERT INTO writer_test(value) VALUES (?1)", [value])
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                })
            }));
        }
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let count: i64 = handle
            .execute("test.count", |connection| {
                connection
                    .query_row("SELECT count(*) FROM writer_test", [], |row| row.get(0))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(count, 16);
        assert_eq!(handle.status().failed, 0);
        runtime.shutdown().unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(writer_lock_path(&path));
    }

    #[test]
    fn second_writer_cannot_lock_same_database() {
        let path = temp_path("lock");
        let runtime = SqliteWriterRuntime::start(&path, 4, 8).unwrap();
        let error = SqliteWriterRuntime::start(&path, 4, 8)
            .err()
            .expect("second writer must fail");
        assert!(error.contains("another SQLite writer owns"));
        runtime.shutdown().unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(writer_lock_path(&path));
    }

    #[test]
    fn remote_transaction_excludes_other_clients_until_commit() {
        let path = temp_path("remote_transaction");
        let runtime = SqliteWriterRuntime::start(&path, 8, 8).unwrap();
        let handle = runtime.handle();
        handle
            .execute_for_client(
                "client-a".to_string(),
                TransactionControl::Begin,
                "test.begin",
                |connection| {
                    connection
                        .execute_batch("BEGIN IMMEDIATE")
                        .map_err(|error| error.to_string())
                },
            )
            .unwrap();

        let (finished_tx, finished_rx) = mpsc::channel();
        let other = handle.clone();
        let thread = thread::spawn(move || {
            let result = other.execute_for_client(
                "client-b".to_string(),
                TransactionControl::None,
                "test.other_client",
                |connection| {
                    connection
                        .execute(
                            "INSERT INTO settings(id, namespace, key, value) VALUES ('b', 'test', 'b', '{}')",
                            [],
                        )
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                },
            );
            let _ = finished_tx.send(result);
        });
        assert!(finished_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        handle
            .execute_for_client(
                "client-a".to_string(),
                TransactionControl::End,
                "test.commit",
                |connection| {
                    connection
                        .execute_batch("COMMIT")
                        .map_err(|error| error.to_string())
                },
            )
            .unwrap();
        finished_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        thread.join().unwrap();
        runtime.shutdown().unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(writer_lock_path(&path));
    }

    #[test]
    fn offline_backup_is_blocked_by_writer_and_succeeds_after_shutdown() {
        let path = temp_path("offline_backup");
        let output = path.with_extension("backup.sqlite");
        let runtime = SqliteWriterRuntime::start(&path, 4, 8).unwrap();
        assert!(is_writer_lock_held(&path).unwrap());
        assert!(create_offline_backup(&path, &output)
            .unwrap_err()
            .contains("requires the resident Writer to be stopped"));
        runtime.shutdown().unwrap();
        assert!(!is_writer_lock_held(&path).unwrap());
        assert!(create_offline_backup(&path, &output).unwrap() > 0);
        let backup =
            Connection::open_with_flags(&output, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let integrity: String = backup
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(writer_lock_path(&path));
    }
}
