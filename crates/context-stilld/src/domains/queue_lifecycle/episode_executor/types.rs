use std::path::Path;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domains::mcp_lifecycle::project_identity::ResolvedCompileProjectIdentity;

use super::super::types::ProviderLeaseAssignment;

use super::quality::{
    default_generation_kind, default_outcome_kind, default_score, deserialize_score,
};

pub(super) const EPISODE_DISTILLATION_VERSION: &str = "episode-distiller-v1";

pub(super) const MIN_EPISODE_VALUE_SCORE: i64 = 60;

pub(super) const MIN_EPISODE_IMPORTANCE: i64 = 55;

pub(super) const MIN_EPISODE_CONFIDENCE: i64 = 55;

pub(super) const MIN_EPISODE_REUSABLE_SIGNAL: i64 = 50;

pub(super) const MIN_EPISODE_EVIDENCE_QUALITY: i64 = 50;

pub(super) const MIN_EPISODE_COMPRESSION_QUALITY: i64 = 45;

#[derive(Debug, Clone)]
pub(crate) struct LocalLlmTargetConfig {
    pub(crate) target_id: String,
    pub(crate) api_base_url: String,
    pub(crate) api_path: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum EpisodeExecutionStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum EpisodeSplitStatus {
    Completed,
    Skipped,
    Failed,
    Retrying,
    Paused,
    Superseded,
}

#[derive(Debug, Clone)]
pub(super) struct EpisodeDistillerJobRow {
    pub(super) id: String,
    pub(super) source_kind: String,
    pub(super) source_key: String,
    pub(super) attempt_count: i64,
    pub(super) max_attempts: i64,
    pub(super) metadata: Value,
}

#[derive(Debug, Clone)]
pub(super) struct SourceDocument {
    pub(super) vibe_memory_id: String,
    pub(super) session_id: String,
    pub(super) content: String,
    pub(super) metadata: Value,
    pub(super) events: Vec<SourceEvent>,
}

#[derive(Debug, Clone)]
pub(super) struct SourceEvent {
    pub(super) id: String,
    pub(super) created_at: String,
    pub(super) file_path: Option<String>,
    pub(super) start_offset: usize,
    pub(super) end_offset: usize,
}

#[derive(Debug, Clone)]
pub(super) struct EpisodeWriteIdentity {
    pub(super) scope: String,
    pub(super) resolved: ResolvedCompileProjectIdentity,
}

impl EpisodeWriteIdentity {
    pub(super) fn snapshot(&self) -> Value {
        let mut snapshot = serde_json::to_value(&self.resolved).unwrap_or_else(|_| json!({}));
        if let Some(object) = snapshot.as_object_mut() {
            object.insert("classificationStatus".to_string(), json!("classified"));
            object.insert("scope".to_string(), json!(self.scope));
        }
        snapshot
    }
}

#[derive(Debug, Clone)]
pub(super) struct Segment {
    pub(super) text: String,
    pub(super) start_offset: usize,
    pub(super) end_offset: usize,
    pub(super) event_start: Option<String>,
    pub(super) event_end: Option<String>,
    pub(super) event_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CanonicalEpisode {
    pub(super) title: String,
    #[serde(default, alias = "situation")]
    pub(super) context: String,
    #[serde(default)]
    pub(super) intent: String,
    #[serde(default, rename = "keyDecisions")]
    pub(super) key_decisions: Vec<String>,
    #[serde(default, rename = "actionTaken")]
    pub(super) action_taken: String,
    pub(super) outcome: String,
    #[serde(default, rename = "failedApproach")]
    pub(super) failed_approach: String,
    #[serde(default, rename = "reusableLesson", alias = "lesson")]
    pub(super) reusable_lesson: String,
    #[serde(default, rename = "usefulFutureTriggers")]
    pub(super) useful_future_triggers: Vec<String>,
    #[serde(default, rename = "openLoops")]
    pub(super) open_loops: Vec<String>,
    #[serde(default = "default_generation_kind", rename = "generationKind")]
    pub(super) generation_kind: String,
    #[serde(default = "default_outcome_kind", rename = "outcomeKind")]
    pub(super) outcome_kind: String,
    #[serde(default)]
    pub(super) domains: Vec<String>,
    #[serde(default)]
    pub(super) technologies: Vec<String>,
    #[serde(default, rename = "changeTypes")]
    pub(super) change_types: Vec<String>,
    #[serde(default)]
    pub(super) tools: Vec<String>,
    #[serde(default)]
    pub(super) scores: EpisodeScores,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct EpisodeScores {
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) importance: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) confidence: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) reusability: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) decision_density: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) failure_value: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) causal_clarity: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) project_specificity: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) evidence_quality: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) compression_quality: i64,
    #[serde(default = "default_score", deserialize_with = "deserialize_score")]
    pub(super) staleness_risk: i64,
}

impl Default for EpisodeScores {
    fn default() -> Self {
        Self {
            importance: 50,
            confidence: 50,
            reusability: 50,
            decision_density: 50,
            failure_value: 50,
            causal_clarity: 50,
            project_specificity: 50,
            evidence_quality: 50,
            compression_quality: 50,
            staleness_risk: 50,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ValueReview {
    pub(super) publish: bool,
    pub(super) score: i64,
    pub(super) reasons: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct PendingEpisode {
    pub(super) canonical: CanonicalEpisode,
    pub(super) source_key: String,
    pub(super) source_start_offset: usize,
    pub(super) source_end_offset: usize,
    pub(super) event_start: Option<String>,
    pub(super) event_end: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct ProcessCounters {
    pub(super) generated: i64,
    pub(super) deduped: i64,
    pub(super) skipped: i64,
    pub(super) value_skipped: i64,
    pub(super) duplicate_generation_kind_skipped: i64,
    pub(super) near_duplicate_skipped: i64,
    pub(super) failed_segments: i64,
    pub(super) accepted_candidate_count: i64,
    pub(super) episode_ids: Vec<String>,
    pub(super) saved_source_keys: Vec<String>,
}

#[derive(Debug, Clone)]
pub(super) struct NearDuplicateCandidate {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) situation: String,
    pub(super) observations: String,
    pub(super) action: String,
    pub(super) outcome: String,
    pub(super) lesson: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct NearDuplicateReview {
    pub(super) publish: bool,
    #[serde(default, rename = "duplicateOfEpisodeId")]
    pub(super) duplicate_of_episode_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_score")]
    pub(super) confidence: i64,
    #[serde(default)]
    pub(super) reason: String,
}

#[derive(Debug)]
pub(super) enum EpisodePersistOutcome {
    Created(String),
    SourceDeduped(String),
    NearDuplicateSkipped(NearDuplicateReview),
}

pub(super) enum EpisodeStore<'a> {
    Legacy(&'a Connection),
    Split {
        sqlite_path: &'a Path,
        reader: Box<Connection>,
        provider_lease: ProviderLeaseAssignment,
    },
}

pub(super) const EPISODE_EXECUTION_SUPERSEDED: &str = "episode_execution_superseded";
