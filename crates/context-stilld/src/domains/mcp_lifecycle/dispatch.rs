use std::path::PathBuf;

#[derive(Debug, Clone)]
pub(crate) struct DispatchConfig {
    pub(crate) project_root: PathBuf,
    pub(crate) sqlite_core_path: PathBuf,
    pub(crate) writer_token: String,
}
