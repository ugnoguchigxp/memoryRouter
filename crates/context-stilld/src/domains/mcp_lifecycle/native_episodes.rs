use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::native_common::{
    content_json, open_database, parse_json_array, parse_json_or_empty, score_text, string_arg,
    table_exists, tool_error, usize_arg,
};
use super::native_tools::NativeToolContext;
use super::project_identity::{resolve_compile_project_identity, CompileProjectIdentityTrust};
use super::repository_scope::{
    applicability_general, eligible_scope_clause, facet_values_intersect, facets_allow,
    identity_input_from_args, optional_string_array, parse_json_object, query_params,
    request_facets_from_args,
};

pub(crate) fn search_episodes(params: &Value, context: &NativeToolContext) -> Value {
    let empty_args = serde_json::Map::new();
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .unwrap_or(&empty_args);
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    let query = string_arg(args, "query");
    let limit = usize_arg(args, "limit").unwrap_or(10).min(100);
    let statuses = match optional_string_array(args, "statuses") {
        Ok(values) if !values.is_empty() => values,
        Ok(_) => vec![string_arg(args, "status").unwrap_or_else(|| "active".to_string())],
        Err(error) => return tool_error(&error),
    };
    let outcome_kinds = match optional_string_array(args, "outcomeKinds") {
        Ok(values) => values,
        Err(error) => return tool_error(&error),
    };
    let requested_tools = match optional_string_array(args, "tools") {
        Ok(values) => values,
        Err(error) => return tool_error(&error),
    };
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
    if !table_exists(&connection, "episode_cards") {
        return content_json(json!({
            "items": [],
            "diagnostics": {
                "scopedSearch": identity.match_basis.as_str() != "none",
                "matchBasis": identity.match_basis.as_str(),
                "scopeMode": identity.scope_mode,
                "missingIdentityGlobalOnly": identity.match_basis.as_str() == "none",
                "repoScopeFallbackUsed": false
            }
        }));
    }
    let rows = match fetch_episode_rows(&connection, &identity) {
        Ok(rows) => rows,
        Err(error) => return tool_error(&error),
    };
    let mut items = Vec::new();
    for row in rows {
        if !statuses.iter().any(|status| status == &row.status)
            || (!outcome_kinds.is_empty()
                && !outcome_kinds.iter().any(|kind| kind == &row.outcome_kind))
        {
            continue;
        }
        let technologies = parse_json_array(&row.technologies)
            .into_iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let change_types = parse_json_array(&row.change_types)
            .into_iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let domains = parse_json_array(&row.domains)
            .into_iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let tools = parse_json_array(&row.tools)
            .into_iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        let applicability = parse_json_object(&row.applicability);
        if !facets_allow(
            &request_facets,
            &technologies,
            &change_types,
            &domains,
            applicability_general(&applicability, &technologies, &change_types, &domains),
        ) || (!requested_tools.is_empty() && !facet_values_intersect(&requested_tools, &tools))
        {
            continue;
        }
        let refs = fetch_episode_refs(&connection, &row.id);
        let score = score_text(
            &episode_search_text(&row, &refs),
            query.as_deref().unwrap_or(""),
        ) + ((row.importance * 6 + row.confidence * 4) / 100)
            + if row.outcome_kind == "unknown" { 0 } else { 1 };
        if query.is_some() && score <= 0 {
            continue;
        }
        items.push((
            score,
            row.created_at.clone(),
            episode_search_payload(row, refs, Some(score)),
        ));
    }
    items.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    content_json(json!({
        "items": items.into_iter().take(limit).map(|(_, _, item)| item).collect::<Vec<_>>(),
        "diagnostics": {
            "scopedSearch": identity.match_basis.as_str() != "none",
            "matchBasis": identity.match_basis.as_str(),
            "scopeMode": identity.scope_mode,
            "missingIdentityGlobalOnly": identity.match_basis.as_str() == "none",
            "repoScopeFallbackUsed": false
        }
    }))
}

