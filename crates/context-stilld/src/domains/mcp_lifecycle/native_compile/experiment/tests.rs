use std::{
    io::{Read, Write},
    net::TcpListener,
};

use super::super::types::OpenAiSettings;
use super::*;

fn dataset_value() -> Value {
    json!({"contractVersion":1,"id":"paired-test","provenance":"unit fixture",
        "repetitions":1,"maxProviderCalls":7,"maxTokens":512,"timeoutMs":1000,
        "corpus":[{"id":"alpha","title":"alpha maintenance","body":"alpha uses the reviewed decision.","source":"unit"}],
        "queries":[{"id":"task","goal":"alpha maintenance: return JSON with decision.",
            "source":"unit","expectedIds":["alpha"],"checks":[{"pointer":"/decision","equals":"HELD_OUT_SENTINEL","critical":true}]}]})
}

#[test]
fn rejects_unlabelled_duplicate_and_unbounded_datasets() {
    for pointer in ["/queries/0/checks", "/queries/0/goal", "/maxProviderCalls"] {
        let mut value = dataset_value();
        *value.pointer_mut(pointer).unwrap() = match pointer {
            "/queries/0/checks" => json!([]),
            "/queries/0/goal" => json!(""),
            _ => json!(6),
        };
        assert!(Dataset::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = dataset_value();
    value["queries"][0]["forbiddenIds"] = json!(["alpha"]);
    assert!(Dataset::parse(value.to_string().as_bytes()).is_err());
    value["queries"][0]["forbiddenIds"] = json!(["missing"]);
    assert!(Dataset::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn answer_prompt_excludes_private_labels_and_dataset_hash_binds_content() {
    let value = dataset_value();
    let bytes = value.to_string();
    let data = Dataset::parse(bytes.as_bytes()).unwrap();
    let prompt = answer_prompt(&data.queries[0], "reference");
    assert!(!prompt.contains("HELD_OUT_SENTINEL"));
    assert!(!prompt.contains("expectedIds"));
    assert!(!prompt.contains("checks"));
    assert_eq!(
        grade(&data.queries[0], &json!({"decision":"HELD_OUT_SENTINEL"})),
        (1.0, false)
    );
    assert_eq!(
        grade(&data.queries[0], &json!({"decision":"wrong"})),
        (0.0, true)
    );
    assert_ne!(
        hash(bytes.as_bytes()),
        hash(bytes.replace("reviewed", "changed").as_bytes())
    );
}

#[test]
fn failed_pairs_remain_in_quality_denominator_and_single_task_has_no_interval() {
    let report = summarize(&[
        json!({"taskId":"t","repetition":0,"condition":"no_memory","status":"completed","quality":1.0}),
        json!({"taskId":"t","repetition":0,"condition":"legacy_memory","status":"failed","quality":0.0}),
    ]);
    assert_eq!(report["comparisons"][0]["completePairs"], 0);
    assert_eq!(
        report["comparisons"][0]["meanQualityDeltaAllAttempts"],
        -1.0
    );
    assert!(report["comparisons"][0]["taskPairedBootstrap95"].is_null());
}

#[test]
fn production_retrieval_keeps_wrong_project_out() {
    let mut value = dataset_value();
    value["corpus"][0]["projectRef"] = json!("other");
    let data = Dataset::parse(value.to_string().as_bytes()).unwrap();
    let fixture = data.fixture().unwrap();
    let task = &data.queries[0];
    assert!(search_knowledge_items(
        &fixture,
        &task.goal,
        8,
        &task_identity(task).unwrap(),
        &RepositoryRequestFacets::default(),
        true
    )
    .is_empty());
}

#[test]
fn paired_runner_uses_real_http_usage_and_never_sends_labels() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for _ in 0..10 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(split) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..split]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap();
                    if bytes.len() >= split + 4 + length {
                        break bytes[split + 4..split + 4 + length].to_vec();
                    }
                }
            };
            let raw = String::from_utf8(body).unwrap();
            assert!(!raw.contains("HELD_OUT_SENTINEL"));
            let request: Value = serde_json::from_str(&raw).unwrap();
            let content = if request["messages"][0]["content"] == ANSWER_SYSTEM {
                json!({"decision":"unknown"})
            } else {
                json!({"markdown":"## alpha maintenance\nUse the reviewed alpha decision.",
                    "usedKnowledge":[{"id":"alpha","confidence":1}],"usedEpisodes":[]})
            };
            let response =
                json!({"model":"fixture-model","usage":{"prompt_tokens":10,"completion_tokens":4},
                "choices":[{"message":{"content":content.to_string()}}]})
                .to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        }
    });
    let mut value = dataset_value();
    let mut second = value["queries"][0].clone();
    second["id"] = json!("task-2");
    value["queries"].as_array_mut().unwrap().push(second);
    value["maxProviderCalls"] = json!(14);
    let bytes = value.to_string();
    let data = Dataset::parse(bytes.as_bytes()).unwrap();
    let settings = RuntimeSettings {
        agentic_enabled: true,
        provider: "openai".into(),
        fallback: vec![],
        timeout_ms: 1000,
        max_tokens: 512,
        azure: None,
        local: None,
        local_llm_model: None,
        openai: Some(OpenAiSettings {
            api_key: "test".into(),
            api_base_url: format!("http://{address}/v1"),
            model: "fixture-model".into(),
        }),
    };
    let report = run_with_settings(&data, bytes.as_bytes(), settings).unwrap();
    server.join().unwrap();
    assert_eq!(report["providerCallsExecuted"], 10);
    assert_eq!(report["results"].as_array().unwrap().len(), 6);
    assert_eq!(report["results"][0]["inputTokens"], 10);
    assert_eq!(report["results"][1]["inputTokens"], 20);
    assert!(report["results"][1]["estimatedCost"].is_null());
    assert_eq!(report["promotionEligible"], false);
}

