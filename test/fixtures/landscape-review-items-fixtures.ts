import type { LandscapeAppliesToRefineCandidate } from "../../src/modules/landscape/landscape-replay.types.js";
import type { LandscapeReplayComparisonResponse } from "../../src/modules/landscape/landscape-replay.types.js";
import type { LandscapeReplaySnapshot } from "../../src/modules/landscape/landscape-replay.types.js";

export function replayComparisonFixture(): {
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
} {
  return {
    appliesToRefineCandidates: [
      {
        runId: "run-1",
        knowledgeId: "knowledge-1",
        reason: "baseline_wrong",
        confidence: "medium",
        suggestedAppliesTo: {
          retrievalMode: "task_context",
          technologies: ["typescript"],
          changeTypes: ["feature"],
          domains: ["graph-ui"],
        },
        evidence: ["wrong baseline"],
      },
    ],
  };
}

export function reviewItemRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-item-1",
    source: "replay_compare",
    reason: "baseline_wrong",
    status: "pending",
    proposedAction: "review_wrong",
    priority: 95,
    confidence: "medium",
    idempotencyKey: "replay_compare:baseline_wrong:run-1:knowledge-1",
    knowledgeId: "knowledge-1",
    runId: "run-1",
    triggerEventId: null,
    communityKey: null,
    communityLabel: null,
    suggestedAppliesTo: {},
    evidence: [],
    payload: {},
    note: null,
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    resolvedAt: null,
    ...overrides,
  };
}

export function landscapeSnapshotFixture() {
  return {
    generatedAt: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    basis: { unit: "community", relationAxes: ["session", "project", "source"], status: "active" },
    thresholds: {
      minSelectedCount: 3,
      minFeedbackCount: 3,
      feedbackConfidence: { mediumMin: 10, highMin: 30 },
      feedbackFactor: { insufficient: 0.4, low: 0.7, medium: 0.9, high: 1 },
      attractor: { strongUsedRateMin: 0.7, usefulUsedRateMin: 0.5, strongSourceRefDensityMin: 0.6 },
      negative: { offTopicWeight: 1, wrongWeight: 3, candidateOffTopicRateMin: 0.4 },
      notUsed: { overSelectedRateMin: 0.6 },
      deadZone: { reachabilityRiskMin: 0.3, staleSourceRefDensityMax: 0.5, staleFactorMin: 0.5 },
      evidenceFactor: { sourceRefDensityBaseline: 1, min: 0.25, max: 1.25 },
    },
    stats: {
      totalCommunities: 1,
      activeCommunities: 1,
      selectedCommunities: 1,
      insufficientFeedbackCommunities: 0,
      strongAttractorCount: 0,
      usefulAttractorCount: 0,
      negativeCandidateCount: 1,
      overSelectedNotUsedCount: 0,
      deadZoneReachabilityCount: 0,
      deadZoneStaleCount: 0,
    },
    communities: [
      {
        communityId: "community:1",
        communityKey: "a".repeat(64),
        communityLabel: "Auth Boundary",
        communityRank: 1,
        size: 3,
        memberCounts: { active: 3, draft: 0, deprecated: 0, rule: 2, procedure: 1, embedded: 3 },
        selection: {
          selectedItemCountWindow: 12,
          selectedRunCountWindow: 8,
          cumulativeCompileSelectCount: 22,
          zeroUseActiveCount: 0,
          zeroUseActiveRatio: 0,
        },
        feedback: {
          usedCountWindow: 4,
          notUsedCountWindow: 3,
          offTopicCountWindow: 2,
          wrongCountWindow: 0,
          feedbackCountWindow: 9,
          usedRate: 0.45,
          notUsedRate: 0.33,
          offTopicRate: 0.22,
          wrongRate: 0,
          feedbackConfidence: "medium",
        },
        quality: {
          avgImportance: 80,
          avgConfidence: 75,
          avgDynamicScore: 24,
          sourceRefCount: 6,
          sourceRefDensity: 2,
          avgFreshnessFactor: 0.88,
          avgStalenessFactor: 0.12,
        },
        scores: {
          activity: 12,
          attractorScore: 1.9,
          negativeScore: 2.2,
          reachabilityRiskScore: 0.2,
        },
        classification: {
          primary: "negative_attractor_candidate",
          flags: [],
          confidence: "high",
          reason: "off_topic 比率が高い",
        },
        recommendedActions: ["appliesTo を見直す"],
        representativeKnowledgeIds: ["k-1", "k-2", "k-3"],
      },
    ],
    risks: [
      {
        communityId: "community:1",
        communityKey: "a".repeat(64),
        communityLabel: "Auth Boundary",
        communityRank: 1,
        type: "negative_attractor_candidate",
        severity: "high",
        reason: "negative signal observed",
      },
    ],
  };
}

