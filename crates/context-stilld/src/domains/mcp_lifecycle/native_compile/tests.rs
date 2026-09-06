#![cfg(test)]
use super::call_metrics::ProviderCall;
use super::test_support::*;
use super::*;
use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn provider_failover_count_requires_a_failed_transition_to_a_different_provider() {
    let calls = vec![
        ProviderCall {
            provider: "primary".to_string(),
            succeeded: false,
            latency_ms: 10.0,
            input_tokens: None,
            output_tokens: None,
            reported_model: None,
        },
        ProviderCall {
            provider: "primary".to_string(),
            succeeded: true,
            latency_ms: 10.0,
            input_tokens: None,
            output_tokens: None,
            reported_model: None,
        },
        ProviderCall {
            provider: "primary".to_string(),
            succeeded: false,
            latency_ms: 10.0,
            input_tokens: None,
            output_tokens: None,
            reported_model: None,
        },
        ProviderCall {
            provider: "fallback".to_string(),
            succeeded: true,
            latency_ms: 10.0,
            input_tokens: None,
            output_tokens: None,
            reported_model: None,
        },
    ];

    assert_eq!(count_provider_failovers(&calls), 1);
}

#[test]
fn native_compile_excludes_wrong_project_and_unresolved_selection() {
    let fixture = repository_isolation_fixture();
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    seed_repository_isolation_knowledge(&connection, &fixture);
    drop(connection);

    let result = context_compile(
        &json!({"arguments": {
            "goal": fixture.legacy_reproduction.goal,
            "projectRef": "project-A"
        }}),
        &NativeToolContext::for_test(std::env::temp_dir(), db_path.clone()),
    );
    assert_ne!(result["content"][0]["text"], "No Content");

    let connection = Connection::open(&db_path).unwrap();
    let pack_ids = connection
        .prepare("select item_id from context_pack_items order by id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .flatten()
        .collect::<Vec<_>>();
    let candidate_ids = connection
        .prepare(
            "select item_id from context_compile_candidate_traces where selected = 1 order by id",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(pack_ids, candidate_ids);
    assert!(!fixture
        .legacy_reproduction
        .expected_legacy_selected_any
        .iter()
        .any(|id| pack_ids.contains(id)));
    assert!(!pack_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
    assert!(!pack_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
    assert!(pack_ids.contains(&"knowledge-repo-a-project".to_string()));
    assert!(pack_ids.contains(&"knowledge-global-general".to_string()));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn split_legacy_rank_preserves_legacy_selected_ids() {
    let fixture = repository_isolation_fixture();
    let legacy_path = temp_db_path();
    let split_path = temp_db_path();
    for path in [&legacy_path, &split_path] {
        let connection = Connection::open(path).unwrap();
        create_minimal_compile_schema(&connection);
        seed_repository_isolation_knowledge(&connection, &fixture);
    }
    let arguments = json!({"arguments": {
        "goal": fixture.legacy_reproduction.goal,
        "projectRef": "project-A"
    }});
    let legacy_context = NativeToolContext::for_test(std::env::temp_dir(), legacy_path.clone());
    let mut split_context = NativeToolContext::for_test(std::env::temp_dir(), split_path.clone());
    split_context.compile_runtime = std::sync::Arc::new(
        crate::domains::context_compile::runtime::CompileRuntimeContext {
            mode: CompileFoundationMode::SplitLegacyRank,
            ..(*split_context.compile_runtime).clone()
        },
    );

    let legacy = context_compile(&arguments, &legacy_context);
    let split = context_compile(&arguments, &split_context);
    assert!(legacy.get("isError").is_none());
    assert!(split.get("isError").is_none());

    let selected_ids = |path: &std::path::Path| {
        let connection = Connection::open(path).unwrap();
        let ids = connection
            .prepare("select item_id from context_pack_items order by item_kind, item_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        ids
    };
    assert_eq!(selected_ids(&legacy_path), selected_ids(&split_path));
    let split_pack: Value = Connection::open(&split_path)
        .unwrap()
        .query_row(
            "select pack_snapshot from context_compile_runs limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .unwrap();
    assert_eq!(
        split_pack["diagnostics"]["foundation"]["pipelineMode"],
        "split_legacy_rank"
    );

    let _ = std::fs::remove_file(legacy_path);
    let _ = std::fs::remove_file(split_path);
}

#[test]
fn native_retrieval_applies_scope_and_facets_before_any_candidate_limit() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_minimal_compile_schema(&connection);
    let transaction = connection.transaction().unwrap();
    for index in 0..501 {
        transaction
            .execute(
                r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref,
                      title, body, importance, applies_to
                    ) values (?1, 'rule', 'active', 'repo', 'classified', 'project-B',
                      'knowledge saturation anchor', 'wrong repository', 100, '{"general":true}')
                    "#,
                [format!("wrong-project-{index:04}")],
            )
            .unwrap();
    }
    transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, project_ref,
                  title, body, importance, applies_to
                ) values ('knowledge-anchor', 'rule', 'active', 'repo', 'classified', 'project-A',
                  'knowledge saturation anchor', 'correct repository', 1, '{"technologies":["rust"]}')
                "#,
                [],
            )
            .unwrap();
    for index in 0..501 {
        transaction
                .execute(
                    r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref,
                      title, body, importance, applies_to
                    ) values (?1, 'rule', 'active', 'repo', 'classified', 'project-A',
                      'facet saturation anchor', 'typescript only', 100, '{"technologies":["typescript"]}')
                    "#,
                    [format!("wrong-facet-{index:04}")],
                )
                .unwrap();
    }
    transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, project_ref,
                  title, body, importance, applies_to
                ) values ('knowledge-facet-anchor', 'rule', 'active', 'repo', 'classified', 'project-A',
                  'facet saturation anchor', 'rust match', 1, '{"technologies":["rust"]}')
                "#,
                [],
            )
            .unwrap();
    for index in 0..201 {
        transaction
            .execute(
                r#"
                    insert into episode_cards (
                      id, title, situation, lesson, technologies, classification_status,
                      scope, project_ref, importance
                    ) values (?1, 'episode saturation anchor', 'wrong repository', 'ignore',
                      '["rust"]', 'classified', 'repo', 'project-B', 100)
                    "#,
                [format!("wrong-episode-{index:04}")],
            )
            .unwrap();
    }
    transaction
        .execute(
            r#"
                insert into episode_cards (
                  id, title, situation, lesson, technologies, classification_status,
                  scope, project_ref, importance
                ) values ('episode-anchor', 'episode saturation anchor', 'correct repository',
                  'use this', '["rust"]', 'classified', 'repo', 'project-A', 1)
                "#,
            [],
        )
        .unwrap();
    transaction
            .execute(
                r#"
                insert into knowledge_items (
                  id, type, status, scope, classification_status, title, body, importance, applies_to
                ) values ('global-anchor', 'rule', 'active', 'global', 'classified',
                  'global only anchor', 'global candidate', 1, '{"general":true}')
                "#,
                [],
            )
            .unwrap();
    transaction.commit().unwrap();

    let project_identity = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: Some("project-A".to_string()),
            repo_key: None,
            repo_path: None,
        },
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .unwrap();
    let rust_facets = RepositoryRequestFacets {
        technologies: vec!["rust".to_string()],
        change_types: Vec::new(),
        domains: Vec::new(),
    };

    let scoped = search_knowledge_items(
        &connection,
        "knowledge saturation anchor",
        8,
        &project_identity,
        &rust_facets,
        false,
    );
    assert!(scoped.iter().any(|item| item.id == "knowledge-anchor"));
    assert!(!scoped
        .iter()
        .any(|item| item.id.starts_with("wrong-project-")));

    let faceted = search_knowledge_items(
        &connection,
        "facet saturation anchor",
        8,
        &project_identity,
        &rust_facets,
        false,
    );
    assert!(faceted
        .iter()
        .any(|item| item.id == "knowledge-facet-anchor"));
    assert!(!faceted
        .iter()
        .any(|item| item.id.starts_with("wrong-facet-")));

    let episodes = search_episode_cards(
        &connection,
        "episode saturation anchor",
        3,
        &project_identity,
        &rust_facets,
        false,
    );
    assert!(episodes.iter().any(|item| item.id == "episode-anchor"));
    assert!(!episodes
        .iter()
        .any(|item| item.id.starts_with("wrong-episode-")));

    let global_identity = resolve_compile_project_identity(
        &CompileProjectIdentityInput::default(),
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .unwrap();
    let global = search_knowledge_items(
        &connection,
        "global only anchor",
        8,
        &global_identity,
        &RepositoryRequestFacets::default(),
        false,
    );
    assert_eq!(
        global
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["global-anchor"]
    );
}

