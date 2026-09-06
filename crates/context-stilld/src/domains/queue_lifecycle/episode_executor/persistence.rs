use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use crate::shared::errors::CliError;

use super::deduplication::{
    find_near_duplicate_candidates, near_duplicate_review_allows_publish,
    review_near_duplicate_episode,
};
use super::helpers::{pseudo_uuid, table_exists};
use super::identity::record_episode_identity_event;
use super::quality::{
    calibrate_episode, canonical_json, clamp_score, join_list, normalize_generation_kind,
    normalize_outcome_kind, review_episode_value, scores_json, unique_strings, value_review_json,
};
use super::types::{
    EpisodePersistOutcome, EpisodeWriteIdentity, LocalLlmTargetConfig, PendingEpisode,
    SourceDocument, EPISODE_DISTILLATION_VERSION,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn create_episode_idempotently(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
    target: &LocalLlmTargetConfig,
    api_key: Option<&str>,
    timeout_seconds: u64,
) -> Result<EpisodePersistOutcome, CliError> {
    if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
        return Ok(EpisodePersistOutcome::SourceDeduped(existing));
    }
    let candidates = find_near_duplicate_candidates(connection, item, document, identity)?;
    if !candidates.is_empty() {
        let review =
            review_near_duplicate_episode(item, &candidates, target, api_key, timeout_seconds)?;
        if !near_duplicate_review_allows_publish(&review, &candidates) {
            return Ok(EpisodePersistOutcome::NearDuplicateSkipped(review));
        }
    }
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| {
            CliError::io(format!("failed to begin episode card transaction: {error}"))
        })?;
    let result = create_episode_idempotently_in_transaction(connection, item, document, identity);
    match result {
        Ok(value) => {
            connection.execute_batch("COMMIT").map_err(|error| {
                CliError::io(format!(
                    "failed to commit episode card transaction: {error}"
                ))
            })?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
                Ok(EpisodePersistOutcome::SourceDeduped(existing))
            } else {
                Err(error)
            }
        }
    }
}

