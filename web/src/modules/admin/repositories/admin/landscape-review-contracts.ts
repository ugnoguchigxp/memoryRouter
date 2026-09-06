import type { LandscapeReviewCandidateLinkStatus } from "./candidate-contracts";
import type { GraphRelationAxis, GraphStatusFilter } from "./graph-contracts";
import type { LandscapeRunStatusFilter } from "./landscape-contracts";

export type LandscapeTrajectoryCandidate = {
  itemKind: "rule" | "procedure";
  itemId: string;
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
  evidence: {
    status: string | null;
    candidateEvidence: {
      textMatched: boolean;
      vectorMatched: boolean;
      vectorScore?: number | null;
      facetMatched: boolean;
    } | null;
  };
};

export type LandscapeTrajectoryResult = {
  run: {
    id: string;
    goal: string;
    retrievalMode: string;
    status: "ok" | "degraded" | "failed";
    source: string;
    createdAt: string;
  };
  traceAvailable: boolean;
  warnings: string[];
  stageCounts: {
    totalCandidates: number;
    textHit: number;
    vectorHit: number;
    merged: number;
    finalRanked: number;
    selected: number;
    suppressed: number;
  };
  selectedKnowledgeIds: string[];
  diagnostics: {
    candidateTraceSavedCount: number | null;
    candidateTraceTruncated: boolean | null;
    candidateTraceLimit: number | null;
    candidateTraceSkippedReason: string | null;
  };
  candidates: LandscapeTrajectoryCandidate[];
  communitySummary: Array<{
    communityKey: string;
    candidateCount: number;
    selectedCount: number;
    suppressedCount: number;
  }>;
  taskTrace: {
    runId: string;
    retrievalMode: string;
    repoPath: string | null;
    repoKey: string | null;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
    embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
    embeddingProvider: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    goalHash: string;
    createdAt: string;
  } | null;
  taskSimilarity: Array<{
    runId: string;
    similarity: number;
    mode: "embedding" | "facets";
    retrievalMode: string;
    repoPath: string | null;
    repoKey: string | null;
    goalHash: string;
    embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
    createdAt: string;
  }>;
};

export type LandscapeReviewItemSource =
  | "replay_compare"
  | "landscape_snapshot"
  | "semantic_relation_comparison"
  | "promotion_gate"
  | "contradiction_detection";

export type LandscapeReviewItemReason =
  | "duplicate_candidate"
  | "used_baseline_lost"
  | "baseline_off_topic"
  | "baseline_wrong"
  | "baseline_missing_after_recompile"
  | "negative_attractor_candidate"
  | "wrong_review_required"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale"
  | "semantic_reachable_dead_zone"
  | "semantic_split"
  | "semantic_merge"
  | "relation_orphan"
  | "promotion_gate_review"
  | "contradiction_review";

export type LandscapeReviewItemStatus = "pending" | "reviewing" | "resolved" | "dismissed";

export type LandscapeReviewItemProposedAction =
  | "review_only"
  | "refine_applies_to"
  | "repair_reachability"
  | "review_wrong"
  | "split_or_merge_review"
  | "promotion_gate_review"
  | "demote_to_draft_candidate"
  | "review_contradiction";

export type LandscapeReviewItemConfidence = "low" | "medium" | "high";

