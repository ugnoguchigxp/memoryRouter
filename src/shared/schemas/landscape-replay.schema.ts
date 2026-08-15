import { z } from "zod";
import {
  landscapeClassificationConfidenceSchema,
  landscapeClassificationPrimarySchema,
  landscapeFeedbackConfidenceSchema,
  landscapeRelationAxisSchema,
  landscapeStatusFilterSchema,
} from "./landscape.schema.js";

export const landscapeRunStatusSchema = z.enum(["ok", "degraded", "failed"]);
export const landscapeRunStatusFilterSchema = z.enum(["ok", "degraded", "failed", "all"]);

export const landscapeVerdictMixSchema = z.object({
  used: z.number().int().nonnegative(),
  notUsed: z.number().int().nonnegative(),
  offTopic: z.number().int().nonnegative(),
  wrong: z.number().int().nonnegative(),
});

export const landscapeTaskFacetKindSchema = z.enum([
  "retrievalMode",
  "repoKey",
  "technology",
  "changeType",
  "domain",
  "source",
  "runStatus",
  "degradedReasonBucket",
]);

export const landscapeTaskFacetsSchema = z.object({
  repoKey: z.string().optional(),
  repoPath: z.string().optional(),
  retrievalMode: z.string(),
  technologies: z.array(z.string()),
  changeTypes: z.array(z.string()),
  domains: z.array(z.string()),
  source: z.string(),
  runStatus: landscapeRunStatusSchema,
  degradedReasonBuckets: z.array(z.string()),
});

export const landscapeBasinExplanationSchema = z.enum([
  "aligned_attractor",
  "negative_explained",
  "dead_zone_missed",
  "over_selected",
  "unexplained",
]);

export const landscapeBasinTraceSchema = z.object({
  communityKey: z.string().min(1),
  communityLabel: z.string().min(1),
  communityRank: z.number().int().positive(),
  selectedItemCount: z.number().int().nonnegative(),
  selectedRanks: z.array(z.number().int().positive()),
  classificationAtAnalysis: landscapeClassificationPrimarySchema,
  classificationConfidenceAtAnalysis: landscapeClassificationConfidenceSchema,
  feedbackConfidenceAtAnalysis: landscapeFeedbackConfidenceSchema,
  verdictMix: landscapeVerdictMixSchema,
  explanation: landscapeBasinExplanationSchema,
});

export const landscapeReplayRunSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  goal: z.string(),
  retrievalMode: z.string(),
  status: landscapeRunStatusSchema,
  source: z.string(),
  taskFacets: landscapeTaskFacetsSchema,
  selectedKnowledgeIds: z.array(z.string()),
  selectedCommunityKeys: z.array(z.string()),
  missingKnowledgeIds: z.array(z.string()),
  verdicts: landscapeVerdictMixSchema,
  basinTrace: z.array(landscapeBasinTraceSchema),
});

export const landscapeAcceptanceWindowSummarySchema = z.object({
  eventCountWindow: z.number().int().nonnegative(),
  acceptedCountWindow: z.number().int().nonnegative(),
  acceptedRunCountWindow: z.number().int().nonnegative(),
  unknownAcceptanceCountWindow: z.number().int().nonnegative(),
  agentActorEventCountWindow: z.number().int().nonnegative(),
  acceptanceRateKnownWindow: z.number().nonnegative(),
  acceptanceCoverageRate: z.number().nonnegative(),
});

export const landscapeFacetBasinSummarySchema = z.object({
  facetKind: landscapeTaskFacetKindSchema,
  facetValue: z.string(),
  replayRunCount: z.number().int().nonnegative(),
  selectedItemCount: z.number().int().nonnegative(),
  selectedCommunityCount: z.number().int().nonnegative(),
  attractorHitCount: z.number().int().nonnegative(),
  negativeCandidateHitCount: z.number().int().nonnegative(),
  overSelectedHitCount: z.number().int().nonnegative(),
  deadZoneMissCount: z.number().int().nonnegative(),
  usedRate: z.number().nonnegative(),
  offTopicRate: z.number().nonnegative(),
  wrongRate: z.number().nonnegative(),
  feedbackCoverageRate: z.number().nonnegative(),
  acceptanceWindow: landscapeAcceptanceWindowSummarySchema,
});

export const landscapeCommunityReplaySummarySchema = z.object({
  communityKey: z.string().min(1),
  communityLabel: z.string().min(1),
  communityRank: z.number().int().positive(),
  replayRunCount: z.number().int().nonnegative(),
  selectedItemCount: z.number().int().nonnegative(),
  classificationAtAnalysis: landscapeClassificationPrimarySchema,
  verdictMix: landscapeVerdictMixSchema,
  explanationCounts: z.object({
    aligned_attractor: z.number().int().nonnegative(),
    negative_explained: z.number().int().nonnegative(),
    dead_zone_missed: z.number().int().nonnegative(),
    over_selected: z.number().int().nonnegative(),
    unexplained: z.number().int().nonnegative(),
  }),
  feedbackCoverageRate: z.number().nonnegative(),
  acceptanceWindow: landscapeAcceptanceWindowSummarySchema,
});

