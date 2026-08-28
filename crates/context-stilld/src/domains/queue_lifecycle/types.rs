use serde::Serialize;

use crate::domains::process_lifecycle::service::{ManagedProcessSpec, CURRENT_EXE_COMMAND};

pub(crate) const QUEUE_SUPERVISOR: ManagedProcessSpec = ManagedProcessSpec {
    state_name: "queue-supervisor",
    display_name: "queue-supervisor",
    command: CURRENT_EXE_COMMAND,
    args: &["queue", "start"],
    log_file: "queue-supervisor.log",
};

pub(crate) const QUEUE_TABLES: &[(&str, &str)] = &[
    ("findingCandidate", "finding_candidate_queue"),
    ("episodeDistiller", "episode_distiller_queue"),
    ("coveringEvidence", "covering_evidence_queue"),
    ("deadZoneMergeReview", "dead_zone_merge_review_queue"),
    ("mergeActivationFinalize", "merge_activation_finalize_queue"),
    ("finalizeDistille", "finalize_distille_queue"),
];

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueInspectReport {
    pub process: &'static str,
    pub action: &'static str,
    pub status: String,
    pub worker_pid: Option<u32>,
    pub executor_mode: String,
    pub executor_running: bool,
    pub executor_pid: Option<u32>,
    pub runnable_pending_count: u64,
    pub unsupported_runnable_count: u64,
    pub unsupported_queues: Vec<UnsupportedQueueBacklog>,
    pub blocked_reason: Option<String>,
    pub sqlite_status: &'static str,
    pub sqlite_core_path: String,
    pub queues: Vec<QueueTableInspect>,
    pub active_lease_count: u64,
    pub active_target_ids: Vec<String>,
    pub active_leases: Vec<ActiveProviderLease>,
    pub last_heartbeat_at: Option<String>,
    pub feature_flags: QueueFeatureFlagsInspect,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedQueueBacklog {
    pub queue_name: &'static str,
    pub runnable_pending: u64,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueFeatureFlagsInspect {
    pub internal_chunked_distillation: bool,
    pub rust_covering_mode: String,
    pub rust_finding_execution_mode: String,
    pub rust_episode_execution_mode: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueTableInspect {
    pub queue_name: &'static str,
    pub table_name: &'static str,
    pub table_status: &'static str,
    pub status_counts: Vec<QueueStatusCount>,
    pub oldest_pending_at: Option<String>,
    pub runnable_pending: u64,
    pub running: u64,
    pub last_heartbeat_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_distiller_progress: Option<EpisodeDistillerProgressInspect>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeDistillerProgressInspect {
    pub running_job_id: String,
    pub current_segment: Option<u64>,
    pub segment_count: Option<u64>,
    pub pipeline_version: Option<String>,
    pub source_window_count: Option<u64>,
    pub semantic_chunk_count: Option<u64>,
    pub last_segment_started_at: Option<String>,
    pub last_segment_completed_at: Option<String>,
    pub last_episode_created_at: Option<String>,
    pub output_gap_seconds: Option<u64>,
    pub output_watchdog_status: Option<String>,
    pub saved_episode_count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatusCount {
    pub status: String,
    pub count: u64,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProviderLease {
    pub pool_id: String,
    pub target_id: String,
    pub queue_name: String,
    pub queue_job_id: String,
    pub worker_id: String,
    pub heartbeat_at: String,
    pub expires_at: String,
}

impl ActiveProviderLease {
    pub(crate) fn is_rust_executor(&self) -> bool {
        self.worker_id.starts_with("context-stilld-rust-executor:")
    }

    pub(crate) fn rust_executor_pid(&self) -> Option<u32> {
        let suffix = self
            .worker_id
            .strip_prefix("context-stilld-rust-executor:")?;
        let (_, pid_and_suffix) = suffix.rsplit_once(':')?;
        let (pid, _) = pid_and_suffix.split_once('-')?;
        pid.parse::<u32>().ok()
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedQueueJob {
    pub queue_name: String,
    pub table_name: &'static str,
    pub id: String,
    pub worker_id: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProviderPoolClaimConfig {
    pub pool_id: String,
    pub targets: Vec<String>,
    pub max_concurrent: u64,
    pub stale_lease_seconds: u64,
    pub low_priority_aging_seconds: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProviderQueueClaimSpec {
    pub queue_name: String,
    pub preferred_target_ids: Vec<String>,
    pub route_target_column: Option<&'static str>,
    pub route_target_preferences: Vec<RowTargetPreference>,
    pub allowed_route_values: Option<Vec<String>>,
    pub candidate_polarity_filter: CandidatePolarityFilter,
    pub allowed_job_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CandidatePolarityFilter {
    Any,
    Negative,
    NonNegative,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RowTargetPreference {
    pub value: String,
    pub preferred_target_ids: Vec<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedProviderLeaseJob {
    pub queue_name: String,
    pub id: String,
    pub provider_lease: ProviderLeaseAssignment,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLeaseAssignment {
    pub id: String,
    pub pool_id: String,
    pub target_id: String,
    pub queue_name: String,
    pub queue_job_id: String,
    pub worker_id: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStateRow {
    pub id: String,
    pub status: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct RunnableProviderCandidate {
    pub(crate) queue_name: String,
    pub(crate) table_name: &'static str,
    pub(crate) id: String,
    pub(crate) queue_order: usize,
    pub(crate) effective_priority: i64,
    pub(crate) priority: i64,
    pub(crate) created_at: String,
    pub(crate) preferred_target_ids: Vec<String>,
}
