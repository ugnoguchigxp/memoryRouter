use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::shared::errors::CliError;

use super::episode_executor::LocalLlmTargetConfig;
use super::events::append_queue_event_for_connection;

const FINDING_VERSION: &str = "finding-candidate-rust-v1";
const MAX_CANDIDATES_PER_JOB: usize = 20;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum FindingExecutionStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
}

#[derive(Debug)]
struct FindingJob {
    id: String,
    input_kind: String,
    source_kind: String,
    source_key: String,
    source_uri: String,
    distillation_version: String,
    priority: i64,
    metadata: Value,
}

#[derive(Debug, Deserialize)]
struct Candidate {
    #[serde(rename = "type")]
    kind: String,
    polarity: String,
    title: String,
    content: String,
}

pub(crate) fn run_finding_candidate_job_for_connection(
    connection: &Connection,
    job_id: &str,
    worker_id: &str,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<FindingExecutionStatus, CliError> {
    let job = load_job(connection, job_id)?;
    let result = process_job(connection, &job, target, api_key, timeout_seconds);
    match result {
        Ok(status) => Ok(status),
        Err(error) if is_provider_unavailable(&error.to_string()) => {
            mark_retrying(connection, &job.id, &error.to_string())?;
            append_finding_event_best_effort(
                connection,
                &event_id("finding-event-retry", &job.id),
                "findingCandidate",
                &job.id,
                "retried",
                Some("finding candidate provider unavailable; job returned to queue"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "reason": "provider_unavailable_retry",
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            );
            Ok(FindingExecutionStatus::Retrying)
        }
        Err(error) => {
            mark_failed(connection, &job.id, &error.to_string())?;
            append_finding_event_best_effort(
                connection,
                &event_id("finding-event-failed", &job.id),
                "findingCandidate",
                &job.id,
                "failed",
                Some("finding candidate failed"),
                Some(
                    &json!({
                        "workerId": worker_id,
                        "executor": "rust",
                        "targetId": target.target_id,
                        "error": truncate(&error.to_string(), 500)
                    })
                    .to_string(),
                ),
            );
            Ok(FindingExecutionStatus::Failed)
        }
    }
}

fn process_job(
    connection: &Connection,
    job: &FindingJob,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<FindingExecutionStatus, CliError> {
    if job.input_kind != "source_target" || job.source_kind != "vibe_memory" {
        return Err(CliError::io(format!(
            "unsupported findingCandidate input: {}/{}",
            job.input_kind, job.source_kind
        )));
    }
    if is_self_ingestion_blocked(connection, &job.source_key)? {
        connection
            .execute(
                "update finding_candidate_queue set status = 'skipped', locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, completed_at = CURRENT_TIMESTAMP, last_error = null, last_outcome_kind = 'self_ingestion_blocked', updated_at = CURRENT_TIMESTAMP where id = ?1",
                [&job.id],
            )
            .map_err(|error| CliError::io(format!("failed to skip self-ingestion job: {error}")))?;
        append_finding_event_best_effort(
            connection,
            &event_id("finding-event-self-ingestion", &job.id),
            "findingCandidate",
            &job.id,
            "skipped",
            Some("self ingestion blocked"),
            Some(
                &json!({"executor":"rust","reason":"codex_finding_escalation_self_ingestion"})
                    .to_string(),
            ),
        );
        return Ok(FindingExecutionStatus::Skipped);
    }
    let source = read_filtered_vibe_source(connection, &job.source_key)?;
    let candidates = request_candidates(target, api_key, timeout_seconds, &source)?;
    persist_result(connection, job, &candidates)?;
    let (status, outcome, message) = if candidates.is_empty() {
        (
            FindingExecutionStatus::Skipped,
            "no_candidate",
            "finding candidate produced no reusable knowledge",
        )
    } else {
        (
            FindingExecutionStatus::Completed,
            "completed",
            "finding candidate completed",
        )
    };
    append_finding_event_best_effort(
        connection,
        &event_id("finding-event-completed", &job.id),
        "findingCandidate",
        &job.id,
        if candidates.is_empty() {
            "skipped"
        } else {
            "completed"
        },
        Some(message),
        Some(
            &json!({
                "executor": "rust",
                "targetId": target.target_id,
                "candidateCount": candidates.len(),
                "outcome": outcome
            })
            .to_string(),
        ),
    );
    Ok(status)
}

fn append_finding_event_best_effort(
    connection: &Connection,
    event_id: &str,
    queue_name: &str,
    queue_job_id: &str,
    event_type: &str,
    message: Option<&str>,
    metadata_json: Option<&str>,
) {
    if let Err(error) = append_queue_event_for_connection(
        connection,
        event_id,
        queue_name,
        queue_job_id,
        event_type,
        message,
        metadata_json,
    ) {
        eprintln!("failed to append {queue_name}/{queue_job_id} {event_type} queue event: {error}");
    }
}

fn is_self_ingestion_blocked(connection: &Connection, source_key: &str) -> Result<bool, CliError> {
    let metadata = connection
        .query_row(
            "select coalesce(metadata, '{}') from vibe_memories where id = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            CliError::io(format!("failed to inspect vibe memory metadata: {error}"))
        })?;
    let value = metadata
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or_else(|| json!({}));
    Ok(value.get("generatedBy").and_then(Value::as_str)
        == Some("contextStill.codexFindingEscalation")
        || value.get("excludedFromVibeMemory").and_then(Value::as_bool) == Some(true)
        || value
            .get("excludeFromFindingCandidate")
            .and_then(Value::as_bool)
            == Some(true))
}

fn load_job(connection: &Connection, job_id: &str) -> Result<FindingJob, CliError> {
    connection.query_row(
        "select id, input_kind, source_kind, source_key, source_uri, distillation_version, priority, coalesce(metadata, '{}') from finding_candidate_queue where id = ?1 limit 1",
        [job_id],
        |row| Ok(FindingJob {
            id: row.get(0)?, input_kind: row.get(1)?, source_kind: row.get(2)?, source_key: row.get(3)?,
            source_uri: row.get(4)?, distillation_version: row.get(5)?, priority: row.get(6)?,
            metadata: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_else(|_| json!({})),
        }),
    ).optional()
     .map_err(|error| CliError::io(format!("failed to load finding candidate job: {error}")))?
     .ok_or_else(|| CliError::io(format!("finding candidate queue job not found: {job_id}")))
}

fn read_filtered_vibe_source(
    connection: &Connection,
    source_key: &str,
) -> Result<String, CliError> {
    let content = connection
        .query_row(
            "select content from vibe_memories where id = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load vibe memory: {error}")))?
        .ok_or_else(|| CliError::io(format!("vibe memory not found: {source_key}")))?;
    let mut blocks = vec![filter_source_text(&content)];
    let table_exists: bool = connection.query_row(
        "select exists(select 1 from sqlite_master where type = 'table' and name = 'agent_diff_entries')",
        [], |row| row.get(0),
    ).unwrap_or(false);
    if table_exists {
        let mut statement = connection.prepare(
            "select file_path, diff_hunk from agent_diff_entries where vibe_memory_id = ?1 order by created_at asc, id asc"
        ).map_err(|error| CliError::io(format!("failed to prepare vibe diffs: {error}")))?;
        let rows = statement
            .query_map([source_key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| CliError::io(format!("failed to query vibe diffs: {error}")))?;
        for row in rows {
            let (path, diff) =
                row.map_err(|error| CliError::io(format!("failed to read vibe diff: {error}")))?;
            blocks.push(format!(
                "\n[agent diff: {}]\n{}",
                path,
                filter_source_text(&diff)
            ));
        }
    }
    let joined = blocks.join("\n");
    Ok(truncate_middle(&joined, 32_000))
}

fn filter_source_text(input: &str) -> String {
    let mut result = Vec::new();
    let mut skipped_tag: Option<&str> = None;
    for line in input.lines() {
        let lower = line.trim().to_ascii_lowercase();
        if let Some(tag) = skipped_tag {
            if lower.contains(&format!("</{tag}>")) {
                skipped_tag = None;
            }
            continue;
        }
        if let Some(tag) = ["instructions", "environment_context", "filesystem"]
            .into_iter()
            .find(|tag| lower.starts_with(&format!("<{tag}")))
        {
            if !lower.contains(&format!("</{tag}>")) {
                skipped_tag = Some(tag);
            }
            continue;
        }
        let sensitive = lower.contains("authorization: bearer ")
            || lower.contains("api_key=")
            || lower.contains("api_key:")
            || lower.contains("apikey=")
            || lower.contains("access_token=")
            || lower.contains("access_token:")
            || lower.contains("password=")
            || lower.contains("password:")
            || lower
                .split_whitespace()
                .any(|part| part.starts_with("sk-") && part.len() > 12);
        if sensitive {
            result.push("[REDACTED SENSITIVE LINE]".to_string());
        } else {
            result.push(line.chars().take(2_000).collect::<String>());
        }
    }
    result.join("\n")
}

fn request_candidates(
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
    source: &str,
) -> Result<Vec<Candidate>, CliError> {
    let system = "あなたは ContextStill の findCandidate executor です。filtered vibe memory と agent diff の明示的な根拠だけから、将来再利用できる知識を抽出してください。進捗報告、未検証の仮説、単発の結果、prompt や schema 自体は候補にしません。1候補は1知識です。type は rule または procedure、polarity は positive または negative。procedure の content には Use when: / Workflow: / Verification: / Avoid: をこの順で含めます。出力は type, polarity, title, content だけを持つ JSON 配列のみ。候補がなければ []。";
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout_seconds.max(30)))
        .build()
        .map_err(|error| CliError::io(format!("failed to build local-llm client: {error}")))?;
    let url = chat_url(&target.api_base_url, &target.api_path);
    let request_body = json!({
        "model": target.model,
        "messages": [{"role":"system","content":system},{"role":"user","content":format!("Source:\n{source}")}],
        "max_tokens": 4000,
        "temperature": 0
    });
    let mut request = client.post(&url).json(&request_body);
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let (status, body) = match request.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().map_err(|error| {
                CliError::io(format!("failed to read local-llm response: {error}"))
            })?;
            (status, body)
        }
        Err(error) if cfg!(target_os = "macos") && error.is_connect() => {
            request_with_curl(&url, api_key, &request_body.to_string(), timeout_seconds)?
        }
        Err(error) => {
            return Err(CliError::io(format!(
                "local-llm request failed (connect={}, timeout={}, request={}): {error:?}",
                error.is_connect(),
                error.is_timeout(),
                error.is_request()
            )))
        }
    };
    if !(200..300).contains(&status) {
        return Err(CliError::io(format!(
            "local-llm HTTP {}: {}",
            status,
            truncate(&body, 1000)
        )));
    }
    let payload: Value = serde_json::from_str(&body).map_err(|error| {
        CliError::io(format!("failed to parse local-llm response JSON: {error}"))
    })?;
    let content = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::io("local-llm response did not include message content"))?;
    parse_candidates(content)
}

