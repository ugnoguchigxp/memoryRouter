import type { GraphRelationAxis, GraphStatusFilter } from "./graph-contracts";
import type { DistillationQueueStatus } from "./queue-api";

export type LandscapeFeedbackConfidence = "insufficient" | "low" | "medium" | "high";

export type LandscapeClassificationPrimary =
  | "strong_attractor"
  | "useful_attractor"
  | "negative_attractor_candidate"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale"
  | "feedback_insufficient"
  | "neutral";

export type LandscapeClassificationConfidence = "low" | "medium" | "high";

export type LandscapeThresholds = {
  minSelectedCount: number;
  minFeedbackCount: number;
  feedbackConfidence: {
    mediumMin: number;
    highMin: number;
  };
  feedbackFactor: Record<LandscapeFeedbackConfidence, number>;
  attractor: {
    strongUsedRateMin: number;
    usefulUsedRateMin: number;
    strongSourceRefDensityMin: number;
  };
  negative: {
    offTopicWeight: number;
    wrongWeight: number;
    candidateOffTopicRateMin: number;
  };
  notUsed: {
    overSelectedRateMin: number;
  };
  deadZone: {
    reachabilityRiskMin: number;
    staleSourceRefDensityMax: number;
    staleFactorMin: number;
  };
  evidenceFactor: {
    sourceRefDensityBaseline: number;
    min: number;
    max: number;
  };
};

export type LandscapeCommunity = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  memberCounts: {
    active: number;
    draft: number;
    deprecated: number;
    rule: number;
    procedure: number;
    embedded: number;
  };
  selection: {
    selectedItemCountWindow: number;
    selectedRunCountWindow: number;
    cumulativeCompileSelectCount: number;
    zeroUseActiveCount: number;
    zeroUseActiveRatio: number;
  };
  feedback: {
    usedCountWindow: number;
    notUsedCountWindow: number;
    offTopicCountWindow: number;
    wrongCountWindow: number;
    feedbackCountWindow: number;
    usedRate: number;
    notUsedRate: number;
    offTopicRate: number;
    wrongRate: number;
    feedbackConfidence: LandscapeFeedbackConfidence;
  };
  quality: {
    avgImportance: number;
    avgConfidence: number;
    avgDynamicScore: number;
    sourceRefCount: number;
    sourceRefDensity: number;
    avgFreshnessFactor: number;
    avgStalenessFactor: number;
  };
  scores: {
    activity: number;
    attractorScore: number;
    negativeScore: number;
    reachabilityRiskScore: number;
  };
  classification: {
    primary: LandscapeClassificationPrimary;
    flags: string[];
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };
  recommendedActions: string[];
  representativeKnowledgeIds: string[];
};

export type LandscapeSnapshot = {
  generatedAt: string;
  windowDays: number;
  basis: {
    unit: "community";
    relationAxes: GraphRelationAxis[];
    status: GraphStatusFilter;
  };
  thresholds: LandscapeThresholds;
  stats: {
    totalCommunities: number;
    activeCommunities: number;
    selectedCommunities: number;
    insufficientFeedbackCommunities: number;
    strongAttractorCount: number;
    usefulAttractorCount: number;
    negativeCandidateCount: number;
    overSelectedNotUsedCount: number;
    deadZoneReachabilityCount: number;
    deadZoneStaleCount: number;
  };
  communities: LandscapeCommunity[];
  risks: Array<{
    communityId: string;
    communityKey: string;
    communityLabel: string;
    communityRank: number;
    type:
      | "negative_attractor_candidate"
      | "wrong_review_required"
      | "over_selected_not_used"
      | "dead_zone_reachability_risk"
      | "dead_zone_stale";
    severity: LandscapeClassificationConfidence;
    reason: string;
  }>;
};

export type DeadZoneKnowledgeReviewBadge =
  | "Strong merge candidate"
  | "Canonical candidate"
  | "Likely duplicate"
  | "Scope differs"
  | "Evidence thin"
  | "Stale"
  | "Niche but valid"
  | "Needs embedding"
  | "Similarity unavailable";

export type DeadZoneKnowledgeReviewReason =
  | "all"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale";