export type LandscapeReviewItem = {
  id: string;
  source: LandscapeReviewItemSource;
  reason: LandscapeReviewItemReason;
  status: LandscapeReviewItemStatus;
  proposedAction: LandscapeReviewItemProposedAction;
  priority: number;
  confidence: LandscapeReviewItemConfidence;
  knowledgeId: string | null;
  runId: string | null;
  triggerEventId: string | null;
  communityKey: string | null;
  communityLabel: string | null;
  suggestedAppliesTo: Record<string, unknown>;
  evidence: string[];
  payload: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type LandscapeReviewItemCandidate = {
  source: LandscapeReviewItemSource;
  reason: LandscapeReviewItemReason;
  proposedAction: LandscapeReviewItemProposedAction;
  priority: number;
  confidence: LandscapeReviewItemConfidence;
  idempotencyKey: string;
  knowledgeId: string | null;
  runId: string | null;
  triggerEventId: string | null;
  communityKey: string | null;
  communityLabel: string | null;
  suggestedAppliesTo: Record<string, unknown>;
  evidence: string[];
  payload: Record<string, unknown>;
  note?: string | null;
};

export type LandscapeReviewItemsMaterializeInput = {
  dryRun: boolean;
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  landscapeLimit: number;
  landscapeStatus: GraphStatusFilter;
  relationAxes: GraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  sources: LandscapeReviewItemSource[];
  materializeLimit: number;
};

export type LandscapeReviewItemsMaterializeResult = {
  dryRun: boolean;
  generatedAt: string;
  candidateCount: number;
  insertedCount: number;
  existingCount: number;
  skippedCount: number;
  items: LandscapeReviewItem[];
  candidates: LandscapeReviewItemCandidate[];
};

export type LandscapeReviewItemsListQuery = {
  status?: LandscapeReviewItemStatus | "all";
  source?: LandscapeReviewItemSource | "all";
  reason?: LandscapeReviewItemReason | "all";
  proposedAction?: LandscapeReviewItemProposedAction | "all";
  knowledgeId?: string;
  runId?: string;
  communityKey?: string;
  priorityMin?: number;
  limit?: number;
};

export type LandscapeReviewItemsListResponse = {
  items: LandscapeReviewItem[];
  count: number;
};

export type LandscapeCurationJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export type LandscapeCurationJob = {
  id: string;
  reviewItemId: string | null;
  findingType:
    | "duplicate_candidate"
    | "reachability_gap"
    | "stale_knowledge"
    | "applicability_issue"
    | "contradiction_candidate";
  subjectKnowledgeId: string;
  candidateKnowledgeIds: string[];
  status: LandscapeCurationJobStatus;
  phase: string;
  decision: string | null;
  disposition: string | null;
  priority: number;
  lastError: string | null;
  lastOutcomeKind: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LandscapeCurationJobListResponse = { items: LandscapeCurationJob[] };

export type LandscapeContradictionOverlayItem = {
  reviewItemId: string;
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  pairKey: string;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  status: LandscapeReviewItemStatus;
  evidence: string[];
  communityKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LandscapeContradictionOverlayList = {
  items: LandscapeContradictionOverlayItem[];
  count: number;
};

export type LandscapeReviewCandidateCreateInput = {
  ids?: string[];
  status?: "pending" | "reviewing";
  limit?: number;
  dryRun?: boolean;
};

export type LandscapeReviewCandidateCreateItem = {
  reviewItemId: string;
  reason: LandscapeReviewItemReason;
  proposedAction: LandscapeReviewItemProposedAction;
  candidateType: "rule" | "procedure";
  candidateKey: string;
  targetKey: string;
  targetStateId: string | null;
  findCandidateResultId: string | null;
  linkId: string | null;
  linkStatus: LandscapeReviewCandidateLinkStatus | null;
  draftLinked: boolean;
};

export type LandscapeReviewCandidateCreateResult = {
  dryRun: boolean;
  processedCount: number;
  createdCount: number;
  existingCount: number;
  missingIds: string[];
  items: LandscapeReviewCandidateCreateItem[];
};

export type LandscapeReviewCandidateLinkUpdateInput = {
  status: "approved" | "rejected";
  note?: string;
  actor?: string;
};

export type LandscapeReviewCandidateLinkUpdateResult = {
  link: {
    id: string;
    reviewItemId: string;
    targetStateId: string;
    findCandidateResultId: string;
    candidateKey: string;
    status: LandscapeReviewCandidateLinkStatus;
    approvalNote: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
};
