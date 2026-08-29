use serde::Serialize;
use serde_json::{json, Value};

use super::{
    memory_profile::MEMORY_CONTRACT_VERSION,
    memory_recall_contract::MemoryType,
    memory_recall_projection::{ProjectedMemory, ProjectedValue},
};

pub(crate) const EXPERIENCE_ITEM_BYTES: usize = 2 * 1024;
pub(crate) const RULE_ITEM_BYTES: usize = 2 * 1024;
pub(crate) const SKILL_ITEM_BYTES: usize = 3 * 1024;
pub(crate) const CALL_RESULT_BYTES: usize = 8 * 1024;

pub(crate) fn build_call_result(
    memory_type: MemoryType,
    candidates: Vec<ProjectedMemory>,
    limit: usize,
    omitted_before_budget: bool,
) -> Result<Value, ()> {
    let mut items = Vec::new();
    let mut truncated = omitted_before_budget;
    for candidate in candidates {
        if items.len() >= limit {
            truncated = true;
            break;
        }
        if candidate.memory_type != memory_type {
            return Err(());
        }
        let per_item_limit = match memory_type {
            MemoryType::Experience => EXPERIENCE_ITEM_BYTES,
            MemoryType::Rule => RULE_ITEM_BYTES,
            MemoryType::Skill => SKILL_ITEM_BYTES,
        };
        if compact_len(&candidate.value)? > per_item_limit {
            truncated = true;
            eprintln!("memory_recall exclusion=OVERSIZED_MEMORY_EXCLUDED");
            continue;
        }

        let mut tentative = items.clone();
        tentative.push(candidate.value);
        let result = call_result(memory_type, &tentative, false, true)?;
        if compact_len(&result)? > CALL_RESULT_BYTES {
            truncated = true;
            eprintln!("memory_recall exclusion=RESULT_BUDGET_EXCLUDED");
            continue;
        }
        items = tentative;
    }
    let result = call_result(memory_type, &items, items.is_empty(), truncated)?;
    (compact_len(&result)? <= CALL_RESULT_BYTES)
        .then_some(result)
        .ok_or(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryEnvelope<'a> {
    contract_version: &'static str,
    memory_type: &'static str,
    trust: MemoryTrust,
    items: &'a [ProjectedValue],
    no_content: bool,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryTrust {
    trust_class: &'static str,
    instruction_authority: &'static str,
}

fn call_result(
    memory_type: MemoryType,
    items: &[ProjectedValue],
    no_content: bool,
    truncated: bool,
) -> Result<Value, ()> {
    let envelope = MemoryEnvelope {
        contract_version: MEMORY_CONTRACT_VERSION,
        memory_type: memory_type.as_str(),
        trust: MemoryTrust {
            trust_class: "untrusted_memory_evidence",
            instruction_authority: "none",
        },
        items,
        no_content,
        truncated,
    };
    let text = serde_json::to_string(&envelope).map_err(|_| ())?;
    Ok(json!({"content":[{"type":"text","text":text}]}))
}

fn compact_len<T: Serialize>(value: &T) -> Result<usize, ()> {
    serde_json::to_vec(value)
        .map(|value| value.len())
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::mcp_lifecycle::memory_recall_projection::{
        ProjectedExperience, ProjectedRule,
    };

    fn projected(memory_type: MemoryType, value: ProjectedValue) -> ProjectedMemory {
        ProjectedMemory {
            id: "id".to_string(),
            score: 1,
            sort_at: "now".to_string(),
            memory_type,
            value,
        }
    }

    #[test]
    fn empty_result_uses_the_contract_envelope() {
        for memory_type in [MemoryType::Experience, MemoryType::Rule, MemoryType::Skill] {
            let result = build_call_result(memory_type, Vec::new(), 3, false).unwrap();
            assert!(result.get("isError").is_none());
            assert_eq!(result["content"].as_array().unwrap().len(), 1);
            let envelope: Value =
                serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(envelope["contractVersion"], MEMORY_CONTRACT_VERSION);
            assert_eq!(envelope["memoryType"], memory_type.as_str());
            assert_eq!(envelope["trust"]["instructionAuthority"], "none");
            assert_eq!(envelope["items"], json!([]));
            assert_eq!(envelope["noContent"], true);
            assert_eq!(envelope["truncated"], false);
        }
    }

    #[test]
    fn oversized_items_are_excluded_without_semantic_truncation() {
        let huge = "x".repeat(RULE_ITEM_BYTES + 1);
        let result = build_call_result(
            MemoryType::Rule,
            vec![projected(
                MemoryType::Rule,
                ProjectedValue::Rule(ProjectedRule {
                    title: "x".to_string(),
                    rule: huge,
                    polarity: "positive".to_string(),
                }),
            )],
            3,
            false,
        )
        .unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(envelope["items"].as_array().unwrap().is_empty());
        assert_eq!(envelope["truncated"], true);
        assert!(compact_len(&result).unwrap() <= CALL_RESULT_BYTES);
    }

    #[test]
    fn internal_type_mismatch_fails_the_whole_result_closed() {
        let result = build_call_result(
            MemoryType::Rule,
            vec![projected(
                MemoryType::Experience,
                ProjectedValue::Experience(ProjectedExperience {
                    title: "x".to_string(),
                    situation: "must not cross type boundary".to_string(),
                    action: None,
                    outcome: None,
                    lesson: "exclude it".to_string(),
                    outcome_kind: "unknown".to_string(),
                }),
            )],
            3,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn shared_no_content_fixture_is_byte_contract_equivalent() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../shared/fixtures/memory-recall-v1/no-content.json"
        ))
        .unwrap();
        let result = build_call_result(MemoryType::Rule, Vec::new(), 3, false).unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(envelope, fixture);
    }

    #[test]
    fn inner_json_uses_the_declared_contract_field_order() {
        let result = build_call_result(MemoryType::Rule, Vec::new(), 3, false).unwrap();
        assert_eq!(
            result["content"][0]["text"],
            concat!(
                "{\"contractVersion\":\"memory-recall-v1\",",
                "\"memoryType\":\"rule\",",
                "\"trust\":{\"trustClass\":\"untrusted_memory_evidence\",\"instructionAuthority\":\"none\"},",
                "\"items\":[],\"noContent\":true,\"truncated\":false}"
            )
        );
    }
}
