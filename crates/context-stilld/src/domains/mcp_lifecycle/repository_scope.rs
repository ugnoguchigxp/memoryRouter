use rusqlite::params_from_iter;
use serde_json::{json, Value};

use super::project_identity::{CompileProjectIdentityMatchBasis, ResolvedCompileProjectIdentity};

#[derive(Debug, Clone, Default)]
pub(crate) struct RepositoryRequestFacets {
    pub(crate) technologies: Vec<String>,
    pub(crate) change_types: Vec<String>,
    pub(crate) domains: Vec<String>,
}

impl RepositoryRequestFacets {
    pub(crate) fn is_empty(&self) -> bool {
        self.technologies.is_empty() && self.change_types.is_empty() && self.domains.is_empty()
    }
}

pub(crate) fn optional_string_array(
    args: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, String> {
    let Some(value) = args.get(key) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(format!("{key} must be an array of non-empty strings"));
    };
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .ok_or_else(|| format!("{key} must contain only non-empty strings"))
        })
        .collect()
}

pub(crate) fn identity_input_from_args(
    args: &serde_json::Map<String, Value>,
) -> Result<super::project_identity::CompileProjectIdentityInput, String> {
    let optional_string = |key: &str| match args.get(key) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    };
    Ok(super::project_identity::CompileProjectIdentityInput {
        project_ref: optional_string("projectRef")?,
        repo_key: optional_string("repoKey")?,
        repo_path: optional_string("repoPath")?,
    })
}

pub(crate) fn request_facets_from_args(
    args: &serde_json::Map<String, Value>,
) -> Result<RepositoryRequestFacets, String> {
    Ok(RepositoryRequestFacets {
        technologies: optional_string_array(args, "technologies")?,
        change_types: optional_string_array(args, "changeTypes")?,
        domains: optional_string_array(args, "domains")?,
    })
}

pub(crate) fn eligible_scope_clause(
    identity: &ResolvedCompileProjectIdentity,
) -> (&'static str, Vec<String>) {
    match identity.match_basis {
        CompileProjectIdentityMatchBasis::ProjectRef => (
            "classification_status = 'classified' and ((scope = 'global' and project_ref is null and repo_key is null and repo_path is null) or (scope = 'repo' and project_ref = ?1))",
            identity.project_ref.iter().cloned().collect(),
        ),
        CompileProjectIdentityMatchBasis::RepoKey => (
            "classification_status = 'classified' and ((scope = 'global' and project_ref is null and repo_key is null and repo_path is null) or (scope = 'repo' and repo_key = ?1))",
            identity.repo_key.iter().cloned().collect(),
        ),
        CompileProjectIdentityMatchBasis::RepoPath => (
            "classification_status = 'classified' and ((scope = 'global' and project_ref is null and repo_key is null and repo_path is null) or (scope = 'repo' and repo_path = ?1))",
            identity.repo_path.iter().cloned().collect(),
        ),
        CompileProjectIdentityMatchBasis::None => (
            "classification_status = 'classified' and (scope = 'global' and project_ref is null and repo_key is null and repo_path is null)",
            Vec::new(),
        ),
    }
}

pub(crate) fn query_params(values: &[String]) -> impl rusqlite::Params + '_ {
    params_from_iter(values.iter())
}

fn normalize_facet_value(value: &str) -> String {
    let mut normalized = String::new();
    for character in value.trim().chars().flat_map(char::to_lowercase) {
        let mapped = if character.is_whitespace() || character == '_' {
            '-'
        } else if character.is_alphanumeric() || matches!(character, '.' | '/' | '+' | '#' | '-') {
            character
        } else {
            '-'
        };
        if mapped == '-' {
            if !normalized.is_empty() && !normalized.ends_with('-') {
                normalized.push('-');
            }
        } else {
            normalized.push(mapped);
        }
    }
    if normalized.ends_with('-') {
        normalized.pop();
    }
    normalized
}

fn normalized(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| normalize_facet_value(value))
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn facet_values_intersect(left: &[String], right: &[String]) -> bool {
    let right = normalized(right);
    normalized(left).iter().any(|value| right.contains(value))
}

pub(crate) fn facets_allow(
    request: &RepositoryRequestFacets,
    candidate_technologies: &[String],
    candidate_change_types: &[String],
    candidate_domains: &[String],
    general: bool,
) -> bool {
    if request.is_empty() || general {
        return true;
    }
    facet_values_intersect(&request.technologies, candidate_technologies)
        || facet_values_intersect(&request.change_types, candidate_change_types)
        || facet_values_intersect(&request.domains, candidate_domains)
}

pub(crate) fn json_string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect()
}

pub(crate) fn applicability_general(
    applicability: &Value,
    technologies: &[String],
    change_types: &[String],
    domains: &[String],
) -> bool {
    match applicability.get("general").and_then(Value::as_bool) {
        Some(value) => value,
        None => technologies.is_empty() && change_types.is_empty() && domains.is_empty(),
    }
}

pub(crate) fn parse_json_object(raw: &str) -> Value {
    serde_json::from_str(raw)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

pub(crate) fn scope_snapshot(
    identity: &ResolvedCompileProjectIdentity,
    item_scope: &str,
    _project_ref: Option<&str>,
    _repo_key: Option<&str>,
    _repo_path: Option<&str>,
) -> Value {
    json!({
        "contractVersion": identity.contract_version,
        "matchBasis": identity.match_basis.as_str(),
        "identityFingerprint": identity.identity_fingerprint,
        "scopeMode": identity.scope_mode,
        "itemScope": item_scope,
        "classificationStatus": "classified",
        "decision": if item_scope == "global" { "ALLOW_GLOBAL" } else { "ALLOW_REPOSITORY" }
    })
}

#[cfg(test)]
mod tests {
    use super::{facets_allow, normalize_facet_value, RepositoryRequestFacets};

    #[test]
    fn facet_normalization_matches_typescript_slug_rules() {
        assert_eq!(normalize_facet_value(" Type__Script! "), "type-script");
        assert_eq!(normalize_facet_value("API@@Layer"), "api-layer");
        assert_eq!(normalize_facet_value("C++"), "c++");
    }

    #[test]
    fn facet_matching_normalizes_request_and_candidate_values() {
        let request = RepositoryRequestFacets {
            technologies: vec!["Type Script".to_string()],
            change_types: Vec::new(),
            domains: Vec::new(),
        };

        assert!(facets_allow(
            &request,
            &["type_script".to_string()],
            &[],
            &[],
            false,
        ));
        assert!(!facets_allow(
            &request,
            &["rust".to_string()],
            &[],
            &[],
            false,
        ));
    }
}
