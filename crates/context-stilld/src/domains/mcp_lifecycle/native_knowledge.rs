use rusqlite::Connection;
use serde_json::{json, Value};

use super::native_common::{
    content_json, now_iso, open_database, parse_json_or_empty, pseudo_uuid, score_text, string_arg,
    table_exists, tool_error, usize_arg, with_writer,
};
use super::native_tools::NativeToolContext;
use super::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput,
    CompileProjectIdentityMatchBasis, CompileProjectIdentityTrust,
};
use super::repository_scope::{
    applicability_general, eligible_scope_clause, facets_allow, identity_input_from_args,
    json_string_array, parse_json_object, query_params, request_facets_from_args,
};

pub(crate) fn search_knowledge(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("search_knowledge arguments must be an object");
    };
    let query = match string_arg(args, "query") {
        Some(query) if !query.is_empty() => query,
        _ => return tool_error("query is required"),
    };
    let limit = usize_arg(args, "limit").unwrap_or(10).min(50);
    let identity_input = match identity_input_from_args(args) {
        Ok(value) => value,
        Err(error) => return tool_error(&error),
    };
    let identity = match resolve_compile_project_identity(
        &identity_input,
        CompileProjectIdentityTrust::RequestHint,
        None,
    ) {
        Ok(value) => value,
        Err(error) => return tool_error(&error.to_string()),
    };
    let request_facets = match request_facets_from_args(args) {
        Ok(value) => value,
        Err(error) => return tool_error(&error),
    };
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    if !table_exists(&connection, "knowledge_items") {
        return content_json(json!({
            "query": query,
            "normalizedQuery": query,
            "items": [],
            "diagnostics": {"degradedReasons":["knowledge_items_missing"],"stats":{
                "queryText": query,
                "scopedSearch": identity.match_basis != CompileProjectIdentityMatchBasis::None,
                "matchBasis": identity.match_basis.as_str(),
                "scopeMode": identity.scope_mode,
                "missingIdentityGlobalOnly": identity.match_basis == CompileProjectIdentityMatchBasis::None,
                "repoScopeFallbackUsed": false
            }}
        }));
    }

    let (scope_clause, scope_values) = eligible_scope_clause(&identity);
    let sql = format!(
        r#"
        select id, type, status, scope, polarity, intent_tags, title, body, applies_to,
               confidence, importance, compile_select_count, last_compiled_at,
               agentic_accept_count, explicit_upvote_count, explicit_downvote_count,
               dynamic_score, metadata, updated_at, last_verified_at,
               project_ref, repo_key, repo_path
        from knowledge_items
        where {scope_clause}
        order by importance desc, updated_at desc
        "#,
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(error) => return tool_error(&format!("failed to search knowledge: {error}")),
    };
    let rows = match statement.query_map(query_params(&scope_values), |row| {
        Ok(KnowledgeRow {
            id: row.get(0)?,
            kind: row.get(1)?,
            status: row.get(2)?,
            scope: row.get(3)?,
            polarity: row.get(4)?,
            intent_tags: row.get(5)?,
            title: row.get(6)?,
            body: row.get(7)?,
            applies_to: row.get(8)?,
            confidence: row.get(9)?,
            importance: row.get(10)?,
            compile_select_count: row.get(11)?,
            last_compiled_at: row.get(12)?,
            agentic_accept_count: row.get(13)?,
            explicit_upvote_count: row.get(14)?,
            explicit_downvote_count: row.get(15)?,
            dynamic_score: row.get(16)?,
            metadata: row.get(17)?,
            updated_at: row.get(18)?,
            last_verified_at: row.get(19)?,
            project_ref: row.get(20)?,
            repo_key: row.get(21)?,
            repo_path: row.get(22)?,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&format!("failed to search knowledge: {error}")),
    };
    let mut items = Vec::new();
    for row in rows.flatten() {
        let status_ok = if args.contains_key("statuses") {
            matches_arg_array(args, "statuses", &row.status)
        } else {
            default_status_matches(args, &row.status)
        };
        if !status_ok {
            continue;
        }
        if !matches_arg_array(args, "types", &row.kind)
            || !matches_arg_array(args, "polarities", &row.polarity)
        {
            continue;
        }
        let applies_to = parse_json_object(&row.applies_to);
        let technologies = json_string_array(&applies_to, "technologies");
        let change_types = json_string_array(&applies_to, "changeTypes");
        let domains = json_string_array(&applies_to, "domains");
        let general = applicability_general(&applies_to, &technologies, &change_types, &domains);
        if args.get("includeGeneral").and_then(Value::as_bool) == Some(false) && general {
            continue;
        }
        if !facets_allow(
            &request_facets,
            &technologies,
            &change_types,
            &domains,
            general,
        ) {
            continue;
        }
        let score = score_text(&format!("{}\n{}", row.title, row.body), &query)
            + row.dynamic_score.round() as i64;
        if score <= 0 {
            continue;
        }
        let source_refs = source_refs(&connection, &row.id);
        items.push((
            score,
            json!({
                "id": row.id,
                "type": row.kind,
                "status": row.status,
                "scope": row.scope,
                "polarity": row.polarity,
                "intentTags": parse_json_array(&row.intent_tags),
                "title": row.title,
                "body": row.body,
                "score": score,
                "confidence": row.confidence,
                "importance": row.importance,
                "dynamicScore": row.dynamic_score,
                "decayFactor": 1.0,
                "compileSelectCount": row.compile_select_count,
                "agenticAcceptCount": row.agentic_accept_count,
                "explicitUpvoteCount": row.explicit_upvote_count,
                "explicitDownvoteCount": row.explicit_downvote_count,
                "lastCompiledAt": row.last_compiled_at,
                "lastVerifiedAt": row.last_verified_at,
                "updatedAt": row.updated_at,
                "sourceRefs": source_refs,
                "appliesTo": applies_to,
                "projectRef": row.project_ref,
                "repoKey": row.repo_key,
                "repoPath": row.repo_path,
                "classificationStatus": "classified",
                "applicabilityScore": 0,
                "applicabilityMatches": {},
                "metadata": parse_json_or_empty(&row.metadata)
            }),
        ));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0));
    let values = items
        .into_iter()
        .take(limit)
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    content_json(json!({
        "query": query,
        "normalizedQuery": query,
        "items": values,
        "diagnostics": {
            "degradedReasons": [],
            "stats": {
                "queryText": query,
                "textHitCount": values.len(),
                "vectorHitCount": 0,
                "mergedCount": values.len(),
                "textFailed": false,
                "vectorFailed": false,
                "embeddingStatus": "disabled",
                "scopedSearch": identity.match_basis != CompileProjectIdentityMatchBasis::None,
                "matchBasis": identity.match_basis.as_str(),
                "scopeMode": identity.scope_mode,
                "missingIdentityGlobalOnly": identity.match_basis == CompileProjectIdentityMatchBasis::None,
                "repoScopeFallbackUsed": false
            }
        }
    }))
}

