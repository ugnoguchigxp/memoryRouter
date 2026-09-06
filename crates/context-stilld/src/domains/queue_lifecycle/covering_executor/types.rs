use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::episode_executor::LocalLlmTargetConfig;
use super::super::types::ProviderLeaseAssignment;

pub(super) const NEGATIVE_SYSTEM_PROMPT: &str =
    include_str!("../../../../../../shared/prompts/cover-negative-evidence-rust-v1.txt");

pub(super) const SYSTEM_CONTEXT_CATALOG: &str =
    include_str!("../../../../../../.s11tnext/catalog.json");

pub(super) const EXTERNAL_FETCH_BYTE_LIMIT: usize = 4 * 1024 * 1024;

pub(super) const LOCAL_SOURCE_BYTE_LIMIT: usize = 16 * 1024 * 1024;

pub(super) const LLM_RESPONSE_BYTE_LIMIT: usize = 2 * 1024 * 1024;

pub(super) const INTENT_TAGS: &[&str] = &[
    "guidance",
    "guardrail",
    "prohibition",
    "warning",
    "failure_pattern",
    "review_finding",
    "regression",
    "test_gap",
    "verification",
    "preference",
    "boundary_violation",
    "architecture_risk",
    "security_risk",
    "performance_risk",
    "operational_risk",
    "data_integrity",
];

#[derive(Debug, Clone)]
pub(crate) struct NegativeCoveringExecution {
    pub(crate) job_id: String,
    pub(crate) found_candidate_id: String,
    pub(crate) distillation_version: String,
    pub(crate) attempt_count: i64,
    pub(crate) max_attempts: i64,
    pub(crate) input_generation: i64,
    pub(crate) protocol_version: i64,
    pub(crate) provider_policy: String,
    pub(crate) candidate_title: String,
    pub(crate) candidate_content: String,
    pub(crate) candidate_type: String,
    pub(crate) candidate_origin: Value,
    pub(crate) candidate_metadata: Value,
    pub(crate) source_key: String,
    pub(crate) source_uri: String,
    pub(crate) source_kind: String,
    pub(crate) provider_lease: ProviderLeaseAssignment,
    pub(crate) target: LocalLlmTargetConfig,
    pub(crate) api_key: Option<String>,
    pub(crate) source_read_root: PathBuf,
    pub(crate) source_content: String,
    pub(super) source_read_ranges: Option<Vec<(usize, usize)>>,
    pub(crate) source_metadata: Value,
    pub(crate) low_importance_reject_threshold: i64,
    pub(crate) duplicate_status: Option<String>,
    pub(crate) duplicate_refs: Vec<Value>,
    pub(crate) external_search: CoveringExternalSearchConfig,
}

#[derive(Debug, Clone)]
pub(crate) struct CoveringExternalSearchConfig {
    pub(crate) provider_order: Vec<String>,
    pub(crate) max_provider_attempts: usize,
    pub(crate) result_count: usize,
    pub(crate) brave_api_key: Option<String>,
    pub(crate) exa_api_key: Option<String>,
}

impl Default for CoveringExternalSearchConfig {
    fn default() -> Self {
        Self {
            provider_order: vec!["duckduckgo".to_string()],
            max_provider_attempts: 1,
            result_count: 3,
            brave_api_key: None,
            exa_api_key: None,
        }
    }
}

impl NegativeCoveringExecution {
    pub(crate) fn is_negative(&self) -> bool {
        self.candidate_origin
            .get("polarity")
            .and_then(Value::as_str)
            == Some("negative")
    }

    pub(crate) fn covering_mode(&self) -> &'static str {
        if self.is_negative() {
            "negative"
        } else {
            "positive"
        }
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub(crate) enum NegativeCoveringPersistStatus {
    Completed,
    Failed,
    Retrying,
    Superseded,
}

#[derive(Debug, Clone)]
pub(crate) struct NegativeCoveringResult {
    pub(crate) status: String,
    pub(crate) stage: &'static str,
    pub(crate) candidate: Option<Value>,
    pub(crate) references: Vec<Value>,
    pub(crate) duplicate_refs: Vec<Value>,
    pub(crate) tool_events: Vec<Value>,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NegativeEvidenceResponse {
    pub(super) status: String,
    pub(super) polarity: String,
    #[serde(default)]
    pub(super) intent_tags: Vec<String>,
    #[serde(default, alias = "applicability")]
    pub(super) applies_to: Value,
    pub(super) distilled: NegativeDistilled,
    #[serde(default)]
    pub(super) evidence: Vec<String>,
    #[serde(default)]
    pub(super) origin_refs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NegativeDistilled {
    pub(super) failure: String,
    pub(super) impact: Option<String>,
    pub(super) trigger: Option<String>,
    pub(super) fix: Option<String>,
    pub(super) verification: Option<String>,
    pub(super) decision_signal: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct NegativeQuality {
    pub(super) ready: bool,
    pub(super) reason: Option<String>,
    pub(super) evidence_count: usize,
    pub(super) confidence: i64,
    pub(super) importance: i64,
}
