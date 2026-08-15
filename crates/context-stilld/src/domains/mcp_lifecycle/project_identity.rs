use std::collections::HashSet;
use std::fmt;

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const CONTRACT_VERSION: u8 = 1;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompileProjectIdentityInput {
    pub(crate) project_ref: Option<String>,
    pub(crate) repo_key: Option<String>,
    pub(crate) repo_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CompileProjectIdentityTrust {
    RequestHint,
    #[allow(dead_code)] // Activated by the T7 trusted Security adapter.
    TrustedAdapter,
}

impl CompileProjectIdentityTrust {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RequestHint => "request_hint",
            Self::TrustedAdapter => "trusted_adapter",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CompileProjectIdentityMatchBasis {
    ProjectRef,
    RepoKey,
    RepoPath,
    None,
}

impl CompileProjectIdentityMatchBasis {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ProjectRef => "project_ref",
            Self::RepoKey => "repo_key",
            Self::RepoPath => "repo_path",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CompileProjectIdentityBindingStatus {
    Verified,
    NotApplicable,
    Unverified,
}

impl CompileProjectIdentityBindingStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::NotApplicable => "not_applicable",
            Self::Unverified => "unverified",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedCompileProjectIdentity {
    pub(crate) contract_version: u8,
    pub(crate) scope_mode: &'static str,
    pub(crate) match_basis: CompileProjectIdentityMatchBasis,
    pub(crate) match_value: Option<String>,
    pub(crate) project_ref: Option<String>,
    pub(crate) repo_key: Option<String>,
    pub(crate) repo_path: Option<String>,
    pub(crate) identity_fingerprint: Option<String>,
    pub(crate) trust: CompileProjectIdentityTrust,
    pub(crate) binding_status: CompileProjectIdentityBindingStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompileProjectIdentityAlias {
    pub(crate) project_ref: String,
    pub(crate) alias_kind: CompileProjectIdentityAliasKind,
    pub(crate) normalized_value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompileProjectIdentityAliasKind {
    RepoKey,
    RepoPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompileProjectIdentityErrorCode {
    InvalidProjectRef,
    InvalidRepoKey,
    InvalidRepoPath,
    IdentityConflict,
}

impl CompileProjectIdentityErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidProjectRef => "INVALID_PROJECT_REF",
            Self::InvalidRepoKey => "INVALID_REPO_KEY",
            Self::InvalidRepoPath => "INVALID_REPO_PATH",
            Self::IdentityConflict => "IDENTITY_CONFLICT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CompileProjectIdentityError {
    pub(crate) code: CompileProjectIdentityErrorCode,
    message: String,
}

impl CompileProjectIdentityError {
    fn new(code: CompileProjectIdentityErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for CompileProjectIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

fn valid_text(
    raw: Option<&str>,
    code: CompileProjectIdentityErrorCode,
    label: &str,
    max_length: usize,
) -> Result<Option<String>, CompileProjectIdentityError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.chars().any(char::is_control) {
        return Err(CompileProjectIdentityError::new(
            code,
            format!("{label} contains control characters"),
        ));
    }
    let value =
        raw.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if value.is_empty() || value.chars().count() > max_length {
        return Err(CompileProjectIdentityError::new(
            code,
            format!("{label} must contain 1-{max_length} characters"),
        ));
    }
    Ok(Some(value.to_string()))
}

pub(crate) fn normalize_project_ref(
    value: Option<&str>,
) -> Result<Option<String>, CompileProjectIdentityError> {
    valid_text(
        value,
        CompileProjectIdentityErrorCode::InvalidProjectRef,
        "projectRef",
        256,
    )
}

pub(crate) fn normalize_repo_key(
    value: Option<&str>,
) -> Result<Option<String>, CompileProjectIdentityError> {
    let Some(value) = valid_text(
        value,
        CompileProjectIdentityErrorCode::InvalidRepoKey,
        "repoKey",
        1024,
    )?
    else {
        return Ok(None);
    };
    let mut normalized = String::with_capacity(value.len());
    let mut previous_separator = false;
    for character in value.chars() {
        let character = if character == '\\' { '/' } else { character };
        if character == '/' {
            if !previous_separator {
                normalized.push('/');
            }
            previous_separator = true;
            continue;
        }
        previous_separator = false;
        if character.is_ascii_uppercase() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push(character);
        }
    }
    Ok(Some(normalized))
}

fn is_windows_drive_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len()
            || !bytes[index + 1].is_ascii_hexdigit()
            || !bytes[index + 2].is_ascii_hexdigit()
        {
            return false;
        }
        index += 3;
    }
    true
}

fn normalize_absolute_segments(value: &str, windows_drive: bool) -> String {
    let slash_normalized = value.replace('\\', "/");
    let (prefix, remainder) = if windows_drive {
        (&slash_normalized[..2], &slash_normalized[2..])
    } else {
        ("", slash_normalized.as_str())
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in remainder.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    if windows_drive {
        if segments.is_empty() {
            format!("{prefix}/")
        } else {
            format!("{prefix}/{}", segments.join("/"))
        }
    } else if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    }
}

pub(crate) fn normalize_repo_path(
    value: Option<&str>,
) -> Result<Option<String>, CompileProjectIdentityError> {
    let Some(value) = valid_text(
        value,
        CompileProjectIdentityErrorCode::InvalidRepoPath,
        "repoPath",
        4096,
    )?
    else {
        return Ok(None);
    };

    let mut path_value = value.clone();
    if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        let url = reqwest::Url::parse(&value).map_err(|_| {
            CompileProjectIdentityError::new(
                CompileProjectIdentityErrorCode::InvalidRepoPath,
                "repoPath is not a valid file URI",
            )
        })?;
        let local_host = url
            .host_str()
            .is_none_or(|host| host.is_empty() || host.eq_ignore_ascii_case("localhost"));
        if url.scheme() != "file"
            || !url.username().is_empty()
            || url.password().is_some()
            || !local_host
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(CompileProjectIdentityError::new(
                CompileProjectIdentityErrorCode::InvalidRepoPath,
                "repoPath file URI must be local, absolute, and omit query/hash",
            ));
        }
        if !valid_percent_encoding(url.path()) {
            return Err(CompileProjectIdentityError::new(
                CompileProjectIdentityErrorCode::InvalidRepoPath,
                "repoPath file URI contains malformed percent encoding",
            ));
        }
        path_value = percent_decode_str(url.path())
            .decode_utf8()
            .map_err(|_| {
                CompileProjectIdentityError::new(
                    CompileProjectIdentityErrorCode::InvalidRepoPath,
                    "repoPath file URI is not valid UTF-8",
                )
            })?
            .into_owned();
        if path_value.len() >= 4
            && path_value.starts_with('/')
            && is_windows_drive_absolute(&path_value[1..])
        {
            path_value.remove(0);
        }
    } else if !is_windows_drive_absolute(&value) {
        if let Some(colon) = value.find(':') {
            let scheme = &value[..colon];
            if !scheme.is_empty()
                && scheme.chars().enumerate().all(|(index, character)| {
                    if index == 0 {
                        character.is_ascii_alphabetic()
                    } else {
                        character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
                    }
                })
            {
                return Err(CompileProjectIdentityError::new(
                    CompileProjectIdentityErrorCode::InvalidRepoPath,
                    "repoPath URI must use the file scheme",
                ));
            }
        }
    }

    if path_value.chars().any(char::is_control) {
        return Err(CompileProjectIdentityError::new(
            CompileProjectIdentityErrorCode::InvalidRepoPath,
            "repoPath contains control characters",
        ));
    }
    if is_windows_drive_absolute(&path_value) {
        return Ok(Some(normalize_absolute_segments(&path_value, true)));
    }
    if path_value.starts_with('/') {
        return Ok(Some(normalize_absolute_segments(&path_value, false)));
    }
    Err(CompileProjectIdentityError::new(
        CompileProjectIdentityErrorCode::InvalidRepoPath,
        "repoPath must be absolute",
    ))
}

fn identity_fingerprint(
    basis: CompileProjectIdentityMatchBasis,
    value: Option<&str>,
) -> Option<String> {
    let value = value?;
    if basis == CompileProjectIdentityMatchBasis::None {
        return None;
    }
    let basis = basis.as_str();
    Some(format!(
        "{:x}",
        Sha256::digest(format!("{CONTRACT_VERSION}\0{basis}\0{value}").as_bytes())
    ))
}

fn binding_status(
    project_ref: Option<&str>,
    repo_key: Option<&str>,
    repo_path: Option<&str>,
    aliases: Option<&[CompileProjectIdentityAlias]>,
) -> Result<CompileProjectIdentityBindingStatus, CompileProjectIdentityError> {
    let identity_count = [project_ref, repo_key, repo_path]
        .into_iter()
        .flatten()
        .count();
    if identity_count <= 1 {
        return Ok(CompileProjectIdentityBindingStatus::NotApplicable);
    }
    let Some(aliases) = aliases else {
        return Ok(CompileProjectIdentityBindingStatus::Unverified);
    };
    let mut project_refs: HashSet<&str> = HashSet::new();
    if let Some(project_ref) = project_ref {
        project_refs.insert(project_ref);
    }
    for alias in aliases {
        if (alias.alias_kind == CompileProjectIdentityAliasKind::RepoKey
            && Some(alias.normalized_value.as_str()) == repo_key)
            || (alias.alias_kind == CompileProjectIdentityAliasKind::RepoPath
                && Some(alias.normalized_value.as_str()) == repo_path)
        {
            project_refs.insert(alias.project_ref.as_str());
        }
    }
    if project_refs.len() != 1 {
        return Err(CompileProjectIdentityError::new(
            CompileProjectIdentityErrorCode::IdentityConflict,
            "compile project identity aliases do not resolve to one project",
        ));
    }
    let resolved_project_ref = project_refs.into_iter().next().unwrap_or_default();
    let alias_matches = |kind: CompileProjectIdentityAliasKind, value: Option<&str>| {
        value.is_none_or(|value| {
            aliases.iter().any(|alias| {
                alias.project_ref == resolved_project_ref
                    && alias.alias_kind == kind
                    && alias.normalized_value == value
            })
        })
    };
    if !alias_matches(CompileProjectIdentityAliasKind::RepoKey, repo_key)
        || !alias_matches(CompileProjectIdentityAliasKind::RepoPath, repo_path)
    {
        return Err(CompileProjectIdentityError::new(
            CompileProjectIdentityErrorCode::IdentityConflict,
            "compile project identity contains an unbound alias",
        ));
    }
    Ok(CompileProjectIdentityBindingStatus::Verified)
}

pub(crate) fn resolve_compile_project_identity(
    input: &CompileProjectIdentityInput,
    trust: CompileProjectIdentityTrust,
    aliases: Option<&[CompileProjectIdentityAlias]>,
) -> Result<ResolvedCompileProjectIdentity, CompileProjectIdentityError> {
    let project_ref = normalize_project_ref(input.project_ref.as_deref())?;
    let repo_key = normalize_repo_key(input.repo_key.as_deref())?;
    let repo_path = normalize_repo_path(input.repo_path.as_deref())?;
    let binding_status = binding_status(
        project_ref.as_deref(),
        repo_key.as_deref(),
        repo_path.as_deref(),
        aliases,
    )?;
    let (match_basis, match_value) = if let Some(value) = project_ref.as_ref() {
        (
            CompileProjectIdentityMatchBasis::ProjectRef,
            Some(value.clone()),
        )
    } else if let Some(value) = repo_key.as_ref() {
        (
            CompileProjectIdentityMatchBasis::RepoKey,
            Some(value.clone()),
        )
    } else if let Some(value) = repo_path.as_ref() {
        (
            CompileProjectIdentityMatchBasis::RepoPath,
            Some(value.clone()),
        )
    } else {
        (CompileProjectIdentityMatchBasis::None, None)
    };
    Ok(ResolvedCompileProjectIdentity {
        contract_version: CONTRACT_VERSION,
        scope_mode: if match_basis == CompileProjectIdentityMatchBasis::None {
            "global_only"
        } else {
            "project"
        },
        match_basis,
        identity_fingerprint: identity_fingerprint(match_basis, match_value.as_deref()),
        match_value,
        project_ref,
        repo_key,
        repo_path,
        trust,
        binding_status,
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::*;

    #[derive(Deserialize)]
    struct Fixture {
        valid: Vec<ValidCase>,
        invalid: Vec<InvalidCase>,
    }

    #[derive(Deserialize)]
    struct ValidCase {
        name: String,
        input: CompileProjectIdentityInput,
        expected: Value,
    }

    #[derive(Deserialize)]
    struct InvalidCase {
        name: String,
        input: CompileProjectIdentityInput,
        code: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/context-compile-project-identity.json"
        )))
        .expect("identity fixture must parse")
    }

    #[test]
    fn shared_valid_fixture_matches_typescript_contract() {
        for case in fixture().valid {
            let result = resolve_compile_project_identity(
                &case.input,
                CompileProjectIdentityTrust::RequestHint,
                None,
            )
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
            let actual = serde_json::to_value(result).expect("resolved identity serializes");
            for (key, expected) in case.expected.as_object().expect("expected is object") {
                assert_eq!(actual.get(key), Some(expected), "{}: {key}", case.name);
            }
            if actual["matchBasis"] == "none" {
                assert!(actual["identityFingerprint"].is_null());
            } else {
                assert_eq!(
                    actual["identityFingerprint"].as_str().map(str::len),
                    Some(64)
                );
            }
        }
    }

    #[test]
    fn shared_invalid_fixture_fails_closed() {
        for case in fixture().invalid {
            let error = resolve_compile_project_identity(
                &case.input,
                CompileProjectIdentityTrust::RequestHint,
                None,
            )
            .expect_err(&case.name);
            assert_eq!(error.code.as_str(), case.code, "{}", case.name);
        }
    }

    #[test]
    fn authoritative_aliases_verify_or_reject_multiple_identifiers() {
        let input = CompileProjectIdentityInput {
            project_ref: Some("project-A".to_string()),
            repo_key: Some("ORG/Repo-A".to_string()),
            repo_path: Some("/work/repo-a".to_string()),
        };
        let aliases = vec![
            CompileProjectIdentityAlias {
                project_ref: "project-A".to_string(),
                alias_kind: CompileProjectIdentityAliasKind::RepoKey,
                normalized_value: "org/repo-a".to_string(),
            },
            CompileProjectIdentityAlias {
                project_ref: "project-A".to_string(),
                alias_kind: CompileProjectIdentityAliasKind::RepoPath,
                normalized_value: "/work/repo-a".to_string(),
            },
        ];
        let resolved = resolve_compile_project_identity(
            &input,
            CompileProjectIdentityTrust::RequestHint,
            Some(&aliases),
        )
        .expect("aliases agree");
        assert_eq!(
            resolved.binding_status,
            CompileProjectIdentityBindingStatus::Verified
        );

        let conflicting = vec![CompileProjectIdentityAlias {
            project_ref: "project-B".to_string(),
            alias_kind: CompileProjectIdentityAliasKind::RepoPath,
            normalized_value: "/work/repo-a".to_string(),
        }];
        let error = resolve_compile_project_identity(
            &input,
            CompileProjectIdentityTrust::RequestHint,
            Some(&conflicting),
        )
        .expect_err("aliases conflict");
        assert_eq!(
            error.code,
            CompileProjectIdentityErrorCode::IdentityConflict
        );
    }

    #[test]
    fn trusted_adapter_is_serialized_without_changing_selection_precedence() {
        let resolved = resolve_compile_project_identity(
            &CompileProjectIdentityInput {
                project_ref: Some("project-A".to_string()),
                ..Default::default()
            },
            CompileProjectIdentityTrust::TrustedAdapter,
            None,
        )
        .expect("trusted identity resolves");
        assert_eq!(resolved.trust, CompileProjectIdentityTrust::TrustedAdapter);
        assert_eq!(
            resolved.match_basis,
            CompileProjectIdentityMatchBasis::ProjectRef
        );
    }

    #[test]
    fn length_limits_count_unicode_code_points() {
        let accepted = resolve_compile_project_identity(
            &CompileProjectIdentityInput {
                project_ref: Some("😀".repeat(256)),
                ..Default::default()
            },
            CompileProjectIdentityTrust::RequestHint,
            None,
        )
        .expect("256 Unicode code points are accepted");
        assert_eq!(
            accepted
                .project_ref
                .as_deref()
                .map(|value| value.chars().count()),
            Some(256)
        );

        let error = resolve_compile_project_identity(
            &CompileProjectIdentityInput {
                project_ref: Some("😀".repeat(257)),
                ..Default::default()
            },
            CompileProjectIdentityTrust::RequestHint,
            None,
        )
        .expect_err("257 Unicode code points must be rejected");
        assert_eq!(
            error.code,
            CompileProjectIdentityErrorCode::InvalidProjectRef
        );
    }
}