pub(crate) fn context_decision_feedback(params: &Value, context: &NativeToolContext) -> Value {
    let owned_params = params.clone();
    match with_writer(
        context,
        "mcp.context_decision_feedback",
        move |connection| {
            Ok(context_decision_feedback_on_connection(
                &owned_params,
                connection,
            ))
        },
    ) {
        Ok(value) => value,
        Err(error) => tool_error(&error),
    }
}

fn context_decision_feedback_on_connection(params: &Value, connection: &mut Connection) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("context_decision_feedback arguments must be an object");
    };
    let decision_id = match string_arg(args, "decisionId") {
        Some(value) => value,
        None => return tool_error("decisionId is required"),
    };
    let source = string_arg(args, "source").unwrap_or_else(|| "ai".to_string());
    if !table_exists(connection, "context_decision_runs") {
        return tool_error("context_decision_runs table is not available");
    }
    let exists = connection
        .query_row(
            "select exists(select 1 from context_decision_runs where id = ?1)",
            [&decision_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        == 1;
    if !exists {
        return tool_error("Context decision not found.");
    }

    if source == "human" {
        let value = string_arg(args, "value").unwrap_or_else(|| "good".to_string());
        let id = pseudo_uuid();
        let now = now_iso();
        if let Err(error) = connection.execute(
            r#"
            insert or replace into context_decision_human_feedback (
              id, decision_run_id, value, created_at
            ) values (?1, ?2, ?3, ?4)
            "#,
            (&id, &decision_id, &value, &now),
        ) {
            return tool_error(&format!("failed to record human feedback: {error}"));
        }
        return content_json(json!({
            "humanFeedback": {
                "id": id,
                "decisionRunId": decision_id,
                "value": value,
                "createdAt": now
            }
        }));
    }

    let id = pseudo_uuid();
    let now = now_iso();
    let outcome = string_arg(args, "outcome").unwrap_or_else(|| "still_unknown".to_string());
    let reason = string_arg(args, "reason").unwrap_or_else(|| "No reason supplied.".to_string());
    let metadata = args.get("metadata").cloned().unwrap_or_else(|| json!({}));
    let affected = selected_support_knowledge_ids(connection, &decision_id);
    if let Err(error) = connection.execute(
        r#"
        insert into context_decision_feedback (
          id, decision_run_id, source, outcome, inferred_reason, affected_knowledge_ids,
          suggested_adjustment, metadata, created_at
        ) values (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?8)
        "#,
        (
            &id,
            &decision_id,
            &source,
            &outcome,
            &reason,
            json!(affected).to_string(),
            metadata.to_string(),
            &now,
        ),
    ) {
        return tool_error(&format!("failed to record decision feedback: {error}"));
    }
    content_json(json!({
        "feedback": {
            "id": id,
            "decisionRunId": decision_id,
            "source": source,
            "outcome": outcome,
            "inferredReason": reason,
            "affectedKnowledgeIds": affected,
            "suggestedAdjustment": {},
            "metadata": metadata,
            "createdAt": now
        },
        "effects": []
    }))
}

pub(crate) fn register_candidates(params: &Value, context: &NativeToolContext) -> Value {
    let owned_params = params.clone();
    match with_writer(context, "mcp.register_candidates", move |connection| {
        Ok(register_candidates_on_connection(&owned_params, connection))
    }) {
        Ok(value) => value,
        Err(error) => tool_error(&error),
    }
}

fn register_candidates_on_connection(params: &Value, connection: &mut Connection) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("register_candidates arguments must be an object");
    };
    let Some(items) = args.get("items").and_then(Value::as_array) else {
        return tool_error("items must be an array");
    };
    if items.is_empty() || items.len() > 10 {
        return tool_error("items must contain 1-10 candidates");
    }
    for table in [
        "distillation_target_states",
        "find_candidate_results",
        "finding_candidate_queue",
        "found_candidates",
        "covering_evidence_queue",
        "distillation_queue_events",
    ] {
        if !table_exists(connection, table) {
            return tool_error(&format!(
                "candidate pipeline table is not available: {table}"
            ));
        }
    }
    let tx = match connection.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            return tool_error(&format!("failed to start candidate transaction: {error}"))
        }
    };
    let mut results = Vec::new();
    let mut registered = 0;
    for (index, value) in items.iter().enumerate() {
        let Some(item) = value.as_object() else {
            results.push(json!({"index": index, "status": "candidate_failed", "error": "candidate must be an object"}));
            continue;
        };
        match normalize_candidate(item).and_then(|candidate| insert_candidate(&tx, candidate)) {
            Ok(result) => {
                registered += 1;
                results.push(json!({
                    "index": index,
                    "status": "candidate_registered",
                    "title": result.title,
                    "type": result.kind,
                    "targetStateId": result.target_state_id,
                    "findCandidateResultId": result.find_candidate_result_id,
                    "findingJobId": result.finding_job_id,
                    "sourceUri": result.source_uri,
                    "warnings": result.warnings
                }));
            }
            Err(error) => {
                if is_project_identity_error(&error) {
                    record_project_identity_producer_event(
                        &tx,
                        "PROJECT_IDENTITY_PRODUCER_REJECTED",
                        json!({
                            "producer": "register-candidates.rust",
                            "entityKind": "candidate",
                            "rejectionCode": error.split(':').next().unwrap_or(&error)
                        }),
                    );
                }
                results.push(json!({"index": index, "status": "candidate_failed", "error": error}));
            }
        }
    }
    if let Err(error) = tx.commit() {
        return tool_error(&format!("failed to commit candidates: {error}"));
    }
    let failed = items.len() - registered;
    let status = if registered == items.len() {
        "bulk_candidates_registered"
    } else if registered > 0 {
        "bulk_candidates_partial"
    } else {
        "bulk_candidates_failed"
    };
    content_json(json!({
        "status": status,
        "registeredCount": registered,
        "failedCount": failed,
        "items": results,
        "next": "distillation_pipeline"
    }))
}

