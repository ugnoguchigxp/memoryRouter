use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelectorCandidate {
    pub(crate) id: String,
    pub(crate) evidence_group_ids: BTreeSet<String>,
    pub(crate) protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selection {
    pub(crate) included_ids: Vec<String>,
    pub(crate) conditional_ids: Vec<String>,
    pub(crate) ordered_optional_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    decisions: Vec<Decision>,
    #[serde(rename = "orderedOptionalIds")]
    ordered_optional_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    #[serde(rename = "candidateId")]
    candidate_id: String,
    verdict: String,
    #[serde(rename = "reasonCode")]
    reason_code: String,
    #[serde(rename = "goalAnchors")]
    goal_anchors: Vec<String>,
    #[serde(rename = "evidenceGroupIds")]
    evidence_group_ids: Vec<String>,
}

fn allowed_reason(verdict: &str, reason: &str) -> bool {
    match verdict {
        "omit" => matches!(reason, "unrelated" | "insufficient_evidence"),
        "include" | "conditional" => {
            matches!(reason, "direct" | "prerequisite" | "conflict" | "precedent")
        }
        _ => false,
    }
}

/// Accepts only the exact selector contract. Any error means callers must discard this response
/// and render deterministic evidence without attempting a repair call.
pub(crate) fn validate(
    raw: &str,
    goal: &str,
    candidates: &[SelectorCandidate],
) -> Result<Selection, String> {
    let response: Response = serde_json::from_str(raw)
        .map_err(|error| format!("selector response is invalid JSON/schema: {error}"))?;
    if response.schema_version != 1 || response.decisions.len() != candidates.len() {
        return Err(
            "selector response has an invalid schema version or decision count".to_string(),
        );
    }
    let candidate_by_id = candidates
        .iter()
        .map(|candidate| (candidate.id.as_str(), candidate))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut included = Vec::new();
    let mut conditional = Vec::new();
    let mut expected_optional = BTreeSet::new();
    for decision in response.decisions {
        let candidate = candidate_by_id
            .get(decision.candidate_id.as_str())
            .ok_or_else(|| {
                format!(
                    "selector returned unknown candidate: {}",
                    decision.candidate_id
                )
            })?;
        if !seen.insert(decision.candidate_id.clone()) {
            return Err(format!(
                "selector returned duplicate candidate: {}",
                decision.candidate_id
            ));
        }
        if !allowed_reason(&decision.verdict, &decision.reason_code) {
            return Err(format!(
                "selector returned invalid verdict/reason: {}",
                decision.candidate_id
            ));
        }
        match decision.verdict.as_str() {
            "omit" => {
                if candidate.protected
                    || !decision.goal_anchors.is_empty()
                    || !decision.evidence_group_ids.is_empty()
                {
                    return Err(format!(
                        "selector omitted protected or malformed candidate: {}",
                        decision.candidate_id
                    ));
                }
            }
            "include" | "conditional" => {
                if decision.goal_anchors.is_empty()
                    || decision.goal_anchors.len() > 3
                    || decision.evidence_group_ids.is_empty()
                    || decision.evidence_group_ids.len() > 8
                    || decision
                        .goal_anchors
                        .iter()
                        .any(|anchor| anchor.is_empty() || !goal.contains(anchor))
                    || decision
                        .evidence_group_ids
                        .iter()
                        .any(|id| !candidate.evidence_group_ids.contains(id))
                    || has_duplicates(&decision.goal_anchors)
                    || has_duplicates(&decision.evidence_group_ids)
                {
                    return Err(format!(
                        "selector returned invalid evidence or goal anchor: {}",
                        decision.candidate_id
                    ));
                }
                if decision.verdict == "include" {
                    included.push(decision.candidate_id.clone());
                } else {
                    conditional.push(decision.candidate_id.clone());
                }
                if !candidate.protected {
                    expected_optional.insert(decision.candidate_id);
                }
            }
            _ => unreachable!("allowed_reason rejects unknown verdicts"),
        }
    }
    if seen.len() != candidates.len() {
        return Err("selector response does not decide every candidate".to_string());
    }
    let optional = response.ordered_optional_ids;
    if has_duplicates(&optional)
        || optional.iter().any(|id| !expected_optional.contains(id))
        || optional.iter().collect::<BTreeSet<_>>().len() != expected_optional.len()
    {
        return Err("selector optional ordering is incomplete or invalid".to_string());
    }
    Ok(Selection {
        included_ids: included,
        conditional_ids: conditional,
        ordered_optional_ids: optional,
    })
}

fn has_duplicates(values: &[String]) -> bool {
    values.iter().collect::<HashSet<_>>().len() != values.len()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{validate, SelectorCandidate};

    fn candidates() -> Vec<SelectorCandidate> {
        vec![
            SelectorCandidate {
                id: "k1".into(),
                evidence_group_ids: BTreeSet::from(["k1:whole".into()]),
                protected: false,
            },
            SelectorCandidate {
                id: "k2".into(),
                evidence_group_ids: BTreeSet::from(["k2:whole".into()]),
                protected: true,
            },
        ]
    }

    #[test]
    fn accepts_complete_valid_selection() {
        let result = validate(r#"{"schemaVersion":1,"decisions":[{"candidateId":"k1","verdict":"include","reasonCode":"direct","goalAnchors":["backup"],"evidenceGroupIds":["k1:whole"]},{"candidateId":"k2","verdict":"conditional","reasonCode":"conflict","goalAnchors":["backup"],"evidenceGroupIds":["k2:whole"]}],"orderedOptionalIds":["k1"]}"#, "change backup", &candidates()).unwrap();
        assert_eq!(result.included_ids, ["k1"]);
        assert_eq!(result.conditional_ids, ["k2"]);
    }

    #[test]
    fn rejects_unknown_duplicate_fake_anchor_and_protected_omit() {
        for raw in [
            r#"{"schemaVersion":1,"decisions":[{"candidateId":"missing","verdict":"omit","reasonCode":"unrelated","goalAnchors":[],"evidenceGroupIds":[]},{"candidateId":"k2","verdict":"conditional","reasonCode":"direct","goalAnchors":["backup"],"evidenceGroupIds":["k2:whole"]}],"orderedOptionalIds":[]}"#,
            r#"{"schemaVersion":1,"decisions":[{"candidateId":"k1","verdict":"include","reasonCode":"direct","goalAnchors":["not-in-goal"],"evidenceGroupIds":["k1:whole"]},{"candidateId":"k2","verdict":"omit","reasonCode":"unrelated","goalAnchors":[],"evidenceGroupIds":[]}],"orderedOptionalIds":["k1"]}"#,
        ] {
            assert!(validate(raw, "change backup", &candidates()).is_err());
        }
    }
}
