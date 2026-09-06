use super::super::types::ProviderLeaseAssignment;
use super::*;

fn setup() -> (Connection, ClaimedProviderLeaseJob, Value) {
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open_in_memory().unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut connection, 2).unwrap();
    connection.execute_batch("insert into knowledge_items(id,type,status,scope,title,body) values
        ('subject','rule','active','global','Subject','Use a transaction for related writes.'),
        ('canonical','rule','active','global','Canonical','Commit related updates atomically.'),
        ('inactive','rule','deprecated','global','Inactive','Old guidance');
        insert into knowledge_items_vec_fallback(knowledge_id,embedding_json,embedding_dimension,content_hash) values ('subject','[1,0]',2,'a'),('canonical','[0.99,0.01]',2,'b');").unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 2);
    let id: String = connection.query_row(
        "select id from landscape_curation_queue where subject_knowledge_id='subject' order by created_at limit 1",
        [],
        |row| row.get(0),
    ).unwrap();
    connection
        .execute(
            "update landscape_curation_queue set status='running',locked_by='worker' where id=?1",
            [&id],
        )
        .unwrap();
    connection.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,status,expires_at) values ('lease','pool','target',?1,?2,'worker','active',datetime('now','+10 minutes'))",params![QUEUE,id]).unwrap();
    let job = ClaimedProviderLeaseJob {
        queue_name: QUEUE.into(),
        id: id.clone(),
        provider_lease: ProviderLeaseAssignment {
            id: "lease".into(),
            pool_id: "pool".into(),
            target_id: "target".into(),
            queue_name: QUEUE.into(),
            queue_job_id: id.clone(),
            worker_id: "worker".into(),
        },
    };
    let snapshot = repository::capture(&connection, &id).unwrap();
    (connection, job, snapshot)
}
fn decision(kind: &str, snapshot: &Value) -> Decision {
    let survivor = "canonical";
    let retained = if kind == "merge" {
        vec!["subject:g0".into(), "canonical:g0".into()]
    } else {
        vec!["canonical:g0".into()]
    };
    let coverage = vec![
        Coverage {
            source_group_id: "subject:g0".into(),
            disposition: if kind == "merge" {
                "retained".into()
            } else {
                "entailed".into()
            },
            target_group_ids: if kind == "merge" {
                vec!["subject:g0".into()]
            } else {
                vec!["canonical:g0".into()]
            },
        },
        Coverage {
            source_group_id: "canonical:g0".into(),
            disposition: "retained".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
    ];
    let checks = json!({"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"});
    Decision {
        schema_version: 2,
        action: kind.into(),
        survivor_knowledge_id: Some(survivor.into()),
        deprecated_knowledge_ids: vec!["subject".into()],
        retained_group_ids: retained,
        coverage,
        reason_codes: vec![if kind == "merge" {
            "COMPLEMENTARY".into()
        } else {
            "COMPLETE_DUPLICATE".into()
        }],
        rationale: "Both express atomicity of related updates.".into(),
        verification: Some(Verification {
            schema_version: 2,
            verdict: "supported".into(),
            input_hash: repository::hash(&repository::canonical_json(snapshot)),
            findings: vec![
                VerificationFinding {
                    source_group_id: "subject:g0".into(),
                    target_group_ids: if kind == "merge" {
                        vec!["subject:g0".into()]
                    } else {
                        vec!["canonical:g0".into()]
                    },
                    checks: checks.clone(),
                },
                VerificationFinding {
                    source_group_id: "canonical:g0".into(),
                    target_group_ids: vec!["canonical:g0".into()],
                    checks,
                },
            ],
            no_new_meaning: "preserved".into(),
            no_unresolved_contradiction: "preserved".into(),
            rationale: "All source groups and conditions remain available.".into(),
        }),
    }
}
fn status(connection: &Connection, id: &str) -> String {
    connection
        .query_row(
            "select status from knowledge_items where id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn queues_every_active_knowledge_once_including_without_candidates() {
    let (connection, _, _) = setup();
    let before = repository::load_knowledge(&connection, "subject")
        .unwrap()
        .unwrap()["contentRevision"]
        .clone();
    let queued: (String,String) = connection.query_row("select evidence_hash,prompt_version from landscape_curation_queue where subject_knowledge_id='subject'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(queued.0, before.as_str().unwrap());
    assert_eq!(queued.1, VERSION);
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 0);
    connection
        .execute("update landscape_curation_queue set status='completed'", [])
        .unwrap();
    connection
        .execute(
            "update knowledge_items set body='changed',updated_at=CURRENT_TIMESTAMP",
            [],
        )
        .unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 2);
    connection.execute("insert into knowledge_items(id,type,status,scope,title,body) values ('new','rule','active','global','New','No embedding')",[]).unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 1);
    assert_eq!(
        repository::capture(
            &connection,
            connection
                .query_row(
                    "select id from landscape_curation_queue where subject_knowledge_id='new'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap()
                .as_str()
        )
        .unwrap()["candidates"],
        json!([])
    );
}

#[test]
fn finds_semantic_candidates_and_excludes_other_repositories_and_polarities() {
    let (connection, job, snapshot) = setup();
    assert_eq!(snapshot["candidates"].as_array().unwrap().len(), 1);
    assert!(snapshot["candidates"][0]["similarity"].as_f64().unwrap() > 0.99);
    connection
        .execute("update knowledge_items set scope='repo',repo_key=id", [])
        .unwrap();
    assert_eq!(
        repository::capture(&connection, &job.id).unwrap()["candidates"],
        json!([])
    );
    connection.execute("update knowledge_items set scope='global',polarity=case when id='canonical' then 'negative' else 'positive' end",[]).unwrap();
    assert_eq!(
        repository::capture(&connection, &job.id).unwrap()["candidates"],
        json!([])
    );
}

#[test]
fn queues_exact_candidates_without_embeddings() {
    let (connection, job, snapshot) = setup();
    connection
        .execute("delete from knowledge_items_vec_fallback", [])
        .unwrap();
    connection
        .execute(
            "update knowledge_items set body=?1 where id='canonical'",
            [snapshot["subject"]["body"].as_str().unwrap()],
        )
        .unwrap();
    let captured = repository::capture(&connection, &job.id).unwrap();
    assert_eq!(captured["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(captured["candidates"][0]["id"], "canonical");
    assert_eq!(captured["candidates"][0]["similarity"], 1.0);
}

#[test]
fn deprecates_semantic_duplicate_and_preserves_lineage_and_rollback() {
    let (mut connection, job, snapshot) = setup();
    connection.execute("insert into knowledge_origin_links(id,knowledge_id,origin_kind,origin_uri,origin_key,confidence) values ('origin','subject','manual','test://source','source',90)",[]).unwrap();
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("deprecate_duplicate", &snapshot), None))
    )
    .unwrap());
    assert_eq!(status(&connection, "subject"), "deprecated");
    assert_eq!(status(&connection, "canonical"), "active");
    assert_eq!(
        repository::load_knowledge(&connection, "canonical")
            .unwrap()
            .unwrap()["body"],
        snapshot["candidates"][0]["body"]
    );
    let lineage: i64 = connection
        .query_row(
            "select count(*) from knowledge_origin_links where knowledge_id='canonical'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(lineage, 1);
    let rollback: String = connection
        .query_row(
            "select rollback_snapshot from landscape_curation_queue where id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&rollback).unwrap()["deprecated"]["status"],
        "active"
    );
    assert!(!persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("deprecate_duplicate", &snapshot), None))
    )
    .unwrap());
}

