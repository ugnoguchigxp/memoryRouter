export const knowledgePolarityValues = ["positive", "negative", "neutral"] as const;
export const knowledgeTypeValues = ["rule", "procedure"] as const;
export const knowledgeStatusValues = ["draft", "active", "deprecated"] as const;
export const scopeValues = ["repo", "global"] as const;
export const projectClassificationStatusValues = [
  "classified",
  "unresolved",
  "conflict",
  "malformed",
] as const;
export const projectIdentityAliasKindValues = ["repo_key", "repo_path"] as const;
export const projectIdentityAliasStatusValues = ["active", "revoked"] as const;
export const compileProjectMatchBasisValues = [
  "project_ref",
  "repo_key",
  "repo_path",
  "none",
] as const;
export const compileProjectScopeModeValues = ["global_only", "project"] as const;
export const compileProjectIdentityTrustValues = ["request_hint", "trusted_adapter"] as const;
export const compileProjectBindingStatusValues = [
  "verified",
  "not_applicable",
  "unverified",
] as const;

export const knowledgeTagKindValues = [
  "technology",
  "change_type",
  "retrieval_mode",
  "domain",
  "intent",
] as const;
export const knowledgeTagStatusValues = ["active", "draft", "deprecated"] as const;

export const knowledgeOriginLinkKindValues = [
  "vibe_memory",
  "episode_card",
  "agent_candidate",
  "landscape_review_item",
  "review_finding",
  "external_review_run",
  "review_correction",
] as const;

export const episodeCardStatusValues = ["active", "deprecated"] as const;
export const episodeOutcomeKindValues = ["success", "failure", "mixed", "unknown"] as const;
export const episodeSourceKindValues = [
  "vibe_memory",
  "compile_run",
  "decision_run",
  "audit_log",
  "manual",
] as const;
export const episodeRefKindValues = [
  "vibe_memory",
  "agent_diff",
  "compile_run",
  "decision_run",
  "audit_log",
  "file",
  "commit",
] as const;
export const episodeRetrievalRunKindValues = ["compile", "decision", "mcp", "api"] as const;
export const episodeRetrievalUsedForValues = [
  "compile",
  "decision",
  "search",
  "drill_down",
] as const;
export const episodeRetrievalVerdictValues = [
  "used",
  "not_relevant",
  "wrong",
  "needs_raw_check",
  "stale",
] as const;

export const sourceKindValues = ["wiki"] as const;
export const settingValueKindValues = ["json", "string", "secret_ref", "encrypted"] as const;

export const distillationTargetKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
  "web_ingest",
] as const;
export const distillationQueueNameValues = [
  "findingCandidate",
  "episodeDistiller",
  "coveringEvidence",
  "deadZoneMergeReview",
  "finalizeDistille",
  "mergeActivationFinalize",
] as const;
export const distillationQueueStatusValues = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
] as const;
export const distillationQueueInputKindValues = ["source_target", "provided_candidate"] as const;
export const distillationQueueSourceKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
  "web_ingest",
] as const;
export const distillationQueueProducerValues = ["coveringEvidence"] as const;
export const distillationQueueProviderPolicyValues = ["default", "cloud_api"] as const;
export const evidenceCoverageStatusValues = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;
export const distillationQueueEventTypeValues = [
  "claimed",
  "completed",
  "failed",
  "paused",
  "resumed",
  "retried",
  "reprocess_requested",
  "enqueued",
  "migration_mapped",
  "migration_failed",
] as const;
export const distillationQueueMigrationStatusValues = ["migrated", "skipped", "failed"] as const;
export const distillationTargetStatusValues = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
] as const;
export const distillationTargetPhaseValues = [
  "selected",
  "reading",
  "researching_source",
  "writing_source",
  "finding_candidate",
  "covering_evidence",
  "finalizing",
  "stored",
] as const;
export const distillationTargetPriorityGroupValues = [
  "knowledge_candidate",
  "web_ingest",
  "wiki",
  "vibe_memory",
] as const;

export const findCandidateResultStatusValues = ["selected", "parse_failed"] as const;