#[derive(Debug)]
struct KnowledgeRow {
    id: String,
    kind: String,
    status: String,
    scope: String,
    polarity: String,
    intent_tags: String,
    title: String,
    body: String,
    applies_to: String,
    confidence: f64,
    importance: f64,
    compile_select_count: i64,
    last_compiled_at: Option<String>,
    agentic_accept_count: i64,
    explicit_upvote_count: i64,
    explicit_downvote_count: i64,
    dynamic_score: f64,
    metadata: String,
    updated_at: String,
    last_verified_at: Option<String>,
    project_ref: Option<String>,
    repo_key: Option<String>,
    repo_path: Option<String>,
}

#[derive(Debug)]
struct Candidate {
    title: String,
    body: String,
    kind: String,
    polarity: String,
    intent_tags: Vec<String>,
    applies_to: Value,
    metadata: Value,
    project_identity: Value,
    warnings: Vec<String>,
}

#[derive(Debug)]
struct InsertCandidateResult {
    target_state_id: String,
    find_candidate_result_id: String,
    finding_job_id: String,
    source_uri: String,
    title: String,
    kind: String,
    warnings: Vec<String>,
}

fn default_status_matches(args: &serde_json::Map<String, Value>, status: &str) -> bool {
    if args.get("statuses").is_some() {
        return false;
    }
    let requested = string_arg(args, "status").unwrap_or_else(|| "active".to_string());
    status == requested
}

fn matches_arg_array(args: &serde_json::Map<String, Value>, key: &str, value: &str) -> bool {
    let Some(values) = args.get(key).and_then(Value::as_array) else {
        return true;
    };
    if values.is_empty() {
        return true;
    }
    values
        .iter()
        .filter_map(Value::as_str)
        .any(|candidate| candidate == value)
}

fn parse_json_array(value: &str) -> Vec<Value> {
    serde_json::from_str(value).unwrap_or_default()
}

