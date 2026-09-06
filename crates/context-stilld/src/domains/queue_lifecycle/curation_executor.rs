use super::curation_repository::{self as repository, QUEUE, VERSION};
use super::episode_executor::LocalLlmTargetConfig;
use super::finalize_executor::{embed_one, refresh_fts, upsert_embedding, FinalizeEmbeddingConfig};
use super::provider_execution::{
    open_query_only_connection, owns_provider_execution, ProviderExecutionHeartbeatGuard,
};
use super::provider_lease::release_provider_lease_for_connection;
use super::types::ClaimedProviderLeaseJob;
use crate::domains::sqlite_writer;
use crate::shared::agent_session::{
    is_agent_session_api_path, run_agent_session_chat, AgentSessionRequest,
};
use crate::shared::errors::CliError;
use reqwest::blocking::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const PLANNER_SYSTEM_CONTEXT: &str =
    include_str!("../../../../../shared/prompts/landscape-curation-v2.txt");
const VERIFIER_SYSTEM_CONTEXT_ARTIFACT: &str =
    include_str!("../../../../../shared/prompts/landscape-curation-verify-v2.txt");

const SYSTEM_CONTEXT_CATALOG: &str = include_str!("../../../../../.s11tnext/catalog.json");

fn managed_context(key: &str) -> Result<String, String> {
    let artifact: Value = serde_json::from_str(SYSTEM_CONTEXT_CATALOG)
        .map_err(|error| format!("invalid SystemContext catalog: {error}"))?;
    let sections = artifact
        .pointer(&format!("/contexts/{key}/locales/en-US/sections"))
        .and_then(Value::as_array)
        .ok_or_else(|| format!("managed SystemContext missing {key}"))?;
    let text = sections
        .iter()
        .flat_map(|section| section["segments"].as_array().into_iter().flatten())
        .filter_map(|segment| segment["value"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err(format!("managed SystemContext empty {key}"));
    }
    Ok(text)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Decision {
    pub(super) schema_version: u8,
    pub(super) action: String,
    pub(super) survivor_knowledge_id: Option<String>,
    pub(super) deprecated_knowledge_ids: Vec<String>,
    pub(super) retained_group_ids: Vec<String>,
    pub(super) coverage: Vec<Coverage>,
    pub(super) reason_codes: Vec<String>,
    pub(super) rationale: String,
    #[serde(skip)]
    pub(super) verification: Option<Verification>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Coverage {
    pub(super) source_group_id: String,
    pub(super) disposition: String,
    pub(super) target_group_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verification {
    pub(super) schema_version: u8,
    pub(super) verdict: String,
    pub(super) input_hash: String,
    pub(super) findings: Vec<VerificationFinding>,
    pub(super) no_new_meaning: String,
    pub(super) no_unresolved_contradiction: String,
    pub(super) rationale: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerificationFinding {
    pub(super) source_group_id: String,
    pub(super) target_group_ids: Vec<String>,
    pub(super) checks: Value,
}

fn parse_decision(content: &str, snapshot: &Value) -> Result<Decision, String> {
    let cleaned = content
        .lines()
        .filter(|s| !s.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    let result: Decision =
        serde_json::from_str(cleaned.trim()).map_err(|e| format!("invalid curation JSON: {e}"))?;
    if result.schema_version != 2
        || ![
            "merge",
            "deprecate_duplicate",
            "keep_separate",
            "needs_evidence",
        ]
        .contains(&result.action.as_str())
        || result.rationale.trim().is_empty()
        || result.rationale.chars().count() > 1200
        || result.reason_codes.is_empty()
        || result.reason_codes.len() > 8
    {
        return Err("invalid curation decision or rationale".into());
    }
    let subject_id = snapshot["subject"]["id"]
        .as_str()
        .ok_or("subject id missing")?;
    let mut ids = vec![subject_id];
    ids.extend(
        snapshot["candidates"]
            .as_array()
            .ok_or("missing candidates")?
            .iter()
            .filter_map(|v| v["id"].as_str()),
    );
    let mutation = ["merge", "deprecate_duplicate"].contains(&result.action.as_str());
    if !mutation {
        if result.survivor_knowledge_id.is_some()
            || !result.deprecated_knowledge_ids.is_empty()
            || !result.retained_group_ids.is_empty()
            || !result.coverage.is_empty()
        {
            return Err("non-mutation must not include a mutation plan".into());
        }
        return Ok(result);
    }
    let survivor = result
        .survivor_knowledge_id
        .as_deref()
        .ok_or("mutation survivor missing")?;
    if !ids.contains(&survivor)
        || result.deprecated_knowledge_ids.len() != 1
        || !ids.contains(&result.deprecated_knowledge_ids[0].as_str())
        || result.deprecated_knowledge_ids[0] == survivor
    {
        return Err("invalid mutation knowledge references".into());
    }
    if survivor != subject_id && result.deprecated_knowledge_ids[0] != subject_id {
        return Err("curation mutation must include the claimed subject".into());
    }
    let other_id = if survivor == subject_id {
        result.deprecated_knowledge_ids[0].as_str()
    } else {
        survivor
    };
    let mut group_ids = Vec::new();
    for knowledge in [
        &snapshot["subject"],
        knowledge(snapshot, other_id).ok_or("mutation counterpart missing")?,
    ] {
        group_ids.extend(
            knowledge["sourceGroups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| value["id"].as_str()),
        );
    }
    if result.retained_group_ids.is_empty()
        || result
            .retained_group_ids
            .iter()
            .any(|id| !group_ids.contains(&id.as_str()))
        || result
            .retained_group_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != result.retained_group_ids.len()
    {
        return Err("invalid retained group references".into());
    }
    if result.coverage.len() != group_ids.len()
        || result.coverage.iter().any(|row| {
            !group_ids.contains(&row.source_group_id.as_str())
                || !["retained", "entailed"].contains(&row.disposition.as_str())
                || row.target_group_ids.is_empty()
                || row
                    .target_group_ids
                    .iter()
                    .any(|id| !result.retained_group_ids.contains(id))
        })
        || result
            .coverage
            .iter()
            .map(|row| &row.source_group_id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != group_ids.len()
    {
        return Err("incomplete or invalid source group coverage".into());
    }
    if result.action == "deprecate_duplicate"
        && result
            .retained_group_ids
            .iter()
            .any(|id| !id.starts_with(&format!("{survivor}:")))
    {
        return Err("duplicate deprecation must retain only survivor groups".into());
    }
    Ok(result)
}

fn request_decision(
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout: u64,
    snapshot: &Value,
) -> Result<Decision, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout.max(30)))
        .build()
        .map_err(|e| e.to_string())?;
    let messages = json!([
        {"role":"system","content":format!("{}\n\n{}", managed_context("landscape.curationPlan")?, PLANNER_SYSTEM_CONTEXT)},
        {"role":"user","content":snapshot.to_string()}
    ]);
    let content = if is_agent_session_api_path(&target.api_path) {
        run_agent_session_chat(
            &client,
            AgentSessionRequest {
                api_base_url: &target.api_base_url,
                api_path: &target.api_path,
                api_key,
                model: &target.model,
                messages: &messages,
                max_tokens: 12000,
                json_response: true,
            },
        )?
    } else {
        let base = target.api_base_url.trim_end_matches('/');
        let path = if target.api_path.trim().is_empty() {
            "/v1/chat/completions".to_string()
        } else {
            format!("/{}", target.api_path.trim_start_matches('/'))
        };
        let url = if base.ends_with("/v1") && path.starts_with("/v1/") {
            format!("{base}{}", &path[3..])
        } else {
            format!("{base}{path}")
        };
        let mut request = client.post(url).json(&json!({"model":target.model,"messages":messages,"max_tokens":12000,"temperature":0,"stream":false}));
        if let Some(key) = api_key.filter(|s| !s.is_empty()) {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .map_err(|_| "curation provider request failed".to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("curation provider HTTP {status}"));
        }
        let payload: Value = response
            .json()
            .map_err(|_| "invalid curation provider response".to_string())?;
        payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or("missing curation response content")?
            .to_string()
    };
    parse_decision(&content, snapshot)
}

fn request_verification(
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout: u64,
    snapshot: &Value,
    decision: &Decision,
) -> Result<Verification, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout.max(30)))
        .build()
        .map_err(|e| e.to_string())?;
    let input_hash = repository::hash(&repository::canonical_json(snapshot));
    let input = json!({"inputHash":input_hash,"snapshot":snapshot,"proposal":decision});
    let messages = json!([{"role":"system","content":format!("{}\n\n{}", managed_context("landscape.curationVerify")?, VERIFIER_SYSTEM_CONTEXT_ARTIFACT)},{"role":"user","content":input.to_string()}]);
    let content = if is_agent_session_api_path(&target.api_path) {
        run_agent_session_chat(
            &client,
            AgentSessionRequest {
                api_base_url: &target.api_base_url,
                api_path: &target.api_path,
                api_key,
                model: &target.model,
                messages: &messages,
                max_tokens: 12000,
                json_response: true,
            },
        )?
    } else {
        let base = target.api_base_url.trim_end_matches('/');
        let path = if target.api_path.trim().is_empty() {
            "/v1/chat/completions".to_string()
        } else {
            format!("/{}", target.api_path.trim_start_matches('/'))
        };
        let url = if base.ends_with("/v1") && path.starts_with("/v1/") {
            format!("{base}{}", &path[3..])
        } else {
            format!("{base}{path}")
        };
        let mut request = client.post(url).json(&json!({"model":target.model,"messages":messages,"max_tokens":12000,"temperature":0,"stream":false}));
        if let Some(key) = api_key.filter(|s| !s.is_empty()) {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .map_err(|_| "curation verifier provider request failed".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "curation verifier provider HTTP {}",
                response.status()
            ));
        }
        let payload: Value = response
            .json()
            .map_err(|_| "invalid curation verifier provider response".to_string())?;
        payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or("missing curation verifier response content")?
            .to_string()
    };
    let cleaned = content
        .lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    let result: Verification = serde_json::from_str(cleaned.trim())
        .map_err(|e| format!("invalid curation verification JSON: {e}"))?;
    if result.schema_version != 2
        || !["supported", "rejected", "unknown"].contains(&result.verdict.as_str())
        || result.input_hash != input_hash
        || result.rationale.trim().is_empty()
        || result.rationale.chars().count() > 1200
        || result.findings.len() > 256
        || ![
            result.no_new_meaning.as_str(),
            result.no_unresolved_contradiction.as_str(),
        ]
        .iter()
        .all(|v| ["preserved", "not_preserved", "unknown"].contains(v))
    {
        return Err("invalid curation verification contract".into());
    }
    Ok(result)
}

pub(super) fn run_for_path(
    path: &Path,
    job: ClaimedProviderLeaseJob,
    target: LocalLlmTargetConfig,
    key: Option<&str>,
    timeout: u64,
    embedding_config: FinalizeEmbeddingConfig,
) -> Result<bool, CliError> {
    let _heartbeat = ProviderExecutionHeartbeatGuard::start(path, &job.provider_lease)?;
    let reader = open_query_only_connection(path)?;
    let snapshot = repository::capture(&reader, &job.id).map_err(CliError::io)?;
    let snapshot_copy = snapshot.clone();
    let job_copy = job.clone();
    let model = target.model.clone();
    sqlite_writer::execute_for_path(path,"queue.curation_snapshot",move |connection| {
        if !owns_provider_execution(connection,&job_copy.provider_lease).map_err(|e|e.to_string())? { return Err("curation claim lost".into()); }
        connection.execute("update landscape_curation_queue set phase='llm_review', input_snapshot=?2, candidate_knowledge_ids=?3, evidence_hash=?4, provider='local-llm', model=?5 where id=?1",
            params![job_copy.id,snapshot_copy.to_string(),json!(snapshot_copy["candidates"].as_array().unwrap().iter().map(|v|v["id"].clone()).collect::<Vec<_>>()).to_string(),snapshot_copy["finding"]["evidenceHash"].as_str(),model]).map_err(|e|e.to_string())?;
        Ok(())
    }).map_err(CliError::io)?;
    let result = if snapshot["subject"]["status"] != "active" {
        Ok(Decision {
            schema_version: 2,
            action: "needs_evidence".into(),
            survivor_knowledge_id: None,
            deprecated_knowledge_ids: vec![],
            retained_group_ids: vec![],
            coverage: vec![],
            reason_codes: vec!["SUBJECT_NOT_ACTIVE".into()],
            rationale: "Subject is no longer active.".into(),
            verification: None,
        })
    } else {
        request_decision(&target, key, timeout, &snapshot)
    };
    // Both model calls and embedding generation happen outside the SQLite writer. The writer only
    // receives a fully validated proposal and precomputed embedding.
    let result = result.and_then(|mut decision| {
        if ["merge", "deprecate_duplicate"].contains(&decision.action.as_str()) {
            decision.verification = Some(request_verification(
                &target, key, timeout, &snapshot, &decision,
            )?);
        }
        let embedding = if eligible(&snapshot, &decision).is_ok() && decision.action == "merge" {
            let survivor = knowledge(
                &snapshot,
                decision
                    .survivor_knowledge_id
                    .as_deref()
                    .ok_or("survivor missing")?,
            )
            .ok_or("survivor missing")?;
            let body = rendered_body(&snapshot, &decision)?;
            if survivor["body"].as_str() != Some(body.as_str()) {
                Some(
                    embed_one(
                        &embedding_config,
                        &format!("{}\n{body}", survivor["title"].as_str().unwrap_or_default()),
                    )
                    .map_err(|e| e.to_string())?,
                )
            } else {
                None
            }
        } else {
            None
        };
        Ok((decision, embedding))
    });
    sqlite_writer::execute_for_path(path, "queue.curation_persist", move |connection| {
        persist(connection, &job, &snapshot, result)
    })
    .map_err(CliError::io)
}

pub(super) fn fail_for_path(
    path: &Path,
    job: ClaimedProviderLeaseJob,
    reason: String,
) -> Result<(), CliError> {
    sqlite_writer::execute_for_path(path, "queue.curation_failure", move |connection| {
        persist(connection, &job, &json!({}), Err(reason)).map(|_| ())
    })
    .map_err(CliError::io)
}

fn knowledge<'a>(snapshot: &'a Value, id: &str) -> Option<&'a Value> {
    if snapshot["subject"]["id"].as_str() == Some(id) {
        return Some(&snapshot["subject"]);
    }
    snapshot["candidates"]
        .as_array()?
        .iter()
        .find(|value| value["id"].as_str() == Some(id))
}