export const coverEvidenceStatusValues = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "reprocess_requested",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;
export const coverEvidenceStageValues = [
  "load",
  "source_support",
  "dedupe",
  "evidence_need",
  "web",
  "mcp",
  "final",
] as const;

export const sourceLinkTypeValues = ["derived_from"] as const;

export const runStatusValues = ["ok", "degraded", "failed"] as const;
export const compileRunSourceValues = ["ui", "mcp", "cli", "unknown"] as const;
export const compileEvalOutcomeValues = ["useful", "partial", "misleading", "unused"] as const;

export const packSectionValues = [
  "rules",
  "procedures",
  "code_context",
  "warnings",
  "guardrails",
] as const;
export const contextCompileCandidateTraceAgenticDecisionValues = [
  "not_evaluated",
  "accepted",
  "rejected",
  "skipped",
] as const;
export const contextCompileTaskTraceEmbeddingStatusValues = [
  "facets_only",
  "embedding_available",
  "embedding_unavailable",
] as const;

export const knowledgeUsageVerdictValues = ["used", "not_used", "off_topic", "wrong"] as const;
export const knowledgeReviewQueueStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const knowledgeReviewProposedActionValues = [
  "review_only",
  "demote_to_draft_candidate",
] as const;

export const landscapeReviewItemSourceValues = [
  "replay_compare",
  "landscape_snapshot",
  "semantic_relation_comparison",
  "promotion_gate",
  "contradiction_detection",
] as const;
export const landscapeReviewItemReasonValues = [
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "semantic_reachable_dead_zone",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "promotion_gate_review",
  "contradiction_review",
] as const;
export const landscapeReviewItemStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;
export const landscapeReviewItemProposedActionValues = [
  "review_only",
  "refine_applies_to",
  "repair_reachability",
  "review_wrong",
  "split_or_merge_review",
  "promotion_gate_review",
  "demote_to_draft_candidate",
  "review_contradiction",
] as const;
export const landscapeReviewItemConfidenceValues = ["low", "medium", "high"] as const;
export const landscapeReviewItemCandidateLinkStatusValues = [
  "draft_created",
  "review_required",
  "approved",
  "rejected",
  "finalized",
] as const;
export const landscapeSnapshotCacheTypeValues = [
  "landscape_snapshot",
  "landscape_replay_snapshot",
  "landscape_replay_comparison",
] as const;
export const landscapeSnapshotCacheStatusValues = ["ready", "stale"] as const;

export const knowledgeQualityAdjustmentKindValues = ["off_topic_quality_decrement"] as const;
export const auditLogActorValues = ["agent", "user", "system"] as const;

export const contextDecisionValues = [
  "execute",
  "reject",
  "revise_and_execute",
  "rollback",
  "discard",
  "escalate",
] as const;
export const contextDecisionAutonomyLevelValues = ["low", "medium", "high"] as const;
export const contextDecisionRiskBudgetValues = ["low", "medium", "high"] as const;
export const contextDecisionKnowledgePolicyValues = ["optional", "required"] as const;
export const contextDecisionStatusValues = ["completed", "degraded", "failed"] as const;
export const contextDecisionEvidenceRoleValues = [
  "selected_support",
  "counter_evidence",
  "rejected_alternative",
  "user_preference",
  "risk_warning",
  "missing_counter_evidence",
] as const;
export const contextDecisionCoverageQueryRoleValues = [
  "support",
  "counter_evidence",
  "user_preference",
  "risk",
  "verification",
  "alternative",
] as const;
export const contextDecisionHumanFeedbackValues = ["good", "bad"] as const;
export const contextDecisionFeedbackSourceValues = ["ai", "system"] as const;
export const contextDecisionFeedbackOutcomeValues = [
  "success",
  "failed",
  "discarded_pr",
  "user_overrode",
  "regression_found",
  "still_unknown",
] as const;
export const contextDecisionEffectValues = ["boost", "penalize", "neutral"] as const;
export const contextDecisionFeedbackEffectStatusValues = [
  "applied",
  "queued_for_review",
  "skipped",
] as const;