export type DeadZoneKnowledgeReviewSortBy =
  | "deadZoneScore"
  | "compileSelectCount"
  | "title"
  | "similarity"
  | "evidence"
  | "usage";

export type DeadZoneKnowledgeMaintenanceAction =
  | "merge_deadzone_into_similar"
  | "merge_similar_into_deadzone"
  | "deprecate_deadzone"
  | "deprecate_similar";

export type DeadZoneRecommendationAction =
  | "merge_deadzone_into_canonical"
  | "deprecate_deadzone"
  | "keep_separate"
  | "promote_deadzone"
  | "needs_evidence";

export type DeadZoneReviewRecommendation = {
  action: DeadZoneRecommendationAction;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  blockers: string[];
};

export type DeadZoneMergeReviewResult = {
  decision: "merge_recommended" | "merge_blocked" | "keep_separate" | "needs_evidence";
  confidence: "low" | "medium" | "high";
  rationale: string[];
  blockers: string[];
  proposedCanonicalBody: string | null;
  proposedSummary: string | null;
  rawOutputExcerpt: string;
  parseStatus: "parsed" | "recovered" | "failed";
};

export type DeadZoneMergeReviewJob = {
  id: string;
  status: DistillationQueueStatus;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string | null;
  reviewItemId: string | null;
  provider: string;
  model: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  result: DeadZoneMergeReviewResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DeadZoneSimilarKnowledge = {
  id: string;
  title: string;
  status: "draft" | "active" | "deprecated";
  similarity: number;
  applicabilityMatch: "low" | "medium" | "high";
  evidenceStrength: "none" | "thin" | "moderate" | "strong";
  usageStrength: "none" | "low" | "moderate" | "strong";
  suggestedAction:
    | "merge_into_similar"
    | "deadzone_is_canonical"
    | "likely_duplicate"
    | "scope_differs"
    | "needs_evidence"
    | "keep_separate";
  reasons: string[];
};

export type DeadZoneKnowledgeReviewItem = {
  knowledge: {
    id: string;
    title: string;
    bodyPreview: string;
    type: "rule" | "procedure";
    status: "draft" | "active" | "deprecated";
    appliesTo: Record<string, unknown>;
    confidence: number;
    importance: number;
    compileSelectCount: number;
    lastCompiledAt: string | null;
    sourceRefCount: number;
    sourceRefDensity: number;
    communityKey: string | null;
    communityLabel: string | null;
  };
  classification: {
    primary: "dead_zone_reachability_risk" | "dead_zone_stale";
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };
  indicators: {
    deadZoneScore: number;
    evidenceStrength: "none" | "thin" | "moderate" | "strong";
    usageStrength: "none" | "low" | "moderate" | "strong";
    structureQuality: "weak" | "partial" | "strong";
    graphHealth: "orphan" | "thin" | "connected";
    badges: DeadZoneKnowledgeReviewBadge[];
  };
  bestCanonicalCandidate: DeadZoneSimilarKnowledge | null;
  alternativeCandidates: DeadZoneSimilarKnowledge[];
  recommendation: DeadZoneReviewRecommendation;
  allowedActions: DeadZoneRecommendationAction[];
  similarKnowledge: DeadZoneSimilarKnowledge[];
  reviewItemId: string | null;
  mergeReviewJob?: DeadZoneMergeReviewJob | null;
};

export type DeadZoneKnowledgeReviewResponse = {
  generatedAt: string;
  windowDays: number;
  minSimilarity: number;
  similarTopK: number;
  communityCount: number;
  itemCount: number;
  unavailableReason: string | null;
  items: DeadZoneKnowledgeReviewItem[];
};

export type DeadZoneKnowledgeMaintenanceResult = {
  action: DeadZoneKnowledgeMaintenanceAction;
  keptKnowledgeId: string | null;
  deprecatedKnowledgeId: string;
};

export type DeadZoneKnowledgeReviewActionResult = {
  action: DeadZoneRecommendationAction;
  status: "recorded" | "applied";
  message: string;
  keptKnowledgeId?: string;
  deprecatedKnowledgeId?: string;
  reviewItemId?: string;
};

export type LandscapeSnapshotCacheType =
  | "landscape_snapshot"
  | "landscape_replay_snapshot"
  | "landscape_replay_comparison";

export type LandscapeSnapshotCacheStatus = {
  generatedAt: string;
  enabled: boolean;
  ttlSeconds: number;
  disabledReason?: string | null;
  snapshots: Array<{
    snapshotType: LandscapeSnapshotCacheType;
    readyCount: number;
    staleCount: number;
    expiredReadyCount: number;
    oldestGeneratedAt: string | null;
    latestGeneratedAt: string | null;
    latestExpiresAt: string | null;
    estimatedPayloadBytes: number;
    lastPurge: {
      purgedAt: string;
      staleDeletedCount: number;
      expiredDeletedCount: number;
      deletedCount: number;
      snapshotTypes: LandscapeSnapshotCacheType[];
      error: string | null;
    } | null;
  }>;
};

export type LandscapeRunStatusFilter = "ok" | "degraded" | "failed" | "all";

export type LandscapeVerdictMix = {
  used: number;
  notUsed: number;
  offTopic: number;
  wrong: number;
};

export type LandscapeBasinExplanation =
  | "aligned_attractor"
  | "negative_explained"
  | "dead_zone_missed"
  | "over_selected"
  | "unexplained";

export type LandscapeFacetBasinSummary = {
  facetKind:
    | "retrievalMode"
    | "repoKey"
    | "technology"
    | "changeType"
    | "domain"
    | "source"
    | "runStatus"
    | "degradedReasonBucket";
  facetValue: string;
  replayRunCount: number;
  selectedItemCount: number;
  selectedCommunityCount: number;
  attractorHitCount: number;
  negativeCandidateHitCount: number;
  overSelectedHitCount: number;
  deadZoneMissCount: number;
  usedRate: number;
  offTopicRate: number;
  wrongRate: number;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeCommunityReplaySummary = {
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  replayRunCount: number;
  selectedItemCount: number;
  classificationAtAnalysis: LandscapeClassificationPrimary;
  verdictMix: LandscapeVerdictMix;
  explanationCounts: Record<LandscapeBasinExplanation, number>;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeAcceptanceWindowSummary = {
  eventCountWindow: number;
  acceptedCountWindow: number;
  acceptedRunCountWindow: number;
  unknownAcceptanceCountWindow: number;
  agentActorEventCountWindow: number;
  acceptanceRateKnownWindow: number;
  acceptanceCoverageRate: number;
};

export type LandscapeCommunityComparison = {
  relationCommunityKey: string;
  relationCommunityLabel: string;
  relationCommunityRank: number;
  semanticCommunityKey?: string;
  comparison:
    | "aligned"
    | "semantic_split"
    | "semantic_merge"
    | "relation_orphan"
    | "semantic_reachable_dead_zone";
  jaccardOverlap: number;
  relationCommunitySize: number;
  semanticCommunitySize: number;
  selectedNeighborCountWindow: number;
  selectedNeighborKnowledgeIds: string[];
  deadZoneSemanticReachabilityScore: number;
};

export type LandscapeReplaySnapshot = {
  generatedAt: string;
  analysisAsOf: string;
  windowDays: number;
  corpusWindow: {
    startAt: string;
    endAt: string;
  };
  landscapeWindow: {
    days: number;
    analysisAsOf: string;
  };
  basis: {
    unit: "community-replay";
    relationAxes: GraphRelationAxis[];
    runStatus: LandscapeRunStatusFilter;
    landscapeStatus: GraphStatusFilter;
    minSimilarity: number;
    semanticTopK: number;
  };
  replayRunCount: number;
  selectedKnowledgeCount: number;
  missingKnowledgeCount: number;
  runs: unknown[];
  facetSummaries: LandscapeFacetBasinSummary[];
  communityReplaySummaries: LandscapeCommunityReplaySummary[];
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
  communityComparison: {
    universeKnowledgeCount: number;
    comparedKnowledgeCount: number;
    missingRelationAssignmentCount: number;
    missingSemanticAssignmentCount: number;
    alignedCount: number;
    semanticSplitCount: number;
    semanticMergeCount: number;
    relationOrphanCount: number;
    semanticReachableDeadZoneCount: number;
    communities: LandscapeCommunityComparison[];
  };
};

export type LandscapeReplayComparisonKind =
  | "stable"
  | "drifted"
  | "lost_baseline"
  | "new_only"
  | "no_current_match"
  | "not_comparable";

export type LandscapeReplayComparisonRun = {
  runId: string;
  createdAt: string;
  goal: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  identityCompatibility: "comparable" | "legacy_identity_unknown";
  taskFacets: {
    repoKey?: string;
    repoPath?: string;
    retrievalMode: string;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
    source: string;
    runStatus: "ok" | "degraded" | "failed";
    degradedReasonBuckets: string[];
  };
  baselineSelectedKnowledgeIds: string[];
  currentRetrievedKnowledgeIds: string[];
  retainedKnowledgeIds: string[];
  missingFromCurrentKnowledgeIds: string[];
  newlyRetrievedKnowledgeIds: string[];
  baselineVerdicts: LandscapeVerdictMix;
  usedBaselineRetainedKnowledgeIds: string[];
  usedBaselineLostKnowledgeIds: string[];
  offTopicBaselineKnowledgeIds: string[];
  wrongBaselineKnowledgeIds: string[];
  overlapRate: number;
  replacementRate: number;
  comparison: LandscapeReplayComparisonKind;
  currentDegradedReasons: string[];
  currentRetrievalStats: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    textFailed: boolean;
    vectorFailed: boolean;
    embeddingStatus: "provided" | "generated" | "unavailable" | "disabled";
    repoScopeFallbackUsed: boolean;
  };
};

export type LandscapeAppliesToRefineCandidate = {
  runId: string;
  knowledgeId: string;
  reason:
    | "used_baseline_lost"
    | "baseline_off_topic"
    | "baseline_wrong"
    | "baseline_missing_after_recompile";
  confidence: "low" | "medium";
  suggestedAppliesTo: {
    repoKey?: string;
    repoPath?: string;
    retrievalMode: string;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
  };
  evidence: string[];
};

export type LandscapeReplayComparisonResponse = {
  generatedAt: string;
  analysisAsOf: string;
  windowDays: number;
  corpusWindow: {
    startAt: string;
    endAt: string;
  };
  basis: {
    unit: "replay-comparison";
    mode: "current_retrieval";
    runStatus: LandscapeRunStatusFilter;
    currentLimit: number;
  };
  replayRunCount: number;
  comparedRunCount: number;
  baselineSelectedItemCount: number;
  currentRetrievedItemCount: number;
  retainedItemCount: number;
  missingFromCurrentItemCount: number;
  newlyRetrievedItemCount: number;
  usedBaselineLostItemCount: number;
  averageOverlapRate: number;
  currentNoMatchRunCount: number;
  comparisonCounts: Record<LandscapeReplayComparisonKind, number>;
  recompilePlan: {
    mode: "current_retrieval_dry_run";
    writesCompileRuns: false;
    replayRunCount: number;
    comparedRunCount: number;
    blockers: string[];
  };
  rankingExperiments: Array<{
    experiment:
      | "current_retrieval"
      | "used_baseline_retention"
      | "negative_repulsion"
      | "diversity_exploration";
    productionEnabled: false;
    targetRunCount: number;
    estimatedRetainedItemCount: number;
    estimatedMissingFromCurrentItemCount: number;
    estimatedUsedBaselineLostItemCount: number;
    estimatedAverageOverlapRate: number;
    riskReductionSignal: number;
    recommendation: string;
  }>;
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
  promotionGateSummary: {
    productionEnabled: false;
    gateMode: "normal" | "review_required";
    shouldTighten: boolean;
    affectedRunCount: number;
    riskyNewKnowledgeCount: number;
    reason: string;
  };
  scoreTuning: {
    productionEnabled: false;
    stableRunCount: number;
    driftedRunCount: number;
    lostBaselineRunCount: number;
    negativeFeedbackRunCount: number;
    highChurnRunCount: number;
    lostUsedBaselineRunCount: number;
    noCurrentMatchRunCount: number;
    averageReplacementRate: number;
    recommendations: string[];
  };
  compileInterventionPlan: {
    productionEnabled: false;
    strategy:
      | "observe_only"
      | "retain_used_baseline"
      | "repel_negative_candidates"
      | "diversity_exploration";
    candidateRunCount: number;
    reason: string;
  };
  runs: LandscapeReplayComparisonRun[];
};
