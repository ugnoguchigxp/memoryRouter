use std::time::Instant;

use rusqlite::{functions::FunctionFlags, params, Connection, OptionalExtension};
use serde_json::Value;

use super::{
    memory_recall_budget::build_call_result,
    memory_recall_context::MemoryRecallContext,
    memory_recall_contract::{parse_tool_call, MemoryType, RecallQuery},
    memory_recall_projection::{project, RawExperience, RawKnowledge, RawMemory},
    native_common::normalized_query_tokens,
    repository_scope::normalize_facet_value,
};

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum MemoryRecallError {
    InvalidArguments(String),
    Internal,
}

pub(crate) fn call(
    params: &Value,
    context: &MemoryRecallContext,
) -> Result<Value, MemoryRecallError> {
    let (memory_type, query) =
        parse_tool_call(params).map_err(MemoryRecallError::InvalidArguments)?;
    let (raw, mut omitted) = retrieve(memory_type, &query, context)?;
    let mut projected = Vec::with_capacity(raw.len());
    for candidate in raw {
        match project(candidate) {
            Ok(candidate) => projected.push(candidate),
            Err(code) => {
                omitted = true;
                operational_exclusion(code);
            }
        }
    }
    projected.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.sort_at.cmp(&left.sort_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    build_call_result(memory_type, projected, query.limit, omitted)
        .map_err(|_| MemoryRecallError::Internal)
}

fn retrieve(
    memory_type: MemoryType,
    query: &RecallQuery,
    context: &MemoryRecallContext,
) -> Result<(Vec<RawMemory>, bool), MemoryRecallError> {
    let connection = open_database(context)?;
    let deadline = Instant::now() + context.deadline;
    connection.progress_handler(1_000, Some(move || Instant::now() >= deadline));
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| MemoryRecallError::Internal)?;
    let result = match memory_type {
        MemoryType::Experience => retrieve_experiences(&transaction, query, context),
        MemoryType::Rule => retrieve_knowledge(&transaction, query, context, false),
        MemoryType::Skill => retrieve_knowledge(&transaction, query, context, true),
    };
    transaction
        .commit()
        .map_err(|_| MemoryRecallError::Internal)?;
    result
}

fn open_database(context: &MemoryRecallContext) -> Result<Connection, MemoryRecallError> {
    let connection = Connection::open_with_flags(
        &context.sqlite_core_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| MemoryRecallError::Internal)?;
    connection
        .busy_timeout(std::time::Duration::from_millis(100))
        .map_err(|_| MemoryRecallError::Internal)?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|_| MemoryRecallError::Internal)?;
    connection
        .create_scalar_function(
            "contextstill_normalize_facet",
            1,
            FunctionFlags::SQLITE_UTF8
                | FunctionFlags::SQLITE_DETERMINISTIC
                | FunctionFlags::SQLITE_INNOCUOUS,
            |context| {
                let value = context.get::<String>(0)?;
                Ok(normalize_facet_value(&value))
            },
        )
        .map_err(|_| MemoryRecallError::Internal)?;
    Ok(connection)
}