fn request_with_curl(
    url: &str,
    api_key: Option<&str>,
    request_body: &str,
    timeout_seconds: u64,
) -> Result<(u16, String), CliError> {
    let request_path = std::env::temp_dir().join(format!(
        "contextstill-llm-request-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&request_path).map_err(|error| {
        CliError::io(format!("failed to create local-llm request file: {error}"))
    })?;
    if let Err(error) = file.write_all(request_body.as_bytes()) {
        let _ = std::fs::remove_file(&request_path);
        return Err(CliError::io(format!(
            "failed to write local-llm request file: {error}"
        )));
    }
    drop(file);

    let timeout = timeout_seconds.max(30).to_string();
    let data_path = format!("@{}", request_path.to_string_lossy());
    let result = (|| -> Result<std::process::Output, CliError> {
        let mut child = Command::new("/usr/bin/curl")
            .args([
                "--silent",
                "--show-error",
                "--max-time",
                &timeout,
                "--request",
                "POST",
                "--header",
                "Content-Type: application/json",
                "--data-binary",
                &data_path,
                "--write-out",
                "\n%{http_code}",
                url,
                "--config",
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| CliError::io(format!("failed to start curl fallback: {error}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
                let escaped = key.replace('\\', "\\\\").replace('"', "\\\"");
                writeln!(stdin, "header = \"Authorization: Bearer {escaped}\"").map_err(
                    |error| CliError::io(format!("failed to configure curl fallback: {error}")),
                )?;
            }
        }
        child
            .wait_with_output()
            .map_err(|error| CliError::io(format!("failed to wait for curl fallback: {error}")))
    })();
    let _ = std::fs::remove_file(&request_path);
    let output = result?;
    if !output.status.success() {
        return Err(CliError::io(format!(
            "local-llm curl fallback failed: {}",
            truncate(&String::from_utf8_lossy(&output.stderr), 1000)
        )));
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let (body, status) = output
        .rsplit_once('\n')
        .ok_or_else(|| CliError::io("local-llm curl fallback omitted HTTP status"))?;
    let status = status
        .trim()
        .parse::<u16>()
        .map_err(|error| CliError::io(format!("invalid curl fallback HTTP status: {error}")))?;
    Ok((status, body.to_string()))
}

fn parse_candidates(content: &str) -> Result<Vec<Candidate>, CliError> {
    let cleaned = content
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    let value: Value = serde_json::from_str(cleaned.trim())
        .or_else(|_| {
            let start = cleaned.find('[').unwrap_or(0);
            let end = cleaned
                .rfind(']')
                .map(|index| index + 1)
                .unwrap_or(cleaned.len());
            serde_json::from_str(&cleaned[start..end])
        })
        .map_err(|error| CliError::io(format!("finding candidate parse failed: {error}")))?;
    let values = if value.is_array() {
        value.as_array().cloned().unwrap_or_default()
    } else {
        vec![value]
    };
    let mut candidates = Vec::new();
    for value in values.into_iter().take(MAX_CANDIDATES_PER_JOB) {
        let Ok(mut candidate) = serde_json::from_value::<Candidate>(value) else {
            continue;
        };
        candidate.kind = candidate.kind.trim().to_ascii_lowercase();
        candidate.polarity = candidate.polarity.trim().to_ascii_lowercase();
        candidate.title = candidate.title.trim().to_string();
        candidate.content = candidate.content.trim().to_string();
        if !matches!(candidate.kind.as_str(), "rule" | "procedure")
            || !matches!(candidate.polarity.as_str(), "positive" | "negative")
            || candidate.title.is_empty()
            || candidate.content.is_empty()
            || (candidate.kind == "procedure" && candidate.polarity == "negative")
            || (candidate.kind == "procedure" && !has_skill_like_procedure_body(&candidate.content))
        {
            continue;
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn has_skill_like_procedure_body(body: &str) -> bool {
    let lines = body.lines().collect::<Vec<_>>();
    let heading_index = |heading: &str| {
        lines.iter().position(|line| {
            line.trim_start()
                .to_ascii_lowercase()
                .starts_with(&format!("{}:", heading.to_ascii_lowercase()))
        })
    };
    let (Some(use_when), Some(workflow), Some(verification), Some(avoid)) = (
        heading_index("Use when"),
        heading_index("Workflow"),
        heading_index("Verification"),
        heading_index("Avoid"),
    ) else {
        return false;
    };
    if !(use_when < workflow && workflow < verification && verification < avoid) {
        return false;
    }
    let section_has_content = |start: usize, end: usize| {
        lines[start..end].iter().enumerate().any(|(index, line)| {
            let content = if index == 0 {
                line.split_once(':').map(|(_, value)| value).unwrap_or("")
            } else {
                line
            };
            !content
                .trim_start_matches(|character: char| {
                    character.is_whitespace()
                        || character == '-'
                        || character == '*'
                        || character == '.'
                        || character == ')'
                        || character.is_ascii_digit()
                })
                .is_empty()
        })
    };
    let workflow_steps = lines[workflow + 1..verification]
        .iter()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ")
                || trimmed
                    .split_once(['.', ')'])
                    .is_some_and(|(prefix, rest)| {
                        !prefix.is_empty()
                            && prefix.chars().all(|character| character.is_ascii_digit())
                            && !rest.trim().is_empty()
                    })
        })
        .count();
    section_has_content(use_when, workflow)
        && workflow_steps >= 2
        && section_has_content(verification, avoid)
        && section_has_content(avoid, lines.len())
}

fn persist_result(
    connection: &Connection,
    job: &FindingJob,
    candidates: &[Candidate],
) -> Result<(), CliError> {
    let tx = connection.unchecked_transaction().map_err(|error| {
        CliError::io(format!(
            "failed to begin finding result transaction: {error}"
        ))
    })?;
    for (index, candidate) in candidates.iter().enumerate() {
        let found_id = stable_id("found-candidate", &job.id, index);
        let cover_id = stable_id("cover-evidence", &job.id, index);
        let origin = json!({
            "queueVersion":"v2", "sourceKind":job.source_kind, "sourceKey":job.source_key,
            "sourceUri":job.source_uri, "findingJobId":job.id, "polarity":candidate.polarity
        });
        let metadata = json!({
            "sourceKind":job.source_kind, "sourceKey":job.source_key, "sourceUri":job.source_uri,
            "polarity":candidate.polarity, "executor":"rust", "version":FINDING_VERSION,
            "sourceMetadata":job.metadata
        });
        tx.execute(
            "insert into found_candidates (id, finding_job_id, candidate_index, type, title, content, source_summary, origin, metadata, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, ?8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) on conflict(id) do update set type=excluded.type, title=excluded.title, content=excluded.content, origin=excluded.origin, metadata=excluded.metadata, updated_at=CURRENT_TIMESTAMP",
            params![found_id, job.id, index as i64, candidate.kind, candidate.title, candidate.content, origin.to_string(), metadata.to_string()],
        ).map_err(|error| CliError::io(format!("failed to persist found candidate: {error}")))?;
        tx.execute(
            "insert into covering_evidence_queue (id, found_candidate_id, distillation_version, status, priority, provider_policy, payload, metadata, created_at, updated_at) select ?1, ?2, ?3, 'pending', ?4, 'default', '{}', ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP where not exists (select 1 from covering_evidence_queue where found_candidate_id = ?2)",
            params![cover_id, found_id, job.distillation_version, job.priority, metadata.to_string()],
        ).map_err(|error| CliError::io(format!("failed to enqueue covering evidence: {error}")))?;
    }
    let outcome = if candidates.is_empty() {
        "no_candidate"
    } else {
        "completed"
    };
    tx.execute(
        "update finding_candidate_queue set status = ?2, locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, completed_at = CURRENT_TIMESTAMP, last_error = null, last_outcome_kind = ?3, metadata = json_set(case when json_valid(metadata) then metadata else '{}' end, '$.findingCandidate.executor', 'rust', '$.findingCandidate.candidateCount', ?4, '$.findingCandidate.version', ?5), updated_at = CURRENT_TIMESTAMP where id = ?1",
        params![job.id, if candidates.is_empty() { "skipped" } else { "completed" }, outcome, candidates.len() as i64, FINDING_VERSION],
    ).map_err(|error| CliError::io(format!("failed to complete finding candidate job: {error}")))?;
    tx.commit().map_err(|error| {
        CliError::io(format!(
            "failed to commit finding result transaction: {error}"
        ))
    })?;
    Ok(())
}

fn mark_retrying(connection: &Connection, job_id: &str, error: &str) -> Result<(), CliError> {
    connection.execute(
        "update finding_candidate_queue set status = 'pending', attempt_count = attempt_count + 1, locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = datetime(CURRENT_TIMESTAMP, '+60 seconds'), last_error = ?2, last_outcome_kind = 'provider_unavailable_retry', updated_at = CURRENT_TIMESTAMP where id = ?1",
        params![job_id, truncate(error, 1000)],
    ).map_err(|error| CliError::io(format!("failed to retry finding candidate job: {error}")))?;
    Ok(())
}

fn mark_failed(connection: &Connection, job_id: &str, error: &str) -> Result<(), CliError> {
    connection.execute(
        "update finding_candidate_queue set status = 'failed', attempt_count = attempt_count + 1, locked_by = null, locked_at = null, heartbeat_at = null, next_run_at = null, last_error = ?2, last_outcome_kind = 'failed', updated_at = CURRENT_TIMESTAMP where id = ?1",
        params![job_id, truncate(error, 1000)],
    ).map_err(|error| CliError::io(format!("failed to mark finding candidate failed: {error}")))?;
    Ok(())
}

fn is_provider_unavailable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("local-llm request failed")
        || lower.contains("failed to read local-llm response")
        || lower.contains("local-llm curl fallback failed")
        || lower.contains("failed to start curl fallback")
        || lower.contains("failed to wait for curl fallback")
        || lower.contains("failed to configure curl fallback")
        || lower.contains("curl fallback omitted http status")
        || lower.contains("invalid curl fallback http status")
        || lower.contains("http 408")
        || lower.contains("http 429")
        || (500..=599).any(|status| lower.contains(&format!("http {status}")))
}

fn chat_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = if path.trim().is_empty() {
        "/v1/chat/completions"
    } else {
        path.trim()
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    if base.ends_with("/v1") && path.starts_with("/v1/") {
        format!("{}{}", base, &path[3..])
    } else {
        format!("{base}{path}")
    }
}

fn stable_id(prefix: &str, job_id: &str, index: usize) -> String {
    let digest = Sha256::digest(format!("{prefix}:{job_id}:{index}"));
    format!("{prefix}-{:x}", digest)[..56].to_string()
}

fn event_id(prefix: &str, job_id: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    stable_id(prefix, &format!("{job_id}:{now}"), 0)
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn truncate_middle(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    let head_len = max_chars * 7 / 10;
    let tail_len = max_chars * 2 / 10;
    let omitted = chars.len() - head_len - tail_len;
    format!(
        "{}\n[...truncated {omitted} chars...]\n{}",
        chars[..head_len].iter().collect::<String>(),
        chars[chars.len() - tail_len..].iter().collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

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
            .map(|index| json!({
                "type":"rule", "polarity":"positive", "title":format!("rule-{index}"), "content":"body"
            }))
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

    #[test]
    fn treats_curl_and_server_failures_as_retryable() {
        assert!(is_provider_unavailable(
            "local-llm curl fallback failed: No route to host"
        ));
        assert!(is_provider_unavailable("local-llm HTTP 500: overloaded"));
        assert!(is_provider_unavailable("local-llm HTTP 429: busy"));
        assert!(is_provider_unavailable(
            "failed to read local-llm response: connection reset"
        ));
        assert!(!is_provider_unavailable("finding candidate parse failed"));
    }

    #[test]
    fn retry_and_failure_increment_attempt_count() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(r#"
            create table finding_candidate_queue (
              id text primary key, status text, attempt_count integer not null default 0,
              locked_by text, locked_at text, heartbeat_at text, next_run_at text,
              completed_at text, last_error text, last_outcome_kind text, updated_at text
            );
            insert into finding_candidate_queue (id, status, attempt_count, updated_at)
              values ('retry-job', 'running', 2, CURRENT_TIMESTAMP), ('failed-job', 'running', 4, CURRENT_TIMESTAMP);
        "#).unwrap();

        mark_retrying(&connection, "retry-job", "temporarily unavailable").unwrap();
        mark_failed(&connection, "failed-job", "invalid output").unwrap();

        let retry: (String, i64, i64) = connection.query_row(
            "select status, attempt_count, next_run_at is not null from finding_candidate_queue where id='retry-job'",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).unwrap();
        let failed: (String, i64) = connection
            .query_row(
                "select status, attempt_count from finding_candidate_queue where id='failed-job'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(retry, ("pending".to_string(), 3, 1));
        assert_eq!(failed, ("failed".to_string(), 5));
    }

    #[test]
    fn normalizes_v1_chat_url() {
        assert_eq!(
            chat_url("http://localhost:5000/v1", "/v1/chat/completions"),
            "http://localhost:5000/v1/chat/completions"
        );
    }

    #[test]
    fn persists_candidates_and_downstream_jobs_before_completing() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
            create table finding_candidate_queue (
              id text primary key, status text, locked_by text, locked_at text, heartbeat_at text,
              next_run_at text, completed_at text, last_error text, last_outcome_kind text,
              metadata text not null default '{}', updated_at text
            );
            create table found_candidates (
              id text primary key, finding_job_id text, candidate_index integer, type text,
              title text, content text, source_summary text, origin text, metadata text,
              created_at text, updated_at text
            );
            create table covering_evidence_queue (
              id text primary key, found_candidate_id text, distillation_version text, status text,
              priority integer, provider_policy text, payload text, metadata text,
              created_at text, updated_at text
            );
            insert into finding_candidate_queue (id, status, metadata, updated_at)
              values ('job-1', 'running', '{}', CURRENT_TIMESTAMP);
        "#,
            )
            .unwrap();
        let job = FindingJob {
            id: "job-1".to_string(),
            input_kind: "source_target".to_string(),
            source_kind: "vibe_memory".to_string(),
            source_key: "memory-1".to_string(),
            source_uri: "vibe-memory://memory-1".to_string(),
            distillation_version: "v1".to_string(),
            priority: 42,
            metadata: json!({}),
        };
        let candidates = vec![Candidate {
            kind: "rule".to_string(),
            polarity: "positive".to_string(),
            title: "Release leases".to_string(),
            content: "Release the provider lease.".to_string(),
        }];

        persist_result(&connection, &job, &candidates).unwrap();
        let updated_candidates = vec![Candidate {
            kind: "rule".to_string(),
            polarity: "negative".to_string(),
            title: "Do not leak leases".to_string(),
            content: "Always release provider leases.".to_string(),
        }];
        persist_result(&connection, &job, &updated_candidates).unwrap();

        let status: String = connection
            .query_row(
                "select status from finding_candidate_queue where id = 'job-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let candidates_count: i64 = connection
            .query_row("select count(*) from found_candidates", [], |row| {
                row.get(0)
            })
            .unwrap();
        let covering_count: i64 = connection
            .query_row(
                "select count(*) from covering_evidence_queue where status = 'pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(candidates_count, 1);
        assert_eq!(covering_count, 1);
        let persisted: (String, String, String) = connection
            .query_row(
                "select title, json_extract(origin, '$.sourceUri'), json_extract(metadata, '$.polarity') from found_candidates limit 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            persisted,
            (
                "Do not leak leases".to_string(),
                "vibe-memory://memory-1".to_string(),
                "negative".to_string()
            )
        );
    }

    #[test]
    fn curl_fallback_keeps_authorization_out_of_arguments_and_reads_status() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 8192];
            let read = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]);
            assert!(request.contains("Authorization: Bearer test-secret"));
            assert!(request.contains("{\"ping\":true}"));
            let body = r#"{"choices":[{"message":{"content":"[]"}}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let (status, body) = request_with_curl(
            &format!("http://{address}/v1/chat/completions"),
            Some("test-secret"),
            "{\"ping\":true}",
            30,
        )
        .unwrap();

        server.join().unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("choices"));
    }
}
