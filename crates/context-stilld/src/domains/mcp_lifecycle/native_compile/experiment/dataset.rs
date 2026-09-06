use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Dataset {
    pub contract_version: u8,
    pub id: String,
    pub provenance: String,
    pub repetitions: usize,
    pub max_provider_calls: usize,
    pub max_tokens: i64,
    pub timeout_ms: u64,
    pub pricing: Option<Pricing>,
    pub corpus: Vec<Knowledge>,
    pub queries: Vec<Task>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pricing {
    pub currency: String,
    pub input_per_million: f64,
    pub output_per_million: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Knowledge {
    pub id: String,
    pub title: String,
    pub body: String,
    pub project_ref: Option<String>,
    #[serde(default)]
    pub dynamic_score: f64,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Task {
    pub id: String,
    pub goal: String,
    pub project_ref: Option<String>,
    pub checks: Vec<Check>,
    pub expected_ids: Vec<String>,
    #[serde(default)]
    pub forbidden_ids: Vec<String>,
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Check {
    pub pointer: String,
    pub equals: Value,
    #[serde(default)]
    pub critical: bool,
}

impl Dataset {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let data: Self = serde_json::from_slice(bytes)
            .map_err(|e| format!("invalid experiment dataset: {e}"))?;
        if data.contract_version != 1
            || data.id.trim().is_empty()
            || data.provenance.trim().is_empty()
            || !(1..=10).contains(&data.repetitions)
            || !(1..=100).contains(&data.queries.len())
            || !(1..=1_000).contains(&data.corpus.len())
            || !(128..=8_000).contains(&data.max_tokens)
            || !(1_000..=120_000).contains(&data.timeout_ms)
        {
            return Err("invalid experiment version, identity, size or execution bounds".into());
        }
        let required_calls = data.queries.len() * data.repetitions * 7;
        if data.max_provider_calls < required_calls || data.max_provider_calls > 7_000 {
            return Err(format!(
                "maxProviderCalls must cover {required_calls} calls and be <= 7000"
            ));
        }
        if let Some(price) = &data.pricing {
            if price.currency.trim().is_empty()
                || !price.input_per_million.is_finite()
                || !price.output_per_million.is_finite()
                || price.input_per_million < 0.0
                || price.output_per_million < 0.0
            {
                return Err("pricing must have a currency and finite non-negative rates".into());
            }
        }
        let mut corpus_ids = HashSet::new();
        for item in &data.corpus {
            if !corpus_ids.insert(&item.id)
                || item.id.trim().is_empty()
                || item.body.trim().is_empty()
                || item.title.trim().is_empty()
                || item.source.trim().is_empty()
                || !item.dynamic_score.is_finite()
            {
                return Err("corpus requires unique IDs, content and provenance".into());
            }
        }
        let mut task_ids = HashSet::new();
        for task in &data.queries {
            if !task_ids.insert(&task.id)
                || task.id.trim().is_empty()
                || task.goal.trim().is_empty()
                || task.source.trim().is_empty()
                || task.checks.is_empty()
            {
                return Err("tasks require unique IDs, goals, checks and provenance".into());
            }
            let mut pointers = HashSet::new();
            for check in &task.checks {
                if !check.pointer.starts_with('/') || !pointers.insert(&check.pointer) {
                    return Err("checks require unique non-root JSON pointers".into());
                }
            }
            let expected: HashSet<_> = task.expected_ids.iter().collect();
            let forbidden: HashSet<_> = task.forbidden_ids.iter().collect();
            if expected.len() != task.expected_ids.len()
                || forbidden.len() != task.forbidden_ids.len()
                || !expected.is_disjoint(&forbidden)
                || expected
                    .union(&forbidden)
                    .any(|id| !corpus_ids.contains(id))
            {
                return Err(
                    "retrieval labels must be unique, disjoint and refer to the corpus".into(),
                );
            }
        }
        Ok(data)
    }

    pub fn fixture(&self) -> Result<Connection, String> {
        let connection = Connection::open_in_memory().map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "CREATE TABLE knowledge_items (
            id TEXT PRIMARY KEY, type TEXT, polarity TEXT, title TEXT, body TEXT,
            dynamic_score REAL, importance REAL DEFAULT 70, applies_to TEXT DEFAULT '{}',
            scope TEXT, project_ref TEXT, repo_key TEXT, repo_path TEXT,
            status TEXT DEFAULT 'active', classification_status TEXT DEFAULT 'classified',
            updated_at TEXT DEFAULT '2026-01-01T00:00:00Z');",
            )
            .map_err(|e| e.to_string())?;
        for item in &self.corpus {
            connection
                .execute(
                    "INSERT INTO knowledge_items
                (id,type,polarity,title,body,dynamic_score,scope,project_ref)
                VALUES (?1,'rule','positive',?2,?3,?4,?5,?6)",
                    params![
                        item.id,
                        item.title,
                        item.body,
                        item.dynamic_score,
                        if item.project_ref.is_some() {
                            "repo"
                        } else {
                            "global"
                        },
                        item.project_ref
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(connection)
    }
}

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

// This is the sole task-answer prompt builder. Evaluation checks, IDs and sources
// stay on the evaluator side; only the public task and compiled memory are sent.
pub(super) fn answer_prompt(task: &Task, context: &str) -> String {
    serde_json::json!({"task": task.goal, "memory": context}).to_string()
}