#[test]
fn merges_body_embedding_and_deprecation_atomically() {
    let (mut connection, job, snapshot) = setup();
    let result = decision("merge", &snapshot);
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((result.clone(), Some(vec![0.8, 0.2])))
    )
    .unwrap());
    assert_eq!(status(&connection, "subject"), "deprecated");
    let canonical = repository::load_knowledge(&connection, "canonical")
        .unwrap()
        .unwrap();
    assert_eq!(
        canonical["body"],
        json!("Use a transaction for related writes.\n\nCommit related updates atomically.")
    );
    assert_eq!(
        canonical["sourceGroups"],
        json!([
            {"id":"subject:g0","text":"Use a transaction for related writes.","hash":repository::hash("Use a transaction for related writes."),"order":0},
            {"id":"canonical:g0","text":"Commit related updates atomically.","hash":repository::hash("Commit related updates atomically."),"order":1}
        ])
    );
    let fts: String = connection
        .query_row(
            "select body from knowledge_items_fts where id='canonical'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts, canonical["body"].as_str().unwrap());
    let vector:String=connection.query_row("select embedding_json from knowledge_items_vec_fallback where knowledge_id='canonical'",[],|r|r.get(0)).unwrap();
    assert_eq!(vector, "[0.8,0.2]");
}

