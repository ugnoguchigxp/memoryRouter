// Observation probes: passing means the reviewed behavior was reproduced,
// not that the behavior is desirable. Append to covering_executor/tests.rs
// only in the disposable snapshot created by run_probes.py.

fn review_defaults() -> Value {
    json!({"type":"rule","title":"Queue writer ownership",
        "body":"All queue writes must use the resident writer and verify queue transitions.",
        "importance":80,"confidence":80,
        "appliesTo":{"repoPath":"/work/project-a","technologies":["rust"],
            "changeTypes":["implementation"],"domains":["queue"]}})
}

#[test]
fn review_probe_unknown_rejection_status_becomes_ready() {
    for status in ["rejected", "false_positive", "not_reusable"] {
        let parsed = parse_positive_response(
            &json!({"status":status,"title":"Rejected candidate"}).to_string(),
            &review_defaults(), "final").unwrap();
        assert_eq!(parsed.status, "knowledge_ready", "status={status}");
        assert_eq!(parsed.candidate.unwrap()["body"], review_defaults()["body"]);
    }
    let parsed = parse_positive_response(
        r#"{"status":"knowledge_ready"}"#, &review_defaults(), "final").unwrap();
    assert_eq!(parsed.candidate.unwrap(), review_defaults());
}

#[test]
fn review_probe_high_risk_negative_accepts_zero_evidence_and_empty_source() {
    let (api_base_url, server) = serve_chat_content(json!({
        "status":"ready","polarity":"negative","intentTags":["data_integrity"],
        "appliesTo":review_defaults()["appliesTo"],
        "distilled":{"failure":"Invented failure", "trigger":"Invented trigger", "fix":"Invented fix"},
        "evidence":[],"originRefs":[]
    }));
    let mut input = execution();
    input.source_content.clear();
    input.target.api_base_url = api_base_url;
    input.duplicate_status = Some("duplicate".into());
    input.duplicate_refs = vec![json!({"knowledgeId":"existing"})];
    let result = execute_covering(&input, 30);
    server.join().unwrap();
    assert_eq!(result.status, "knowledge_ready");
    assert!(result.references.is_empty());
    assert!(result.duplicate_refs.is_empty());
    assert_eq!(result.candidate.as_ref().unwrap()["confidence"], 74);
    let mut db = Connection::open_in_memory().unwrap();
    create_persistence_schema(&db);
    assert_eq!(persist_negative_covering_result(&mut db, &input, &result).unwrap(), NegativeCoveringPersistStatus::Completed);
    let count: i64 = db.query_row("select count(*) from finalize_distille_queue", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);
}

fn review_dedupe_db(title: &str, body: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("create table knowledge_items (id text, title text, body text, status text, updated_at text)").unwrap();
    db.execute("insert into knowledge_items values ('existing', ?1, ?2, 'active', CURRENT_TIMESTAMP)", rusqlite::params![title,body]).unwrap();
    db
}

#[test]
fn review_probe_opposite_instruction_is_duplicate() {
    let title = "Production queue migration validation";
    let common = "When modifying the production queue migration, inspect the schema, record the migration version, validate state transitions and review the result with the owner. ";
    let existing = format!("{common}Do run the migration automatically.");
    let candidate = format!("{common}Do not run the migration automatically.");
    let db = review_dedupe_db(title, &existing);
    let (status, refs) = super::deduplication::inspect_knowledge_duplicates(&db, title, &candidate).unwrap();
    assert_eq!(status.as_deref(), Some("duplicate"));
    eprintln!("opposite instruction similarity: {}", refs[0]["score"]);
}

#[test]
fn review_probe_normalized_exact_duplicate_missed_by_sql_prefilter() {
    let title = "Queue writer ownership";
    let body = "All queue writes must use the resident writer and verify queue transitions.";
    let existing_title = title.replace(' ', "   ");
    let existing_body = body.replace(' ', "   ");
    assert_eq!(super::deduplication::normalize_dedupe_text(title), super::deduplication::normalize_dedupe_text(&existing_title));
    assert_eq!(super::deduplication::normalize_dedupe_text(body), super::deduplication::normalize_dedupe_text(&existing_body));
    let db = review_dedupe_db(&existing_title, &existing_body);
    let (status, refs) = super::deduplication::inspect_knowledge_duplicates(&db, title, body).unwrap();
    assert!(status.is_none());
    assert!(refs.is_empty());
}

#[test]
fn review_probe_value_prompt_drops_late_evidence() {
    let mut input = execution();
    input.candidate_origin = json!({"readRanges":[{"from":0,"toExclusive":1400}]});
    input.source_content = format!("{} LATE_SOURCE_EVIDENCE", "context ".repeat(1200));
    let read = positive_source_content(&input, 30).unwrap();
    assert!(read.content.contains("LATE_SOURCE_EVIDENCE"));
    input.source_read_ranges = Some(read.read_ranges);
    let prompt = super::positive_response::positive_value_user_prompt(&input, &review_defaults(), &read.content);
    assert!(!prompt.contains("LATE_SOURCE_EVIDENCE"));
    assert_eq!(source_reference(&input)[0]["locator"], "tokens:0-1201");
}

#[test]
fn review_probe_transient_refinement_failure_becomes_terminal() {
    let mut input = execution();
    input.candidate_origin = json!({});
    let mut defaults = review_defaults();
    defaults["appliesTo"].as_object_mut().unwrap().remove("domains");
    let parsed = parse_positive_response(r#"{"status":"knowledge_ready"}"#, &defaults, "final").unwrap();
    // Port 1 is the existing fixture's unavailable provider, so refinement fails.
    let result = super::execution::finalize_positive_result(&input, parsed, "source", 30);
    assert_eq!(result.status, "insufficient");
    assert_eq!(result.reason.as_deref(), Some("applies_to_categories_required"));
    assert!(result.tool_events.iter().any(|event| event["name"] == "applicability_refinement" && event["ok"] == false && event.get("error").is_some()));
    let mut db = Connection::open_in_memory().unwrap();
    create_persistence_schema(&db);
    assert_eq!(persist_negative_covering_result(&mut db, &input, &result).unwrap(), NegativeCoveringPersistStatus::Completed);
}

#[test]
fn review_probe_llm_can_overwrite_positive_project_identity() {
    let parsed = parse_positive_response(
        &json!({"status":"knowledge_ready","appliesTo":{"repoPath":"/work/project-b"}}).to_string(),
        &review_defaults(), "final").unwrap();
    assert_eq!(parsed.candidate.unwrap()["appliesTo"]["repoPath"], "/work/project-b");
}

#[test]
fn review_probe_reprocessed_ready_does_not_reopen_failed_finalize() {
    let mut db = Connection::open_in_memory().unwrap();
    create_persistence_schema(&db);
    let mut input = execution();
    let result = parse_positive_response(r#"{"status":"knowledge_ready"}"#, &review_defaults(), "final").unwrap();
    persist_negative_covering_result(&mut db, &input, &result).unwrap();
    db.execute_batch("update finalize_distille_queue set status='failed'; update covering_evidence_queue set status='running',locked_by='worker-1'; update llm_provider_leases set status='active';").unwrap();
    input.attempt_count = 1;
    persist_negative_covering_result(&mut db, &input, &result).unwrap();
    let status: String = db.query_row("select status from finalize_distille_queue", [], |row| row.get(0)).unwrap();
    assert_eq!(status, "failed");
}
