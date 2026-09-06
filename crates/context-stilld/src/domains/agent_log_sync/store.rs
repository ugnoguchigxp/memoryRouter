use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::domains::mcp_lifecycle::project_identity::{
    resolve_compile_project_identity, CompileProjectIdentityInput,
    CompileProjectIdentityMatchBasis, CompileProjectIdentityTrust,
};
use crate::domains::process_lifecycle::service::now_timestamp;
use crate::shared::errors::CliError;

use super::types::{
    AgentLogSource, ChatMessage, IngestCursor, IngestCursorEntry, IngestResult, StoreSourceResult,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);
const DISTILLATION_VERSION: &str = "select-distillation-target-v1";
const NIGHTWORKERS_RUNTIME_CONTRACT_MARKER: &str = "[NightWorkers Runtime Contract]";

#[derive(Debug, Clone, Eq, PartialEq)]
struct NightWorkersRuntimeContractInfo {
    before: String,
    execution_mode: String,
    task_id: Option<String>,
    run_id: Option<String>,
}

pub(crate) fn read_cursor(
    connection: &Connection,
    source_id: &str,
) -> Result<IngestCursor, CliError> {
    let raw: Option<String> = connection
        .query_row(
            "select cursor from sync_states where id = ?",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(parse_cursor(raw.as_deref()))
}

pub(crate) fn store_source_result(
    connection: &mut Connection,
    source: &AgentLogSource,
    result: IngestResult,
    min_distillable_chars: usize,
) -> Result<StoreSourceResult, CliError> {
    if result.skipped {
        return Ok(StoreSourceResult {
            inserted_memories: 0,
            inserted_diffs: 0,
            last_synced_at: None,
        });
    }

    let source_id = source.id.id();
    let mut inserted_memories = 0;
    let tx = connection.transaction().map_err(sql_error)?;
    let grouped = group_messages(source_id, result.messages);
    for (memory_session_id, messages) in grouped {
        let chunks = chunk_messages(&messages, 120, 12_000);
        for (chunk_index, chunk) in chunks.iter().enumerate() {
            let sanitized_chunk = sanitize_nightworkers_runtime_contract_chunk(chunk);
            if sanitized_chunk.is_empty() {
                continue;
            }
            let content = build_readable_transcript(&sanitized_chunk);
            if content.trim().len() <= min_distillable_chars {
                continue;
            }
            if has_targeted_nightworkers_runtime_contract(&content) {
                continue;
            }
            let dedupe_key = format!("{source_id}:{memory_session_id}:{chunk_index}");
            let existing: Option<String> = tx
                .query_row(
                    "select id from vibe_memories where session_id = ? and dedupe_key = ? limit 1",
                    params![memory_session_id, dedupe_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(sql_error)?;
            if existing.is_some() {
                continue;
            }

            let memory_id = next_id("vibe-memory");
            let now = now_timestamp();
            let mut metadata = build_memory_metadata(
                source,
                &sanitized_chunk,
                chunk.len(),
                chunk_index,
                &dedupe_key,
            );
            let project_identity = match resolve_agent_log_project_identity(&metadata) {
                Ok(identity) => identity,
                Err(error) => {
                    record_project_identity_producer_event(
                        &tx,
                        "PROJECT_IDENTITY_PRODUCER_REJECTED",
                        json!({
                            "producer": "agent-log-sync.rust",
                            "entityKind": "vibe_memory",
                            "scope": "repo",
                            "rejectionCode": error.split(':').next().unwrap_or(&error)
                        }),
                    );
                    continue;
                }
            };
            record_project_identity_producer_event(
                &tx,
                "PROJECT_IDENTITY_PRODUCER_PERSISTED",
                json!({
                    "producer": "agent-log-sync.rust",
                    "entityKind": "vibe_memory",
                    "scope": "repo",
                    "matchBasis": project_identity
                        .get("matchBasis")
                        .and_then(Value::as_str),
                    "identityFingerprint": project_identity
                        .get("identityFingerprint")
                        .and_then(Value::as_str),
                    "bindingStatus": project_identity
                        .get("bindingStatus")
                        .and_then(Value::as_str)
                }),
            );
            set_metadata_value(&mut metadata, "projectIdentity", project_identity);
            tx.execute(
                "
                insert into vibe_memories (
                  id, session_id, content, memory_type, dedupe_key, metadata, created_at
                ) values (?, ?, ?, 'chat', ?, ?, ?)
                ",
                params![
                    memory_id,
                    memory_session_id,
                    content,
                    dedupe_key,
                    metadata.to_string(),
                    now
                ],
            )
            .map_err(sql_error)?;
            tx.execute(
                "insert into vibe_memories_fts(id, content) values (?, ?)",
                params![memory_id, content],
            )
            .ok();
            enqueue_episode_distiller(
                &tx,
                &memory_id,
                source_id,
                &memory_session_id,
                chunk_index,
                &dedupe_key,
            )?;
            enqueue_finding_candidate_if_eligible(
                &tx,
                &memory_id,
                source_id,
                &memory_session_id,
                chunk_index,
                &dedupe_key,
                &content,
                &metadata,
                &now,
            )?;
            inserted_memories += 1;
        }
    }

    let synced_at = now_timestamp();
    tx.execute(
        "
        insert into sync_states (id, last_synced_at, cursor, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          last_synced_at = excluded.last_synced_at,
          cursor = excluded.cursor,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
        ",
        params![
            source_id,
            synced_at,
            cursor_to_json(&result.cursor).to_string(),
            json!({
                "checkedFiles": result.checked_files,
                "warnings": result.warnings,
                "skipped": result.skipped,
                "messageCount": grouped_message_count(&result.cursor),
                "maxObservedMtimeMs": result.max_observed_mtime_ms,
                "formatVersion": "rust-1.0"
            })
            .to_string(),
            synced_at,
            synced_at
        ],
    )
    .map_err(sql_error)?;
    tx.commit().map_err(sql_error)?;

    Ok(StoreSourceResult {
        inserted_memories,
        inserted_diffs: 0,
        last_synced_at: Some(synced_at),
    })
}

fn enqueue_episode_distiller(
    tx: &rusqlite::Transaction<'_>,
    memory_id: &str,
    source_id: &str,
    memory_session_id: &str,
    chunk_index: usize,
    dedupe_key: &str,
) -> Result<(), CliError> {
    let id = next_id("episode-job");
    let now = now_timestamp();
    tx.execute(
        "
        insert into episode_distiller_queue (
          id, source_kind, source_key, source_uri, distillation_version,
          payload, metadata, priority, provider_policy, status, created_at, updated_at
        ) values (?, 'vibe_memory', ?, ?, ?, ?, ?, 50, 'default', 'pending', ?, ?)
        on conflict(source_kind, source_key, distillation_version) do nothing
        ",
        params![
            id,
            memory_id,
            format!("vibe_memory:{memory_id}"),
            DISTILLATION_VERSION,
            json!({"sourceType":"agent_log_sync","sourceId":source_id,"memorySessionId":memory_session_id,"chunkIndex":chunk_index,"dedupeKey":dedupe_key}).to_string(),
            json!({"sourceType":"agent_log_sync","sourceId":source_id,"memorySessionId":memory_session_id,"chunkIndex":chunk_index,"dedupeKey":dedupe_key}).to_string(),
            now,
            now
        ],
    )
    .map_err(sql_error)?;
    append_queue_event(
        tx,
        "episodeDistiller",
        &id,
        "episode distiller enqueued from Rust agent log sync",
    )
}

fn append_queue_event(
    tx: &rusqlite::Transaction<'_>,
    queue_name: &str,
    queue_job_id: &str,
    message: &str,
) -> Result<(), CliError> {
    tx.execute(
        "
        insert into distillation_queue_events (id, queue_name, queue_job_id, event_type, message, metadata, created_at)
        values (?, ?, ?, 'enqueued', ?, '{}', ?)
        ",
        params![next_id("queue-event"), queue_name, queue_job_id, message, now_timestamp()],
    )
    .map_err(sql_error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn enqueue_finding_candidate_if_eligible(
    tx: &rusqlite::Transaction<'_>,
    memory_id: &str,
    source_id: &str,
    memory_session_id: &str,
    chunk_index: usize,
    dedupe_key: &str,
    content: &str,
    metadata: &Value,
    memory_created_at: &str,
) -> Result<(), CliError> {
    let Some(eligibility) = evaluate_finding_eligibility(content, metadata) else {
        return Ok(());
    };
    if finding_candidate_already_enqueued(tx, memory_id, dedupe_key)? {
        return Ok(());
    }
    let id = next_id("finding-job");
    let now = now_timestamp();
    let mut finding_metadata = json!({
        "enqueuedBy": "vibe-finding-controlled-enqueue",
        "enqueueReason": "eligible_vibe_memory",
        "sourceId": source_id,
        "sessionId": memory_session_id,
        "chunkIndex": chunk_index,
        "dedupeKey": dedupe_key,
        "eligibilityScore": eligibility.score,
        "eligibilitySignals": eligibility.signals,
        "sourceCreatedAt": memory_created_at,
        "backfill": false
    });
    if let Some(project_identity) = metadata.get("projectIdentity") {
        finding_metadata["projectIdentity"] = project_identity.clone();
    }
    tx.execute(
        "
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          payload, metadata, priority, status, created_at, updated_at
        ) values (?, 'source_target', 'vibe_memory', ?, ?, ?, '{}', ?, 50, 'pending', ?, ?)
        ",
        params![
            id,
            memory_id,
            format!("vibe_memory:{memory_id}"),
            DISTILLATION_VERSION,
            finding_metadata.to_string(),
            now,
            now
        ],
    )
    .map_err(sql_error)?;
    append_queue_event(
        tx,
        "findingCandidate",
        &id,
        "finding candidate enqueued from Rust controlled vibe memory selector",
    )
}

fn finding_candidate_already_enqueued(
    tx: &rusqlite::Transaction<'_>,
    memory_id: &str,
    dedupe_key: &str,
) -> Result<bool, CliError> {
    let existing: Option<String> = tx
        .query_row(
            "
            select id
            from finding_candidate_queue
            where source_kind = 'vibe_memory'
              and distillation_version = ?
              and (
                source_key = ?
                or json_extract(metadata, '$.dedupeKey') = ?
              )
            limit 1
            ",
            params![DISTILLATION_VERSION, memory_id, dedupe_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(existing.is_some())
}

struct FindingEligibility {
    score: i64,
    signals: Vec<&'static str>,
}

fn evaluate_finding_eligibility(content: &str, metadata: &Value) -> Option<FindingEligibility> {
    let normalized = content.to_lowercase();
    let mut score = 0;
    let mut signals = Vec::new();

    if content.trim().chars().count() < 120 {
        score -= 30;
    }
    if contains_any(
        &normalized,
        &[
            "検証",
            "確認",
            "通りました",
            "失敗",
            "原因",
            "修正",
            "完了",
            "問題",
            "エラー",
            "レビュー",
            "復旧",
            "再発",
            "test",
            "build",
            "lint",
            "verify",
            "failed",
            "failure",
            "error",
            "timeout",
            "panic",
            "assertion",
            "review",
            "fixed",
            "root cause",
        ],
    ) {
        score += 40;
        signals.push("verification_or_failure_terms");
    }
    if metadata
        .get("roles")
        .and_then(Value::as_array)
        .is_some_and(|roles| {
            let has_user = roles.iter().any(|role| role.as_str() == Some("user"));
            let has_assistant = roles.iter().any(|role| role.as_str() == Some("assistant"));
            has_user && has_assistant
        })
    {
        score += 20;
        signals.push("mixed_roles");
    }
    if contains_any(
        &normalized,
        &[
            "queue",
            "db",
            "database",
            "sqlite",
            "daemon",
            "provider",
            "runtime",
            "worker",
            "launchagent",
            "process",
            "heartbeat",
            "requeue",
            "retry",
            "finding",
            "candidate",
            "distillation",
        ],
    ) {
        score += 15;
        signals.push("runtime_or_queue_terms");
    }
    if contains_any(
        &normalized,
        &[
            "bun", "npm", "pnpm", "cargo", "sqlite3", "git", "rg", "test", "build", "lint",
            "verify", "curl", "lsof", "ps aux",
        ],
    ) {
        score += 10;
        signals.push("command_terms");
    }
    if contains_any(
        &normalized,
        &[
            "必ず",
            "禁止",
            "避け",
            "しない",
            "してください",
            "方針",
            "境界",
            "優先",
            "好み",
            "prefer",
            "avoid",
            "must",
            "never",
            "do not",
            "should",
        ],
    ) {
        score += 20;
        signals.push("preference_terms");
    }
    let boilerplate = boilerplate_heavy(content);
    if boilerplate {
        score -= 40;
    }
    let progress_only = progress_only(content);
    if progress_only {
        score -= 40;
    }
    if boilerplate || progress_only || signals.is_empty() || score < 50 {
        return None;
    }
    Some(FindingEligibility { score, signals })
}

fn contains_any(value: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| value.contains(term))
}

fn boilerplate_heavy(content: &str) -> bool {
    let lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return true;
    }
    let boilerplate = lines
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            lower.contains("agents.md instructions")
                || lower.contains("<instructions>")
                || lower.contains("<environment_context>")
                || lower.contains("<filesystem>")
                || lower.contains("initial_instructions")
                || lower.contains("workspace_roots")
        })
        .count();
    boilerplate * 10 >= lines.len() * 6
}

fn progress_only(content: &str) -> bool {
    let blocks = content
        .split("\n\n")
        .map(|block| block.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|block| block.trim().to_string())
        .filter(|block| !block.is_empty())
        .collect::<Vec<_>>();
    if blocks.is_empty() {
        return true;
    }
    blocks.iter().all(|block| {
        let normalized = block.strip_prefix("ASSISTANT: ").unwrap_or(block).trim();
        matches!(
            normalized,
            "確認します。"
                | "確認します"
                | "調べます。"
                | "調べます"
                | "読みます。"
                | "読みます"
                | "実行します。"
                | "実行します"
                | "進めます。"
                | "進めます"
                | "次に"
                | "最後に"
                | "了解しました。"
                | "了解しました"
        )
    })
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::super::types::AgentLogSourceId;
    use super::*;

    fn nightworkers_runtime_contract_prompt(prefix: &str, execution_mode: &str) -> String {
        [
            prefix,
            "",
            NIGHTWORKERS_RUNTIME_CONTRACT_MARKER,
            "taskId: task-impl-1",
            "runId: run-impl-1",
            "repoRoot: /Users/y.noguchi/Code/example",
            &format!("executionMode: {execution_mode}"),
            "NightWorkers MCP:",
            "- MCP server name: nightworkers",
            "Minimal implementation behavior:",
            "- Use nightworkers.todo_list as the single Todo control tool.",
        ]
        .join("\n")
    }

    #[test]
    fn agent_log_sync_rejects_progress_only_finding_eligibility() {
        let content = "ASSISTANT: 確認します。\n\nASSISTANT: 進めます。";
        let metadata = json!({"roles":["assistant"]});

        assert!(evaluate_finding_eligibility(content, &metadata).is_none());
    }

    #[test]
    fn sanitizes_nightworkers_implementation_runtime_contract_message() {
        let message = ChatMessage {
            role: "user",
            content: nightworkers_runtime_contract_prompt("実装依頼を残します。", "implementation"),
            metadata: json!({"sourceId":"codex_logs","sessionId":"nightworkers-session"}),
        };

        let sanitized = sanitize_nightworkers_runtime_contract_message(&message).unwrap();

        assert_eq!(sanitized.content, "実装依頼を残します。");
        assert!(!sanitized
            .content
            .contains(NIGHTWORKERS_RUNTIME_CONTRACT_MARKER));
        assert_eq!(
            metadata_string(
                &sanitized.metadata,
                "nightWorkersRuntimeContractExecutionMode"
            )
            .as_deref(),
            Some("implementation")
        );
        assert_eq!(
            metadata_string(&sanitized.metadata, "nightWorkersTaskId").as_deref(),
            Some("task-impl-1")
        );
        assert_eq!(
            metadata_string(&sanitized.metadata, "nightWorkersRunId").as_deref(),
            Some("run-impl-1")
        );
    }

    #[test]
    fn keeps_non_implementation_runtime_contract_message_unchanged() {
        let message = ChatMessage {
            role: "user",
            content: nightworkers_runtime_contract_prompt("計画だけ確認します。", "planning"),
            metadata: json!({"sourceId":"codex_logs","sessionId":"nightworkers-session"}),
        };

        let sanitized = sanitize_nightworkers_runtime_contract_message(&message).unwrap();

        assert_eq!(sanitized.content, message.content);
        assert!(sanitized
            .content
            .contains(NIGHTWORKERS_RUNTIME_CONTRACT_MARKER));
    }

    #[test]
    fn sanitizes_runtime_contract_fields_with_label_spacing() {
        let message = ChatMessage {
            role: "user",
            content: nightworkers_runtime_contract_prompt(
                "空白つき field の実装依頼です。",
                "implementation",
            )
            .replace("taskId:", " taskId :")
            .replace("runId:", " runId :")
            .replace("executionMode:", " executionMode :"),
            metadata: json!({"sourceId":"codex_logs","sessionId":"nightworkers-session"}),
        };

        let sanitized = sanitize_nightworkers_runtime_contract_message(&message).unwrap();

        assert_eq!(sanitized.content, "空白つき field の実装依頼です。");
        assert_eq!(
            metadata_string(
                &sanitized.metadata,
                "nightWorkersRuntimeContractExecutionMode"
            )
            .as_deref(),
            Some("implementation")
        );
        assert_eq!(
            metadata_string(&sanitized.metadata, "nightWorkersTaskId").as_deref(),
            Some("task-impl-1")
        );
        assert_eq!(
            metadata_string(&sanitized.metadata, "nightWorkersRunId").as_deref(),
            Some("run-impl-1")
        );
    }

    #[test]
    fn drops_runtime_contract_only_implementation_message() {
        let message = ChatMessage {
            role: "user",
            content: nightworkers_runtime_contract_prompt("", "implementation")
                .trim()
                .to_string(),
            metadata: json!({"sourceId":"codex_logs","sessionId":"nightworkers-session"}),
        };

        assert!(sanitize_nightworkers_runtime_contract_message(&message).is_none());
    }

    #[test]
    fn build_memory_metadata_preserves_raw_message_count_after_sanitizing() {
        let raw_chunk = vec![
            ChatMessage {
                role: "user",
                content: nightworkers_runtime_contract_prompt("実装依頼です。", "implementation"),
                metadata: json!({
                    "sourceId":"codex_logs",
                    "sessionId":"nightworkers-session",
                    "projectName":"nightWorkers"
                }),
            },
            ChatMessage {
                role: "assistant",
                content: "修正して検証しました。".to_string(),
                metadata: json!({
                    "sourceId":"codex_logs",
                    "sessionId":"nightworkers-session",
                    "projectName":"nightWorkers"
                }),
            },
        ];
        let sanitized = sanitize_nightworkers_runtime_contract_chunk(&raw_chunk);
        let source = AgentLogSource {
            id: AgentLogSourceId::Codex,
            roots: Vec::new(),
            initial_lookback_hours: 0,
        };
        let metadata = build_memory_metadata(&source, &sanitized, raw_chunk.len(), 0, "dedupe-1");

        assert_eq!(
            metadata.get("rawMessageCount").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            metadata.get("messageCount").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            metadata
                .get("nightWorkersRuntimeContractStripped")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            metadata
                .get("nightWorkersRuntimeContractStrippedCount")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            metadata
                .get("nightWorkersRuntimeContractExecutionMode")
                .and_then(Value::as_str),
            Some("implementation")
        );
    }

    #[test]
    fn agent_log_sync_rejects_boilerplate_heavy_finding_eligibility() {
        let content = [
            "USER: # AGENTS.md instructions for /repo",
            "<INSTRUCTIONS>",
            "このプロジェクトでの作業を開始する際、initial_instructions を確認してください。",
            "</INSTRUCTIONS>",
            "<environment_context><cwd>/repo</cwd></environment_context>",
            "<filesystem><workspace_roots><root>/repo</root></workspace_roots></filesystem>",
        ]
        .join("\n");
        let metadata = json!({"roles":["user"]});

        assert!(evaluate_finding_eligibility(&content, &metadata).is_none());
    }
}

fn group_messages(
    source_id: &str,
    messages: Vec<ChatMessage>,
) -> BTreeMap<String, Vec<ChatMessage>> {
    let mut grouped = BTreeMap::new();
    for message in messages {
        let session = metadata_string(&message.metadata, "sessionId")
            .unwrap_or_else(|| "default".to_string());
        let project = metadata_string(&message.metadata, "projectName")
            .or_else(|| metadata_string(&message.metadata, "projectRoot"))
            .unwrap_or_else(|| "default".to_string());
        grouped
            .entry(format!("{source_id}:{project}:{session}"))
            .or_insert_with(Vec::new)
            .push(message);
    }
    grouped
}

fn chunk_messages(
    messages: &[ChatMessage],
    max_messages: usize,
    max_chars: usize,
) -> Vec<Vec<ChatMessage>> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0;
    for message in messages {
        if !current.is_empty()
            && (current.len() >= max_messages || current_chars + message.content.len() > max_chars)
        {
            chunks.push(current);
            current = Vec::new();
            current_chars = 0;
        }
        current.push(message.clone());
        current_chars += message.content.len();
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn build_readable_transcript(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .filter(|message| {
            metadata_string(&message.metadata, "messageKind").as_deref() != Some("tool_call")
        })
        .map(|message| format!("{}: {}", message.role.to_uppercase(), message.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn extract_runtime_contract_field(contract: &str, field: &str) -> Option<String> {
    contract.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim() == field {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        None
    })
}

fn nightworkers_runtime_contract_info(content: &str) -> Option<NightWorkersRuntimeContractInfo> {
    let marker_index = content.find(NIGHTWORKERS_RUNTIME_CONTRACT_MARKER)?;
    let before = content[..marker_index].trim().to_string();
    let contract = &content[marker_index..];
    let execution_mode = extract_runtime_contract_field(contract, "executionMode")?;
    if execution_mode != "implementation" {
        return None;
    }
    Some(NightWorkersRuntimeContractInfo {
        before,
        execution_mode,
        task_id: extract_runtime_contract_field(contract, "taskId"),
        run_id: extract_runtime_contract_field(contract, "runId"),
    })
}

fn has_targeted_nightworkers_runtime_contract(content: &str) -> bool {
    nightworkers_runtime_contract_info(content).is_some()
}

fn set_metadata_value(metadata: &mut Value, key: &str, value: Value) {
    if !metadata.is_object() {
        *metadata = json!({});
    }
    if let Some(object) = metadata.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

fn sanitize_nightworkers_runtime_contract_message(message: &ChatMessage) -> Option<ChatMessage> {
    if metadata_string(&message.metadata, "sourceId").as_deref() != Some("codex_logs") {
        return Some(message.clone());
    }
    let Some(contract_info) = nightworkers_runtime_contract_info(&message.content) else {
        return Some(message.clone());
    };
    if contract_info.before.is_empty() {
        return None;
    }

    let mut sanitized = message.clone();
    sanitized.content = contract_info.before;
    set_metadata_value(
        &mut sanitized.metadata,
        "nightWorkersRuntimeContractStripped",
        json!(true),
    );
    set_metadata_value(
        &mut sanitized.metadata,
        "nightWorkersRuntimeContractExecutionMode",
        json!(contract_info.execution_mode),
    );
    if let Some(task_id) = contract_info.task_id {
        set_metadata_value(
            &mut sanitized.metadata,
            "nightWorkersTaskId",
            json!(task_id),
        );
    }
    if let Some(run_id) = contract_info.run_id {
        set_metadata_value(&mut sanitized.metadata, "nightWorkersRunId", json!(run_id));
    }
    Some(sanitized)
}

fn sanitize_nightworkers_runtime_contract_chunk(chunk: &[ChatMessage]) -> Vec<ChatMessage> {
    chunk
        .iter()
        .filter_map(sanitize_nightworkers_runtime_contract_message)
        .collect()
}

fn build_memory_metadata(
    source: &AgentLogSource,
    messages: &[ChatMessage],
    raw_message_count: usize,
    chunk_index: usize,
    dedupe_key: &str,
) -> Value {
    let project_name = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "projectName"));
    let project_root = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "projectRoot"));
    let cwd = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "cwd"));
    let stripped_count = messages
        .iter()
        .filter(|message| {
            message
                .metadata
                .get("nightWorkersRuntimeContractStripped")
                .and_then(Value::as_bool)
                == Some(true)
        })
        .count();
    let execution_mode = messages.iter().find_map(|message| {
        metadata_string(
            &message.metadata,
            "nightWorkersRuntimeContractExecutionMode",
        )
    });
    let task_id = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "nightWorkersTaskId"));
    let run_id = messages
        .iter()
        .find_map(|message| metadata_string(&message.metadata, "nightWorkersRunId"));
    let mut metadata = json!({
        "source": source.id.label(),
        "sourceId": source.id.id(),
        "sources": [source.id.label()],
        "projectName": project_name,
        "projectRoot": project_root,
        "cwd": cwd,
        "chunkIndex": chunk_index,
        "dedupeKey": dedupe_key,
        "rawMessageCount": raw_message_count,
        "messageCount": messages.len(),
        "roles": messages.iter().map(|message| message.role).collect::<Vec<_>>(),
        "kind": "agent_log_chunk",
        "memoryPipeline": "raw_for_distillation",
        "rustAgentLogSync": true
    });
    if stripped_count > 0 {
        set_metadata_value(
            &mut metadata,
            "nightWorkersRuntimeContractStripped",
            json!(true),
        );
        set_metadata_value(
            &mut metadata,
            "nightWorkersRuntimeContractStrippedCount",
            json!(stripped_count),
        );
        if let Some(execution_mode) = execution_mode {
            set_metadata_value(
                &mut metadata,
                "nightWorkersRuntimeContractExecutionMode",
                json!(execution_mode),
            );
        }
        if let Some(task_id) = task_id {
            set_metadata_value(&mut metadata, "nightWorkersTaskId", json!(task_id));
        }
        if let Some(run_id) = run_id {
            set_metadata_value(&mut metadata, "nightWorkersRunId", json!(run_id));
        }
    }
    metadata
}

