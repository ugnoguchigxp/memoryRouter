use super::super::*;

#[test]
fn parses_candidate_array_and_rejects_invalid_enum() {
    let candidates = parse_candidates(r#"[{"type":"rule","polarity":" POSITIVE ","title":" Keep leases ","content":" Release every lease "}]"#).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].title, "Keep leases");
    assert!(parse_candidates(
        r#"[{"type":"note","polarity":"positive","title":"x","content":"y"}]"#
    )
    .is_err());
    assert!(parse_candidates(
        r#"[{"type":"rule","title":"missing polarity","content":"ignored"}]"#
    )
    .is_err());
}

#[test]
fn accepts_skill_like_positive_procedure() {
    let candidates = parse_candidates(r#"[{"type":"procedure","polarity":"positive","title":"Recover a queue","content":"Use when: queue processing stalls\nWorkflow:\n1. Inspect the lease\n2. Restart the worker\nVerification: confirm a job completes\nAvoid: deleting queued jobs"}]"#).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, "procedure");
}

#[test]
fn rejects_unvalidated_output_limits_and_filters_sensitive_boilerplate() {
    let items = (0..25)
        .map(|index| {
            json!({
                "type":"rule", "polarity":"positive", "title":format!("rule-{index}"), "content":"body"
            })
        })
        .collect::<Vec<_>>();
    assert!(parse_candidates(&json!(items).to_string()).is_err());

    let filtered = filter_source_text(
        "before\n<environment_context>\nSECRET ENV\n</environment_context>\nAPI_KEY: abcdef\nauthorization: bearer token-value\nafter",
    );
    assert!(filtered.contains("before"));
    assert!(filtered.contains("after"));
    assert!(!filtered.contains("SECRET ENV"));
    assert!(!filtered.contains("abcdef"));
    assert!(!filtered.contains("token-value"));
}

#[test]
fn finding_v2_redaction_fixtures_never_reach_the_source_snapshot() {
    let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../../../test/fixtures/finding-v2/redaction.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let name = fixture["name"].as_str().unwrap();
        let filtered = filter_source_text(fixture["input"].as_str().unwrap());
        assert!(
            !filtered.contains(fixture["secret"].as_str().unwrap()),
            "secret leaked for {name}: {filtered}"
        );
        assert!(
            filtered.contains(fixture["safeText"].as_str().unwrap()),
            "safe context was lost for {name}: {filtered}"
        );
    }
}