fn source_group<'a>(snapshot: &'a Value, id: &str) -> Option<&'a Value> {
    std::iter::once(&snapshot["subject"])
        .chain(snapshot["candidates"].as_array().into_iter().flatten())
        .flat_map(|knowledge| knowledge["sourceGroups"].as_array().into_iter().flatten())
        .find(|group| group["id"].as_str() == Some(id))
}

fn rendered_body(snapshot: &Value, result: &Decision) -> Result<String, String> {
    let body = retained_source_groups(snapshot, result)?
        .iter()
        .filter_map(|group| group["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if body.trim().is_empty() {
        return Err("rendered body is empty".into());
    }
    Ok(body)
}

fn retained_source_groups(snapshot: &Value, result: &Decision) -> Result<Vec<Value>, String> {
    result
        .retained_group_ids
        .iter()
        .enumerate()
        .map(|(order, id)| {
            let group =
                source_group(snapshot, id).ok_or_else(|| format!("missing retained group {id}"))?;
            let text = group["text"]
                .as_str()
                .ok_or_else(|| format!("retained group text missing {id}"))?;
            Ok(json!({
                "id": id,
                "text": text,
                "hash": repository::hash(text),
                "order": order,
            }))
        })
        .collect()
}

fn eligible(snapshot: &Value, result: &Decision) -> Result<(), String> {
    if !["merge", "deprecate_duplicate"].contains(&result.action.as_str()) {
        return Err("record_only".into());
    }
    let subject = &snapshot["subject"];
    let survivor_id = result
        .survivor_knowledge_id
        .as_deref()
        .ok_or("CANDIDATE_REFERENCE_INVALID")?;
    let survivor = knowledge(snapshot, survivor_id).ok_or("CANDIDATE_REFERENCE_INVALID")?;
    let deprecated_id = result
        .deprecated_knowledge_ids
        .first()
        .ok_or("CANDIDATE_REFERENCE_INVALID")?;
    let deprecated = knowledge(snapshot, deprecated_id).ok_or("CANDIDATE_REFERENCE_INVALID")?;
    if subject["status"] != "active"
        || survivor["status"] != "active"
        || deprecated["status"] != "active"
    {
        return Err("CANDIDATE_NOT_ACTIVE".into());
    }
    if subject["type"] != survivor["type"]
        || subject["polarity"] != survivor["polarity"]
        || subject["type"] != deprecated["type"]
        || subject["polarity"] != deprecated["polarity"]
    {
        return Err("TYPE_MISMATCH".into());
    }
    if !repository::same_repository(subject, survivor)
        || !repository::same_repository(subject, deprecated)
    {
        return Err("REPOSITORY_IDENTITY_MISMATCH".into());
    }
    if !repository::same_applicability(&subject["appliesTo"], &survivor["appliesTo"])
        || !repository::same_applicability(&subject["appliesTo"], &deprecated["appliesTo"])
    {
        return Err("SCOPE_OVERLAP_BELOW_THRESHOLD".into());
    }
    let input_hash = repository::hash(&repository::canonical_json(snapshot));
    let verification = result.verification.as_ref().ok_or("VERIFICATION_MISSING")?;
    if verification.verdict != "supported"
        || verification.input_hash != input_hash
        || verification.no_new_meaning != "preserved"
        || verification.no_unresolved_contradiction != "preserved"
    {
        return Err("VERIFICATION_REJECTED".into());
    }
    let all_checks = [
        "obligations",
        "conditions",
        "negation",
        "exceptions",
        "numbersAndUnits",
        "identifiers",
        "ordering",
        "provenance",
    ];
    if verification.findings.len() != result.coverage.len()
        || verification.findings.iter().any(|finding| {
            !result.coverage.iter().any(|coverage| {
                coverage.source_group_id == finding.source_group_id
                    && coverage.target_group_ids == finding.target_group_ids
            }) || all_checks
                .iter()
                .any(|key| finding.checks[*key].as_str() != Some("preserved"))
        })
    {
        return Err("VERIFICATION_INCOMPLETE".into());
    }
    if result.action == "merge" {
        rendered_body(snapshot, result)?;
    }
    Ok(())
}

pub(super) fn persist(
    connection: &mut Connection,
    job: &ClaimedProviderLeaseJob,
    snapshot: &Value,
    result: Result<(Decision, Option<Vec<f64>>), String>,
) -> Result<bool, String> {
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    if !owns_provider_execution(&tx, &job.provider_lease).map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let (decision, embedding) = match result {
        Ok(value) => value,
        Err(error) => {
            tx.execute("update landscape_curation_queue set status=case when attempt_count+1>=max_attempts then 'failed' else 'paused' end, attempt_count=attempt_count+1, next_run_at=case when attempt_count+1>=max_attempts then null else datetime('now','+5 minutes') end, completed_at=case when attempt_count+1>=max_attempts then CURRENT_TIMESTAMP else null end, locked_by=null,locked_at=null,heartbeat_at=null,last_error=?2,last_outcome_kind='curation_failed',updated_at=CURRENT_TIMESTAMP where id=?1",params![job.id,error.chars().take(1000).collect::<String>()]).map_err(|e|e.to_string())?;
            release_provider_lease_for_connection(&tx, &job.provider_lease.id, "worker_failed")
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(false);
        }
    };
    let gate = eligible(snapshot, &decision);
    let mutation = gate.is_ok();
    let mut outcome = decision.action.clone();
    let mut disposition = if mutation {
        "auto_execute"
    } else if ["merge", "deprecate_duplicate"].contains(&decision.action.as_str()) {
        "blocked"
    } else if decision.action == "needs_evidence" {
        "await_evidence"
    } else {
        "record_only"
    };
    let mut reason = gate
        .err()
        .unwrap_or_else(|| "AUTONOMOUS_SAFE_MUTATION".into());
    let mut applied = false;
    if mutation {
        let survivor_id = decision
            .survivor_knowledge_id
            .as_deref()
            .ok_or("survivor missing")?;
        let deprecated_id = decision
            .deprecated_knowledge_ids
            .first()
            .ok_or("deprecated id missing")?;
        let survivor = knowledge(snapshot, survivor_id).ok_or("survivor missing")?;
        let deprecated = knowledge(snapshot, deprecated_id).ok_or("deprecated missing")?;
        let current_deprecated = repository::load_knowledge(&tx, deprecated_id)?;
        let current_survivor = repository::load_knowledge(&tx, survivor_id)?;
        if !current_deprecated
            .as_ref()
            .is_some_and(|k| repository::unchanged(k, deprecated))
            || !current_survivor
                .as_ref()
                .is_some_and(|k| repository::unchanged(k, survivor))
        {
            disposition = "blocked";
            reason = "STALE_INPUT".into();
            outcome = "stale_input".into();
        } else {
            let body = if decision.action == "merge" {
                rendered_body(snapshot, &decision)?
            } else {
                survivor["body"]
                    .as_str()
                    .ok_or("survivor body missing")?
                    .to_string()
            };
            tx.execute("update landscape_curation_queue set rollback_snapshot=?2,mutation_plan=?3 where id=?1",params![job.id,json!({"deprecated":current_deprecated,"survivor":current_survivor}).to_string(),json!({"survivorKnowledgeId":survivor_id,"deprecatedKnowledgeId":deprecated_id,"body":body,"appliesTo":survivor["appliesTo"],"action":decision.action,"coverage":decision.coverage}).to_string()]).map_err(|e|e.to_string())?;
            if decision.action == "merge" {
                if survivor["body"].as_str() != Some(body.as_str()) && embedding.is_none() {
                    return Err("merged body requires embedding".into());
                }
                let source_groups = retained_source_groups(snapshot, &decision)?;
                tx.execute("update knowledge_items set body=?2,metadata=json_set(metadata,'$.landscapeCuration',json(?3)),updated_at=CURRENT_TIMESTAMP where id=?1",params![survivor_id,body,json!({"curationJobId":job.id,"mergedKnowledgeId":deprecated_id,"policyVersion":VERSION,"sourceGroups":source_groups}).to_string()]).map_err(|e|e.to_string())?;
                if let Some(vector) = embedding.as_ref() {
                    upsert_embedding(
                        &tx,
                        survivor_id,
                        survivor["title"].as_str().unwrap_or_default(),
                        &body,
                        vector,
                    )
                    .map_err(|e| e.to_string())?;
                }
                refresh_fts(&tx, survivor_id).map_err(|e| e.to_string())?;
            }
            preserve_lineage(&tx, deprecated_id, survivor_id, &job.id)?;
            tx.execute("update knowledge_items set status='deprecated',metadata=json_set(metadata,'$.deprecation',json(?2)),updated_at=CURRENT_TIMESTAMP where id=?1",params![deprecated_id,json!({"reason":"merged","mergedIntoKnowledgeId":survivor_id,"curationJobId":job.id,"policyVersion":VERSION}).to_string()]).map_err(|e|e.to_string())?;
            let verified: bool=tx.query_row("select exists(select 1 from knowledge_items d,knowledge_items s where d.id=?1 and d.status='deprecated' and s.id=?2 and s.status='active' and s.body=?3)",params![deprecated_id,survivor_id,body],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !verified {
                return Err("curation postcheck failed".into());
            }
            tx.execute(
                "update landscape_snapshots set status='stale' where status='ready'",
                [],
            )
            .map_err(|e| e.to_string())?;
            outcome = if decision.action == "merge" {
                "knowledge_merged"
            } else {
                "duplicate_deprecated"
            }
            .into();
            applied = true;
        }
    }
    let saved = serde_json::to_value(&decision).map_err(|e| e.to_string())?;
    let now = crate::domains::process_lifecycle::service::now_timestamp();
    let input_revision_hash = repository::hash(&repository::canonical_json(snapshot));
    let proposal_hash = repository::hash(&repository::canonical_json(&saved));
    let verification_hash = repository::hash(&repository::canonical_json(
        &serde_json::to_value(&decision.verification).map_err(|e| e.to_string())?,
    ));
    if applied {
        let survivor_id = decision
            .survivor_knowledge_id
            .as_deref()
            .ok_or("survivor missing")?;
        let deprecated_id = decision
            .deprecated_knowledge_ids
            .first()
            .map(String::as_str)
            .ok_or("deprecated missing")?;
        let survivor = repository::load_knowledge(&tx, survivor_id)?
            .ok_or("survivor disappeared after mutation")?;
        let deprecated = repository::load_knowledge(&tx, deprecated_id)?
            .ok_or("deprecated disappeared after mutation")?;
        let mutation_id = format!("curation-mutation:{}", job.id);
        let before_snapshot: String = tx
            .query_row(
                "select rollback_snapshot from landscape_curation_queue where id=?1",
                [&job.id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute("insert into curation_mutations(id,curation_job_id,survivor_knowledge_id,deprecated_knowledge_id,input_revision_hash,proposal_hash,verification_hash,before_snapshot,after_snapshot) values (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![mutation_id,job.id,survivor_id,deprecated_id,input_revision_hash,proposal_hash,verification_hash,before_snapshot,json!({"survivor":survivor,"deprecated":deprecated}).to_string()]).map_err(|e| e.to_string())?;
        tx.execute("insert into knowledge_supersessions(deprecated_knowledge_id,survivor_knowledge_id,curation_mutation_id) values (?1,?2,?3)",params![deprecated_id,survivor_id,mutation_id]).map_err(|e| e.to_string())?;
        let (left, right) = if survivor_id < deprecated_id {
            (survivor_id, deprecated_id)
        } else {
            (deprecated_id, survivor_id)
        };
        let left_revision = knowledge(snapshot, left)
            .and_then(|value| value["contentRevision"].as_str())
            .ok_or("left revision missing")?;
        let right_revision = knowledge(snapshot, right)
            .and_then(|value| value["contentRevision"].as_str())
            .ok_or("right revision missing")?;
        tx.execute("insert or replace into curation_pair_reviews(left_knowledge_id,right_knowledge_id,left_revision,right_revision,evidence_revision,policy_version,verdict,curation_job_id,updated_at) values (?1,?2,?3,?4,?5,?6,?7,?8,CURRENT_TIMESTAMP)",params![left,right,left_revision,right_revision,input_revision_hash,VERSION,if decision.action=="merge" {"merged"} else {"deprecated"},job.id]).map_err(|e| e.to_string())?;
    }
    let subject_revision = snapshot["subject"]["contentRevision"]
        .as_str()
        .ok_or("subject revision missing")?;
    let review_outcome = if decision.action == "needs_evidence" {
        "needs_evidence"
    } else {
        "reviewed"
    };
    tx.execute("insert or replace into curation_review_ledger(knowledge_id,content_revision,evidence_revision,policy_version,candidate_index_epoch,outcome,curation_job_id,updated_at) values (?1,?2,?3,?4,'v2',?5,?6,CURRENT_TIMESTAMP)",params![snapshot["subject"]["id"].as_str(),subject_revision,input_revision_hash,VERSION,review_outcome,job.id]).map_err(|e| e.to_string())?;
    let queue_decision = if decision.action == "merge" {
        "merge_review"
    } else {
        decision.action.as_str()
    };
    let policy = json!({"schemaVersion":2,"policyVersion":VERSION,"releaseMode":if applied {"auto_bounded"} else {"auto_non_destructive"},"requestedDecision":decision.action,"disposition":disposition,"effectiveAction":if applied {decision.action.as_str()} else {"record"},"reasonCodes":[if reason=="record_only" {"AUTONOMOUS_TERMINAL_DECISION"} else {&reason}],"evaluatedAt":now,"limits":{"dailyRemaining":0,"repoRemaining":0},"executor":VERSION});
    tx.execute("update landscape_curation_queue set status=?2,phase=?3,decision=?4,disposition=?5,result=?6,policy_result=?7,postcheck_result=?8,attempt_count=attempt_count+1,next_run_at=null,locked_by=null,locked_at=null,heartbeat_at=null,last_error=null,last_outcome_kind=?9,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP where id=?1",params![job.id,if disposition=="blocked" || disposition=="await_evidence" {"skipped"} else {"completed"},if applied {"postcheck"} else {"policy"},queue_decision,disposition,saved.to_string(),policy.to_string(),json!({"applied":applied,"verified":applied,"verification":decision.verification}).to_string(),outcome]).map_err(|e|e.to_string())?;
    super::events::append_queue_event_for_connection(
        &tx,
        &format!("curation-result:{}:{}", job.id, now),
        QUEUE,
        &job.id,
        "completed",
        Some(&outcome),
        Some(&policy.to_string()),
    )
    .map_err(|e| e.to_string())?;
    release_provider_lease_for_connection(&tx, &job.provider_lease.id, "worker_finished")
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

fn preserve_lineage(
    connection: &Connection,
    subject: &str,
    canonical: &str,
    job: &str,
) -> Result<(), String> {
    connection.execute("insert into knowledge_source_links(id,knowledge_id,source_fragment_id,link_type,confidence,metadata,created_at) select ?3 || ':' || l.id,?2,l.source_fragment_id,l.link_type,l.confidence,l.metadata,CURRENT_TIMESTAMP from knowledge_source_links l where l.knowledge_id=?1 and not exists(select 1 from knowledge_source_links c where c.knowledge_id=?2 and c.source_fragment_id=l.source_fragment_id)",params![subject,canonical,job]).map_err(|e|e.to_string())?;
    connection.execute("insert or ignore into knowledge_origin_links(id,knowledge_id,origin_kind,origin_uri,origin_key,confidence,metadata,created_at) select ?3 || ':' || id,?2,origin_kind,origin_uri,origin_key,confidence,metadata,CURRENT_TIMESTAMP from knowledge_origin_links where knowledge_id=?1",params![subject,canonical,job]).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(test)]
#[path = "curation_tests.rs"]
mod tests;
