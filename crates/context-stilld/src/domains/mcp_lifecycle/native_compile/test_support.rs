#![cfg(test)]
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;

use super::*;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub(super) fn temp_db_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("context_still_native_compile_{nanos}_{id}.sqlite"))
}

pub(super) fn create_minimal_compile_schema(connection: &Connection) {
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
                  title text not null,
                  body text not null,
                  intent_tags text not null default '[]',
                  applies_to text not null default '{}',
                  importance real not null default 70,
                  dynamic_score real not null default 0,
                  compile_select_count integer not null default 0,
                  last_compiled_at text,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_runs (
                  id text primary key,
                  goal text not null,
                  intent text not null,
                  session_id text,
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  match_basis text not null default 'none',
                  identity_contract_version integer not null default 1,
                  scope_mode text not null default 'global_only',
                  input text not null default '{}',
                  retrieval_mode text not null,
                  status text not null,
                  degraded_reasons text not null default '[]',
                  token_budget integer not null default 0,
                  duration_ms integer not null default 0,
                  source text not null default 'unknown',
                  pack_snapshot text,
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_task_traces (
                  run_id text primary key,
                  retrieval_mode text not null,
                  project_ref text,
                  repo_path text,
                  repo_key text,
                  match_basis text not null default 'none',
                  identity_contract_version integer not null default 1,
                  scope_mode text not null default 'global_only',
                  identity_fingerprint text,
                  identity_trust text not null default 'request_hint',
                  binding_status text not null default 'not_applicable',
                  technologies text not null default '[]',
                  change_types text not null default '[]',
                  domains text not null default '[]',
                  goal_hash text not null,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_pack_items (
                  id integer primary key autoincrement,
                  run_id text not null,
                  item_kind text not null,
                  item_id text not null,
                  section text not null,
                  score real not null default 0,
                  ranking_reason text not null default '',
                  source_refs text not null default '[]',
                  scope_snapshot text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table knowledge_usage_events (
                  id text primary key,
                  run_id text not null,
                  knowledge_id text not null,
                  verdict text not null,
                  actor text not null,
                  reason text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table context_compile_candidate_traces (
                  id integer primary key autoincrement,
                  run_id text not null,
                  item_kind text not null,
                  item_id text not null,
                  text_rank integer,
                  text_score real,
                  vector_rank integer,
                  vector_score real,
                  merged_rank integer,
                  merged_score real,
                  final_rank integer,
                  final_score real,
                  selected integer not null default 0,
                  suppressed integer not null default 0,
                  suppression_reason text,
                  agentic_decision text not null default 'not_evaluated',
                  ranking_reason text,
                  community_key text,
                  evidence text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table episode_cards (
                  id text primary key,
                  title text not null,
                  situation text not null,
                  lesson text not null default '',
                  technologies text not null default '[]',
                  change_types text not null default '[]',
                  domains text not null default '[]',
                  applicability text not null default '{}',
                  classification_status text not null default 'classified',
                  scope text not null default 'global',
                  project_ref text,
                  repo_key text,
                  repo_path text,
                  importance integer not null default 50,
                  compile_use_count integer not null default 0,
                  status text not null default 'active',
                  updated_at text not null default CURRENT_TIMESTAMP
                );
                create table episode_retrieval_feedback (
                  id text primary key,
                  episode_card_id text not null,
                  run_kind text not null,
                  run_id text not null,
                  used_for text not null,
                  verdict text not null,
                  reason text,
                  metadata text not null default '{}',
                  created_at text not null default CURRENT_TIMESTAMP
                );
                create table settings (
                  id text primary key,
                  namespace text not null,
                  key text not null,
                  value text not null default '{}',
                  value_kind text not null default 'json',
                  secret_ref text,
                  is_secret integer not null default 0,
                  description text,
                  schema_version integer not null default 1,
                  created_at text not null default CURRENT_TIMESTAMP,
                  updated_at text not null default CURRENT_TIMESTAMP,
                  updated_by text,
                  unique(namespace, key)
                );
                "#,
        )
        .unwrap();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RepositoryIsolationFixture {
    pub(super) candidates: Vec<RepositoryIsolationCandidate>,
    pub(super) legacy_reproduction: LegacyReproduction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RepositoryIsolationCandidate {
    pub(super) id: String,
    pub(super) entity_kind: String,
    pub(super) status: String,
    pub(super) classification_status: String,
    pub(super) scope: String,
    pub(super) project_ref: Option<String>,
    pub(super) repo_key: Option<String>,
    pub(super) repo_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyReproduction {
    pub(super) goal: String,
    pub(super) wrong_project_knowledge_id: String,
    pub(super) unresolved_knowledge_id: String,
    pub(super) expected_legacy_selected_any: Vec<String>,
}

pub(super) fn repository_isolation_fixture() -> RepositoryIsolationFixture {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/context-compile-repository-isolation-v1.json"
    )))
    .expect("repository isolation fixture must parse")
}

pub(super) fn seed_repository_isolation_knowledge(
    connection: &Connection,
    fixture: &RepositoryIsolationFixture,
) {
    for candidate in fixture
        .candidates
        .iter()
        .filter(|candidate| candidate.entity_kind == "knowledge")
    {
        let importance = if candidate.id == fixture.legacy_reproduction.wrong_project_knowledge_id {
            100
        } else if candidate.id == fixture.legacy_reproduction.unresolved_knowledge_id {
            99
        } else {
            10
        };
        connection
            .execute(
                r#"
                    insert into knowledge_items (
                      id, type, status, scope, classification_status, project_ref, repo_key,
                      repo_path, title, body, importance
                    ) values (?1, 'rule', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                    "#,
                rusqlite::params![
                    candidate.id,
                    candidate.status,
                    candidate.scope,
                    candidate.classification_status,
                    candidate.project_ref,
                    candidate.repo_key,
                    candidate.repo_path,
                    format!("{} {}", fixture.legacy_reproduction.goal, candidate.id),
                    format!(
                        "{} verification candidate {}",
                        fixture.legacy_reproduction.goal, candidate.id
                    ),
                    importance,
                ],
            )
            .unwrap();
    }
}

pub(super) fn read_http_request(stream: &mut std::net::TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = stream.read(&mut buffer).unwrap_or(0);
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        if bytes.len() >= header_end + 4 + content_length {
            break;
        }
    }
    let body_start = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[body_start..]).to_string()
}

pub(super) fn spawn_composer_mock(
    goal: &str,
    used_ids: &[String],
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let goal = goal.to_string();
    let used_ids = used_ids.to_vec();
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..1 {
            let (mut stream, _) = listener.accept().unwrap();
            requests.push(read_http_request(&mut stream));
            let content = json!({
                    "markdown": format!("## 実装フォーカス\n- {goal}\n\n## 実装手順\n1. fixture\n\n## 検証観点\n- ids"),
                    "usedKnowledge": used_ids
                        .iter()
                        .map(|id| json!({"id": id, "confidence": 0.8}))
                        .collect::<Vec<_>>(),
                    "usedEpisodes": []
                })
                .to_string();
            let response_body = json!({
                "choices": [{"message": {"content": content}}]
            })
            .to_string();
            let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (format!("http://{address}"), handle)
}
