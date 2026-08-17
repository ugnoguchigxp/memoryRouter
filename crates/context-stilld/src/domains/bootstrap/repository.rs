use std::path::PathBuf;

use crate::shared::{config::EnvProvider, fs_paths};

pub fn read_app_data_dir<E: EnvProvider>(env: &E) -> PathBuf {
    if let Some(value) = env.var("CONTEXT_STILL_APP_DATA_DIR") {
        return PathBuf::from(value);
    }
    fs_paths::default_app_data_dir(env)
}

pub fn read_sqlite_core_path<E: EnvProvider>(env: &E, app_data_dir: &std::path::Path) -> PathBuf {
    if let Some(value) = env
        .var("CONTEXT_STILL_SQLITE_CORE_PATH")
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(value);
    }
    app_data_dir.join("context-still-core.sqlite")
}
