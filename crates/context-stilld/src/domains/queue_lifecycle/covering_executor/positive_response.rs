use std::collections::BTreeSet;

use regex::Regex;
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::applicability::{merge_applicability, required_applicability_present};
use super::helpers::truncate;
use super::provider::request_covering_completion;
use super::source::{configured_source_read_ranges, normalized_character_count, source_reference};
use super::types::{NegativeCoveringExecution, NegativeCoveringResult, SYSTEM_CONTEXT_CATALOG};

pub(super) fn render_catalog_prompt(key: &str, variables: &Value) -> Result<String, CliError> {
    let catalog: Value = serde_json::from_str(SYSTEM_CONTEXT_CATALOG).map_err(|error| {
        CliError::io(format!("invalid embedded system context catalog: {error}"))
    })?;
    let sections = catalog
        .pointer(&format!(
            "/contexts/{}/locales/ja-JP/sections",
            key.replace('~', "~0").replace('/', "~1")
        ))
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::io(format!("system context catalog omitted {key}")))?;
    let mut rendered_sections = Vec::new();
    for section in sections {
        let mut rendered = String::new();
        for segment in section
            .get("segments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match segment.get("type").and_then(Value::as_str) {
                Some("literal") => rendered.push_str(
                    segment
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                Some("variable") => {
                    let name = segment
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| CliError::io("system context variable omitted name"))?;
                    let value = variables.get(name).ok_or_else(|| {
                        CliError::io(format!("system context variable missing: {name}"))
                    })?;
                    match value {
                        Value::String(text) => rendered.push_str(text),
                        other => rendered.push_str(&other.to_string()),
                    }
                }
                _ => {}
            }
        }
        if !rendered.trim().is_empty() {
            rendered_sections.push(rendered);
        }
    }
    Ok(rendered_sections.join("\n\n"))
}

pub(super) fn positive_source_context(execution: &NegativeCoveringExecution) -> Value {
    let read_ranges = execution
        .source_read_ranges
        .clone()
        .unwrap_or_else(|| configured_source_read_ranges(execution))
        .into_iter()
        .map(|(from, to_exclusive)| json!({"from": from, "toExclusive": to_exclusive}))
        .collect::<Vec<_>>();
    json!({
        "targetKind": execution.source_kind,
        "sourceUri": execution.source_uri,
        "readRanges": read_ranges,
        "assessmentSource": "primary",
        "hasPrimaryEvidence": true
    })
}

pub(super) fn positive_value_user_prompt(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
) -> String {
    [
        "候補の value と source support を判定してください。".to_string(),
        format!("候補:\n{}", candidate),
        format!(
            "source references:\n{}",
            Value::Array(source_reference(execution))
        ),
        format!(
            "system/source metadata:\n{}",
            positive_source_context(execution)
        ),
        format!(
            "source evidence excerpt:\n{}",
            truncate(&source_content.replace(char::is_whitespace, " "), 1000)
        ),
    ]
    .join("\n\n")
}

