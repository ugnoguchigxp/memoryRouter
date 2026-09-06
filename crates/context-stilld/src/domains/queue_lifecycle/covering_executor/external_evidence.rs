use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::execution::finalize_positive_result;
use super::external_fetch::{
    classify_external_fetch_error, fetch_guarded_external_url, search_external,
};
use super::helpers::truncate;
use super::positive_response::{
    merge_json_references, parse_positive_response, positive_failure_result,
    positive_source_context, positive_terminal_result, render_catalog_prompt,
};
use super::provider::request_covering_completion;
use super::source::source_reference;
use super::types::{NegativeCoveringExecution, NegativeCoveringResult};

pub(super) fn run_positive_external_evidence(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    run_positive_external_evidence_impl(execution, candidate, source_content, timeout_seconds)
}

#[derive(Debug, Clone)]
pub(super) struct ExternalSearchEntry {
    pub(super) title: String,
    pub(super) url: String,
}

#[derive(Debug, Clone)]
pub(super) struct ExternalSearchOutcome {
    pub(super) provider: String,
    pub(super) results: Vec<ExternalSearchEntry>,
    pub(super) attempted_providers: Vec<String>,
    pub(super) provider_errors: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub(super) struct GuardedExternalEvidence {
    pub(super) url: String,
    pub(super) text: String,
    pub(super) content_type: String,
}

pub(super) fn run_positive_external_evidence_impl(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> NegativeCoveringResult {
    let query_prompt = match render_catalog_prompt("coverEvidence.externalSearchQuery", &json!({}))
    {
        Ok(prompt) => prompt,
        Err(error) => {
            return positive_failure_result(
                "parse_failed",
                "web",
                &error.to_string(),
                source_reference(execution),
            )
        }
    };
    let query_user = format!(
        "title: {}\n\nbody: {}",
        execution.candidate_title,
        truncate(&execution.candidate_content, 500)
    );
    let query_completion = match request_covering_completion(
        execution,
        &query_prompt,
        &query_user,
        256,
        timeout_seconds,
    ) {
        Ok(completion) => completion,
        Err(error) => {
            return positive_failure_result(
                "provider_failed",
                "web",
                &format!("external_search_query_provider_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    let query = normalized_external_query(&query_completion, &execution.candidate_title);
    let search = match search_external(&query, execution, timeout_seconds) {
        Ok(outcome) if !outcome.results.is_empty() => outcome,
        Ok(_) => {
            return positive_terminal_result(
                "insufficient",
                "web",
                "external_search_no_results",
                source_reference(execution),
            )
        }
        Err(error) => {
            return positive_failure_result(
                "tool_failed",
                "web",
                &format!("external_search_failed:{error}"),
                source_reference(execution),
            )
        }
    };
    let search_results = &search.results;
    let mut tool_events = vec![
        json!({
            "name": "search_query_generation",
            "ok": true,
            "metadata": {"query": query, "rawOutput": truncate(&query_completion, 500)}
        }),
        json!({
            "name": "search_web",
            "ok": true,
            "metadata": {
                "query": query,
                "provider": search.provider,
                "resultCount": search_results.len(),
                "attemptedProviders": search.attempted_providers,
                "providerAttemptCount": search.attempted_providers.len(),
                "providerErrors": search.provider_errors
            }
        }),
    ];
    let mut guarded = Vec::new();
    for entry in search_results.iter().take(3) {
        match fetch_guarded_external_url(&entry.url, timeout_seconds) {
            Ok(evidence) => {
                tool_events.push(json!({
                    "name": "fetch_content",
                    "ok": true,
                    "metadata": {
                        "url": entry.url,
                        "finalUrl": evidence.url,
                        "title": entry.title,
                        "contentType": evidence.content_type,
                        "trust": "untrusted",
                        "tainted": true,
                        "guardDecision": "allow_with_warning",
                        "requiredControls": ["CitationRequired"]
                    }
                }));
                guarded.push(evidence);
            }
            Err(error) => {
                let (error_code, guard_decision) = classify_external_fetch_error(&error);
                tool_events.push(json!({
                    "name": "fetch_content",
                    "ok": false,
                    "error": error_code,
                    "metadata": {
                        "url": entry.url,
                        "trust": "untrusted",
                        "tainted": true,
                        "guardDecision": guard_decision,
                        "reason": truncate(&error, 500)
                    }
                }));
            }
        }
    }
    if guarded.is_empty() {
        let mut result = positive_failure_result(
            "tool_failed",
            "web",
            "external_fetch_failed",
            source_reference(execution),
        );
        result.tool_events = tool_events;
        return result;
    }
    let web_payload = guarded
        .iter()
        .map(|evidence| {
            json!({
                "url": evidence.url,
                "excerpt": evidence.text,
                "trust": "untrusted",
                "tainted": true,
                "guardDecision": "allow_with_warning"
            })
        })
        .collect::<Vec<_>>();
    let final_prompt = match render_catalog_prompt(
        "coverEvidence.externalFinal",
        &json!({"webEvidenceTokenBudget": 15000}),
    ) {
        Ok(prompt) => prompt,
        Err(error) => {
            let mut result = positive_failure_result(
                "parse_failed",
                "web",
                &error.to_string(),
                source_reference(execution),
            );
            result.tool_events = tool_events;
            return result;
        }
    };
    let final_user = [
        "候補:".to_string(),
        serde_json::to_string_pretty(candidate).unwrap_or_else(|_| candidate.to_string()),
        "source references:".to_string(),
        Value::Array(source_reference(execution)).to_string(),
        "system/source metadata:".to_string(),
        positive_source_context(execution).to_string(),
        "source evidence:".to_string(),
        truncate(source_content, 1000),
        format!("search query: {query}"),
        "UNTRUSTED WEB EVIDENCE:".to_string(),
        serde_json::to_string_pretty(&web_payload).unwrap_or_else(|_| "[]".to_string()),
    ]
    .join("\n\n");
    let completion = match request_covering_completion(
        execution,
        &final_prompt,
        &final_user,
        4096,
        timeout_seconds,
    ) {
        Ok(completion) => completion,
        Err(error) => {
            let mut result = positive_failure_result(
                "provider_failed",
                "web",
                &format!("external_provider_failed:{error}"),
                source_reference(execution),
            );
            result.tool_events = tool_events;
            return result;
        }
    };
    let mut parsed = match parse_positive_response(&completion, candidate, "web") {
        Ok(result) => result,
        Err(error) => {
            let mut result = positive_failure_result(
                "parse_failed",
                "web",
                &format!("external_parse_failed:{error}"),
                source_reference(execution),
            );
            result.tool_events = tool_events;
            return result;
        }
    };
    parsed.tool_events = tool_events;
    let web_references = guarded
        .iter()
        .map(|evidence| {
            json!({
                "kind": "web",
                "uri": evidence.url,
                "note": "fetch_content verified external evidence",
                "evidenceRole": "external_verification"
            })
        })
        .collect::<Vec<_>>();
    parsed.references = merge_json_references(parsed.references, web_references);
    finalize_positive_result(execution, parsed, source_content, timeout_seconds)
}

pub(super) fn normalized_external_query(raw: &str, fallback: &str) -> String {
    let without_backticks = raw.replace('`', "");
    let terms = without_backticks
        .split('|')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    let query = if terms.is_empty() {
        raw.split_whitespace().take(8).collect::<Vec<_>>().join(" ")
    } else {
        terms.join(" ")
    };
    let normalized = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        truncate(fallback, 160)
    } else {
        truncate(&normalized, 200)
    }
}
