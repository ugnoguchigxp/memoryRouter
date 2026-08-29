use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub(crate) struct MemoryRecallContext {
    pub(crate) sqlite_core_path: PathBuf,
    pub(crate) project_ref: String,
    pub(crate) include_global: bool,
    pub(crate) deadline: Duration,
}
