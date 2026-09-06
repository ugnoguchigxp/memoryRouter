use super::super::*;

#[test]
fn parses_candidate_array_and_rejects_invalid_enum() {
    let candidates = parse_candidates(r#"[{"type":"rule","polarity":" POSITIVE ","title":" Keep leases ","content":" Release every lease "},{"type":"note","polarity":"positive","title":"x","content":"y"},{"type":"rule","title":"missing polarity","content":"ignored"},{"type":"procedure","polarity":"negative","title":"bad procedure","content":"Use when: x\nWorkflow:\n1. a\n2. b\nVerification: v\nAvoid: z"},{"type":"procedure","polarity":"positive","title":"shapeless","content":"do something"}]"#).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].title, "Keep leases");
}

#[test]
fn accepts_skill_like_positive_procedure() {
    let candidates = parse_candidates(r#"[{"type":"procedure","polarity":"positive","title":"Recover a queue","content":"Use when: queue processing stalls\nWorkflow:\n1. Inspect the lease\n2. Restart the worker\nVerification: confirm a job completes\nAvoid: deleting queued jobs"}]"#).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, "procedure");
}

#[test]
fn caps_candidates_and_filters_sensitive_boilerplate() {
    let items = (0..25)
        .map(|index| {
            json!({
                "type":"rule", "polarity":"positive", "title":format!("rule-{index}"), "content":"body"
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        parse_candidates(&json!(items).to_string()).unwrap().len(),
        20
    );

    let filtered = filter_source_text(
        "before\n<environment_context>\nSECRET ENV\n</environment_context>\nAPI_KEY: abcdef\nauthorization: bearer token-value\nafter",
    );
    assert!(filtered.contains("before"));
    assert!(filtered.contains("after"));
    assert!(!filtered.contains("SECRET ENV"));
    assert!(!filtered.contains("abcdef"));
    assert!(!filtered.contains("token-value"));
}