#[test]
fn agentic_harness_observes_candidate_outbound_and_pack_ids() {
    let fixture = repository_isolation_fixture();
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    seed_repository_isolation_knowledge(&connection, &fixture);
    let expected_used_ids = vec![
        "knowledge-global-general".to_string(),
        "knowledge-global-rust".to_string(),
        "knowledge-repo-a-project".to_string(),
        "knowledge-repo-a-general".to_string(),
    ];
    let (base_url, mock_handle) =
        spawn_composer_mock(&fixture.legacy_reproduction.goal, &expected_used_ids);
    let settings = json!({
        "settings": {
            "providers": {
                "openai": {"enabled": false, "apiBaseUrl": "https://api.openai.com/v1", "model": "gpt-test"},
                "azure-openai": {"enabled": false, "apiBaseUrl": "", "apiPath": "/openai/deployments", "apiVersion": "2025-04-01-preview", "model": ""},
                "local-llm": {
                    "enabled": true,
                    "apiBaseUrl": base_url,
                    "apiPath": "/chat",
                    "model": "fixture-model",
                    "models": []
                }
            },
            "taskRouting": {
                "agenticCompile": {
                    "enabled": true,
                    "provider": "local-llm",
                    "model": "fixture-model",
                    "fallback": [],
                    "timeoutMs": 5000,
                    "maxTokens": 512
                }
            }
        }
    });
    connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
    drop(connection);

    let result = context_compile(
        &json!({"arguments": {
            "goal": fixture.legacy_reproduction.goal,
            "projectRef": "project-A"
        }}),
        &NativeToolContext::for_test(std::env::temp_dir(), db_path.clone()),
    );
    assert!(!result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false));
    let outbound_requests = mock_handle.join().unwrap();
    assert_eq!(
        outbound_requests.len(),
        1,
        "composer must use one provider call"
    );

    let connection = Connection::open(&db_path).unwrap();
    let selected_ids = connection
        .prepare(
            "select item_id from context_compile_candidate_traces where selected = 1 order by id",
        )
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .flatten()
        .collect::<BTreeSet<_>>();
    let pack_ids = connection
        .prepare("select item_id from context_pack_items order by id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .flatten()
        .collect::<BTreeSet<_>>();
    let all_fixture_ids = fixture
        .candidates
        .iter()
        .map(|candidate| candidate.id.as_str())
        .collect::<Vec<_>>();
    let outbound_ids = outbound_requests
        .iter()
        .flat_map(|request| {
            let payload: Value = serde_json::from_str(request).unwrap();
            let user_content = payload["messages"]
                .as_array()
                .and_then(|messages| messages.iter().find(|message| message["role"] == "user"))
                .and_then(|message| message["content"].as_str())
                .unwrap_or_default();
            all_fixture_ids
                .iter()
                .filter(move |id| user_content.contains(**id))
                .map(|id| (*id).to_string())
                .collect::<Vec<_>>()
        })
        .collect::<BTreeSet<_>>();

    assert_eq!(selected_ids, pack_ids);
    assert!(outbound_ids.is_subset(&selected_ids));
    for expected in expected_used_ids {
        assert!(selected_ids.contains(&expected));
        assert!(outbound_ids.contains(&expected));
    }
    assert!(!selected_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
    assert!(!selected_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
    assert!(!outbound_ids.contains(&fixture.legacy_reproduction.wrong_project_knowledge_id));
    assert!(!outbound_ids.contains(&fixture.legacy_reproduction.unresolved_knowledge_id));
    let pack_snapshot = connection
        .query_row(
            "select pack_snapshot from context_compile_runs limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    let pack: Value = serde_json::from_str(&pack_snapshot).unwrap();
    let provider_attempts = pack["diagnostics"]["responseComposer"]["providerAttempts"]
        .as_array()
        .unwrap();
    assert_eq!(provider_attempts.len(), outbound_requests.len());
    assert!(provider_attempts
        .iter()
        .all(|attempt| attempt["succeeded"] == true));
    let _ = std::fs::remove_file(db_path);
}

fn sample_knowledge() -> Vec<PackKnowledge> {
    vec![
            PackKnowledge {
                id: "rule-1".to_string(),
                kind: "rule".to_string(),
                title: "Rust native context_compile must preserve TS composer behavior".to_string(),
                body: "Use when: migrating context_compile to Rust.\nVerification:\n- Output is composed markdown, not a raw context pack.".to_string(),
                polarity: "positive".to_string(),
                score: 10,
                query_score: 10,
                dynamic_score: 0.0,
                importance: 70.0,
                source_refs: vec![],
                scope_snapshot: json!({}),
            },
            PackKnowledge {
                id: "procedure-1".to_string(),
                kind: "procedure".to_string(),
                title: "Route context_compile through the configured composer".to_string(),
                body: "Workflow:\n1. Load runtime settings from SQLite.\n2. Use taskRouting.agenticCompile.\nVerification:\n- The result has task-focused headings.\nAvoid:\n- Do not expose ranking metadata as the user-facing answer.".to_string(),
                polarity: "positive".to_string(),
                score: 9,
                query_score: 9,
                dynamic_score: 0.0,
                importance: 70.0,
                source_refs: vec![],
                scope_snapshot: json!({}),
            },
        ]
}

#[test]
fn fallback_compose_does_not_render_raw_context_pack() {
    let markdown = build_fallback_compose(
        "Rust composer fallback should follow TS output contract",
        &sample_knowledge(),
        &[],
        &ComposePlan::default(),
    );

    assert!(markdown.contains("## 実装フォーカス"));
    assert!(markdown.contains("## 実装手順"));
    assert!(markdown.contains("## 検証観点"));
    assert!(!markdown.contains("# Context Pack"));
    assert!(!markdown.contains("runId"));
    assert!(!markdown.contains("score"));
    assert!(markdown.contains("[rule-1]"));
    assert!(markdown.contains("Use when: migrating context_compile to Rust."));
}

#[test]
fn fallback_compose_preserves_late_conditions_and_negative_guardrails() {
    let knowledge = vec![
        PackKnowledge {
            id: "rule-retention".to_string(),
            kind: "rule".to_string(),
            title: "バックアップ運用".to_string(),
            body: "保存期間は30日。\n削除前に復元確認を必須とする。".to_string(),
            polarity: "positive".to_string(),
            score: 10,
            query_score: 10,
            dynamic_score: 0.0,
            importance: 70.0,
            source_refs: vec![],
            scope_snapshot: json!({}),
        },
        PackKnowledge {
            id: "guardrail-delete".to_string(),
            kind: "rule".to_string(),
            title: "削除の前提".to_string(),
            body: "復元確認前の削除は禁止。".to_string(),
            polarity: "negative".to_string(),
            score: 9,
            query_score: 9,
            dynamic_score: 0.0,
            importance: 70.0,
            source_refs: vec![],
            scope_snapshot: json!({}),
        },
    ];

    let markdown = build_fallback_compose(
        "バックアップ運用を変更する",
        &knowledge,
        &[],
        &ComposePlan::default(),
    );
    let used = fallback_used_knowledge(&knowledge, &[], &ComposePlan::default());

    assert!(markdown.contains("保存期間は30日。"));
    assert!(markdown.contains("削除前に復元確認を必須とする。"));
    assert!(markdown.contains("復元確認前の削除は禁止。"));
    assert!(markdown.contains("## 適用条件・禁止事項"));
    assert_eq!(used.len(), 2);
    assert!(used
        .iter()
        .all(|item| item.reason.as_deref() == Some("fallback_evidence_rendered")));
    assert!(used.iter().any(|item| item.id == "guardrail-delete"
        && item.output_section.as_deref() == Some("適用条件・禁止事項")));
}

#[test]
fn budget_partial_is_persisted_as_degraded_with_renderer_reasons() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    connection
        .execute(
            r#"
            insert into knowledge_items
              (id, type, status, scope, classification_status, polarity, title, body, applies_to)
            values (?1, 'rule', 'active', 'global', 'classified', 'negative', ?2, ?3, '{}')
            "#,
            (
                "oversized-protected",
                "Budget guardrail",
                "budget-token ".repeat(3_000),
            ),
        )
        .unwrap();
    drop(connection);

    let mut context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
    context.compile_runtime = std::sync::Arc::new(
        crate::domains::context_compile::runtime::CompileRuntimeContext {
            mode: CompileFoundationMode::SplitLegacyRank,
            ..(*context.compile_runtime).clone()
        },
    );
    let result = context_compile(
        &json!({"arguments": {"goal": "budget-token", "projectRef": "project-a"}}),
        &context,
    );
    assert!(result.get("isError").is_none());

    let (status, snapshot): (String, String) = Connection::open(&db_path)
        .unwrap()
        .query_row(
            "select status, pack_snapshot from context_compile_runs limit 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(status, "degraded");
    assert!(snapshot["diagnostics"]["degradedReasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().is_some_and(|value| value
            .starts_with("CONTEXT_EVIDENCE_PARTIAL:protected_group_omitted:oversized-protected"))));
    assert!(
        snapshot["diagnostics"]["responseComposer"]["partialReasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "protected_group_omitted:oversized-protected")
    );
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn context_compile_reports_incompatible_retrieval_schema_instead_of_no_content() {
    let db_path = temp_db_path();
    let mut connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    connection
        .execute(
            "alter table knowledge_items rename column body to broken_body",
            [],
        )
        .unwrap();
    let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());

    let result = context_compile_on_connection(
        &json!({"arguments": {"goal": "backup retention"}}),
        &context,
        &mut connection,
    );

    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("knowledge retrieval schema is incompatible")));
    let run_count: i64 = connection
        .query_row("select count(*) from context_compile_runs", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(run_count, 0);
    drop(connection);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn compile_run_insert_fails_closed_when_identity_trace_cannot_be_saved() {
    let mut connection = Connection::open_in_memory().unwrap();
    create_minimal_compile_schema(&connection);
    connection
        .execute("drop table context_compile_task_traces", [])
        .unwrap();
    let input = json!({"goal": "trace persistence", "projectRef": "project-A"});
    let pack = json!({});
    let transaction = connection.transaction().unwrap();
    let error = insert_compile_run(CompileRunInsert {
        connection: &transaction,
        run_id: "run-trace-failure",
        goal: "trace persistence",
        session_id: None,
        project_ref: Some("project-A"),
        repo_path: None,
        repo_key: None,
        match_basis: "project_ref",
        identity_contract_version: 1,
        scope_mode: "project",
        identity_fingerprint: Some(
            "0513f9c3cf83583e36682ab931ecc66a70eafc5cd40b15123fab848a60cd7407",
        ),
        identity_trust: "request_hint",
        binding_status: "not_applicable",
        input: &input,
        status: "ok",
        pack: &pack,
        duration_ms: 1,
    })
    .expect_err("missing identity trace table must fail the compile write");
    assert!(error.contains("failed to insert context_compile task trace"));
    drop(transaction);

    let run_count: i64 = connection
        .query_row("select count(*) from context_compile_runs", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(run_count, 0);
}

#[test]
fn context_compile_disabled_agentic_settings_returns_composed_fallback() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body) values (?1, ?2, 'active', ?3, ?4)",
                (
                    "procedure-1",
                    "procedure",
                    "Rust composer fallback route",
                    "Workflow:\n1. Load runtime settings.\n2. Compose user-facing markdown.\nVerification:\n- No raw Context Pack is returned.",
                ),
            )
            .unwrap();
    connection
            .execute(
                "insert into episode_cards (id, title, situation, lesson, importance) values (?1, ?2, ?3, ?4, 80)",
                (
                    "episode-1",
                    "Rust composer fallback route precedent",
                    "Rust context_compile was moved to native daemon.",
                    "Keep MCP context_compile persistence in Rust, including audit signals.",
                ),
            )
            .unwrap();
    let settings = json!({
        "settings": {
            "providers": {
                "openai": {"enabled": false, "apiBaseUrl": "https://api.openai.com/v1", "model": "gpt-test"},
                "azure-openai": {"enabled": false, "apiBaseUrl": "", "apiPath": "/openai/deployments", "apiVersion": "2025-04-01-preview", "model": ""},
                "local-llm": {"enabled": false, "apiBaseUrl": "http://127.0.0.1:4444", "apiPath": "/v1/chat/completions", "model": "local-test", "models": []}
            },
            "taskRouting": {
                "agenticCompile": {
                    "enabled": false,
                    "provider": "local-llm",
                    "model": "local-test",
                    "fallback": [],
                    "timeoutMs": 1000,
                    "maxTokens": 512
                }
            }
        }
    });
    connection
            .execute(
                "insert into settings (id, namespace, key, value) values ('settings-1', 'runtime', 'settings.v1', ?1)",
                [settings.to_string()],
            )
            .unwrap();
    drop(connection);

    let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
    let result = context_compile(
        &json!({"arguments": {
            "goal": "Rust composer fallback route",
            "projectRef": "project-A",
            "repoKey": "ORG/Repo-A",
            "repoPath": "/work/./repo-a"
        }}),
        &context,
    );
    let text = result["content"][0]["text"].as_str().unwrap();

    assert!(text.contains("## 実装フォーカス"));
    assert!(text.contains("## 実装手順"));
    assert!(!text.contains("# Context Pack"));
    assert!(!text.contains("runId"));
    assert!(!text.contains("score"));
    assert!(!text.contains("project-A"));
    assert!(!text.contains("/work/repo-a"));
    assert!(!result
        .get("isError")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false));

    let connection = Connection::open(&db_path).unwrap();
    let usage_rows = connection
            .query_row(
                "select count(*), sum(case when verdict = 'used' then 1 else 0 end) from knowledge_usage_events",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
    assert_eq!(usage_rows, (1, 1));
    let episode_usage_rows = connection
            .query_row(
                "select count(*), sum(case when verdict = 'used' then 1 else 0 end) from episode_retrieval_feedback",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
    assert_eq!(episode_usage_rows, (1, 1));
    let pack_kind = connection
            .query_row(
                "select item_kind from context_pack_items where run_id = (select id from context_compile_runs limit 1) limit 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
    assert_eq!(pack_kind, "procedure");
    let trace_rows = connection
            .query_row(
                "select count(*), sum(case when selected = 1 then 1 else 0 end) from context_compile_candidate_traces",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
    assert_eq!(trace_rows, (1, 1));
    let trace_reason = connection
        .query_row(
            "select ranking_reason from context_compile_candidate_traces limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(trace_reason, "rust_native_text_score");
    let run_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, identity_contract_version, scope_mode, input from context_compile_runs limit 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(run_identity.0, "project-A");
    assert_eq!(run_identity.1, "org/repo-a");
    assert_eq!(run_identity.2, "/work/repo-a");
    assert_eq!(run_identity.3, "project_ref");
    assert_eq!(run_identity.4, 1);
    assert_eq!(run_identity.5, "project");
    let persisted_input: Value = serde_json::from_str(&run_identity.6).unwrap();
    assert_eq!(
        persisted_input["projectIdentity"]["bindingStatus"],
        "unverified"
    );
    let trace_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, identity_fingerprint, identity_trust, binding_status from context_compile_task_traces limit 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(trace_identity.0, "project-A");
    assert_eq!(trace_identity.1, "org/repo-a");
    assert_eq!(trace_identity.2, "/work/repo-a");
    assert_eq!(trace_identity.3, "project_ref");
    assert_eq!(trace_identity.4.len(), 64);
    assert_eq!(trace_identity.5, "request_hint");
    assert_eq!(trace_identity.6, "unverified");

    let global_only = context_compile(
        &json!({"arguments": {"goal": "Rust global-only identity trace"}}),
        &context,
    );
    assert!(!global_only
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false));
    let global_identity = connection
            .query_row(
                "select project_ref, repo_key, repo_path, match_basis, scope_mode, input from context_compile_runs where goal = 'Rust global-only identity trace'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
    assert_eq!(global_identity.0, None);
    assert_eq!(global_identity.1, None);
    assert_eq!(global_identity.2, None);
    assert_eq!(global_identity.3, "none");
    assert_eq!(global_identity.4, "global_only");
    let global_input: Value = serde_json::from_str(&global_identity.5).unwrap();
    assert_eq!(global_input["projectIdentity"]["matchValue"], Value::Null);
    assert_eq!(
        global_input["projectIdentity"]["identityFingerprint"],
        Value::Null
    );

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn foundation_split_persists_counter_and_diagnostic_contracts() {
    let db_path = temp_db_path();
    let connection = Connection::open(&db_path).unwrap();
    create_minimal_compile_schema(&connection);
    connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body, dynamic_score) values ('rule-foundation', 'rule', 'active', 'Foundation split persistence', 'Persist selected counters through the SQLite writer.', -999)",
                [],
            )
            .unwrap();
    connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body, dynamic_score) values ('rule-unmatched', 'rule', 'active', 'Unrelated candidate', 'This content has no requested terms.', 999)",
                [],
            )
            .unwrap();
    for index in 0..300 {
        connection
                .execute(
                    "insert into knowledge_items (id, type, status, title, body, dynamic_score) values (?1, 'rule', 'active', 'Unrelated candidate', 'This content has no requested terms.', 1000)",
                    [format!("rule-unmatched-{index:03}")],
                )
                .unwrap();
    }
    connection
            .execute(
                "insert into episode_cards (id, title, situation, lesson) values ('episode-foundation', 'Foundation split persistence precedent', 'A compile transaction needs verified counters.', 'Commit the pack snapshot and counter changes together.')",
                [],
            )
            .unwrap();
    drop(connection);

    let mut context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
    context.compile_runtime = std::sync::Arc::new(
        crate::domains::context_compile::runtime::CompileRuntimeContext {
            mode: CompileFoundationMode::Foundation,
            ..(*context.compile_runtime).clone()
        },
    );
    let result = context_compile(
        &json!({"arguments": {"goal": "Foundation split persistence"}}),
        &context,
    );
    assert!(result.get("isError").is_none());

    let connection = Connection::open(&db_path).unwrap();
    let knowledge_counter: i64 = connection
        .query_row(
            "select compile_select_count from knowledge_items where id = 'rule-foundation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let episode_counter: i64 = connection
        .query_row(
            "select compile_use_count from episode_cards where id = 'episode-foundation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(knowledge_counter, 1);
    assert_eq!(episode_counter, 1);
    let pack: Value = connection
        .query_row(
            "select pack_snapshot from context_compile_runs limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .unwrap();
    assert_eq!(pack["diagnostics"]["foundation"]["snapshotComplete"], true);
    assert_eq!(
        pack["diagnostics"]["foundation"]["pipelineMode"],
        "foundation"
    );
    assert_eq!(
        pack["diagnostics"]["foundation"]["persistence"]["knowledgeCounterUpdated"],
        1
    );
    assert_eq!(
        pack["diagnostics"]["foundation"]["persistence"]["episodeCounterUpdated"],
        1
    );
    assert_eq!(
        pack["diagnostics"]["foundation"]["candidates"]["eligibleKnowledge"],
        9
    );
    assert_eq!(
        pack["diagnostics"]["foundation"]["candidates"]["queryMatchedKnowledge"],
        1
    );
    let delivered_ids = connection
        .prepare("select item_id from context_pack_items where item_kind != 'episode'")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(delivered_ids, vec!["rule-foundation"]);
    let evidence: Value = connection
            .query_row(
                "select evidence from context_compile_candidate_traces where item_id = 'rule-foundation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
    assert_eq!(evidence["foundation"]["delivered"], true);
    assert_eq!(
        evidence["foundation"]["contentVersion"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    let shadow_selected: i64 = connection
            .query_row(
                "select count(*) from context_compile_candidate_traces where item_kind != 'episode' and selected = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert!(shadow_selected > 0);
    let episode_trace: Value = connection
            .query_row(
                "select evidence from context_compile_candidate_traces where item_id = 'episode-foundation'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).unwrap())
            .unwrap();
    assert_eq!(episode_trace["foundation"]["delivered"], true);
    assert_eq!(
        episode_trace["foundation"]["contentVersion"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    drop(connection);
    let _ = std::fs::remove_file(db_path);
}

#[test]
fn context_compile_rejects_non_string_project_identity() {
    let db_path = temp_db_path();
    let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
    let result = context_compile(
        &json!({"arguments": {"goal": "Reject malformed identity", "projectRef": 42}}),
        &context,
    );

    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("projectRef must be a string")));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn context_compile_rejects_unknown_and_control_arguments() {
    let db_path = temp_db_path();
    let context = NativeToolContext::for_test(std::env::temp_dir(), db_path.clone());
    let unknown = context_compile(
        &json!({"arguments": {"goal": "Reject unknown argument", "tokenBudget": 1000}}),
        &context,
    );
    assert_eq!(unknown["isError"], true);
    assert!(unknown["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("unknown context_compile argument: tokenBudget")));

    let control = context_compile(
        &json!({"arguments": {"goal": "Reject control", "projectRef": "project-A\n"}}),
        &context,
    );
    assert_eq!(control["isError"], true);
    assert!(control["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("INVALID_PROJECT_REF")));

    let malformed_facets = context_compile(
        &json!({"arguments": {
            "goal": "Reject malformed facets",
            "technologies": ["Rust", 42]
        }}),
        &context,
    );
    assert_eq!(malformed_facets["isError"], true);
    assert!(malformed_facets["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("technologies must contain only non-empty strings")));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn parses_agentic_used_knowledge_from_composer_json() {
    let episodes = vec![PackEpisode {
        id: "episode-1".to_string(),
        title: "Rust native episode".to_string(),
        situation: "Rust-native compile uses episode precedent.".to_string(),
        lesson: "Persist episode retrieval feedback from composer output.".to_string(),
        score: 8,
        query_score: 8,
        importance: 50.0,
        scope_snapshot: json!({}),
    }];
    let parsed = parse_composer_payload(
            r###"{"markdown":"## 実装フォーカス\n- Rust context_compile","usedKnowledge":[{"id":"rule-1","confidence":0.82,"evidence":"applied","outputSection":"実装フォーカス","reason":"directly relevant"},{"id":"unknown","confidence":1}],"usedEpisodes":[{"id":"episode-1","confidence":0.7,"reason":"precedent applied"},{"id":"missing","confidence":1}]}"###,
            &sample_knowledge(),
            &episodes,
        )
        .unwrap();

    assert_eq!(parsed.1.len(), 1);
    assert_eq!(parsed.1[0].id, "rule-1");
    assert_eq!(parsed.1[0].confidence, 0.82);
    assert_eq!(parsed.1[0].reason.as_deref(), Some("directly relevant"));
    assert_eq!(parsed.2.len(), 1);
    assert_eq!(parsed.2[0].id, "episode-1");
    assert_eq!(parsed.2[0].reason.as_deref(), Some("precedent applied"));
}

#[test]
fn goal_alignment_rejects_unrelated_markdown_without_relabeling_it_as_no_content() {
    let parsed = parse_composer_payload(
            r###"{"markdown":"## unrelated\n- This only discusses release notes.","usedKnowledge":[],"usedEpisodes":[]}"###,
            &sample_knowledge(),
            &[],
        )
        .unwrap();

    assert_ne!(parsed.0, "No Content");
    assert!(!looks_goal_aligned(
        &parsed.0,
        "Rust native context_compile composer persistence",
    ));
}