pub(super) fn create_episode_idempotently_in_transaction(
    connection: &Connection,
    item: &PendingEpisode,
    document: &SourceDocument,
    identity: &EpisodeWriteIdentity,
) -> Result<EpisodePersistOutcome, CliError> {
    if let Some(existing) = existing_episode_id(connection, &item.source_key)? {
        return Ok(EpisodePersistOutcome::SourceDeduped(existing));
    }
    let id = pseudo_uuid();
    let ref_id = pseudo_uuid();
    let canonical = calibrate_episode(item.canonical.clone());
    let generation_kind = normalize_generation_kind(&canonical.generation_kind);
    let value_review = review_episode_value(&canonical);
    let observations = join_list(
        &canonical.key_decisions,
        "主要な判断は特定されませんでした。",
    );
    let action = if canonical.failed_approach.trim().is_empty() {
        canonical.action_taken.trim().to_string()
    } else {
        format!(
            "{}\n\n失敗した、または避けたアプローチ:\n{}",
            canonical.action_taken.trim(),
            canonical.failed_approach.trim()
        )
    };
    let source_fragment_key = item.source_key.clone();
    let project_identity = identity.snapshot();
    let metadata = json!({
        "source": "episodeDistiller",
        "episodeDistillation": {
            "version": EPISODE_DISTILLATION_VERSION,
            "canonical": canonical_json(&canonical),
            "scores": scores_json(&canonical.scores),
            "sourceFragmentKey": source_fragment_key,
            "sourceStartOffset": item.source_start_offset,
            "sourceEndOffset": item.source_end_offset,
            "sourceEventStart": item.event_start,
            "sourceEventEnd": item.event_end,
            "readRanges": [{"from": item.source_start_offset, "toExclusive": item.source_end_offset}],
            "parentVibeMemoryId": document.vibe_memory_id,
            "generatingQueueName": "episodeDistiller",
            "sessionId": document.session_id,
            "projectIdentity": project_identity,
            "valueReview": value_review_json(&value_review)
        },
        "triggers": canonical.useful_future_triggers
    });
    let applicability = json!({
        "sourceFragmentKey": source_fragment_key,
        "generationKind": generation_kind
    });
    let anti_applicability = json!({
        "requiresRawEvidenceCheck": true,
        "stalenessRisk": clamp_score(canonical.scores.staleness_risk),
        "openLoops": unique_strings(&canonical.open_loops)
    });
    connection
        .execute(
            "
            insert into episode_cards (
              id, title, situation, observations, action, outcome, lesson,
              applicability, anti_applicability, domains, technologies, change_types, tools,
              classification_status, scope, project_ref, repo_path, repo_key,
              source_kind, source_key, outcome_kind, importance, confidence,
              compile_use_count, decision_use_count, status, stale_at, metadata,
              created_at, updated_at
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'classified', ?14, ?15, ?16, ?17, 'vibe_memory', ?18, ?19, ?20, ?21, 0, 0, 'active', null, ?22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ",
            params![
                id,
                canonical.title.trim(),
                canonical.context.trim(),
                observations,
                action,
                canonical.outcome.trim(),
                canonical.reusable_lesson.trim(),
                applicability.to_string(),
                anti_applicability.to_string(),
                json!(unique_strings(&canonical.domains)).to_string(),
                json!(unique_strings(&canonical.technologies)).to_string(),
                json!(unique_strings(&canonical.change_types)).to_string(),
                json!(unique_strings(&canonical.tools)).to_string(),
                identity.scope,
                identity.resolved.project_ref,
                identity.resolved.repo_path,
                identity.resolved.repo_key,
                item.source_key,
                normalize_outcome_kind(&canonical.outcome_kind),
                clamp_score(canonical.scores.importance),
                clamp_score(canonical.scores.confidence),
                metadata.to_string()
            ],
        )
        .map_err(|error| CliError::io(format!("failed to insert episode card: {error}")))?;
    let rowid = connection
        .query_row(
            "select rowid from episode_cards where id = ?1",
            [&id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| CliError::io(format!("failed to read episode card rowid: {error}")))?;
    if table_exists(connection, "episode_cards_fts")? {
        connection
            .execute(
                "
                insert into episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
                values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    rowid,
                    id,
                    canonical.title.trim(),
                    canonical.context.trim(),
                    observations,
                    action,
                    canonical.outcome.trim(),
                    canonical.reusable_lesson.trim()
                ],
            )
            .map_err(|error| CliError::io(format!("failed to insert episode card FTS row: {error}")))?;
    }
    connection
        .execute(
            "
            insert into episode_refs (
              id, episode_card_id, ref_kind, ref_value, locator, query_hint, metadata, created_at
            ) values (?1, ?2, 'vibe_memory', ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
            ",
            params![
                ref_id,
                id,
                document.vibe_memory_id,
                format!("bytes:{}-{}", item.source_start_offset, item.source_end_offset),
                canonical.title.trim(),
                json!({
                    "sourceFragmentKey": item.source_key,
                    "sourceStartOffset": item.source_start_offset,
                    "sourceEndOffset": item.source_end_offset,
                    "sourceEventStart": item.event_start,
                    "sourceEventEnd": item.event_end,
                    "readRanges": [{"from": item.source_start_offset, "toExclusive": item.source_end_offset}],
                    "sessionId": document.session_id,
                    "projectIdentity": project_identity
                }).to_string()
            ],
        )
        .map_err(|error| CliError::io(format!("failed to insert episode ref: {error}")))?;
    record_episode_identity_event(
        connection,
        "PROJECT_IDENTITY_PRODUCER_PERSISTED",
        json!({
            "producer": "episode-distiller.rust",
            "entityKind": "episode",
            "entityId": id,
            "scope": identity.scope,
            "matchBasis": identity.resolved.match_basis.as_str(),
            "identityFingerprint": identity.resolved.identity_fingerprint,
            "bindingStatus": identity.resolved.binding_status.as_str()
        }),
    );
    Ok(EpisodePersistOutcome::Created(id))
}

pub(super) fn existing_episode_id(
    connection: &Connection,
    source_key: &str,
) -> Result<Option<String>, CliError> {
    connection
        .query_row(
            "select id from episode_cards where source_kind = 'vibe_memory' and source_key = ?1 limit 1",
            [source_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to check existing episode card: {error}")))
}