export const landscapeCommunityComparisonKindSchema = z.enum([
  "aligned",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "semantic_reachable_dead_zone",
]);

export const landscapeCommunityComparisonSchema = z.object({
  relationCommunityKey: z.string().min(1),
  relationCommunityLabel: z.string().min(1),
  relationCommunityRank: z.number().int().positive(),
  semanticCommunityKey: z.string().optional(),
  comparison: landscapeCommunityComparisonKindSchema,
  jaccardOverlap: z.number().min(0).max(1),
  relationCommunitySize: z.number().int().nonnegative(),
  semanticCommunitySize: z.number().int().nonnegative(),
  selectedNeighborCountWindow: z.number().int().nonnegative(),
  selectedNeighborKnowledgeIds: z.array(z.string()),
  deadZoneSemanticReachabilityScore: z.number().min(0).max(1),
});

export const landscapeCommunityComparisonSummarySchema = z.object({
  universeKnowledgeCount: z.number().int().nonnegative(),
  comparedKnowledgeCount: z.number().int().nonnegative(),
  missingRelationAssignmentCount: z.number().int().nonnegative(),
  missingSemanticAssignmentCount: z.number().int().nonnegative(),
  alignedCount: z.number().int().nonnegative(),
  semanticSplitCount: z.number().int().nonnegative(),
  semanticMergeCount: z.number().int().nonnegative(),
  relationOrphanCount: z.number().int().nonnegative(),
  semanticReachableDeadZoneCount: z.number().int().nonnegative(),
  communities: z.array(landscapeCommunityComparisonSchema),
});

export const landscapeReplayComparisonKindSchema = z.enum([
  "stable",
  "drifted",
  "lost_baseline",
  "new_only",
  "no_current_match",
  "not_comparable",
]);

export const landscapeReplayRecompilePlanSchema = z.object({
  mode: z.literal("current_retrieval_dry_run"),
  writesCompileRuns: z.literal(false),
  replayRunCount: z.number().int().nonnegative(),
  comparedRunCount: z.number().int().nonnegative(),
  blockers: z.array(z.string()),
});

export const landscapeRankingExperimentKindSchema = z.enum([
  "current_retrieval",
  "used_baseline_retention",
  "negative_repulsion",
  "diversity_exploration",
]);

export const landscapeRankingExperimentSummarySchema = z.object({
  experiment: landscapeRankingExperimentKindSchema,
  productionEnabled: z.literal(false),
  targetRunCount: z.number().int().nonnegative(),
  estimatedRetainedItemCount: z.number().int().nonnegative(),
  estimatedMissingFromCurrentItemCount: z.number().int().nonnegative(),
  estimatedUsedBaselineLostItemCount: z.number().int().nonnegative(),
  estimatedAverageOverlapRate: z.number().min(0).max(1),
  riskReductionSignal: z.number().min(0).max(1),
  recommendation: z.string(),
});

export const landscapeAppliesToRefineReasonSchema = z.enum([
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
]);

export const landscapeAppliesToRefineCandidateSchema = z.object({
  runId: z.string().min(1),
  knowledgeId: z.string().min(1),
  reason: landscapeAppliesToRefineReasonSchema,
  confidence: z.enum(["low", "medium"]),
  suggestedAppliesTo: z.object({
    repoKey: z.string().optional(),
    repoPath: z.string().optional(),
    retrievalMode: z.string(),
    technologies: z.array(z.string()),
    changeTypes: z.array(z.string()),
    domains: z.array(z.string()),
  }),
  evidence: z.array(z.string()),
});

export const landscapePromotionGateSummarySchema = z.object({
  productionEnabled: z.literal(false),
  gateMode: z.enum(["normal", "review_required"]),
  shouldTighten: z.boolean(),
  affectedRunCount: z.number().int().nonnegative(),
  riskyNewKnowledgeCount: z.number().int().nonnegative(),
  reason: z.string(),
});

export const landscapeScoreTuningSummarySchema = z.object({
  productionEnabled: z.literal(false),
  stableRunCount: z.number().int().nonnegative(),
  driftedRunCount: z.number().int().nonnegative(),
  lostBaselineRunCount: z.number().int().nonnegative(),
  negativeFeedbackRunCount: z.number().int().nonnegative(),
  highChurnRunCount: z.number().int().nonnegative(),
  lostUsedBaselineRunCount: z.number().int().nonnegative(),
  noCurrentMatchRunCount: z.number().int().nonnegative(),
  averageReplacementRate: z.number().min(0).max(1),
  recommendations: z.array(z.string()),
});

export const landscapeCompileInterventionPlanSchema = z.object({
  productionEnabled: z.literal(false),
  strategy: z.enum([
    "observe_only",
    "retain_used_baseline",
    "repel_negative_candidates",
    "diversity_exploration",
  ]),
  candidateRunCount: z.number().int().nonnegative(),
  reason: z.string(),
});

export const landscapeReplayComparisonRunSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  goal: z.string(),
  retrievalMode: z.string(),
  status: landscapeRunStatusSchema,
  identityCompatibility: z.enum(["comparable", "legacy_identity_unknown"]),
  taskFacets: landscapeTaskFacetsSchema,
  baselineSelectedKnowledgeIds: z.array(z.string()),
  currentRetrievedKnowledgeIds: z.array(z.string()),
  retainedKnowledgeIds: z.array(z.string()),
  missingFromCurrentKnowledgeIds: z.array(z.string()),
  newlyRetrievedKnowledgeIds: z.array(z.string()),
  baselineVerdicts: landscapeVerdictMixSchema,
  usedBaselineRetainedKnowledgeIds: z.array(z.string()),
  usedBaselineLostKnowledgeIds: z.array(z.string()),
  offTopicBaselineKnowledgeIds: z.array(z.string()),
  wrongBaselineKnowledgeIds: z.array(z.string()),
  overlapRate: z.number().min(0).max(1),
  replacementRate: z.number().min(0).max(1),
  comparison: landscapeReplayComparisonKindSchema,
  currentDegradedReasons: z.array(z.string()),
  currentRetrievalStats: z.object({
    textHitCount: z.number().int().nonnegative(),
    vectorHitCount: z.number().int().nonnegative(),
    mergedCount: z.number().int().nonnegative(),
    textFailed: z.boolean(),
    vectorFailed: z.boolean(),
    embeddingStatus: z.enum(["provided", "generated", "unavailable", "disabled"]),
    repoScopeFallbackUsed: z.boolean(),
  }),
});

export const landscapeReplayComparisonResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  analysisAsOf: z.string().datetime(),
  windowDays: z.number().int().min(1).max(180),
  corpusWindow: z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  }),
  basis: z.object({
    unit: z.literal("replay-comparison"),
    mode: z.literal("current_retrieval"),
    runStatus: landscapeRunStatusFilterSchema,
    currentLimit: z.number().int().min(1).max(50),
  }),
  replayRunCount: z.number().int().nonnegative(),
  comparedRunCount: z.number().int().nonnegative(),
  baselineSelectedItemCount: z.number().int().nonnegative(),
  currentRetrievedItemCount: z.number().int().nonnegative(),
  retainedItemCount: z.number().int().nonnegative(),
  missingFromCurrentItemCount: z.number().int().nonnegative(),
  newlyRetrievedItemCount: z.number().int().nonnegative(),
  usedBaselineLostItemCount: z.number().int().nonnegative(),
  averageOverlapRate: z.number().min(0).max(1),
  currentNoMatchRunCount: z.number().int().nonnegative(),
  comparisonCounts: z.object({
    stable: z.number().int().nonnegative(),
    drifted: z.number().int().nonnegative(),
    lost_baseline: z.number().int().nonnegative(),
    new_only: z.number().int().nonnegative(),
    no_current_match: z.number().int().nonnegative(),
    not_comparable: z.number().int().nonnegative(),
  }),
  recompilePlan: landscapeReplayRecompilePlanSchema,
  rankingExperiments: z.array(landscapeRankingExperimentSummarySchema),
  appliesToRefineCandidates: z.array(landscapeAppliesToRefineCandidateSchema),
  promotionGateSummary: landscapePromotionGateSummarySchema,
  scoreTuning: landscapeScoreTuningSummarySchema,
  compileInterventionPlan: landscapeCompileInterventionPlanSchema,
  runs: z.array(landscapeReplayComparisonRunSchema),
});

export const landscapeReplaySnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  analysisAsOf: z.string().datetime(),
  windowDays: z.number().int().min(1).max(180),
  corpusWindow: z.object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
  }),
  landscapeWindow: z.object({
    days: z.number().int().min(1).max(180),
    analysisAsOf: z.string().datetime(),
  }),
  basis: z.object({
    unit: z.literal("community-replay"),
    relationAxes: z.array(landscapeRelationAxisSchema),
    runStatus: landscapeRunStatusFilterSchema,
    landscapeStatus: landscapeStatusFilterSchema,
    minSimilarity: z.number().min(0).max(1),
    semanticTopK: z.number().int().min(1).max(10),
  }),
  replayRunCount: z.number().int().nonnegative(),
  selectedKnowledgeCount: z.number().int().nonnegative(),
  missingKnowledgeCount: z.number().int().nonnegative(),
  runs: z.array(landscapeReplayRunSchema),
  facetSummaries: z.array(landscapeFacetBasinSummarySchema),
  communityReplaySummaries: z.array(landscapeCommunityReplaySummarySchema),
  acceptanceWindow: landscapeAcceptanceWindowSummarySchema,
  communityComparison: landscapeCommunityComparisonSummarySchema,
});

export type LandscapeReplaySnapshot = z.infer<typeof landscapeReplaySnapshotSchema>;
export type LandscapeReplayComparisonResponse = z.infer<
  typeof landscapeReplayComparisonResponseSchema
>;