#[test]
fn stale_input_low_confidence_and_conflicting_scope_do_not_mutate() {
    for case in ["stale", "confidence", "scope", "counter_evidence"] {
        let (mut connection, job, mut snapshot) = setup();
        let mut result = decision("deprecate_duplicate", &snapshot);
        match case {
            "stale" => {
                connection
                    .execute(
                        "update knowledge_items set body='new guidance' where id='canonical'",
                        [],
                    )
                    .unwrap();
            }
            "confidence" => result.verification.as_mut().unwrap().verdict = "unknown".into(),
            "scope" => snapshot["subject"]["appliesTo"] = json!({"path":"private"}),
            _ => result.verification.as_mut().unwrap().no_new_meaning = "unknown".into(),
        }
        persist(&mut connection, &job, &snapshot, Ok((result, None))).unwrap();
        assert_eq!(status(&connection, "subject"), "active", "{case}");
        let queue_status: String = connection
            .query_row(
                "select status from landscape_curation_queue where id=?1",
                [&job.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queue_status, "skipped");
    }
}

#[test]
fn rejects_lossy_verification_and_preserves_reverse_direction_lineage() {
    let (mut connection, job, snapshot) = setup();
    let mut lossy = decision("merge", &snapshot);
    lossy.verification.as_mut().unwrap().findings[0].checks["exceptions"] = json!("not_preserved");
    persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((lossy, Some(vec![0.8, 0.2]))),
    )
    .unwrap();
    assert_eq!(status(&connection, "subject"), "active");

    let (mut connection, job, snapshot) = setup();
    let mut reverse = decision("deprecate_duplicate", &snapshot);
    reverse.survivor_knowledge_id = Some("subject".into());
    reverse.deprecated_knowledge_ids = vec!["canonical".into()];
    reverse.retained_group_ids = vec!["subject:g0".into()];
    reverse.coverage[0].target_group_ids = vec!["subject:g0".into()];
    reverse.coverage[1].disposition = "entailed".into();
    reverse.coverage[1].target_group_ids = vec!["subject:g0".into()];
    let verification = reverse.verification.as_mut().unwrap();
    verification.findings[0].target_group_ids = vec!["subject:g0".into()];
    verification.findings[1].target_group_ids = vec!["subject:g0".into()];
    verification.input_hash = repository::hash(&repository::canonical_json(&snapshot));
    assert!(persist(&mut connection, &job, &snapshot, Ok((reverse, None))).unwrap());
    assert_eq!(status(&connection, "canonical"), "deprecated");
    let supersession: String = connection.query_row("select survivor_knowledge_id from knowledge_supersessions where deprecated_knowledge_id='canonical'", [], |row| row.get(0)).unwrap();
    assert_eq!(supersession, "subject");
    let audit: (String, String) = connection.query_row("select proposal_hash,verification_hash from curation_mutations where curation_job_id=?1", [&job.id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!((audit.0.len(), audit.1.len()), (64, 64));
}

#[test]
fn provider_failure_and_missing_embedding_never_partially_mutate() {
    let (mut connection, job, snapshot) = setup();
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("merge", &snapshot), None))
    )
    .is_err());
    assert_eq!(status(&connection, "subject"), "active");
    assert!(!persist(
        &mut connection,
        &job,
        &snapshot,
        Err("embedding unavailable".into())
    )
    .unwrap());
    let state: (String, i64) = connection
        .query_row(
            "select status,attempt_count from landscape_curation_queue where id=?1",
            [&job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("paused".into(), 1));
    assert_eq!(
        repository::load_knowledge(&connection, "canonical")
            .unwrap()
            .unwrap()["body"],
        snapshot["candidates"][0]["body"]
    );
}