fn resolve_agent_log_project_identity(metadata: &Value) -> Result<Value, String> {
    let repo_path = metadata_string(metadata, "projectRoot");
    let resolved = resolve_compile_project_identity(
        &CompileProjectIdentityInput {
            project_ref: None,
            repo_key: None,
            repo_path,
        },
        CompileProjectIdentityTrust::TrustedAdapter,
        None,
    )
    .map_err(|error| error.to_string())?;
    if resolved.match_basis == CompileProjectIdentityMatchBasis::None {
        return Err("PROJECT_IDENTITY_REQUIRED: agent log VibeMemory writes require captured project identity".to_string());
    }
    let mut snapshot = serde_json::to_value(&resolved)
        .map_err(|error| format!("failed to serialize project identity: {error}"))?;
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("classificationStatus".to_string(), json!("classified"));
        object.insert("scope".to_string(), json!("repo"));
    }
    Ok(snapshot)
}

fn record_project_identity_producer_event(
    connection: &rusqlite::Transaction<'_>,
    event_type: &str,
    payload: Value,
) {
    let _ = connection.execute(
        "insert into audit_logs (id, event_type, actor, payload, created_at) values (?1, ?2, 'system', ?3, ?4)",
        params![next_id("audit"), event_type, payload.to_string(), now_timestamp()],
    );
}