pub(super) fn parse_positive_response(
    content: &str,
    defaults: &Value,
    default_stage: &'static str,
) -> Result<NegativeCoveringResult, CliError> {
    let record = parse_positive_record(content)?;
    let nested = record.get("candidate").filter(|value| value.is_object());
    let candidate_record = nested.unwrap_or(&record);
    let inferred_candidate = candidate_record.get("title").is_some()
        || candidate_record.get("body").is_some()
        || candidate_record.get("content").is_some();
    let status = record
        .get("status")
        .or_else(|| record.get("STATUS"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| {
            matches!(
                value.as_str(),
                "knowledge_ready"
                    | "duplicate"
                    | "near_duplicate"
                    | "insufficient"
                    | "reprocess_requested"
                    | "parse_failed"
                    | "tool_failed"
                    | "provider_failed"
            )
        })
        .unwrap_or_else(|| {
            if inferred_candidate {
                "knowledge_ready".to_string()
            } else {
                "insufficient".to_string()
            }
        });
    let stage = match record
        .get("stage")
        .or_else(|| record.get("STAGE"))
        .and_then(Value::as_str)
        .unwrap_or(default_stage)
        .trim()
        .to_lowercase()
        .as_str()
    {
        "load" => "load",
        "source_support" => "source_support",
        "dedupe" => "dedupe",
        "evidence_need" => "evidence_need",
        "web" => "web",
        "mcp" => "mcp",
        _ => default_stage,
    };
    let candidate = if status == "knowledge_ready" {
        Some(parse_positive_candidate(candidate_record, defaults)?)
    } else {
        None
    };
    let references = record
        .get("references")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let duplicate_refs = record
        .get("duplicateRefs")
        .or_else(|| record.get("duplicate_refs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tool_events = record
        .get("toolEvents")
        .or_else(|| record.get("tool_events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reason = record
        .get("reason")
        .or_else(|| record.get("REASON"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && !matches!(*value, "null" | "none" | "-"))
        .map(|value| truncate(value, 160))
        .or_else(|| (status == "insufficient").then(|| "insufficient".to_string()));
    Ok(NegativeCoveringResult {
        status,
        stage,
        candidate,
        references,
        duplicate_refs,
        tool_events,
        reason,
    })
}

pub(super) fn parse_positive_record(content: &str) -> Result<Value, CliError> {
    let cleaned = content
        .replace("```json", "")
        .replace("```JSON", "")
        .replace("```", "")
        .trim()
        .to_string();
    if let Ok(value) = serde_json::from_str::<Value>(&cleaned) {
        if value.is_object() {
            return Ok(value);
        }
    }
    if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if start < end {
            if let Ok(value) = serde_json::from_str::<Value>(&cleaned[start..=end]) {
                if value.is_object() {
                    return Ok(value);
                }
            }
        }
    }
    parse_positive_label_output(&cleaned).ok_or_else(|| {
        CliError::io("coverEvidence output must be a JSON object or labelled result")
    })
}

pub(super) fn parse_positive_label_output(content: &str) -> Option<Value> {
    let lines = content.lines().collect::<Vec<_>>();
    let metadata_index = lines.iter().rposition(|line| {
        line.contains('/')
            && line.to_ascii_uppercase().contains("STATUS")
            && line.to_ascii_uppercase().contains("TYPE")
    })?;
    if metadata_index == 0 {
        return None;
    }
    let title_index = lines[..metadata_index]
        .iter()
        .position(|line| !line.trim().is_empty())?;
    let title = lines[title_index].trim();
    let body = lines[title_index + 1..metadata_index]
        .join("\n")
        .trim()
        .to_string();
    let tokens = lines[metadata_index]
        .split('/')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let mut record = serde_json::Map::new();
    record.insert("title".to_string(), json!(title));
    record.insert("body".to_string(), json!(body));
    let mut index = 0;
    while index + 1 < tokens.len() {
        let key = match tokens[index].to_ascii_uppercase().as_str() {
            "TYPE" => "type",
            "STATUS" => "status",
            "STAGE" => "stage",
            "IMPORTANCE" => "importance",
            "CONFIDENCE" => "confidence",
            "TECHNOLOGIES" => "technologies",
            "CHANGE_TYPES" | "CHANGETYPES" => "changeTypes",
            "DOMAINS" | "DOMAIN" => "domains",
            "REPO_PATH" => "repoPath",
            "REPO_KEY" => "repoKey",
            "REASON" => "reason",
            _ => {
                index += 1;
                continue;
            }
        };
        record.insert(key.to_string(), json!(tokens[index + 1]));
        index += 2;
    }
    Some(Value::Object(record))
}

pub(super) fn parse_positive_candidate(
    record: &Value,
    defaults: &Value,
) -> Result<Value, CliError> {
    let string_value = |keys: &[&str]| -> Option<String> {
        keys.iter().find_map(|key| {
            record
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
    };
    let title = string_value(&["title", "TITLE"])
        .or_else(|| {
            defaults
                .get("title")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| CliError::io("coverEvidence candidate omitted title"))?;
    let body = string_value(&["body", "content", "BODY", "CONTENT"])
        .or_else(|| {
            defaults
                .get("body")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| CliError::io("coverEvidence candidate omitted body"))?;
    let candidate_type = string_value(&["type", "TYPE"])
        .or_else(|| {
            defaults
                .get("type")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "rule".to_string());
    let importance = parse_positive_score(
        record
            .get("importance")
            .or_else(|| record.get("IMPORTANCE")),
        defaults
            .get("importance")
            .and_then(Value::as_i64)
            .unwrap_or(70),
    );
    let confidence = parse_positive_score(
        record
            .get("confidence")
            .or_else(|| record.get("CONFIDENCE")),
        defaults
            .get("confidence")
            .and_then(Value::as_i64)
            .unwrap_or(70),
    );
    let default_applies = defaults
        .get("appliesTo")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let applies_to = merge_applicability(&default_applies, &json!({}), record);
    Ok(json!({
        "type": if candidate_type == "procedure" { "procedure" } else { "rule" },
        "title": title,
        "body": body,
        "importance": importance,
        "confidence": confidence,
        "appliesTo": applies_to
    }))
}

pub(super) fn parse_positive_score(value: Option<&Value>, fallback: i64) -> i64 {
    let Some(numeric) = value.and_then(|value| {
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<f64>().ok())
        })
    }) else {
        return fallback;
    };
    let normalized = if (0.0..=1.0).contains(&numeric) {
        numeric * 100.0
    } else {
        numeric
    };
    normalized.round().clamp(0.0, 100.0) as i64
}

pub(super) fn candidate_has_required_applicability(candidate: &Value) -> bool {
    let applies_to = candidate.get("appliesTo").unwrap_or(candidate);
    required_applicability_present(applies_to)
}

pub(super) fn candidate_has_project_identity(candidate: &Value) -> bool {
    let applies_to = candidate.get("appliesTo").unwrap_or(candidate);
    ["projectRef", "repoPath", "repoKey"].iter().any(|key| {
        applies_to
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    })
}

pub(super) fn refine_positive_applicability(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> Result<(Value, Value), Value> {
    let system_prompt = render_catalog_prompt("coverEvidence.applicabilityRefinement", &json!({}))
        .map_err(
            |error| json!({"name":"applicability_refinement","ok":false,"error":error.to_string()}),
        )?;
    let user_prompt = [
        "以下の candidate について、3カテゴリを補完してください。".to_string(),
        format!("candidate:\n{candidate}"),
        format!(
            "source references:\n{}",
            Value::Array(source_reference(execution))
        ),
        format!(
            "system/source metadata:\n{}",
            positive_source_context(execution)
        ),
        format!(
            "source evidence summary/excerpt:\n{}",
            truncate(source_content, 1000)
        ),
    ]
    .join("\n\n");
    let completion = request_covering_completion(
        execution,
        &system_prompt,
        &user_prompt,
        2048,
        timeout_seconds,
    )
    .map_err(
        |error| json!({"name":"applicability_refinement","ok":false,"error":error.to_string()}),
    )?;
    let refined = parse_positive_response(&completion, candidate, "final").map_err(
        |error| json!({"name":"applicability_refinement","ok":false,"error":error.to_string()}),
    )?;
    let Some(refined_candidate) = refined.candidate else {
        return Err(json!({
            "name": "applicability_refinement",
            "ok": false,
            "metadata": {"reason": "refinement_not_knowledge_ready"}
        }));
    };
    let mut merged = candidate.clone();
    let merged_applies = merge_applicability(
        candidate.get("appliesTo").unwrap_or(&json!({})),
        &json!({}),
        refined_candidate.get("appliesTo").unwrap_or(&json!({})),
    );
    if let Some(object) = merged.as_object_mut() {
        object.insert("appliesTo".to_string(), merged_applies);
    }
    Ok((
        merged,
        json!({
            "name": "applicability_refinement",
            "ok": true,
            "metadata": {"missingAfter": []}
        }),
    ))
}

pub(super) fn has_skill_like_procedure_body(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let use_when = lower.find("use when:");
    let workflow = lower.find("workflow:");
    let verification = lower.find("verification:");
    let avoid = lower.find("avoid:");
    let ordered = matches!(
        (use_when, workflow, verification, avoid),
        (Some(a), Some(b), Some(c), Some(d)) if a < b && b < c && c < d
    );
    let steps = body
        .lines()
        .filter(|line| {
            Regex::new(r"^\s*(?:\d+[.)]|[-*])\s+\S")
                .expect("procedure step regex")
                .is_match(line)
        })
        .count();
    ordered && steps >= 2
}

pub(super) fn repair_positive_procedure(
    execution: &NegativeCoveringExecution,
    candidate: &Value,
    source_content: &str,
    timeout_seconds: u64,
) -> Result<Value, String> {
    let combined = format!(
        "{}\n{}\n{}",
        candidate
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        candidate
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        source_content
    );
    let step_count = combined
        .lines()
        .filter(|line| {
            Regex::new(r"^\s*(?:\d+[.)]|[-*])\s+\S")
                .expect("procedure evidence step regex")
                .is_match(line)
        })
        .count();
    let workflow_signal = Regex::new(
        r"(?i)(step|then|first|finally|まず|次に|その後|最後に|手順|workflow|コマンド|`[^`]+`)",
    )
    .expect("procedure workflow regex")
    .is_match(&combined);
    let verification_signal = Regex::new(r"(?i)(verify|test|check|confirm|smoke|検証|確認|テスト)")
        .expect("procedure verification regex")
        .is_match(&combined);
    let avoid_signal =
        Regex::new(r"(?i)(avoid|do not|never|skip|避ける|禁止|しない|してはいけない)")
            .expect("procedure avoid regex")
            .is_match(&combined);
    if !workflow_signal || step_count < 2 || !verification_signal || !avoid_signal {
        return Err("insufficient_workflow_evidence".to_string());
    }
    let system_prompt = render_catalog_prompt("coverEvidence.procedureRepair", &json!({}))
        .map_err(|error| error.to_string())?;
    let user_prompt = format!(
        "Candidate title:\n{}\n\nCandidate body:\n{}\n\nSource evidence:\n{}",
        candidate
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        candidate
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        truncate(source_content, 8000)
    );
    let completion = request_covering_completion(
        execution,
        &system_prompt,
        &user_prompt,
        2048,
        timeout_seconds,
    )
    .map_err(|error| error.to_string())?;
    let parsed = parse_positive_record(&completion).map_err(|error| error.to_string())?;
    let title = parsed
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "repair_parse_failed".to_string())?;
    let body = parsed
        .get("body")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "repair_parse_failed".to_string())?;
    if !has_skill_like_procedure_body(body) {
        return Err("repair_parse_failed".to_string());
    }
    let mut repaired = candidate.clone();
    if let Some(object) = repaired.as_object_mut() {
        object.insert("title".to_string(), json!(title));
        object.insert("body".to_string(), json!(body));
        object.insert("type".to_string(), json!("procedure"));
    }
    Ok(repaired)
}

pub(super) fn positive_rule_body_actionable(title: &str, body: &str) -> bool {
    normalized_character_count(title) >= 3 && normalized_character_count(body) >= 24
}

pub(super) fn positive_terminal_result(
    status: &str,
    stage: &'static str,
    reason: &str,
    references: Vec<Value>,
) -> NegativeCoveringResult {
    NegativeCoveringResult {
        status: status.to_string(),
        stage,
        candidate: None,
        references,
        duplicate_refs: Vec::new(),
        tool_events: Vec::new(),
        reason: Some(truncate(reason, 160)),
    }
}

pub(super) fn positive_failure_result(
    status: &str,
    stage: &'static str,
    reason: &str,
    references: Vec<Value>,
) -> NegativeCoveringResult {
    NegativeCoveringResult {
        status: status.to_string(),
        stage,
        candidate: None,
        references,
        duplicate_refs: Vec::new(),
        tool_events: vec![json!({
            "name": "cover_evidence",
            "ok": false,
            "error": truncate(reason, 500)
        })],
        reason: Some(truncate(reason, 160)),
    }
}

pub(super) fn prepend_positive_tool_events(
    mut result: NegativeCoveringResult,
    mut events: Vec<Value>,
) -> NegativeCoveringResult {
    events.extend(result.tool_events);
    result.tool_events = events;
    result
}

pub(super) fn merge_json_references(first: Vec<Value>, second: Vec<Value>) -> Vec<Value> {
    let mut seen = BTreeSet::new();
    let mut merged = Vec::new();
    for reference in first.into_iter().chain(second) {
        let key = format!(
            "{}\0{}\0{}\0{}",
            reference
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            reference
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            reference
                .get("locator")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            reference
                .get("evidenceRole")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
        if seen.insert(key) {
            merged.push(reference);
        }
    }
    merged
}