pub(crate) fn fetch_episode(params: &Value, context: &NativeToolContext) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("fetch_episode arguments must be an object");
    };
    let id = match string_arg(args, "id") {
        Some(id) if !id.is_empty() => id,
        _ => return tool_error("id is required"),
    };
    let connection = match open_database(context) {
        Ok(connection) => connection,
        Err(error) => return tool_error(&error),
    };
    let row = match fetch_episode_row(&connection, &id) {
        Ok(Some(row)) => row,
        Ok(None) => return tool_error("Episode not found."),
        Err(error) => return tool_error(&error),
    };
    content_json(episode_full_payload(
        row,
        fetch_episode_refs(&connection, &id),
    ))
}

#[derive(Debug, Clone)]
struct EpisodeRow {
    id: String,
    title: String,
    situation: String,
    observations: String,
    action: String,
    outcome: String,
    lesson: String,
    applicability: String,
    anti_applicability: String,
    domains: String,
    technologies: String,
    change_types: String,
    tools: String,
    classification_status: String,
    scope: String,
    project_ref: Option<String>,
    repo_path: Option<String>,
    repo_key: Option<String>,
    source_kind: String,
    source_key: String,
    outcome_kind: String,
    importance: i64,
    confidence: i64,
    compile_use_count: i64,
    decision_use_count: i64,
    status: String,
    stale_at: Option<String>,
    metadata: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeRef {
    ref_kind: String,
    ref_value: String,
    locator: Option<String>,
    query_hint: Option<String>,
}

const EPISODE_SELECT_COLUMNS: &str = "id, title, situation, observations, action, outcome, lesson, applicability, anti_applicability, domains, technologies, change_types, tools, classification_status, scope, project_ref, repo_path, repo_key, source_kind, source_key, outcome_kind, importance, confidence, compile_use_count, decision_use_count, status, stale_at, metadata, created_at, updated_at";

fn fetch_episode_rows(
    connection: &Connection,
    identity: &super::project_identity::ResolvedCompileProjectIdentity,
) -> Result<Vec<EpisodeRow>, String> {
    let (scope_clause, values) = eligible_scope_clause(identity);
    let sql = format!(
        "select {EPISODE_SELECT_COLUMNS} from episode_cards where {scope_clause} order by created_at desc"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("failed to search episodes: {error}"))?;
    let rows = statement
        .query_map(query_params(&values), map_episode_row)
        .map_err(|error| format!("failed to search episodes: {error}"))?;
    Ok(rows.flatten().collect())
}

fn fetch_episode_row(connection: &Connection, id: &str) -> Result<Option<EpisodeRow>, String> {
    connection
        .query_row(
            &format!("select {EPISODE_SELECT_COLUMNS} from episode_cards where id = ?1 limit 1"),
            [id],
            map_episode_row,
        )
        .optional()
        .map_err(|error| format!("failed to fetch episode: {error}"))
}

fn map_episode_row(row: &rusqlite::Row<'_>) -> Result<EpisodeRow, rusqlite::Error> {
    Ok(EpisodeRow {
        id: row.get(0)?,
        title: row.get(1)?,
        situation: row.get(2)?,
        observations: row.get(3)?,
        action: row.get(4)?,
        outcome: row.get(5)?,
        lesson: row.get(6)?,
        applicability: row.get(7)?,
        anti_applicability: row.get(8)?,
        domains: row.get(9)?,
        technologies: row.get(10)?,
        change_types: row.get(11)?,
        tools: row.get(12)?,
        classification_status: row.get(13)?,
        scope: row.get(14)?,
        project_ref: row.get(15)?,
        repo_path: row.get(16)?,
        repo_key: row.get(17)?,
        source_kind: row.get(18)?,
        source_key: row.get(19)?,
        outcome_kind: row.get(20)?,
        importance: row.get(21)?,
        confidence: row.get(22)?,
        compile_use_count: row.get(23)?,
        decision_use_count: row.get(24)?,
        status: row.get(25)?,
        stale_at: row.get(26)?,
        metadata: row.get(27)?,
        created_at: row.get(28)?,
        updated_at: row.get(29)?,
    })
}

fn fetch_episode_refs(connection: &Connection, episode_id: &str) -> Vec<EpisodeRef> {
    let mut statement = match connection.prepare(
        "select ref_kind, ref_value, locator, query_hint from episode_refs where episode_card_id = ?1",
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([episode_id], |row| {
            Ok(EpisodeRef {
                ref_kind: row.get(0)?,
                ref_value: row.get(1)?,
                locator: row.get(2)?,
                query_hint: row.get(3)?,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn episode_search_payload(row: EpisodeRow, refs: Vec<EpisodeRef>, score: Option<i64>) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "situation": row.situation,
        "outcome": row.outcome,
        "lesson": row.lesson,
        "outcomeKind": row.outcome_kind,
        "importance": row.importance,
        "confidence": row.confidence,
        "compileUseCount": row.compile_use_count,
        "decisionUseCount": row.decision_use_count,
        "status": row.status,
        "classificationStatus": row.classification_status,
        "scope": row.scope,
        "projectRef": row.project_ref,
        "score": score,
        "domains": parse_json_array(&row.domains),
        "technologies": parse_json_array(&row.technologies),
        "changeTypes": parse_json_array(&row.change_types),
        "repoPath": row.repo_path,
        "repoKey": row.repo_key,
        "refs": refs,
        "createdAt": row.created_at
    })
}

fn episode_full_payload(row: EpisodeRow, refs: Vec<EpisodeRef>) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "situation": row.situation,
        "observations": row.observations,
        "action": row.action,
        "outcome": row.outcome,
        "lesson": row.lesson,
        "applicability": parse_json_or_empty(&row.applicability),
        "antiApplicability": parse_json_or_empty(&row.anti_applicability),
        "domains": parse_json_array(&row.domains),
        "technologies": parse_json_array(&row.technologies),
        "changeTypes": parse_json_array(&row.change_types),
        "tools": parse_json_array(&row.tools),
        "repoPath": row.repo_path,
        "repoKey": row.repo_key,
        "classificationStatus": row.classification_status,
        "scope": row.scope,
        "projectRef": row.project_ref,
        "sourceKind": row.source_kind,
        "sourceKey": row.source_key,
        "outcomeKind": row.outcome_kind,
        "importance": row.importance,
        "confidence": row.confidence,
        "compileUseCount": row.compile_use_count,
        "decisionUseCount": row.decision_use_count,
        "status": row.status,
        "staleAt": row.stale_at,
        "metadata": parse_json_or_empty(&row.metadata),
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "refs": refs
    })
}

fn episode_search_text(row: &EpisodeRow, refs: &[EpisodeRef]) -> String {
    [
        row.title.as_str(),
        row.situation.as_str(),
        row.observations.as_str(),
        row.action.as_str(),
        row.outcome.as_str(),
        row.lesson.as_str(),
        row.domains.as_str(),
        row.technologies.as_str(),
        row.change_types.as_str(),
        row.tools.as_str(),
        &refs
            .iter()
            .map(|reference| {
                format!(
                    "{} {} {}",
                    reference.ref_kind,
                    reference.ref_value,
                    reference.query_hint.clone().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(" "),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::domains::mcp_lifecycle::native_tools::NativeToolContext;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_db_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("context_still_native_episodes_{nanos}_{id}.sqlite"))
    }

    fn create_episode_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                create table episode_cards (
                  id text primary key,
                  title text not null,
                  situation text not null,
                  observations text not null default '',
                  action text not null default '',
                  outcome text not null default '',
                  lesson text not null default '',
                  applicability text not null default '{}',
                  anti_applicability text not null default '{}',
                  domains text not null default '[]',
                  technologies text not null default '[]',
                  change_types text not null default '[]',
                  tools text not null default '[]',
                  classification_status text not null default 'classified',
                  scope text not null default 'global',
                  project_ref text,
                  repo_path text,
                  repo_key text,
                  source_kind text not null default 'distilled',
                  source_key text not null default '',
                  outcome_kind text not null default 'unknown',
                  importance integer not null default 50,
                  confidence integer not null default 50,
                  compile_use_count integer not null default 0,
                  decision_use_count integer not null default 0,
                  status text not null default 'active',
                  stale_at text,
                  dynamic_score real not null default 0,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table episode_refs (
                  id integer primary key autoincrement,
                  episode_card_id text not null,
                  ref_kind text not null,
                  ref_value text not null,
                  locator text,
                  query_hint text,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                "#,
            )
            .unwrap();
    }

    fn insert_episode(connection: &Connection, id: &str, title: &str, situation: &str) {
        connection
            .execute(
                "insert into episode_cards (id, title, situation) values (?1, ?2, ?3)",
                (id, title, situation),
            )
            .unwrap();
    }

    fn insert_episode_full(
        connection: &Connection,
        id: &str,
        title: &str,
        situation: &str,
        lesson: &str,
        status: &str,
        importance: i64,
    ) {
        connection
            .execute(
                "insert into episode_cards (id, title, situation, lesson, status, importance) values (?1, ?2, ?3, ?4, ?5, ?6)",
                (id, title, situation, lesson, status, importance),
            )
            .unwrap();
    }

    fn insert_episode_ref(
        connection: &Connection,
        episode_id: &str,
        ref_kind: &str,
        ref_value: &str,
        query_hint: Option<&str>,
    ) {
        connection
            .execute(
                "insert into episode_refs (episode_card_id, ref_kind, ref_value, query_hint) values (?1, ?2, ?3, ?4)",
                (episode_id, ref_kind, ref_value, query_hint),
            )
            .unwrap();
    }

    fn make_context(db_path: &Path) -> NativeToolContext {
        NativeToolContext {
            project_root: std::env::temp_dir(),
            sqlite_core_path: db_path.to_path_buf(),
        }
    }

    /// content_json でラップされた結果からテキストを取り出し、JSON としてパースする
    fn extract_content_json(result: &serde_json::Value) -> serde_json::Value {
        let text = result["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    fn extract_content_text(result: &serde_json::Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    // -----------------------------------------------------------------------
    // search_episodes テスト
    // -----------------------------------------------------------------------

    #[test]
    fn search_episodes_empty_db_returns_empty_items() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = search_episodes(&json!({"arguments": {}}), &context);
        let payload = extract_content_json(&result);

        assert_eq!(payload["items"], json!([]));
        assert_eq!(
            payload["diagnostics"]["missingIdentityGlobalOnly"],
            json!(true)
        );

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_no_table_returns_empty_items() {
        let db_path = temp_db_path();
        // テーブルを作成せず空の DB のみ
        let _connection = Connection::open(&db_path).unwrap();
        drop(_connection);

        let context = make_context(&db_path);
        let result = search_episodes(&json!({"arguments": {}}), &context);
        let payload = extract_content_json(&result);

        assert_eq!(payload["items"], json!([]));
        assert_eq!(
            payload["diagnostics"]["missingIdentityGlobalOnly"],
            json!(true)
        );

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_respects_limit() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        for i in 0..5 {
            insert_episode(
                &connection,
                &format!("ep-{i}"),
                &format!("Episode {i}"),
                &format!("Situation {i}"),
            );
        }
        drop(connection);

        let context = make_context(&db_path);
        let result = search_episodes(&json!({"arguments": {"limit": 2}}), &context);
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();

        assert_eq!(items.len(), 2);

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_filters_by_query() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        insert_episode(
            &connection,
            "ep-rust",
            "Rust compilation error",
            "When compiling Rust code",
        );
        insert_episode(
            &connection,
            "ep-python",
            "Python import issue",
            "When importing Python modules",
        );
        insert_episode(
            &connection,
            "ep-go",
            "Go concurrency pattern",
            "When writing Go goroutines",
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_episodes(
            &json!({"arguments": {"query": "Rust compilation"}}),
            &context,
        );
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();

        // "Rust compilation" はタイトルに完全一致するのでスコア > 0
        assert!(!items.is_empty());
        // 最初の結果が Rust 関連であること
        assert_eq!(items[0]["id"], "ep-rust");

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_normalizes_tool_filters_like_typescript() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        insert_episode(
            &connection,
            "ep-typescript",
            "TypeScript episode",
            "Tool normalization",
        );
        connection
            .execute(
                "update episode_cards set tools = '[\"type_script\"]' where id = 'ep-typescript'",
                [],
            )
            .unwrap();
        drop(connection);

        let context = make_context(&db_path);
        let result = search_episodes(&json!({"arguments": {"tools": ["Type Script!"]}}), &context);
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "ep-typescript");

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_filters_by_status() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        insert_episode_full(
            &connection,
            "ep-active",
            "Active episode",
            "Active situation",
            "Active lesson",
            "active",
            50,
        );
        insert_episode_full(
            &connection,
            "ep-deprecated",
            "Deprecated episode",
            "Deprecated situation",
            "Deprecated lesson",
            "deprecated",
            50,
        );
        drop(connection);

        let context = make_context(&db_path);

        // デフォルト (active) では deprecated は表示されない
        let result = search_episodes(&json!({"arguments": {}}), &context);
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "ep-active");

        // status=deprecated を指定すると deprecated のみ表示
        let result = search_episodes(&json!({"arguments": {"status": "deprecated"}}), &context);
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "ep-deprecated");

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn search_episodes_returns_refs() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        insert_episode(
            &connection,
            "ep-with-ref",
            "Episode with refs",
            "Some situation",
        );
        insert_episode_ref(
            &connection,
            "ep-with-ref",
            "file",
            "src/main.rs",
            Some("entry point"),
        );
        insert_episode_ref(
            &connection,
            "ep-with-ref",
            "url",
            "https://example.com",
            None,
        );
        drop(connection);

        let context = make_context(&db_path);
        let result = search_episodes(&json!({"arguments": {}}), &context);
        let payload = extract_content_json(&result);
        let items = payload["items"].as_array().unwrap();

        assert_eq!(items.len(), 1);
        let refs = items[0]["refs"].as_array().unwrap();
        assert_eq!(refs.len(), 2);

        // refs の中身を検証
        let ref_kinds: Vec<&str> = refs
            .iter()
            .map(|r| r["refKind"].as_str().unwrap())
            .collect();
        assert!(ref_kinds.contains(&"file"));
        assert!(ref_kinds.contains(&"url"));

        let _ = std::fs::remove_file(&db_path);
    }

    // -----------------------------------------------------------------------
    // fetch_episode テスト
    // -----------------------------------------------------------------------

    #[test]
    fn fetch_episode_happy_path() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        connection
            .execute(
                r#"insert into episode_cards (
                    id, title, situation, observations, action, outcome, lesson,
                    applicability, anti_applicability,
                    domains, technologies, change_types, tools,
                    repo_path, repo_key, source_kind, source_key,
                    outcome_kind, importance, confidence,
                    compile_use_count, decision_use_count, status
                ) values (
                    'ep-full', 'Full Episode', 'Test situation', 'Test observations',
                    'Test action', 'Test outcome', 'Test lesson',
                    '{"when": "always"}', '{"when": "never"}',
                    '["backend"]', '["rust"]', '["refactor"]', '["cargo"]',
                    '/repo/path', 'repo-key-1', 'distilled', 'source-key-1',
                    'success', 80, 90, 3, 1, 'active'
                )"#,
                [],
            )
            .unwrap();
        insert_episode_ref(&connection, "ep-full", "commit", "abc123", Some("fix bug"));
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_episode(&json!({"arguments": {"id": "ep-full"}}), &context);
        let payload = extract_content_json(&result);

        assert_eq!(payload["id"], "ep-full");
        assert_eq!(payload["title"], "Full Episode");
        assert_eq!(payload["situation"], "Test situation");
        assert_eq!(payload["observations"], "Test observations");
        assert_eq!(payload["action"], "Test action");
        assert_eq!(payload["outcome"], "Test outcome");
        assert_eq!(payload["lesson"], "Test lesson");
        assert_eq!(payload["outcomeKind"], "success");
        assert_eq!(payload["importance"], 80);
        assert_eq!(payload["confidence"], 90);
        assert_eq!(payload["compileUseCount"], 3);
        assert_eq!(payload["decisionUseCount"], 1);
        assert_eq!(payload["status"], "active");
        assert_eq!(payload["repoPath"], "/repo/path");
        assert_eq!(payload["repoKey"], "repo-key-1");
        assert_eq!(payload["sourceKind"], "distilled");
        assert_eq!(payload["sourceKey"], "source-key-1");
        assert_eq!(payload["domains"], json!(["backend"]));
        assert_eq!(payload["technologies"], json!(["rust"]));
        assert_eq!(payload["changeTypes"], json!(["refactor"]));
        assert_eq!(payload["tools"], json!(["cargo"]));
        assert_eq!(payload["applicability"], json!({"when": "always"}));
        assert_eq!(payload["antiApplicability"], json!({"when": "never"}));

        let refs = payload["refs"].as_array().unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0]["refKind"], "commit");
        assert_eq!(refs[0]["refValue"], "abc123");
        assert_eq!(refs[0]["queryHint"], "fix bug");

