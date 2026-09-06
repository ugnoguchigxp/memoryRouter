use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::domains::mcp_lifecycle::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput, CompileProjectIdentityTrust,
};

use super::helpers::non_empty;
use super::types::NegativeCoveringExecution;

pub(super) fn merge_applicability(origin: &Value, metadata: &Value, parsed: &Value) -> Value {
    let mut merged = serde_json::Map::new();
    for value in [origin, metadata, parsed] {
        let source = value
            .get("appliesTo")
            .or_else(|| value.get("applicability"))
            .unwrap_or(value);
        for key in ["technologies", "changeTypes", "domains"] {
            if let Some(items) = normalized_string_array(source.get(key)) {
                if !items.is_empty() {
                    merged.insert(key.to_string(), json!(items));
                }
            }
        }
        for key in ["projectRef", "repoPath", "repoKey"] {
            if let Some(text) = source
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                merged.insert(key.to_string(), json!(text));
            }
        }
        if let Some(general) = source.get("general").and_then(Value::as_bool) {
            merged.insert("general".to_string(), json!(general));
        }
    }
    for identity in [
        origin.get("projectIdentity"),
        metadata.get("projectIdentity"),
        metadata.pointer("/sourceMetadata/projectIdentity"),
    ]
    .into_iter()
    .flatten()
    {
        for key in ["projectRef", "repoPath", "repoKey"] {
            if let Some(text) = identity
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                merged.insert(key.to_string(), json!(text));
            }
        }
    }
    Value::Object(merged)
}

pub(super) fn merge_execution_applicability(
    execution: &NegativeCoveringExecution,
    parsed: &Value,
) -> Value {
    let mut metadata = execution.candidate_metadata.clone();
    if let Some(identity) = trusted_source_project_identity(&execution.source_metadata) {
        if let Some(object) = metadata.as_object_mut() {
            object.insert("projectIdentity".to_string(), identity);
        }
    }
    merge_applicability(&execution.candidate_origin, &metadata, parsed)
}

pub(super) fn trusted_source_project_identity(source_metadata: &Value) -> Option<Value> {
    let mut inputs = Vec::new();
    if let Some(identity) = source_metadata.get("projectIdentity") {
        inputs.push(CompileProjectIdentityInput {
            project_ref: string_property(identity, &["projectRef", "project_ref"]),
            repo_key: string_property(identity, &["repoKey", "repo_key"]),
            repo_path: string_property(identity, &["repoPath", "repo_path"]),
        });
    }
    if trusted_agent_log_source_metadata(source_metadata) {
        inputs.push(CompileProjectIdentityInput {
            project_ref: None,
            repo_key: None,
            repo_path: string_property(source_metadata, &["projectRoot"]),
        });
    }
    inputs.into_iter().find_map(|input| {
        let resolved = resolve_compile_project_identity(
            &input,
            CompileProjectIdentityTrust::TrustedAdapter,
            None,
        )
        .ok()?;
        resolved.match_value.as_ref()?;
        serde_json::to_value(resolved).ok()
    })
}

pub(super) fn trusted_agent_log_source_metadata(source_metadata: &Value) -> bool {
    if source_metadata
        .get("rustAgentLogSync")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return true;
    }
    string_property(source_metadata, &["kind"]).as_deref() == Some("agent_log_chunk")
        && string_property(source_metadata, &["sourceId"]).as_deref() == Some("codex_logs")
        && string_property(source_metadata, &["memoryPipeline"]).as_deref()
            == Some("raw_for_distillation")
        && (string_property(source_metadata, &["sessionFile"]).is_some()
            || source_metadata
                .get("sessionFiles")
                .and_then(Value::as_array)
                .is_some_and(|files| !files.is_empty()))
}

pub(super) fn string_property(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

pub(super) fn normalized_string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let values = match value? {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        Value::String(text) => text
            .split([',', '、', '，'])
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
        _ => return None,
    };
    Some(
        values
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    )
}

pub(super) fn required_applicability_present(value: &Value) -> bool {
    ["technologies", "changeTypes", "domains"]
        .iter()
        .all(|key| {
            value
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| non_empty(item.as_str())))
        })
}