#[test]
fn refuses_unknown_references_and_invalid_or_empty_llm_results() {
    let (_, _, mut snapshot) = setup();
    assert!(parse_decision("{}", &snapshot).is_err());
    assert!(parse_decision("null", &snapshot).is_err());
    let mut result = decision("deprecate_duplicate", &snapshot);
    result.survivor_knowledge_id = Some("unknown".into());
    assert!(parse_decision(&serde_json::to_string(&result).unwrap(), &snapshot).is_err());
    result.survivor_knowledge_id = Some("canonical".into());
    result.coverage.pop();
    assert!(parse_decision(&serde_json::to_string(&result).unwrap(), &snapshot).is_err());
    let mut third = snapshot["candidates"][0].clone();
    third["id"] = json!("third");
    third["sourceGroups"][0]["id"] = json!("third:g0");
    snapshot["candidates"].as_array_mut().unwrap().push(third);
    let mut unrelated = decision("deprecate_duplicate", &snapshot);
    unrelated.survivor_knowledge_id = Some("canonical".into());
    unrelated.deprecated_knowledge_ids = vec!["third".into()];
    unrelated.retained_group_ids = vec!["canonical:g0".into()];
    unrelated.coverage = vec![
        Coverage {
            source_group_id: "subject:g0".into(),
            disposition: "entailed".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
        Coverage {
            source_group_id: "third:g0".into(),
            disposition: "entailed".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
    ];
    assert!(parse_decision(&serde_json::to_string(&unrelated).unwrap(), &snapshot).is_err());
}

#[test]
fn runs_claimed_curation_through_http_provider_and_durable_completion() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    let (connection, job, _) = setup();
    let directory = super::super::test_support::temp_app_dir("curation-http");
    let path = directory.join("core.sqlite");
    connection
        .execute("vacuum into ?1", [path.to_string_lossy().as_ref()])
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for request_number in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            let input: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            let content = if request_number == 0 {
                assert_eq!(input["subject"]["id"], "subject");
                assert_eq!(input["candidates"][0]["id"], "canonical");
                serde_json::to_string(&decision("deprecate_duplicate", &input)).unwrap()
            } else {
                let input_hash = input["inputHash"].as_str().unwrap();
                json!({"schemaVersion":2,"verdict":"supported","inputHash":input_hash,"findings":[
                    {"sourceGroupId":"subject:g0","targetGroupIds":["canonical:g0"],"checks":{"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"}},
                    {"sourceGroupId":"canonical:g0","targetGroupIds":["canonical:g0"],"checks":{"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"}}
                ],"noNewMeaning":"preserved","noUnresolvedContradiction":"preserved","rationale":"All constraints are preserved."}).to_string()
            };
            let response = json!({"choices":[{"message":{"content":content}}]}).to_string();
            write!(reader.get_mut(),"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        }
    });
    let target = LocalLlmTargetConfig {
        target_id: "target".into(),
        api_base_url: format!("http://{address}/v1"),
        api_path: "/v1/chat/completions".into(),
        model: "test".into(),
    };
    let embedding = FinalizeEmbeddingConfig {
        provider: "disabled".into(),
        daemon_url: String::new(),
        access_token: None,
        timeout_seconds: 1,
        expected_dimension: Some(2),
        openai_api_base_url: None,
        openai_api_version: None,
        openai_model: None,
        openai_api_key: None,
    };
    let executed = run_for_path(&path, job.clone(), target, None, 30, embedding).unwrap();
    if !executed {
        let debug = open_query_only_connection(&path).unwrap()
            .query_row("select decision,policy_result,postcheck_result,last_error from landscape_curation_queue where id=?1", [&job.id], |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?)))
            .unwrap();
        panic!("curation execution was blocked: {debug:?}");
    }
    server.join().unwrap();
    let reader = open_query_only_connection(&path).unwrap();
    assert_eq!(status(&reader, "subject"), "deprecated");
    let row: (String, String) = reader
        .query_row(
            "select status,phase from landscape_curation_queue where id=?1",
            [job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("completed".into(), "postcheck".into()));
    drop(reader);
    std::fs::remove_dir_all(directory).unwrap();
}

#[path = "curation_evaluation.rs"]
mod evaluation;
