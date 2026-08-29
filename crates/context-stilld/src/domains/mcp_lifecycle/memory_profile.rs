use std::path::{Path, PathBuf};

use crate::shared::{config::EnvProvider, errors::CliError};

use super::memory_recall_context::MemoryRecallContext;

pub(crate) const MEMORY_CONTRACT_VERSION: &str = "memory-recall-v1";
pub(crate) const MEMORY_PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum ToolProfile {
    Default,
    TypedMemory,
}

impl ToolProfile {
    pub(crate) fn from_env<E: EnvProvider>(env: &E) -> Result<Self, CliError> {
        match env
            .var("CONTEXT_STILL_MCP_TOOL_PROFILE")
            .unwrap_or_else(|| "default".to_string())
            .as_str()
        {
            "default" => Ok(Self::Default),
            "typed-memory" => Ok(Self::TypedMemory),
            value => Err(CliError::invalid_arguments(format!(
                "CONTEXT_STILL_MCP_TOOL_PROFILE must be default or typed-memory, got {value}"
            ))),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::TypedMemory => "typed-memory",
        }
    }
}

pub(crate) fn memory_context_from_env<E: EnvProvider>(
    env: &E,
) -> Result<MemoryRecallContext, CliError> {
    let project_ref = env
        .var("CONTEXT_STILL_MCP_MEMORY_PROJECT_REF")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CliError::invalid_arguments(
                "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF is required for typed-memory",
            )
        })?;
    if project_ref.trim() != project_ref {
        return Err(CliError::invalid_arguments(
            "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF must not have leading or trailing whitespace",
        ));
    }
    validate_text(&project_ref, 256, "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF")?;

    let contract = env
        .var("CONTEXT_STILL_MCP_MEMORY_CONTRACT")
        .unwrap_or_else(|| MEMORY_CONTRACT_VERSION.to_string());
    if contract != MEMORY_CONTRACT_VERSION {
        return Err(CliError::invalid_arguments(format!(
            "CONTEXT_STILL_MCP_MEMORY_CONTRACT must be {MEMORY_CONTRACT_VERSION}"
        )));
    }

    let include_global = match env
        .var("CONTEXT_STILL_MCP_MEMORY_INCLUDE_GLOBAL")
        .unwrap_or_else(|| "false".to_string())
        .as_str()
    {
        "true" => true,
        "false" => false,
        _ => {
            return Err(CliError::invalid_arguments(
                "CONTEXT_STILL_MCP_MEMORY_INCLUDE_GLOBAL must be true or false",
            ))
        }
    };

    let sqlite_core_path = env
        .var("CONTEXT_STILL_SQLITE_CORE_PATH")
        .map(PathBuf::from)
        .ok_or_else(|| {
            CliError::invalid_arguments(
                "CONTEXT_STILL_SQLITE_CORE_PATH is required for typed-memory",
            )
        })?;
    validate_database_path(&sqlite_core_path)?;

    Ok(MemoryRecallContext {
        sqlite_core_path,
        project_ref,
        include_global,
        deadline: std::time::Duration::from_secs(1),
    })
}

fn validate_text(value: &str, max: usize, name: &str) -> Result<(), CliError> {
    if value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(CliError::invalid_arguments(format!(
            "{name} must contain 1-{max} Unicode scalars without control characters"
        )));
    }
    Ok(())
}

fn validate_database_path(path: &Path) -> Result<(), CliError> {
    if !path.is_absolute() {
        return Err(CliError::invalid_arguments(
            "CONTEXT_STILL_SQLITE_CORE_PATH must be absolute for typed-memory",
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        CliError::invalid_arguments(format!(
            "typed-memory SQLite database must already exist: {error}"
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CliError::invalid_arguments(
            "typed-memory SQLite database must be a regular non-symlink file",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        CliError::invalid_arguments("typed-memory SQLite database must have a parent directory")
    })?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        CliError::invalid_arguments(format!(
            "failed to inspect SQLite parent directory: {error}"
        ))
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(CliError::invalid_arguments(
            "typed-memory SQLite parent must be a regular non-symlink directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode = parent_metadata.permissions().mode();
        let effective_uid = unsafe { libc::geteuid() };
        if metadata.uid() != effective_uid || parent_metadata.uid() != effective_uid {
            return Err(CliError::invalid_arguments(
                "typed-memory SQLite database and parent directory must be owned by the current user",
            ));
        }
        if mode & 0o077 != 0 {
            return Err(CliError::invalid_arguments(
                "typed-memory SQLite parent directory must be owner-only (mode 0700 or stricter)",
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(CliError::invalid_arguments(
            "typed-memory cannot verify owner-only SQLite permissions on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::config::MapEnv;
    use std::collections::HashMap;

    #[test]
    fn rejects_unknown_profile() {
        let env = MapEnv::new(HashMap::from([(
            "CONTEXT_STILL_MCP_TOOL_PROFILE".to_string(),
            "wide-open".to_string(),
        )]));
        assert!(ToolProfile::from_env(&env).is_err());
    }

    #[test]
    fn profile_name_is_not_silently_trimmed() {
        let env = MapEnv::new(HashMap::from([(
            "CONTEXT_STILL_MCP_TOOL_PROFILE".to_string(),
            " typed-memory".to_string(),
        )]));
        assert!(ToolProfile::from_env(&env).is_err());
    }

    #[test]
    fn project_ref_is_not_silently_normalized() {
        let env = MapEnv::new(HashMap::from([
            (
                "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF".to_string(),
                " project-a".to_string(),
            ),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH".to_string(),
                "/not/used/because/project-ref-fails-first".to_string(),
            ),
        ]));
        assert!(memory_context_from_env(&env)
            .err()
            .unwrap()
            .to_string()
            .contains("leading or trailing whitespace"));
    }

    #[cfg(unix)]
    #[test]
    fn database_parent_must_not_be_visible_to_group_or_world() {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "context_still_memory_profile_permissions_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        let database = directory.join("memory.sqlite");
        std::fs::write(&database, []).unwrap();
        let env = MapEnv::new(HashMap::from([
            (
                "CONTEXT_STILL_MCP_MEMORY_PROJECT_REF".to_string(),
                "project-a".to_string(),
            ),
            (
                "CONTEXT_STILL_SQLITE_CORE_PATH".to_string(),
                database.to_string_lossy().into_owned(),
            ),
        ]));
        assert!(memory_context_from_env(&env)
            .err()
            .unwrap()
            .to_string()
            .contains("owner-only"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