fn source_refs(connection: &Connection, knowledge_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select s.uri, sf.locator
        from knowledge_source_links ksl
        join source_fragments sf on sf.id = ksl.source_fragment_id
        join sources s on s.id = sf.source_id
        where ksl.knowledge_id = ?1
        order by ksl.confidence desc, ksl.created_at desc
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([knowledge_id], |row| {
            let uri: String = row.get(0)?;
            let locator: String = row.get(1)?;
            Ok(format!("{uri}#{locator}"))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn selected_support_knowledge_ids(connection: &Connection, decision_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select knowledge_id
        from context_decision_evidence
        where decision_run_id = ?1 and role = 'selected_support' and knowledge_id is not null
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([decision_id], |row| row.get::<_, String>(0))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn normalize_candidate(item: &serde_json::Map<String, Value>) -> Result<Candidate, String> {
    let polarity = string_arg(item, "polarity").unwrap_or_else(|| "positive".to_string());
    let mut kind = string_arg(item, "type").unwrap_or_else(|| "rule".to_string());
    if kind != "rule" && kind != "procedure" {
        return Err("type must be rule or procedure".to_string());
    }
    let body = string_arg(item, "body")
        .or_else(|| string_arg(item, "text"))
        .or_else(|| {
            if polarity == "negative" {
                Some(format!(
                    "避けること: {}\n推奨: {}",
                    string_arg(item, "avoid").unwrap_or_default(),
                    string_arg(item, "prefer").unwrap_or_default()
                ))
            } else {
                None
            }
        })
        .ok_or_else(|| "body or text is required".to_string())?;
    if polarity == "negative" && kind == "procedure" {
        kind = "rule".to_string();
    }
    let title = string_arg(item, "title").unwrap_or_else(|| infer_title(&body));
    let mut warnings = Vec::new();
    if kind == "procedure" && !has_skill_like_sections(&body) {
        return Err("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS".to_string());
    }
    if item.get("text").is_some() {
        warnings.push("text_parsed_to_candidate_json".to_string());
    }
    let applies_to = build_applies_to(item);
    let project_identity = resolve_candidate_write_identity(item, &applies_to)?;
    let metadata = json!({
        "source": "mcp_register_candidate",
        "registeredAt": now_iso(),
        "polarity": polarity,
        "metadata": item.get("metadata").cloned().unwrap_or_else(|| json!({}))
    });
    Ok(Candidate {
        title,
        body,
        kind,
        polarity,
        intent_tags: string_array_arg(item, "intentTags"),
        applies_to,
        metadata,
        project_identity,
        warnings,
    })
}

fn insert_candidate(
    connection: &rusqlite::Transaction<'_>,
    candidate: Candidate,
) -> Result<InsertCandidateResult, String> {
    let candidate_id = pseudo_uuid();
    let target_state_id = pseudo_uuid();
    let find_candidate_result_id = pseudo_uuid();
    let finding_job_id = pseudo_uuid();
    let found_candidate_id = pseudo_uuid();
    let covering_job_id = pseudo_uuid();
    let source_uri = format!("agent://candidate/{candidate_id}");
    let now = now_iso();
    let origin = json!({
        "source": "mcp_register_candidate",
        "registeredAt": now,
        "candidateType": candidate.kind,
        "polarity": candidate.polarity,
        "intentTags": candidate.intent_tags,
        "appliesTo": candidate.applies_to,
        "metadata": candidate.metadata,
        "projectIdentity": candidate.project_identity,
    });
    let payload = json!({
        "title": candidate.title,
        "body": candidate.body,
        "type": candidate.kind,
        "polarity": candidate.polarity,
        "appliesTo": candidate.applies_to,
        "intentTags": candidate.intent_tags,
        "origin": origin,
        "projectIdentity": candidate.project_identity,
        "legacyTargetStateId": target_state_id,
        "legacyFindCandidateResultId": find_candidate_result_id,
    });
    let metadata = json!({
        "source": "mcp_register_candidate",
        "registeredAt": now,
        "legacyTargetStateId": target_state_id,
        "legacyFindCandidateResultId": find_candidate_result_id,
        "polarity": candidate.polarity,
        "intentTags": candidate.intent_tags,
        "appliesTo": candidate.applies_to,
        "projectIdentity": candidate.project_identity,
    });
    connection
        .execute(
            r#"
            insert into distillation_target_states (
              id, target_kind, target_key, source_uri, distillation_version,
              status, phase, priority_group, sort_key, metadata, created_at, updated_at
            ) values (?1, 'knowledge_candidate', ?2, ?3, 'v1',
              'pending', 'selected', 'knowledge_candidate', ?4, ?5, ?4, ?4)
            "#,
            (
                &target_state_id,
                &candidate_id,
                &source_uri,
                &now,
                metadata.to_string(),
            ),
        )
        .map_err(|error| format!("failed to insert candidate target: {error}"))?;
    connection
        .execute(
            r#"
            insert into find_candidate_results (
              id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at
            ) values (?1, ?2, 0, ?3, ?4, ?5, 'selected', ?6, ?6)
            "#,
            (
                &find_candidate_result_id,
                &target_state_id,
                &candidate.title,
                &candidate.body,
                origin.to_string(),
                &now,
            ),
        )
        .map_err(|error| format!("failed to insert candidate result: {error}"))?;
    connection
        .execute(
            r#"
            insert into finding_candidate_queue (
              id, input_kind, source_kind, source_key, source_uri, distillation_version,
              status, priority, payload, metadata, completed_at, last_outcome_kind, created_at, updated_at
            ) values (?1, 'provided_candidate', 'knowledge_candidate', ?2, ?3, 'v1',
              'completed', 90, ?4, ?5, ?6, 'provided_candidate_registered', ?6, ?6)
            "#,
            (
                &finding_job_id,
                &candidate_id,
                &source_uri,
                payload.to_string(),
                metadata.to_string(),
                &now,
            ),
        )
        .map_err(|error| format!("failed to insert finding queue job: {error}"))?;
    connection
        .execute(
            r#"
            insert into found_candidates (
              id, finding_job_id, candidate_index, type, title, content, origin, metadata, created_at, updated_at
            ) values (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
            "#,
            (
                &found_candidate_id,
                &finding_job_id,
                &candidate.kind,
                &candidate.title,
                &candidate.body,
                origin.to_string(),
                metadata.to_string(),
                &now,
            ),
        )
        .map_err(|error| format!("failed to insert found candidate: {error}"))?;
    connection
        .execute(
            r#"
            insert into covering_evidence_queue (
              id, found_candidate_id, distillation_version, status, priority,
              provider_policy, payload, metadata, created_at, updated_at
            ) values (?1, ?2, 'v1', 'pending', 90, 'default', '{}', ?3, ?4, ?4)
            "#,
            (
                &covering_job_id,
                &found_candidate_id,
                json!({"projectIdentity": candidate.project_identity}).to_string(),
                &now,
            ),
        )
        .map_err(|error| format!("failed to insert covering queue job: {error}"))?;
    record_project_identity_producer_event(
        connection,
        "PROJECT_IDENTITY_PRODUCER_PERSISTED",
        json!({
            "producer": "register-candidates.rust",
            "entityKind": "candidate",
            "scope": candidate.project_identity.get("scope"),
            "matchBasis": candidate.project_identity.get("matchBasis"),
            "identityFingerprint": candidate.project_identity.get("identityFingerprint"),
            "bindingStatus": candidate.project_identity.get("bindingStatus")
        }),
    );
    for (queue_name, queue_job_id, event_type, message) in [
        (
            "findingCandidate",
            &finding_job_id,
            "completed",
            "provided candidate persisted to candidate pipeline",
        ),
        (
            "coveringEvidence",
            &covering_job_id,
            "enqueued",
            "covering job enqueued from register-candidate",
        ),
    ] {
        connection
            .execute(
                r#"
                insert into distillation_queue_events (
                  id, queue_name, queue_job_id, event_type, message, metadata, created_at
                ) values (?1, ?2, ?3, ?4, ?5, '{}', ?6)
                "#,
                (
                    pseudo_uuid(),
                    queue_name,
                    queue_job_id,
                    event_type,
                    message,
                    &now,
                ),
            )
            .map_err(|error| format!("failed to append candidate queue event: {error}"))?;
    }
    Ok(InsertCandidateResult {
        target_state_id,
        find_candidate_result_id,
        finding_job_id,
        source_uri,
        title: candidate.title,
        kind: candidate.kind,
        warnings: candidate.warnings,
    })
}

fn resolve_candidate_write_identity(
    item: &serde_json::Map<String, Value>,
    applies_to: &Value,
) -> Result<Value, String> {
    let scope = string_arg(item, "scope").unwrap_or_else(|| "repo".to_string());
    if scope != "repo" && scope != "global" {
        return Err("scope must be repo or global".to_string());
    }
    let nested_string = |key: &str| {
        applies_to
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let resolved = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: string_arg(item, "projectRef"),
            repo_key: string_arg(item, "repoKey").or_else(|| nested_string("repoKey")),
            repo_path: string_arg(item, "repoPath").or_else(|| nested_string("repoPath")),
        },
        CompileProjectIdentityTrust::TrustedAdapter,
        None,
    )
    .map_err(|error| error.to_string())?;

    if scope == "global" && resolved.match_basis != CompileProjectIdentityMatchBasis::None {
        return Err(
            "PROJECT_IDENTITY_FORBIDDEN: global writes must not carry project identity".to_string(),
        );
    }
    if scope == "repo" && resolved.match_basis == CompileProjectIdentityMatchBasis::None {
        return Err("PROJECT_IDENTITY_REQUIRED: repo-scoped writes require projectRef, repoKey, or an absolute repoPath".to_string());
    }

    let mut snapshot = serde_json::to_value(&resolved)
        .map_err(|error| format!("failed to serialize project identity: {error}"))?;
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("classificationStatus".to_string(), json!("classified"));
        object.insert("scope".to_string(), json!(scope));
    }
    Ok(snapshot)
}

fn is_project_identity_error(error: &str) -> bool {
    [
        "PROJECT_IDENTITY_REQUIRED",
        "PROJECT_IDENTITY_FORBIDDEN",
        "INVALID_PROJECT_REF",
        "INVALID_REPO_KEY",
        "INVALID_REPO_PATH",
        "IDENTITY_CONFLICT",
    ]
    .iter()
    .any(|code| error.starts_with(code))
}

fn record_project_identity_producer_event(
    connection: &rusqlite::Transaction<'_>,
    event_type: &str,
    payload: Value,
) {
    let _ = connection.execute(
        "insert into audit_logs (id, event_type, actor, payload, created_at) values (?1, ?2, 'agent', ?3, ?4)",
        (pseudo_uuid(), event_type, payload.to_string(), now_iso()),
    );
}

fn infer_title(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Registered candidate")
        .trim_start_matches('#')
        .trim_start_matches(['-', '*', ' '])
        .chars()
        .take(96)
        .collect()
}

fn has_skill_like_sections(body: &str) -> bool {
    ["Use when", "Workflow", "Verification", "Avoid"]
        .iter()
        .all(|heading| body.contains(&format!("{heading}:")))
}

fn build_applies_to(item: &serde_json::Map<String, Value>) -> Value {
    let mut applies_to = item.get("appliesTo").cloned().unwrap_or_else(|| json!({}));
    if !applies_to.is_object() {
        applies_to = json!({});
    }
    for key in [
        "general",
        "technologies",
        "changeTypes",
        "domains",
        "repoPath",
        "repoKey",
    ] {
        if let Some(value) = item.get(key) {
            applies_to[key] = value.clone();
        }
    }
    applies_to
}

fn string_array_arg(args: &serde_json::Map<String, Value>, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "context_still_native_knowledge_{nanos}_{id}.sqlite"
        ))
    }

    fn make_context(db_path: &Path) -> NativeToolContext {
        NativeToolContext::for_test(std::env::temp_dir(), db_path.to_path_buf())
    }

    fn create_knowledge_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table knowledge_items (
                  id text primary key,
                  type text not null,
                  status text not null,
                  scope text not null default 'global',
                  classification_status text not null default 'classified',
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  polarity text not null default 'positive',
                  intent_tags text not null default '[]',
                  title text not null,
                  body text not null,
                  applies_to text not null default '{}',
                  confidence real not null default 70,
                  importance real not null default 70,
                  compile_select_count integer not null default 0,
                  last_compiled_at text,
                  agentic_accept_count integer not null default 0,
                  explicit_upvote_count integer not null default 0,
                  explicit_downvote_count integer not null default 0,
                  dynamic_score real not null default 0,
                  metadata text not null default '{}',
                  updated_at text not null default CURRENT_TIMESTAMP,
                  last_verified_at text,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table sources (
                  id text primary key,
                  uri text not null,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table source_fragments (
                  id text primary key,
                  source_id text not null,
                  locator text not null,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table knowledge_source_links (
                  id text primary key,
                  knowledge_id text not null,
                  source_fragment_id text not null,
                  confidence real not null default 0,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table knowledge_items_fts (
                  id text,
                  title text,
                  body text
                );
                "#,
            )
            .unwrap();
    }

    fn create_decision_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table context_decision_runs (
                  id text primary key,
                  session_id text,
                  decision_point text not null,
                  options text not null default '[]',
                  retrieval_hints text not null default '{}',
                  decision text not null,
                  selected_action text not null,
                  rejected_actions text not null default '[]',
                  mandate text not null,
                  agent_message text not null,
                  confidence integer not null,
                  confidence_trace text not null default '{}',
                  autonomy_level text not null default 'high',
                  risk_budget text not null default 'medium',
                  knowledge_policy text not null default 'optional',
                  guardrails text not null default '{}',
                  unsupported_alternatives text not null default '[]',
                  status text not null,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_decision_evidence (
                  id text primary key,
                  decision_run_id text not null,
                  knowledge_id text,
                  role text not null,
                  weight_at_decision real not null default 0,
                  dynamic_score_at_decision real not null default 0,
                  applicability_score real not null default 0,
                  temporal_relevance real not null default 100,
                  summary text not null default '',
                  source_refs text not null default '[]',
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table context_decision_feedback (
                  id text primary key,
                  decision_run_id text not null,
                  source text not null,
                  outcome text not null default 'still_unknown',
                  inferred_reason text not null default '',
                  affected_knowledge_ids text not null default '[]',
                  suggested_adjustment text not null default '{}',
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table context_decision_human_feedback (
                  id text primary key,
                  decision_run_id text not null,
                  value text not null,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                "#,
            )
            .unwrap();
    }

    fn create_candidate_pipeline_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table distillation_target_states (
                  id text primary key, target_kind text not null, target_key text not null,
                  source_uri text not null, distillation_version text not null,
                  status text not null, phase text not null, priority_group text not null,
                  sort_key text not null, metadata text not null default '{}',
                  created_at text not null, updated_at text not null
                );
                create table find_candidate_results (
                  id text primary key, target_state_id text not null, candidate_index integer not null,
                  title text not null, content text not null, origin text not null default '{}',
                  status text not null, created_at text not null, updated_at text not null
                );
                create table finding_candidate_queue (
                  id text primary key, input_kind text not null, source_kind text not null,
                  source_key text not null, source_uri text not null, distillation_version text not null,
                  status text not null, priority integer not null, payload text not null,
                  metadata text not null, completed_at text, last_outcome_kind text,
                  created_at text not null, updated_at text not null
                );
                create table found_candidates (
                  id text primary key, finding_job_id text not null, candidate_index integer not null,
                  type text, title text not null, content text not null, origin text not null,
                  metadata text not null, created_at text not null, updated_at text not null
                );
                create table covering_evidence_queue (
                  id text primary key, found_candidate_id text, distillation_version text not null,
                  status text not null, priority integer not null, provider_policy text,
                  payload text not null, metadata text not null,
                  created_at text not null, updated_at text not null
                );
                create table distillation_queue_events (
                  id text primary key, queue_name text not null, queue_job_id text not null,
                  event_type text not null, message text, metadata text not null,
                  created_at text not null
                );
                create table audit_logs (
                  id text primary key, event_type text not null, actor text not null,
                  payload text not null, created_at text not null
                );
                "#,
            )
            .unwrap();
    }

    fn create_candidate_registration_schema(connection: &Connection) {
        create_knowledge_schema(connection);
        create_candidate_pipeline_schema(connection);
    }

    fn insert_knowledge(
        connection: &Connection,
        id: &str,
        kind: &str,
        status: &str,
        title: &str,
        body: &str,
    ) {
        connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body) values (?1, ?2, ?3, ?4, ?5)",
                (id, kind, status, title, body),
            )
            .unwrap();
    }

    fn insert_decision_run(connection: &Connection, id: &str) {
        connection
            .execute(
                r#"insert into context_decision_runs (
                  id, decision_point, decision, selected_action, mandate,
                  agent_message, confidence, status
                ) values (?1, 'test point', 'execute', 'proceed', 'test mandate',
                  'test message', 80, 'completed')"#,
                [id],
            )
            .unwrap();
    }

    fn extract_text(result: &Value) -> String {
        result["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    fn parse_inner(result: &Value) -> Value {
        let text = extract_text(result);
        serde_json::from_str(&text).unwrap_or(json!({}))
    }

    fn is_error(result: &Value) -> bool {
        result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    // ──────────────────────────────────────────────
    //  search_knowledge tests
    // ──────────────────────────────────────────────

    #[test]
    fn search_knowledge_requires_query() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(&json!({"arguments": {}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("query is required"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_no_table_returns_empty() {
        let db_path = temp_db_path();
        // Create empty DB without knowledge_items table
        let _connection = Connection::open(&db_path).unwrap();
        drop(_connection);

        let context = make_context(&db_path);
        let result = search_knowledge(&json!({"arguments": {"query": "anything"}}), &context);
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(inner["items"].as_array().unwrap().len(), 0);
        let degraded = inner["diagnostics"]["degradedReasons"].as_array().unwrap();
        assert!(degraded
            .iter()
            .any(|v| v.as_str() == Some("knowledge_items_missing")));
        assert_eq!(
            inner["diagnostics"]["stats"]["missingIdentityGlobalOnly"],
            json!(true)
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_empty_result_reports_global_only_diagnostics() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(&json!({"arguments": {"query": "anything"}}), &context);
        let inner = parse_inner(&result);
        assert_eq!(inner["items"], json!([]));
        assert_eq!(inner["diagnostics"]["stats"]["scopedSearch"], json!(false));
        assert_eq!(
            inner["diagnostics"]["stats"]["missingIdentityGlobalOnly"],
            json!(true)
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_matches_query() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "k1",
            "rule",
            "active",
            "Rust error handling",
            "Always use Result for recoverable errors in Rust",
        );
        insert_knowledge(
            &connection,
            "k2",
            "rule",
            "active",
            "Python style guide",
            "Follow PEP8 style guide for Python code",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust error handling"}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        assert!(!items.is_empty());
        // The Rust item should match and appear
        assert!(items.iter().any(|item| item["id"].as_str() == Some("k1")));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_respects_limit() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        for i in 0..5 {
            insert_knowledge(
                &connection,
                &format!("k{i}"),
                "rule",
                "active",
                &format!("Rust test rule {i}"),
                &format!("Rust rule body for testing limit {i}"),
            );
        }
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust rule", "limit": 2}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        assert!(items.len() <= 2);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_filters_by_statuses() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "active1",
            "rule",
            "active",
            "Rust active rule",
            "Rust active rule body text",
        );
        insert_knowledge(
            &connection,
            "draft1",
            "rule",
            "draft",
            "Rust draft rule",
            "Rust draft rule body text",
        );
        insert_knowledge(
            &connection,
            "deprecated1",
            "rule",
            "deprecated",
            "Rust deprecated rule",
            "Rust deprecated rule body text",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust rule", "statuses": ["draft"]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        // Only draft items should match
        for item in items {
            assert_eq!(item["status"].as_str().unwrap(), "draft");
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_default_status_active() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "active1",
            "rule",
            "active",
            "Rust active item",
            "Rust active item body",
        );
        insert_knowledge(
            &connection,
            "draft1",
            "rule",
            "draft",
            "Rust draft item",
            "Rust draft item body",
        );
        drop(connection);

        let context = make_context(&db_path);
        // No statuses filter → default is 'active'
        let result = search_knowledge(&json!({"arguments": {"query": "Rust item"}}), &context);
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        for item in items {
            assert_eq!(item["status"].as_str().unwrap(), "active");
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_filters_by_types() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "r1",
            "rule",
            "active",
            "Rust type filter rule",
            "Rust type filter rule body",
        );
        insert_knowledge(
            &connection,
            "p1",
            "procedure",
            "active",
            "Rust type filter procedure",
            "Rust type filter procedure body",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust type filter", "types": ["procedure"]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        for item in items {
            assert_eq!(item["type"].as_str().unwrap(), "procedure");
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_filters_by_polarities() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "pos1",
            "rule",
            "active",
            "Rust polarity positive",
            "Rust polarity positive body",
        );
        connection
            .execute(
                "insert into knowledge_items (id, type, status, polarity, title, body) values (?1, ?2, ?3, ?4, ?5, ?6)",
                ("neg1", "rule", "active", "negative", "Rust polarity negative", "Rust polarity negative body"),
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust polarity", "polarities": ["negative"]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        for item in items {
            assert_eq!(item["polarity"].as_str().unwrap(), "negative");
        }

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_includes_source_refs() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        insert_knowledge(
            &connection,
            "k-src",
            "rule",
            "active",
            "Rust source ref test",
            "Rust source ref test body",
        );
        connection
            .execute(
                "insert into sources (id, uri) values ('s1', 'file:///src/main.rs')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into source_fragments (id, source_id, locator) values ('sf1', 's1', 'L10-L20')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into knowledge_source_links (id, knowledge_id, source_fragment_id, confidence) values ('ksl1', 'k-src', 'sf1', 0.9)",
                [],
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust source ref test"}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        let items = inner["items"].as_array().unwrap();
        let item = items
            .iter()
            .find(|i| i["id"].as_str() == Some("k-src"))
            .unwrap();
        let refs = item["sourceRefs"].as_array().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].as_str().unwrap(), "file:///src/main.rs#L10-L20");

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn search_knowledge_json_parse_failure_no_panic() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_knowledge_schema(&connection);
        // Insert row with malformed JSON in intent_tags and applies_to
        connection
            .execute(
                "insert into knowledge_items (id, type, status, title, body, intent_tags, applies_to) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    "k-bad-json",
                    "rule",
                    "active",
                    "Rust bad json test",
                    "Rust bad json test body content",
                    "not valid json[[[",
                    "{broken",
                ),
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        // Should NOT panic
        let result = search_knowledge(
            &json!({"arguments": {"query": "Rust bad json test"}}),
            &context,
        );
        assert!(!is_error(&result));

        let _ = std::fs::remove_file(db_path);
    }

    // ──────────────────────────────────────────────
    //  context_decision_feedback tests
    // ──────────────────────────────────────────────

    #[test]
    fn context_decision_feedback_requires_decision_id() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_decision_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = context_decision_feedback(&json!({"arguments": {"source": "ai"}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("decisionId is required"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn context_decision_feedback_unknown_decision_returns_error() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_decision_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = context_decision_feedback(
            &json!({"arguments": {"decisionId": "nonexistent-id", "source": "ai"}}),
            &context,
        );
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("not found"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn context_decision_feedback_ai_source_records() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_decision_schema(&connection);
        insert_decision_run(&connection, "dec-ai-1");
        drop(connection);

        let context = make_context(&db_path);
        let result = context_decision_feedback(
            &json!({"arguments": {
                "decisionId": "dec-ai-1",
                "source": "ai",
                "outcome": "success",
                "reason": "Tests passed"
            }}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(
            inner["feedback"]["decisionRunId"].as_str().unwrap(),
            "dec-ai-1"
        );
        assert_eq!(inner["feedback"]["source"].as_str().unwrap(), "ai");
        assert_eq!(inner["feedback"]["outcome"].as_str().unwrap(), "success");
        assert_eq!(
            inner["feedback"]["inferredReason"].as_str().unwrap(),
            "Tests passed"
        );

        // Verify persisted in DB
        let connection = Connection::open(&db_path).unwrap();
        let count: i64 = connection
            .query_row(
                "select count(*) from context_decision_feedback where decision_run_id = 'dec-ai-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn context_decision_feedback_human_source_records() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_decision_schema(&connection);
        insert_decision_run(&connection, "dec-human-1");
        drop(connection);

        let context = make_context(&db_path);
        let result = context_decision_feedback(
            &json!({"arguments": {
                "decisionId": "dec-human-1",
                "source": "human",
                "value": "bad"
            }}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(
            inner["humanFeedback"]["decisionRunId"].as_str().unwrap(),
            "dec-human-1"
        );
        assert_eq!(inner["humanFeedback"]["value"].as_str().unwrap(), "bad");

        // Verify persisted in DB
        let connection = Connection::open(&db_path).unwrap();
        let value: String = connection
            .query_row(
                "select value from context_decision_human_feedback where decision_run_id = 'dec-human-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "bad");

        let _ = std::fs::remove_file(db_path);
    }

    // ──────────────────────────────────────────────
    //  register_candidates tests
    // ──────────────────────────────────────────────

    #[test]
    fn register_candidates_valid_rule() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(
            &json!({"arguments": {"items": [
                {
                    "type": "rule",
                    "scope": "repo",
                    "repoKey": "test/native-register",
                    "title": "Always use Result",
                    "body": "Always use Result for recoverable errors"
                }
            ]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(
            inner["status"].as_str().unwrap(),
            "bulk_candidates_registered"
        );
        assert_eq!(inner["registeredCount"].as_i64().unwrap(), 1);
        assert_eq!(inner["failedCount"].as_i64().unwrap(), 0);
        let items = inner["items"].as_array().unwrap();
        assert_eq!(items[0]["status"].as_str().unwrap(), "candidate_registered");
        assert_eq!(items[0]["type"].as_str().unwrap(), "rule");

        // Registration persists a pipeline candidate, not active Knowledge.
        let connection = Connection::open(&db_path).unwrap();
        let active_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items where status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 0);
        let candidate_count: i64 = connection
            .query_row("select count(*) from find_candidate_results", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(candidate_count, 1);
        let identity_json: String = connection
            .query_row(
                "select metadata from distillation_target_states limit 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let identity: Value = serde_json::from_str(&identity_json).unwrap();
        assert_eq!(
            identity["projectIdentity"]["repoKey"].as_str(),
            Some("test/native-register")
        );
        assert_eq!(
            identity["projectIdentity"]["classificationStatus"].as_str(),
            Some("classified")
        );

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_valid_procedure() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let body = "Use when: migrating to Rust\nWorkflow:\n1. Read TS code\n2. Write Rust\nVerification:\n- Tests pass\nAvoid:\n- Do not skip tests";
        let result = register_candidates(
            &json!({"arguments": {"items": [
                {
                    "type": "procedure",
                    "scope": "global",
                    "title": "TS to Rust migration",
                    "body": body
                }
            ]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(
            inner["status"].as_str().unwrap(),
            "bulk_candidates_registered"
        );
        assert_eq!(inner["registeredCount"].as_i64().unwrap(), 1);
        let items = inner["items"].as_array().unwrap();
        assert_eq!(items[0]["type"].as_str().unwrap(), "procedure");

        // The procedure remains a candidate until the existing pipeline finalizes it.
        let connection = Connection::open(&db_path).unwrap();
        let kind: String = connection
            .query_row("select type from found_candidates limit 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kind, "procedure");
        let active_count: i64 = connection
            .query_row(
                "select count(*) from knowledge_items where status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 0);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_missing_body_rejected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(
            &json!({"arguments": {"items": [
                {
                    "type": "rule",
                    "title": "No body rule"
                }
            ]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(inner["registeredCount"].as_i64().unwrap(), 0);
        assert_eq!(inner["failedCount"].as_i64().unwrap(), 1);
        let items = inner["items"].as_array().unwrap();
        assert_eq!(items[0]["status"].as_str().unwrap(), "candidate_failed");
        assert!(items[0]["error"].as_str().unwrap().contains("body"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_invalid_type_rejected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(
            &json!({"arguments": {"items": [
                {
                    "type": "invalid_type",
                    "title": "Bad type",
                    "body": "Some body text"
                }
            ]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(inner["registeredCount"].as_i64().unwrap(), 0);
        let items = inner["items"].as_array().unwrap();
        assert_eq!(items[0]["status"].as_str().unwrap(), "candidate_failed");
        assert!(items[0]["error"]
            .as_str()
            .unwrap()
            .contains("type must be rule or procedure"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_identityless_repo_rejected_and_audited() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(
            &json!({"arguments": {"items": [{
                "type": "rule",
                "title": "Identity is required",
                "body": "A repo candidate must declare project identity"
            }]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(inner["registeredCount"].as_i64(), Some(0));
        assert!(inner["items"][0]["error"]
            .as_str()
            .unwrap()
            .starts_with("PROJECT_IDENTITY_REQUIRED"));

        let connection = Connection::open(&db_path).unwrap();
        let rejection_count: i64 = connection
            .query_row(
                "select count(*) from audit_logs where event_type = 'PROJECT_IDENTITY_PRODUCER_REJECTED'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rejection_count, 1);

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_procedure_without_skill_sections_rejected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(
            &json!({"arguments": {"items": [
                {
                    "type": "procedure",
                    "title": "Bad procedure",
                    "body": "This procedure has no required sections at all"
                }
            ]}}),
            &context,
        );
        assert!(!is_error(&result));
        let inner = parse_inner(&result);
        assert_eq!(inner["registeredCount"].as_i64().unwrap(), 0);
        let items = inner["items"].as_array().unwrap();
        assert_eq!(items[0]["status"].as_str().unwrap(), "candidate_failed");
        assert!(items[0]["error"]
            .as_str()
            .unwrap()
            .contains("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_empty_items_rejected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = register_candidates(&json!({"arguments": {"items": []}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("1-10"));

        let _ = std::fs::remove_file(db_path);
    }

    #[test]
    fn register_candidates_too_many_items_rejected() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_candidate_registration_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let items: Vec<Value> = (0..11)
            .map(|i| {
                json!({
                    "type": "rule",
                    "title": format!("Rule {i}"),
                    "body": format!("Rule body {i}")
                })
            })
            .collect();
        let result = register_candidates(&json!({"arguments": {"items": items}}), &context);
        assert!(is_error(&result));
        assert!(extract_text(&result).contains("1-10"));

        let _ = std::fs::remove_file(db_path);
    }

    // ──────────────────────────────────────────────
    //  Helper function tests
    // ──────────────────────────────────────────────

    #[test]
    fn infer_title_from_body() {
        assert_eq!(infer_title("# My Title\nBody text"), "My Title");
        assert_eq!(
            infer_title("- List item first\nMore text"),
            "List item first"
        );
        assert_eq!(infer_title("* Starred item\nMore text"), "Starred item");
        assert_eq!(
            infer_title("\n\n  Leading whitespace line\n"),
            "Leading whitespace line"
        );
        assert_eq!(infer_title(""), "Registered candidate");
        // Title should be truncated at 96 chars
        let long_body = "A".repeat(200);
        let inferred = infer_title(&long_body);
        assert!(inferred.chars().count() <= 96);
    }

    #[test]
    fn has_skill_like_sections_check() {
        let valid = "Use when: something\nWorkflow:\n1. Step one\nVerification:\n- Check result\nAvoid:\n- Bad practice";
        assert!(has_skill_like_sections(valid));

        let missing_avoid = "Use when: something\nWorkflow:\n1. Step\nVerification:\n- Check";
        assert!(!has_skill_like_sections(missing_avoid));

        let missing_workflow = "Use when: something\nVerification:\n- Check\nAvoid:\n- Bad";
        assert!(!has_skill_like_sections(missing_workflow));

        assert!(!has_skill_like_sections(""));
        assert!(!has_skill_like_sections(
            "Just plain text without any headings"
        ));
    }

    #[test]
    fn selected_support_knowledge_ids_from_evidence() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_decision_schema(&connection);
        insert_decision_run(&connection, "dec-evidence-1");
        // Insert evidence with different roles
        connection
            .execute(
                "insert into context_decision_evidence (id, decision_run_id, knowledge_id, role) values ('e1', 'dec-evidence-1', 'k1', 'selected_support')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into context_decision_evidence (id, decision_run_id, knowledge_id, role) values ('e2', 'dec-evidence-1', 'k2', 'selected_support')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into context_decision_evidence (id, decision_run_id, knowledge_id, role) values ('e3', 'dec-evidence-1', 'k3', 'background')",
                [],
            )
            .unwrap();
        // Evidence with null knowledge_id should be excluded
        connection
            .execute(
                "insert into context_decision_evidence (id, decision_run_id, knowledge_id, role) values ('e4', 'dec-evidence-1', null, 'selected_support')",
                [],
            )
            .unwrap();

        let ids = selected_support_knowledge_ids(&connection, "dec-evidence-1");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"k1".to_string()));
        assert!(ids.contains(&"k2".to_string()));
        // background role and null knowledge_id should not appear
        assert!(!ids.contains(&"k3".to_string()));

        let _ = std::fs::remove_file(db_path);
    }
}
