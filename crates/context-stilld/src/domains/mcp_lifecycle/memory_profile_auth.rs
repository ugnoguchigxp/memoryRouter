use std::{io::Write, path::Path};

use crate::shared::errors::CliError;

pub(crate) fn protect_owner_only_directory(path: &Path, label: &str) -> Result<(), CliError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| CliError::io(format!("failed to inspect {label}: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CliError::io(format!(
            "refusing non-directory or symlink {label} path"
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(CliError::io(format!(
                "refusing {label} owned by another user"
            )));
        }
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| CliError::io(format!("failed to protect {label}: {error}")))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(CliError::io(format!(
            "typed-memory cannot enforce owner-only permissions for {label} on this platform"
        )))
    }
}

pub(crate) fn create_bearer_token(path: &Path) -> Result<String, CliError> {
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy)
        .map_err(|error| CliError::io(format!("failed to generate MCP bearer token: {error}")))?;
    let token = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    write_owner_only(path, &format!("{token}\n"), "MCP bearer token")?;
    Ok(token)
}

pub(crate) fn write_owner_only(path: &Path, content: &str, label: &str) -> Result<(), CliError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CliError::io(format!(
                "refusing non-regular or symlink {label} path"
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(CliError::io(format!(
                    "refusing {label} path owned by another user"
                )));
            }
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CliError::io(format!("failed to open {label}: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| CliError::io(format!("failed to protect {label}: {error}")))?;
    }
    file.write_all(content.as_bytes())
        .map_err(|error| CliError::io(format!("failed to write {label}: {error}")))?;
    Ok(())
}

pub(crate) fn constant_time_bearer_matches(header: Option<&str>, expected: &str) -> bool {
    let supplied = header
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .as_bytes();
    let expected = expected.as_bytes();
    if supplied.len() != expected.len() {
        return false;
    }
    supplied
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_comparison_is_exact() {
        assert!(constant_time_bearer_matches(
            Some("Bearer secret"),
            "secret"
        ));
        assert!(!constant_time_bearer_matches(
            Some("bearer secret"),
            "secret"
        ));
        assert!(!constant_time_bearer_matches(
            Some("Bearer secret "),
            "secret"
        ));
        assert!(!constant_time_bearer_matches(None, "secret"));
    }

    #[test]
    fn bearer_token_is_rotated_on_each_creation() {
        let directory = std::env::temp_dir().join(format!(
            "context_still_auth_rotation_{}_{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("token");
        let first = create_bearer_token(&path).unwrap();
        let second = create_bearer_token(&path).unwrap();
        assert_ne!(first, second);
        assert_eq!(second.len(), 64);
        assert!(second
            .chars()
            .all(|character| character.is_ascii_hexdigit()));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{second}\n")
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_directory_is_tightened_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = std::env::temp_dir().join(format!(
            "context_still_owner_directory_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o755)).unwrap();
        protect_owner_only_directory(&directory, "test directory").unwrap();
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let link = directory.with_extension("link");
        let _ = std::fs::remove_file(&link);
        symlink(&directory, &link).unwrap();
        assert!(protect_owner_only_directory(&link, "test directory").is_err());
        let _ = std::fs::remove_file(link);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_writer_refuses_symlink_targets() {
        use std::os::unix::fs::symlink;
        let directory =
            std::env::temp_dir().join(format!("context_still_auth_symlink_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("target");
        let link = directory.join("token");
        std::fs::write(&target, "unchanged").unwrap();
        symlink(&target, &link).unwrap();
        assert!(write_owner_only(&link, "secret", "test token").is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "unchanged");
        let _ = std::fs::remove_dir_all(directory);
    }
}