#[test]
fn regression_dataset_preserves_expected_retrieval_despite_history_distractors() {
    let bytes = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/context-compile-foundation/decision-tasks.v1.json"
    ));
    let data = Dataset::parse(bytes).unwrap();
    let fixture = data.fixture().unwrap();
    for task in &data.queries {
        let candidates = search_knowledge_items(
            &fixture,
            &task.goal,
            KNOWLEDGE_CANDIDATE_LIMIT,
            &task_identity(task).unwrap(),
            &RepositoryRequestFacets::default(),
            true,
        );
        let ids = rank_foundation_knowledge(&candidates)
            .iter()
            .map(|k| k.id.clone())
            .collect::<Vec<_>>();
        for expected in &task.expected_ids {
            assert!(
                ids.contains(expected),
                "{} missing {expected}: {ids:?}",
                task.id
            );
        }
        assert!(ids.iter().all(|id| !task.forbidden_ids.contains(id)));
    }
}

#[test]
fn provider_failure_opens_circuit_and_counts_unattempted_pairs() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let mut value = dataset_value();
    value["repetitions"] = json!(2);
    value["maxProviderCalls"] = json!(14);
    let bytes = value.to_string();
    let data = Dataset::parse(bytes.as_bytes()).unwrap();
    let settings = RuntimeSettings {
        agentic_enabled: true,
        provider: "openai".into(),
        fallback: vec![],
        timeout_ms: 1000,
        max_tokens: 512,
        azure: None,
        local: None,
        local_llm_model: None,
        openai: Some(OpenAiSettings {
            api_key: "test".into(),
            api_base_url: format!("http://{address}/v1"),
            model: "fixture".into(),
        }),
    };
    let report = run_with_settings(&data, bytes.as_bytes(), settings).unwrap();
    assert_eq!(report["providerCallsExecuted"], 5);
    let rows = report["results"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .filter(|r| r["status"] == "not_attempted")
            .count(),
        3
    );
    assert!(rows.iter().all(|r| r["quality"] == 0.0));
    assert_eq!(report["summary"]["comparisons"][0]["completePairs"], 0);
    assert_eq!(report["summary"]["comparisons"][0]["independentTasks"], 1);
    assert!(rows[0]["estimatedCost"].is_null());
    assert!(rows[0]["inputTokens"].is_null());
}

#[test]
fn composer_prompt_preserves_later_conditions_numbers_and_long_goals() {
    let body = "Use Foundation ranking. Knowledge is limited to 8; episodes to 3.\nDo not accept relative paths.";
    let evidence = super::super::prompts::composer_evidence(body);
    assert_eq!(evidence["text"], body);
    assert_eq!(evidence["truncated"], false);
    let long = format!("START {} END do not write", "🙂".repeat(1400));
    let evidence = super::super::prompts::composer_evidence(&long);
    assert_eq!(evidence["text"].as_str().unwrap().chars().count(), 1423);
    assert!(evidence["text"]
        .as_str()
        .unwrap()
        .ends_with("END do not write"));
    assert_eq!(evidence["truncated"], false);
    let goal = format!("{} preserve-tail-condition", "task ".repeat(80));
    let prompt = super::super::prompts::build_composer_user_prompt(
        &goal,
        &[],
        &[],
        &super::super::types::ComposePlan::default(),
    );
    assert!(prompt.contains("preserve-tail-condition"));
}
