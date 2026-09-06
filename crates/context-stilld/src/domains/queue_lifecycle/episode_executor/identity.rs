use rusqlite::Connection;
use serde_json::Value;

use crate::domains::mcp_lifecycle::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput,
    CompileProjectIdentityMatchBasis, CompileProjectIdentityTrust, CONTRACT_VERSION,
};
use crate::shared::errors::CliError;

use super::helpers::{now_timestamp, pseudo_uuid};
use super::types::EpisodeWriteIdentity;

pub(super) fn project_identity_snapshot_string(
    snapshot: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, CliError> {
    match snapshot.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(CliError::io(format!(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.{key} must be a string or null"
        ))),
    }
}

pub(super) fn resolve_episode_write_identity(
    metadata: &Value,
) -> Result<EpisodeWriteIdentity, CliError> {
    let snapshot = metadata
        .get("projectIdentity")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            CliError::io(
                "PROJECT_IDENTITY_REQUIRED: episodeDistiller requires metadata.projectIdentity",
            )
        })?;
    if snapshot.get("contractVersion").and_then(Value::as_u64) != Some(CONTRACT_VERSION.into()) {
        return Err(CliError::io(format!(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.contractVersion must be {CONTRACT_VERSION}"
        )));
    }
    if snapshot.get("classificationStatus").and_then(Value::as_str) != Some("classified") {
        return Err(CliError::io(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.classificationStatus must be classified",
        ));
    }
    let scope = snapshot
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| matches!(*scope, "repo" | "global"))
        .ok_or_else(|| {
            CliError::io(
                "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.scope must be repo or global",
            )
        })?
        .to_string();
    let resolved = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: project_identity_snapshot_string(snapshot, "projectRef")?,
            repo_key: project_identity_snapshot_string(snapshot, "repoKey")?,
            repo_path: project_identity_snapshot_string(snapshot, "repoPath")?,
        },
        CompileProjectIdentityTrust::TrustedAdapter,
        None,
    )
    .map_err(|error| CliError::io(error.to_string()))?;
    if scope == "repo" && resolved.match_basis == CompileProjectIdentityMatchBasis::None {
        return Err(CliError::io(
            "PROJECT_IDENTITY_REQUIRED: repo-scoped episode writes require projectRef, repoKey, or an absolute repoPath",
        ));
    }
    if scope == "global" && resolved.match_basis != CompileProjectIdentityMatchBasis::None {
        return Err(CliError::io(
            "PROJECT_IDENTITY_FORBIDDEN: global episode writes must not carry project identity",
        ));
    }
    if snapshot.get("scopeMode").and_then(Value::as_str) != Some(resolved.scope_mode) {
        return Err(CliError::io(
            "PROJECT_IDENTITY_SNAPSHOT_INVALID: projectIdentity.scopeMode does not match its canonical identity",
        ));
    }
    Ok(EpisodeWriteIdentity { scope, resolved })
}

pub(super) fn record_episode_identity_event(
    connection: &Connection,
    event_type: &str,
    payload: Value,
) {
    let _ = connection.execute(
        "insert into audit_logs (id, event_type, actor, payload, created_at) values (?1, ?2, 'agent', ?3, ?4)",
        (pseudo_uuid(), event_type, payload.to_string(), now_timestamp()),
    );
}

pub(super) fn metadata_string_at(metadata: &Value, pointer: &str) -> Option<String> {
    metadata
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
