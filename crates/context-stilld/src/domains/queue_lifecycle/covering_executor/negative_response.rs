use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::applicability::{merge_execution_applicability, required_applicability_present};
use super::helpers::{build_negative_body, non_empty};
use super::types::{
    NegativeCoveringExecution, NegativeCoveringResult, NegativeEvidenceResponse, NegativeQuality,
    INTENT_TAGS,
};

pub(super) fn parse_negative_response(
    execution: &NegativeCoveringExecution,
    content: &str,
) -> Result<NegativeCoveringResult, CliError> {
    let cleaned = content
        .replace("```json", "")
        .replace("```", "")
        .trim()
        .to_string();
    let parsed: NegativeEvidenceResponse = serde_json::from_str(&cleaned).map_err(|error| {
        CliError::io(format!(
            "failed to parse negative evidence result JSON: {error}"
        ))
    })?;
    if parsed.distilled.failure.trim().is_empty() {
        return Err(CliError::io(
            "negative evidence response omitted distilled.failure",
        ));
    }
    let intent_tags = parsed
        .intent_tags
        .iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| INTENT_TAGS.contains(&tag.as_str()))
        .collect::<Vec<_>>();
    let applies_to = merge_execution_applicability(execution, &parsed.applies_to);
    let quality = assess_negative_quality(&parsed, &intent_tags, &applies_to);
    let has_required_applicability = required_applicability_present(&applies_to);
    let ready = quality.ready && has_required_applicability;
    let status = if ready {
        "knowledge_ready".to_string()
    } else {
        "insufficient".to_string()
    };
    let reason = if quality.ready && !has_required_applicability {
        Some("applies_to_categories_required".to_string())
    } else {
        quality.reason.clone()
    };
    let candidate = ready.then(|| {
        json!({
            "type": "rule",
            "title": execution.candidate_title,
            "body": build_negative_body(&parsed.distilled),
            "confidence": quality.confidence,
            "importance": quality.importance,
            "appliesTo": applies_to
        })
    });
    let references = parsed
        .evidence
        .iter()
        .map(|evidence| {
            json!({
                "kind": "source",
                "uri": if execution.source_uri.trim().is_empty() {
                    format!("agent://candidate/{}", execution.found_candidate_id)
                } else {
                    execution.source_uri.clone()
                },
                "note": evidence.trim(),
                "evidenceRole": "supports_candidate"
            })
        })
        .collect::<Vec<_>>();
    let tool_events = vec![json!({
        "name": "negative_coverage",
        "ok": true,
        "metadata": {
            "polarity": parsed.polarity,
            "intentTags": intent_tags,
            "appliesTo": applies_to,
            "originRefs": parsed.origin_refs,
            "distilled": parsed.distilled,
            "quality": {
                "ready": quality.ready,
                "reason": quality.reason,
                "evidenceCount": quality.evidence_count,
                "confidence": quality.confidence,
                "importance": quality.importance
            }
        }
    })];
    Ok(NegativeCoveringResult {
        status,
        stage: "final",
        candidate,
        references,
        duplicate_refs: Vec::new(),
        tool_events,
        reason,
    })
}

pub(super) fn assess_negative_quality(
    parsed: &NegativeEvidenceResponse,
    intent_tags: &[String],
    applies_to: &Value,
) -> NegativeQuality {
    let evidence_count = parsed
        .evidence
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .collect::<BTreeSet<_>>()
        .len();
    let has_trigger = non_empty(parsed.distilled.trigger.as_deref());
    let has_fix = non_empty(parsed.distilled.fix.as_deref());
    let has_verification = non_empty(parsed.distilled.verification.as_deref());
    let has_decision_signal = non_empty(parsed.distilled.decision_signal.as_deref());
    let has_high_risk_tag = intent_tags.iter().any(|tag| {
        matches!(
            tag.as_str(),
            "regression" | "security_risk" | "data_integrity"
        )
    });
    let general = applies_to
        .get("general")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut confidence = 62 + (evidence_count.min(3) as i64 * 6);
    let mut importance = 58;
    if has_trigger {
        confidence += 6;
    }
    if has_fix {
        confidence += 6;
    }
    if has_verification {
        confidence += 4;
    }
    if has_decision_signal {
        confidence += 2;
    }
    if general {
        confidence -= 8;
    }
    if has_high_risk_tag {
        importance += 14;
    }
    if has_trigger && has_fix {
        importance += 8;
    }
    if evidence_count >= 2 {
        importance += 6;
    }
    if general && !has_high_risk_tag {
        importance -= 6;
    }
    let confidence = confidence.clamp(45, 90);
    let importance = importance.clamp(45, 90);
    let reason = if parsed.status != "ready" {
        Some(parsed.status.clone())
    } else if parsed.polarity != "negative" {
        Some("negative_polarity_required".to_string())
    } else if parsed.distilled.failure.trim().is_empty() {
        Some("negative_failure_required".to_string())
    } else if !has_trigger {
        Some("negative_trigger_required".to_string())
    } else if !has_fix {
        Some("negative_fix_required".to_string())
    } else if evidence_count < 2 && !has_high_risk_tag {
        Some("negative_evidence_too_thin".to_string())
    } else if general && !has_high_risk_tag && evidence_count < 3 {
        Some("negative_general_scope_requires_stronger_evidence".to_string())
    } else {
        None
    };
    NegativeQuality {
        ready: reason.is_none(),
        reason,
        evidence_count,
        confidence,
        importance,
    }
}