        // createdAt / updatedAt が存在する
        assert!(payload["createdAt"].is_string());
        assert!(payload["updatedAt"].is_string());

        // isError フラグがないこと
        assert!(result.get("isError").is_none());

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_episode_not_found() {
        let db_path = temp_db_path();
        let connection = Connection::open(&db_path).unwrap();
        create_episode_schema(&connection);
        drop(connection);

        let context = make_context(&db_path);
        let result = fetch_episode(&json!({"arguments": {"id": "nonexistent-id"}}), &context);

        assert_eq!(result["isError"], true);
        let text = extract_content_text(&result);
        assert!(
            text.contains("not found"),
            "expected 'not found' in: {text}"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_episode_missing_args() {
        let db_path = temp_db_path();
        let _connection = Connection::open(&db_path).unwrap();
        drop(_connection);

        let context = make_context(&db_path);
        // arguments キーがない
        let result = fetch_episode(&json!({}), &context);

        assert_eq!(result["isError"], true);
        let text = extract_content_text(&result);
        assert!(
            text.contains("arguments must be an object"),
            "expected 'arguments must be an object' in: {text}"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn fetch_episode_empty_id() {
        let db_path = temp_db_path();
        let _connection = Connection::open(&db_path).unwrap();
        drop(_connection);

        let context = make_context(&db_path);
        let result = fetch_episode(&json!({"arguments": {"id": ""}}), &context);

        assert_eq!(result["isError"], true);
        let text = extract_content_text(&result);
        assert!(
            text.contains("id is required"),
            "expected 'id is required' in: {text}"
        );

        let _ = std::fs::remove_file(&db_path);
    }

    // -----------------------------------------------------------------------
    // episode_search_text テスト
    // -----------------------------------------------------------------------

    #[test]
    fn episode_search_text_includes_title_situation_lesson_refs() {
        let row = EpisodeRow {
            id: "ep-search-text".to_string(),
            title: "Search Text Title".to_string(),
            situation: "Critical situation".to_string(),
            observations: "Important observations".to_string(),
            action: "Corrective action".to_string(),
            outcome: "Positive outcome".to_string(),
            lesson: "Valuable lesson learned".to_string(),
            applicability: "{}".to_string(),
            anti_applicability: "{}".to_string(),
            domains: r#"["backend","api"]"#.to_string(),
            technologies: r#"["rust","tokio"]"#.to_string(),
            change_types: r#"["bugfix"]"#.to_string(),
            tools: r#"["cargo"]"#.to_string(),
            classification_status: "classified".to_string(),
            scope: "global".to_string(),
            project_ref: None,
            repo_path: None,
            repo_key: None,
            source_kind: "distilled".to_string(),
            source_key: "".to_string(),
            outcome_kind: "success".to_string(),
            importance: 80,
            confidence: 90,
            compile_use_count: 0,
            decision_use_count: 0,
            status: "active".to_string(),
            stale_at: None,
            metadata: "{}".to_string(),
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
        };
        let refs = vec![
            EpisodeRef {
                ref_kind: "commit".to_string(),
                ref_value: "abc123".to_string(),
                locator: None,
                query_hint: Some("fix critical bug".to_string()),
            },
            EpisodeRef {
                ref_kind: "file".to_string(),
                ref_value: "src/lib.rs".to_string(),
                locator: None,
                query_hint: None,
            },
        ];

        let text = episode_search_text(&row, &refs);

        // タイトル・状況・レッスンが含まれる
        assert!(text.contains("Search Text Title"));
        assert!(text.contains("Critical situation"));
        assert!(text.contains("Valuable lesson learned"));

        // observations, action, outcome も含まれる
        assert!(text.contains("Important observations"));
        assert!(text.contains("Corrective action"));
        assert!(text.contains("Positive outcome"));

        // domains, technologies, tools が含まれる
        assert!(text.contains("backend"));
        assert!(text.contains("rust"));
        assert!(text.contains("cargo"));

        // refs の情報が含まれる
        assert!(text.contains("commit"));
        assert!(text.contains("abc123"));
        assert!(text.contains("fix critical bug"));
        assert!(text.contains("file"));
        assert!(text.contains("src/lib.rs"));
    }
}