export function landscapeReplaySnapshotFixture(): LandscapeReplaySnapshot {
  return {
    generatedAt: "2026-05-24T00:00:00.000Z",
    analysisAsOf: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    corpusWindow: { startAt: "2026-04-24T00:00:00.000Z", endAt: "2026-05-24T00:00:00.000Z" },
    landscapeWindow: { days: 30, analysisAsOf: "2026-05-24T00:00:00.000Z" },
    basis: {
      unit: "community-replay",
      relationAxes: ["session", "project", "source"],
      runStatus: "all",
      landscapeStatus: "active",
      minSimilarity: 0.72,
      semanticTopK: 3,
    },
    replayRunCount: 0,
    selectedKnowledgeCount: 0,
    missingKnowledgeCount: 0,
    runs: [],
    facetSummaries: [],
    communityReplaySummaries: [],
    acceptanceWindow: {
      eventCountWindow: 0,
      acceptedCountWindow: 0,
      acceptedRunCountWindow: 0,
      unknownAcceptanceCountWindow: 0,
      agentActorEventCountWindow: 0,
      acceptanceRateKnownWindow: 0,
      acceptanceCoverageRate: 0,
    },
    communityComparison: {
      universeKnowledgeCount: 100,
      comparedKnowledgeCount: 80,
      missingRelationAssignmentCount: 0,
      missingSemanticAssignmentCount: 0,
      alignedCount: 0,
      semanticSplitCount: 1,
      semanticMergeCount: 0,
      relationOrphanCount: 0,
      semanticReachableDeadZoneCount: 0,
      communities: [
        {
          relationCommunityKey: "b".repeat(64),
          relationCommunityLabel: "User Session",
          relationCommunityRank: 2,
          semanticCommunityKey: "c".repeat(64),
          comparison: "semantic_split",
          jaccardOverlap: 0.31,
          relationCommunitySize: 10,
          semanticCommunitySize: 14,
          selectedNeighborCountWindow: 4,
          selectedNeighborKnowledgeIds: ["k-11", "k-12", "k-13", "k-14"],
          deadZoneSemanticReachabilityScore: 0.2,
        },
      ],
    },
  };
}

export function replayComparisonForPromotionGate(
  gateMode: "normal" | "review_required",
): LandscapeReplayComparisonResponse {
  return {
    generatedAt: "2026-05-24T00:00:00.000Z",
    analysisAsOf: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    corpusWindow: { startAt: "2026-04-24T00:00:00.000Z", endAt: "2026-05-24T00:00:00.000Z" },
    basis: {
      unit: "replay-comparison",
      mode: "current_retrieval",
      runStatus: "all",
      currentLimit: 12,
    },
    replayRunCount: 0,
    comparedRunCount: 0,
    baselineSelectedItemCount: 0,
    currentRetrievedItemCount: 0,
    retainedItemCount: 0,
    missingFromCurrentItemCount: 0,
    newlyRetrievedItemCount: 0,
    usedBaselineLostItemCount: 0,
    averageOverlapRate: 0,
    currentNoMatchRunCount: 0,
    comparisonCounts: {
      stable: 0,
      drifted: 0,
      lost_baseline: 0,
      new_only: 0,
      no_current_match: 0,
      not_comparable: 0,
    },
    recompilePlan: {
      mode: "current_retrieval_dry_run",
      writesCompileRuns: false,
      replayRunCount: 0,
      comparedRunCount: 0,
      blockers: [],
    },
    rankingExperiments: [],
    appliesToRefineCandidates: [],
    promotionGateSummary: {
      productionEnabled: false,
      gateMode,
      shouldTighten: gateMode === "review_required",
      affectedRunCount: gateMode === "review_required" ? 4 : 0,
      riskyNewKnowledgeCount: gateMode === "review_required" ? 7 : 0,
      reason:
        gateMode === "review_required" ? "used baseline loss and churn exceeded threshold" : "none",
    },
    scoreTuning: {
      productionEnabled: false,
      stableRunCount: 0,
      driftedRunCount: 0,
      lostBaselineRunCount: 0,
      negativeFeedbackRunCount: 0,
      highChurnRunCount: 0,
      lostUsedBaselineRunCount: 0,
      noCurrentMatchRunCount: 0,
      averageReplacementRate: 0,
      recommendations: [],
    },
    compileInterventionPlan: {
      productionEnabled: false,
      strategy: "observe_only",
      candidateRunCount: 0,
      reason: "none",
    },
    runs: [],
  };
}