#[cfg(test)]
pub(crate) fn ensure_test_schema(connection: &Connection) -> Result<(), CliError> {
    connection
        .execute_batch(include_str!("schema_agent_log_sync.sql"))
        .map_err(sql_error)
}

fn parse_cursor(raw: Option<&str>) -> IngestCursor {
    let Some(raw) = raw else {
        return IngestCursor::new();
    };
    let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(raw) else {
        return IngestCursor::new();
    };
    entries
        .into_iter()
        .filter_map(|(path, value)| {
            let offset = value.get("offset").and_then(Value::as_u64)?;
            let mtime_ms = value.get("mtimeMs").and_then(Value::as_u64).unwrap_or(0);
            Some((path, IngestCursorEntry { offset, mtime_ms }))
        })
        .collect()
}

fn cursor_to_json(cursor: &IngestCursor) -> Value {
    Value::Object(
        cursor
            .iter()
            .map(|(path, entry)| {
                (
                    path.clone(),
                    json!({"offset": entry.offset, "mtimeMs": entry.mtime_ms}),
                )
            })
            .collect(),
    )
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn grouped_message_count(cursor: &IngestCursor) -> usize {
    cursor.len()
}

fn next_id(prefix: &str) -> String {
    format!(
        "rust-{prefix}-{}-{}",
        now_timestamp(),
        NEXT_ID.fetch_add(1, Ordering::SeqCst)
    )
}

fn sql_error(error: rusqlite::Error) -> CliError {
    CliError::runtime(format!("sqlite agent-log-sync failed: {error}"))
}
