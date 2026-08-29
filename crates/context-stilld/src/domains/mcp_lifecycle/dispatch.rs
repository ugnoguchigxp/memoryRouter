use std::{path::PathBuf, sync::Arc};

#[derive(Clone)]
pub(crate) enum DispatchConfig {
    Default {
        project_root: PathBuf,
        sqlite_core_path: PathBuf,
        writer_token: String,
        compile_runtime: Arc<crate::domains::context_compile::runtime::CompileRuntimeContext>,
    },
    TypedMemory {
        context: super::memory_recall_context::MemoryRecallContext,
        bearer_token: String,
        expected_host: String,
    },
}

impl DispatchConfig {
    pub(crate) fn is_typed_memory(&self) -> bool {
        matches!(self, Self::TypedMemory { .. })
    }

    pub(crate) fn native_context(&self) -> Option<super::native_tools::NativeToolContext> {
        match self {
            Self::Default {
                project_root,
                sqlite_core_path,
                compile_runtime,
                ..
            } => Some(super::native_tools::NativeToolContext {
                project_root: project_root.clone(),
                sqlite_core_path: sqlite_core_path.clone(),
                compile_runtime: Arc::clone(compile_runtime),
            }),
            Self::TypedMemory { .. } => None,
        }
    }

    pub(crate) fn writer(&self) -> Option<(&PathBuf, &str)> {
        match self {
            Self::Default {
                sqlite_core_path,
                writer_token,
                ..
            } => Some((sqlite_core_path, writer_token)),
            Self::TypedMemory { .. } => None,
        }
    }

    pub(crate) fn memory_context(
        &self,
    ) -> Option<&super::memory_recall_context::MemoryRecallContext> {
        match self {
            Self::TypedMemory { context, .. } => Some(context),
            Self::Default { .. } => None,
        }
    }

    pub(crate) fn bearer_auth(&self) -> Option<(&str, &str)> {
        match self {
            Self::TypedMemory {
                bearer_token,
                expected_host,
                ..
            } => Some((bearer_token, expected_host)),
            Self::Default { .. } => None,
        }
    }
}
