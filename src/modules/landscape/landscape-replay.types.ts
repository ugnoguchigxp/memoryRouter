import type {
  LandscapeClassificationConfidence,
  LandscapeClassificationPrimary,
  LandscapeFeedbackConfidence,
  LandscapeGraphRelationAxis,
  LandscapeGraphStatusFilter,
} from "./landscape.types.js";

export type LandscapeRunStatus = "ok" | "degraded" | "failed";
export type LandscapeRunStatusFilter = LandscapeRunStatus | "all";

export type LandscapeUsageVerdict = "used" | "not_used" | "off_topic" | "wrong";
export type LandscapeFeedbackActor = "agent" | "user" | "system";

export type LandscapeVerdictMix = {
  used: number;
  notUsed: number;
  offTopic: number;
  wrong: number;
};

export type LandscapeTaskFacetKind =
  | "retrievalMode"
  | "repoKey"
  | "technology"
  | "changeType"
  | "domain"
  | "source"
  | "runStatus"
  | "degradedReasonBucket";

export type LandscapeTaskFacetEntry = {
  facetKind: LandscapeTaskFacetKind;
  facetValue: string;
};

export type LandscapeTaskFacets = {
  repoKey?: string;
  repoPath?: string;
  retrievalMode: string;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  source: string;
  runStatus: LandscapeRunStatus;
  degradedReasonBuckets: string[];
};

export type LandscapeBasinExplanation =
  | "aligned_attractor"
  | "negative_explained"
  | "dead_zone_missed"
  | "over_selected"
  | "unexplained";

export type LandscapeBasinTrace = {
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  selectedItemCount: number;
  selectedRanks: number[];
  classificationAtAnalysis: LandscapeClassificationPrimary;
  classificationConfidenceAtAnalysis: LandscapeClassificationConfidence;
  feedbackConfidenceAtAnalysis: LandscapeFeedbackConfidence;
  verdictMix: LandscapeVerdictMix;
  explanation: LandscapeBasinExplanation;
};

export type LandscapeReplayRun = {
  runId: string;
  createdAt: string;
  goal: string;
  retrievalMode: string;
  status: LandscapeRunStatus;
  source: string;
  taskFacets: LandscapeTaskFacets;
  selectedKnowledgeIds: string[];
  selectedCommunityKeys: string[];
  missingKnowledgeIds: string[];
  verdicts: LandscapeVerdictMix;
  basinTrace: LandscapeBasinTrace[];
};

export type LandscapeFacetBasinSummary = {
  facetKind: LandscapeTaskFacetKind;
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

export type LandscapeCommunityComparisonKind =
  | "aligned"
  | "semantic_split"
  | "semantic_merge"
  | "relation_orphan"
  | "semantic_reachable_dead_zone";

export type LandscapeCommunityComparison = {
  relationCommunityKey: string;
  relationCommunityLabel: string;
  relationCommunityRank: number;
  semanticCommunityKey?: string;
  comparison: LandscapeCommunityComparisonKind;
  jaccardOverlap: number;
  relationCommunitySize: number;
  semanticCommunitySize: number;
  selectedNeighborCountWindow: number;
  selectedNeighborKnowledgeIds: string[];
  deadZoneSemanticReachabilityScore: number;
};

export type LandscapeCommunityComparisonSummary = {
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

export type LandscapeReplayComparisonKind =
  | "stable"
  | "drifted"
  | "lost_baseline"
  | "new_only"
  | "no_current_match"
  | "not_comparable";

export type LandscapeReplayRecompilePlan = {
  mode: "current_retrieval_dry_run";
  writesCompileRuns: false;
  replayRunCount: number;
  comparedRunCount: number;
  blockers: string[];
};

export type LandscapeRankingExperimentKind =
  | "current_retrieval"
  | "used_baseline_retention"
  | "negative_repulsion"
  | "diversity_exploration";

export type LandscapeRankingExperimentSummary = {
  experiment: LandscapeRankingExperimentKind;
  productionEnabled: false;
  targetRunCount: number;
  estimatedRetainedItemCount: number;
  estimatedMissingFromCurrentItemCount: number;
  estimatedUsedBaselineLostItemCount: number;
  estimatedAverageOverlapRate: number;
  riskReductionSignal: number;
  recommendation: string;
};

export type LandscapeAppliesToRefineReason =
  | "used_baseline_lost"
  | "baseline_off_topic"
  | "baseline_wrong"
  | "baseline_missing_after_recompile";

export type LandscapeAppliesToRefineCandidate = {
  runId: string;
  knowledgeId: string;
  reason: LandscapeAppliesToRefineReason;
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

export type LandscapePromotionGateSummary = {
  productionEnabled: false;
  gateMode: "normal" | "review_required";
  shouldTighten: boolean;
  affectedRunCount: number;
  riskyNewKnowledgeCount: number;
  reason: string;
};

export type LandscapeScoreTuningSummary = {
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

export type LandscapeCompileInterventionPlan = {
  productionEnabled: false;
  strategy:
    | "observe_only"
    | "retain_used_baseline"
    | "repel_negative_candidates"
    | "diversity_exploration";
  candidateRunCount: number;
  reason: string;
};

export type LandscapeReplayComparisonRun = {
  runId: string;
  createdAt: string;
  goal: string;
  retrievalMode: string;
  status: LandscapeRunStatus;
  identityCompatibility: "comparable" | "legacy_identity_unknown";
  taskFacets: LandscapeTaskFacets;
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
  recompilePlan: LandscapeReplayRecompilePlan;
  rankingExperiments: LandscapeRankingExperimentSummary[];
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
  promotionGateSummary: LandscapePromotionGateSummary;
  scoreTuning: LandscapeScoreTuningSummary;
  compileInterventionPlan: LandscapeCompileInterventionPlan;
  runs: LandscapeReplayComparisonRun[];
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
    relationAxes: LandscapeGraphRelationAxis[];
    runStatus: LandscapeRunStatusFilter;
    landscapeStatus: LandscapeGraphStatusFilter;
    minSimilarity: number;
    semanticTopK: number;
  };
  replayRunCount: number;
  selectedKnowledgeCount: number;
  missingKnowledgeCount: number;
  runs: LandscapeReplayRun[];
  facetSummaries: LandscapeFacetBasinSummary[];
  communityReplaySummaries: LandscapeCommunityReplaySummary[];
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
  communityComparison: LandscapeCommunityComparisonSummary;
};

export type BuildLandscapeReplaySnapshotInput = {
  windowDays: number;
  limit: number;
  landscapeLimit: number;
  runStatus: LandscapeRunStatusFilter;
  landscapeStatus: LandscapeGraphStatusFilter;
  relationAxes: LandscapeGraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  includeRuns: boolean;
};

export type BuildLandscapeReplayComparisonInput = {
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  includeRuns: boolean;
};
