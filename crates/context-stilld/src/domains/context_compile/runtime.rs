use std::path::PathBuf;

#[cfg(test)]
use std::path::Path;

use crate::domains::runtime_identity::{self, DatabaseIdentitySource, EffectiveDatabaseIdentity};
use crate::shared::config::EnvProvider;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CompileFoundationMode {
    Legacy,
    SplitLegacyRank,
    SplitShadowRank,
    Foundation,
}

impl CompileFoundationMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "legacy" => Ok(Self::Legacy),
            "split_legacy_rank" => Ok(Self::SplitLegacyRank),
            "split_shadow_rank" => Ok(Self::SplitShadowRank),
            "foundation" => Ok(Self::Foundation),
            _ => Err("CONTEXT_STILL_COMPILE_FOUNDATION_MODE must be legacy, split_legacy_rank, split_shadow_rank, or foundation".to_string()),
        }
    }

    pub fn from_env<E: EnvProvider>(env: &E) -> Result<Self, String> {
        Self::parse(
            &env.var("CONTEXT_STILL_COMPILE_FOUNDATION_MODE")
                .unwrap_or_else(|| "legacy".to_string()),
        )
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::SplitLegacyRank => "split_legacy_rank",
            Self::SplitShadowRank => "split_shadow_rank",
            Self::Foundation => "foundation",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompileRuntimeContext {
    pub mode: CompileFoundationMode,
    pub runtime_build_id: String,
    pub database_identity_source: DatabaseIdentitySource,
    pub database_identity_fingerprint: String,
    pub logs_dir: PathBuf,
}

impl CompileRuntimeContext {
    pub fn new(
        mode: CompileFoundationMode,
        database_identity: &EffectiveDatabaseIdentity,
        logs_dir: PathBuf,
    ) -> Result<Self, String> {
        if database_identity.fingerprint.is_empty() || runtime_identity::build_id().is_empty() {
            return Err("runtime identity/build ID is unavailable".to_string());
        }
        std::fs::create_dir_all(logs_dir.join("context-compile-foundation"))
            .map_err(|error| format!("failed to create Foundation telemetry directory: {error}"))?;
        Ok(Self {
            mode,
            runtime_build_id: runtime_identity::build_id(),
            database_identity_source: database_identity.source,
            database_identity_fingerprint: database_identity.fingerprint.clone(),
            logs_dir,
        })
    }

    #[cfg(test)]
    pub fn for_test(sqlite_core_path: &Path) -> Self {
        Self {
            mode: CompileFoundationMode::Legacy,
            runtime_build_id: runtime_identity::build_id(),
            database_identity_source: DatabaseIdentitySource::ExplicitEnvironment,
            database_identity_fingerprint: runtime_identity::service::fingerprint(sqlite_core_path),
            logs_dir: sqlite_core_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("logs"),
        }
    }
}