fn retrieve_experiences(
    connection: &Connection,
    query: &RecallQuery,
    context: &MemoryRecallContext,
) -> Result<(Vec<RawMemory>, bool), MemoryRecallError> {
    if !table_exists(connection, "episode_cards")? {
        return Ok((Vec::new(), false));
    }
    let cap = 20.min(query.limit * 4);
    let domains = serde_json::to_string(&query.domains).map_err(|_| MemoryRecallError::Internal)?;
    let technologies =
        serde_json::to_string(&query.technologies).map_err(|_| MemoryRecallError::Internal)?;
    let change_types =
        serde_json::to_string(&query.change_types).map_err(|_| MemoryRecallError::Internal)?;
    let outcome_kinds =
        serde_json::to_string(&query.outcome_kinds).map_err(|_| MemoryRecallError::Internal)?;
    let tokens = normalized_query_tokens(&query.query);
    let tokens = serde_json::to_string(&tokens).map_err(|_| MemoryRecallError::Internal)?;
    let mut statement = connection
        .prepare(
            r#"
            with eligible as (
              select e.*,
                     lower(e.title || char(10) || e.situation || char(10) || e.action || char(10) || e.outcome || char(10) || e.lesson) as search_text,
                     coalesce(nullif(e.updated_at, ''), e.created_at) as sort_at
              from episode_cards e
              where e.status = 'active'
                and e.classification_status = 'classified'
                and ((e.scope = 'repo' and e.project_ref = ?1) or (?2 = 1 and e.scope = 'global'))
                and (?3 = '[]' or exists (
                  select 1 from json_each(?3) requested
                  join json_each(case when json_valid(e.domains) then e.domains else '[]' end) candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?4 = '[]' or exists (
                  select 1 from json_each(?4) requested
                  join json_each(case when json_valid(e.technologies) then e.technologies else '[]' end) candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?5 = '[]' or exists (
                  select 1 from json_each(?5) requested
                  join json_each(case when json_valid(e.change_types) then e.change_types else '[]' end) candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?6 = '[]' or exists (
                  select 1 from json_each(?6) requested
                  where lower(requested.value) = lower(e.outcome_kind)
                ))
            )
            select id, title, situation, action, outcome, lesson, outcome_kind,
                   (case when instr(search_text, lower(?7)) > 0 then 8 else 0 end)
                     + ((importance * 6 + confidence * 4) / 100) as score,
                   sort_at
            from eligible
            where instr(search_text, lower(?7)) > 0
               or exists (select 1 from json_each(?8) token where instr(search_text, lower(token.value)) > 0)
            order by score desc, sort_at desc, id asc
            limit ?9
            "#,
        )
        .map_err(|_| MemoryRecallError::Internal)?;
    let rows = statement
        .query_map(
            params![
                context.project_ref,
                if context.include_global { 1_i64 } else { 0_i64 },
                domains,
                technologies,
                change_types,
                outcome_kinds,
                query.query,
                tokens,
                i64::try_from(cap + 1).unwrap_or(21)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(|_| MemoryRecallError::Internal)?;
    let mut matches = Vec::new();
    for row in rows {
        let (id, title, situation, action, outcome, lesson, outcome_kind, score, sort_at) =
            row.map_err(|_| MemoryRecallError::Internal)?;
        matches.push(RawMemory::Experience(RawExperience {
            id,
            title,
            situation,
            action,
            outcome,
            lesson,
            outcome_kind,
            score,
            sort_at,
        }));
    }
    let omitted = matches.len() > cap;
    matches.truncate(cap);
    Ok((matches, omitted))
}

fn retrieve_knowledge(
    connection: &Connection,
    query: &RecallQuery,
    context: &MemoryRecallContext,
    skill: bool,
) -> Result<(Vec<RawMemory>, bool), MemoryRecallError> {
    if !table_exists(connection, "knowledge_items")? {
        return Ok((Vec::new(), false));
    }
    let kind = if skill { "procedure" } else { "rule" };
    let cap = 20.min(query.limit * 4);
    let domains = serde_json::to_string(&query.domains).map_err(|_| MemoryRecallError::Internal)?;
    let technologies =
        serde_json::to_string(&query.technologies).map_err(|_| MemoryRecallError::Internal)?;
    let change_types =
        serde_json::to_string(&query.change_types).map_err(|_| MemoryRecallError::Internal)?;
    let polarities =
        serde_json::to_string(&query.polarities).map_err(|_| MemoryRecallError::Internal)?;
    let intent_tags =
        serde_json::to_string(&query.intent_tags).map_err(|_| MemoryRecallError::Internal)?;
    let tokens = serde_json::to_string(&normalized_query_tokens(&query.query))
        .map_err(|_| MemoryRecallError::Internal)?;
    let mut statement = connection
        .prepare(
            r#"
            with eligible as (
              select k.*,
                     lower(k.title || char(10) || k.body) as search_text,
                     coalesce(nullif(k.updated_at, ''), k.created_at) as sort_at
              from knowledge_items k
              where k.type = ?1
                and k.status = 'active'
                and k.classification_status = 'classified'
                and ((k.scope = 'repo' and k.project_ref = ?2) or (?3 = 1 and k.scope = 'global'))
                and (?4 = '[]' or exists (
                  select 1 from json_each(?4) requested
                  join json_each(case when json_valid(k.applies_to) then k.applies_to else '{}' end, '$.domains') candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?5 = '[]' or exists (
                  select 1 from json_each(?5) requested
                  join json_each(case when json_valid(k.applies_to) then k.applies_to else '{}' end, '$.technologies') candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?6 = '[]' or exists (
                  select 1 from json_each(?6) requested
                  join json_each(case when json_valid(k.applies_to) then k.applies_to else '{}' end, '$.changeTypes') candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
                and (?7 = '[]' or exists (
                  select 1 from json_each(?7) requested
                  where lower(requested.value) = lower(k.polarity)
                ))
                and (?8 = '[]' or exists (
                  select 1 from json_each(?8) requested
                  join json_each(case when json_valid(k.intent_tags) then k.intent_tags else '[]' end) candidate
                    on contextstill_normalize_facet(requested.value) != ''
                   and contextstill_normalize_facet(requested.value) = contextstill_normalize_facet(candidate.value)
                ))
            )
            select id, title, body, polarity,
                   (case when instr(search_text, lower(?9)) > 0 then 8 else 0 end)
                     + cast(round(importance / 20.0) as integer)
                     + cast(round(dynamic_score) as integer) as score,
                   sort_at
            from eligible
            where instr(search_text, lower(?9)) > 0
               or exists (select 1 from json_each(?10) token where instr(search_text, lower(token.value)) > 0)
            order by score desc, sort_at desc, id asc
            limit ?11
            "#,
        )
        .map_err(|_| MemoryRecallError::Internal)?;
    let rows = statement
        .query_map(
            params![
                kind,
                context.project_ref,
                if context.include_global { 1_i64 } else { 0_i64 },
                domains,
                technologies,
                change_types,
                polarities,
                intent_tags,
                query.query,
                tokens,
                i64::try_from(cap + 1).unwrap_or(21)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .map_err(|_| MemoryRecallError::Internal)?;
    let mut matches = Vec::new();
    for row in rows {
        let (id, title, body, polarity, score, sort_at) =
            row.map_err(|_| MemoryRecallError::Internal)?;
        let raw = RawKnowledge {
            id,
            title,
            body,
            polarity,
            score,
            sort_at,
        };
        matches.push(if skill {
            RawMemory::Skill(raw)
        } else {
            RawMemory::Rule(raw)
        });
    }
    let omitted = matches.len() > cap;
    matches.truncate(cap);
    Ok((matches, omitted))
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, MemoryRecallError> {
    connection
        .query_row(
            "select 1 from sqlite_master where type = 'table' and name = ?1 limit 1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|_| MemoryRecallError::Internal)
}

fn operational_exclusion(code: &str) {
    match code {
        "MALFORMED_EXPERIENCE_PROJECTION"
        | "MALFORMED_RULE_PROJECTION"
        | "MALFORMED_SKILL_PROJECTION" => {
            eprintln!("memory_recall exclusion={code}")
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::mcp_lifecycle::{
        native_episodes, native_knowledge, native_tools::NativeToolContext,
    };
    use rusqlite::Connection;
    use serde::Deserialize;
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::SystemTime,
    };

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("context_still_typed_memory_{nanos}_{id}.sqlite"))
    }

    fn context(path: PathBuf) -> MemoryRecallContext {
        MemoryRecallContext {
            sqlite_core_path: path,
            project_ref: "project-a".to_string(),
            include_global: false,
            deadline: std::time::Duration::from_secs(1),
        }
    }

    fn schema(connection: &Connection) {
        connection.execute_batch(r#"
            create table episode_cards (
              id text primary key, title text not null, situation text not null,
              observations text not null default '',
              action text not null default '', outcome text not null default '', lesson text not null default '',
              applicability text not null default '{}', anti_applicability text not null default '{}',
              outcome_kind text not null default 'unknown', importance integer not null default 50,
              confidence integer not null default 50, domains text not null default '[]',
              technologies text not null default '[]', change_types text not null default '[]',
              tools text not null default '[]',
              status text not null default 'active', classification_status text not null default 'classified',
              scope text not null default 'repo', project_ref text, repo_key text, repo_path text,
              source_kind text not null default 'distilled', source_key text not null default '',
              compile_use_count integer not null default 0, decision_use_count integer not null default 0,
              stale_at text, dynamic_score real not null default 0, metadata text not null default '{}',
              created_at text not null default CURRENT_TIMESTAMP,
              updated_at text not null default CURRENT_TIMESTAMP
            );
            create table knowledge_items (
              id text primary key, type text not null, status text not null default 'active',
              classification_status text not null default 'classified', scope text not null default 'repo',
              project_ref text, repo_key text, repo_path text,
              title text not null, body text not null, polarity text not null default 'positive',
              intent_tags text not null default '[]', applies_to text not null default '{}',
              confidence real not null default 70, importance real not null default 70,
              compile_select_count integer not null default 0, last_compiled_at text,
              agentic_accept_count integer not null default 0, explicit_upvote_count integer not null default 0,
              explicit_downvote_count integer not null default 0, dynamic_score real not null default 0,
              metadata text not null default '{}', last_verified_at text,
              created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP
            );
            create table episode_refs (
              id integer primary key autoincrement, episode_card_id text not null,
              ref_kind text not null, ref_value text not null, locator text, query_hint text,
              created_at text not null default CURRENT_TIMESTAMP
            );
            create table sources (
              id text primary key, uri text not null, created_at text not null default CURRENT_TIMESTAMP
            );
            create table source_fragments (
              id text primary key, source_id text not null, locator text not null,
              created_at text not null default CURRENT_TIMESTAMP
            );
            create table knowledge_source_links (
              id text primary key, knowledge_id text not null, source_fragment_id text not null,
              confidence real not null default 0, created_at text not null default CURRENT_TIMESTAMP
            );
        "#).unwrap();
    }

    #[test]
    fn recalls_only_configured_project_and_public_fields() {
        let path = temp_path();
        let connection = Connection::open(&path).unwrap();
        schema(&connection);
        connection.execute("insert into episode_cards (id,title,situation,lesson,outcome_kind,project_ref) values ('a','Rust deploy','service release','verify health','success','project-a')", []).unwrap();
        connection.execute("insert into episode_cards (id,title,situation,lesson,outcome_kind,project_ref) values ('b','Rust secret','other project','do not leak','success','project-b')", []).unwrap();
        drop(connection);
        let database_before = std::fs::read(&path).unwrap();
        let result = call(
            &json!({"name":"recall_experience","arguments":{"query":"Rust"}}),
            &context(path.clone()),
        )
        .unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        let items = envelope["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "Rust deploy");
        assert!(items[0].get("id").is_none());
        assert!(items[0].get("score").is_none());
        assert_eq!(std::fs::read(&path).unwrap(), database_before);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn database_errors_are_not_reported_as_no_content() {
        let path = temp_path();
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let result = call(
            &json!({"name":"recall_rule","arguments":{"query":"rust"}}),
            &context(path.clone()),
        );
        assert_eq!(result, Err(MemoryRecallError::Internal));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn expired_deadline_fails_closed() {
        let path = temp_path();
        let mut connection = Connection::open(&path).unwrap();
        schema(&connection);
        let transaction = connection.transaction().unwrap();
        for index in 0..500 {
            transaction.execute(
                "insert into knowledge_items (id,type,project_ref,title,body) values (?1,'rule','project-a',?2,'deadline needle')",
                (format!("deadline-{index:03}"), format!("Deadline {index:03}")),
            ).unwrap();
        }
        transaction.commit().unwrap();
        drop(connection);
        let mut expired = context(path.clone());
        expired.deadline = std::time::Duration::ZERO;
        let result = call(
            &json!({"name":"recall_rule","arguments":{"query":"deadline needle"}}),
            &expired,
        );
        assert_eq!(result, Err(MemoryRecallError::Internal));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn malformed_skill_is_excluded_without_raw_fallback() {
        let path = temp_path();
        let connection = Connection::open(&path).unwrap();
        schema(&connection);
        connection.execute("insert into knowledge_items (id,type,project_ref,title,body) values ('s','procedure','project-a','Deploy skill','raw secret without headings')", []).unwrap();
        drop(connection);
        let result = call(
            &json!({"name":"recall_skill","arguments":{"query":"secret"}}),
            &context(path.clone()),
        )
        .unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(envelope["items"].as_array().unwrap().is_empty());
        assert_eq!(envelope["truncated"], true);
        assert!(!result.to_string().contains("raw secret"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn active_classified_scope_and_global_policy_are_enforced_before_recall() {
        let path = temp_path();
        let connection = Connection::open(&path).unwrap();
        schema(&connection);
        connection.execute("insert into knowledge_items (id,type,project_ref,title,body) values ('repo','rule','project-a','Release repo','release safely')", []).unwrap();
        connection.execute("insert into knowledge_items (id,type,scope,project_ref,title,body) values ('global','rule','global',null,'Release global','release globally')", []).unwrap();
        connection.execute("insert into knowledge_items (id,type,status,project_ref,title,body) values ('draft','rule','draft','project-a','Release draft','release draft')", []).unwrap();
        connection.execute("insert into knowledge_items (id,type,classification_status,project_ref,title,body) values ('unresolved','rule','unresolved','project-a','Release unresolved','release unresolved')", []).unwrap();
        drop(connection);

        let params = json!({"name":"recall_rule","arguments":{"query":"release","limit":5}});
        let repo_only = call(&params, &context(path.clone())).unwrap();
        let repo_only: Value =
            serde_json::from_str(repo_only["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(repo_only["items"].as_array().unwrap().len(), 1);
        assert_eq!(repo_only["items"][0]["title"], "Release repo");

        let mut global_context = context(path.clone());
        global_context.include_global = true;
        let with_global = call(&params, &global_context).unwrap();
        let with_global: Value =
            serde_json::from_str(with_global["content"][0]["text"].as_str().unwrap()).unwrap();
        let titles = with_global["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["title"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(titles.len(), 2);
        assert!(titles.contains(&"Release repo"));
        assert!(titles.contains(&"Release global"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn facet_matching_uses_shared_slug_normalization() {
        let path = temp_path();
        let connection = Connection::open(&path).unwrap();
        schema(&connection);
        connection.execute(
            "insert into knowledge_items (id,type,project_ref,title,body,intent_tags,applies_to) values ('rule','rule','project-a','Typed rule','Use strict types','[\"release_flow\"]','{\"technologies\":[\"type_script\"]}')",
            [],
        ).unwrap();
        drop(connection);

        let result = call(
            &json!({"name":"recall_rule","arguments":{"query":"types","technologies":["Type Script"],"intentTags":["Release Flow"]}}),
            &context(path.clone()),
        )
        .unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(envelope["items"].as_array().unwrap().len(), 1);
        assert_eq!(envelope["items"][0]["title"], "Typed rule");

        let empty_slug = call(
            &json!({"name":"recall_rule","arguments":{"query":"types","technologies":["!!!"]}}),
            &context(path.clone()),
        )
        .unwrap();
        let empty_slug: Value =
            serde_json::from_str(empty_slug["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(empty_slug["items"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn skill_projection_and_candidate_omission_are_bounded() {
        let path = temp_path();
        let connection = Connection::open(&path).unwrap();
        schema(&connection);
        for index in 0..13 {
            connection.execute(
                "insert into knowledge_items (id,type,project_ref,title,body,intent_tags) values (?1,'procedure','project-a',?2,?3,'[\"release\"]')",
                (
                    format!("skill-{index:02}"),
                    format!("Release skill {index:02}"),
                    "Use when: releasing\nWorkflow:\n1. Run tests\nVerification: tests pass\nAvoid: guessing",
                ),
            ).unwrap();
        }
        drop(connection);
        let result = call(
            &json!({"name":"recall_skill","arguments":{"query":"release","limit":3,"intentTags":["release"]}}),
            &context(path.clone()),
        )
        .unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() <= 8 * 1024);
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(envelope["items"].as_array().unwrap().len(), 3);
        assert_eq!(envelope["truncated"], true);
        assert_eq!(envelope["items"][0]["title"], "Release skill 00");
        assert_eq!(envelope["items"][0]["workflow"], json!(["Run tests"]));
        let _ = std::fs::remove_file(path);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QualityFixture {
        evaluator_version: String,
        seed: String,
        queries_per_type: usize,
        cases: Vec<QualityCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct QualityCase {
        memory_type: String,
        query_prefix: String,
        expected_title_prefix: String,
    }

    #[test]
    fn synthetic_recall_at_five_does_not_drop_below_generic_baseline() {
        let fixture: QualityFixture = serde_json::from_str(include_str!(
            "../../../../../shared/fixtures/memory-recall-v1/retrieval-quality.json"
        ))
        .unwrap();
        assert_eq!(fixture.evaluator_version, "memory-recall-quality-v1");
        assert_eq!(fixture.seed, "context-still-synthetic-golden-v1");
        assert!(fixture.queries_per_type >= 50);

        let path = temp_path();
        let mut connection = Connection::open(&path).unwrap();
        schema(&connection);
        let transaction = connection.transaction().unwrap();
        for case in &fixture.cases {
            for index in 0..fixture.queries_per_type {
                let query = format!("{}-{index:02}", case.query_prefix);
                let title = format!("{} {index:02}", case.expected_title_prefix);
                match case.memory_type.as_str() {
                    "experience" => transaction.execute(
                        "insert into episode_cards (id,title,situation,lesson,project_ref) values (?1,?2,?3,'synthetic lesson','project-a')",
                        (&query, &title, &query),
                    ),
                    "rule" => transaction.execute(
                        "insert into knowledge_items (id,type,project_ref,title,body) values (?1,'rule','project-a',?2,?3)",
                        (&query, &title, &query),
                    ),
                    "skill" => transaction.execute(
                        "insert into knowledge_items (id,type,project_ref,title,body) values (?1,'procedure','project-a',?2,?3)",
                        (
                            &query,
                            &title,
                            format!("Use when: {query}\nWorkflow: run the synthetic step\nVerification: synthetic check passes\nAvoid: guessing"),
                        ),
                    ),
                    _ => panic!("unknown synthetic memory type"),
                }
                .unwrap();
            }
        }
        transaction.commit().unwrap();
        drop(connection);

        let recall_context = context(path.clone());
        let generic_context = NativeToolContext::for_test(std::env::temp_dir(), path.clone());
        for case in &fixture.cases {
            let (memory_type, tool_name) = match case.memory_type.as_str() {
                "experience" => (MemoryType::Experience, "recall_experience"),
                "rule" => (MemoryType::Rule, "recall_rule"),
                "skill" => (MemoryType::Skill, "recall_skill"),
                _ => panic!("unknown synthetic memory type"),
            };
            let mut typed_hits = 0;
            let mut generic_hits = 0;
            for index in 0..fixture.queries_per_type {
                let query = format!("{}-{index:02}", case.query_prefix);
                let expected_title = format!("{} {index:02}", case.expected_title_prefix);
                let typed = call(
                    &json!({"name":tool_name,"arguments":{"query":query,"limit":5}}),
                    &recall_context,
                )
                .unwrap();
                typed_hits += usize::from(typed_titles(&typed).contains(&expected_title));
                generic_hits += usize::from(
                    generic_recall(memory_type, &query, &generic_context).contains(&expected_title),
                );
            }
            assert_eq!(generic_hits, fixture.queries_per_type);
            assert!(
                typed_hits >= generic_hits,
                "{tool_name} typed Recall@5={typed_hits}, generic Recall@5={generic_hits}"
            );
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ten_thousand_row_recall_p95_meets_generic_baseline_gate() {
        let path = temp_path();
        let mut connection = Connection::open(&path).unwrap();
        schema(&connection);
        let transaction = connection.transaction().unwrap();
        for index in 0..10_000 {
            match index % 3 {
                0 => {
                    transaction.execute(
                        "insert into episode_cards (id,title,situation,lesson,project_ref) values (?1,?2,'latency needle experience','verify the outcome','project-a')",
                        (format!("experience-{index:05}"), format!("Latency experience {index:05}")),
                    ).unwrap();
                }
                1 => {
                    transaction.execute(
                        "insert into knowledge_items (id,type,project_ref,title,body) values (?1,'rule','project-a',?2,'latency needle rule')",
                        (format!("rule-{index:05}"), format!("Latency rule {index:05}")),
                    ).unwrap();
                }
                _ => {
                    transaction.execute(
                        "insert into knowledge_items (id,type,project_ref,title,body) values (?1,'procedure','project-a',?2,'Use when: latency needle skill\nWorkflow: run the check\nVerification: check passes\nAvoid: guessing')",
                        (format!("skill-{index:05}"), format!("Latency skill {index:05}")),
                    ).unwrap();
                }
            }
        }
        transaction.commit().unwrap();
        drop(connection);

        let recall_context = context(path.clone());
        let generic_context = NativeToolContext::for_test(std::env::temp_dir(), path.clone());
        let cases = [
            (
                MemoryType::Experience,
                "recall_experience",
                "latency needle experience",
            ),
            (MemoryType::Rule, "recall_rule", "latency needle rule"),
            (MemoryType::Skill, "recall_skill", "latency needle skill"),
        ];

        for (memory_type, tool_name, query) in cases {
            let typed_params = json!({"name":tool_name,"arguments":{"query":query,"limit":5}});
            call(&typed_params, &recall_context).unwrap();
            generic_recall(memory_type, query, &generic_context);

            let mut typed_samples = Vec::new();
            let mut generic_samples = Vec::new();
            for _ in 0..20 {
                let started = std::time::Instant::now();
                call(&typed_params, &recall_context).unwrap();
                typed_samples.push(started.elapsed());

                let started = std::time::Instant::now();
                generic_recall(memory_type, query, &generic_context);
                generic_samples.push(started.elapsed());
            }
            let typed_p95 = p95(&mut typed_samples);
            let generic_p95 = p95(&mut generic_samples);
            assert!(
                typed_p95 <= std::time::Duration::from_millis(500),
                "{tool_name} typed p95={typed_p95:?}"
            );
            assert!(
                typed_p95.as_secs_f64() <= generic_p95.as_secs_f64() * 1.25,
                "{tool_name} typed p95={typed_p95:?}, generic p95={generic_p95:?}"
            );
        }
        let _ = std::fs::remove_file(path);
    }

    fn typed_titles(result: &Value) -> Vec<String> {
        let payload: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["title"].as_str().map(ToString::to_string))
            .collect()
    }

    fn generic_recall(
        memory_type: MemoryType,
        query: &str,
        context: &NativeToolContext,
    ) -> Vec<String> {
        let result = match memory_type {
            MemoryType::Experience => native_episodes::search_episodes(
                &json!({"arguments":{"query":query,"projectRef":"project-a","limit":5}}),
                context,
            ),
            MemoryType::Rule => native_knowledge::search_knowledge(
                &json!({"arguments":{"query":query,"projectRef":"project-a","types":["rule"],"limit":5}}),
                context,
            ),
            MemoryType::Skill => native_knowledge::search_knowledge(
                &json!({"arguments":{"query":query,"projectRef":"project-a","types":["procedure"],"limit":5}}),
                context,
            ),
        };
        assert!(result.get("isError").is_none(), "{result}");
        let payload: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(!payload["items"].as_array().unwrap().is_empty());
        payload["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["title"].as_str().map(ToString::to_string))
            .collect()
    }

    fn p95(samples: &mut [std::time::Duration]) -> std::time::Duration {
        samples.sort();
        samples[(samples.len() * 95 / 100).min(samples.len() - 1)]
    }
}
