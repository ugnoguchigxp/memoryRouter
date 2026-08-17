use std::{path::PathBuf, sync::Arc};

#[derive(Debug, Clone)]
pub(crate) struct DispatchConfig {
    pub(crate) project_root: PathBuf,
    pub(crate) sqlite_core_path: PathBuf,
    pub(crate) writer_token: String,
    pub(crate) compile_runtime:
        Arc<crate::domains::context_compile::runtime::CompileRuntimeContext>,
}
