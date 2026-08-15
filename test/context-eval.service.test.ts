import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { buildLandscapeReplayComparisonMock } = vi.hoisted(() => ({
  buildLandscapeReplayComparisonMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: buildLandscapeReplayComparisonMock,
}));

import { buildContextEvalReportFromReplay } from "../src/modules/landscape/context-eval.service.js";

describe("context eval service", () => {
  const previousCacheEnabled = process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = "true";
  });

  afterEach(() => {
    if (previousCacheEnabled === undefined) {
      process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = undefined;
    } else {
      process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED = previousCacheEnabled;
    }
  });

  test("builds read-only replay evaluation scores and risk buckets", async () => {
    buildLandscapeReplayComparisonMock.mockImplementation(async () => {
      expect(process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED).toBe("false");
      return {
        generatedAt: "2026-05-25T00:00:00.000Z",
        analysisAsOf: "2026-05-25T00:00:00.000Z",
        windowDays: 30,
        corpusWindow: {
          startAt: "2026-04-25T00:00:00.000Z",
          endAt: "2026-05-25T00:00:00.000Z",
        },
        basis: {
          unit: "replay-comparison",
          mode: "current_retrieval",
          runStatus: "all",
          currentLimit: 12,
        },
        replayRunCount: 2,
        comparedRunCount: 2,
        baselineSelectedItemCount: 5,
        currentRetrievedItemCount: 3,
        retainedItemCount: 2,
        missingFromCurrentItemCount: 3,
        newlyRetrievedItemCount: 1,
        usedBaselineLostItemCount: 1,
        averageOverlapRate: 0.25,
        currentNoMatchRunCount: 1,
        comparisonCounts: {
          stable: 0,
          drifted: 1,
          lost_baseline: 0,
          new_only: 0,
          no_current_match: 1,
          not_comparable: 0,
        },
        recompilePlan: {
          mode: "current_retrieval_dry_run",
          writesCompileRuns: false,
          replayRunCount: 2,
          comparedRunCount: 2,
          blockers: [],
        },
        rankingExperiments: [],
        appliesToRefineCandidates: [],
        promotionGateSummary: {
          productionEnabled: false,
          gateMode: "review_required",
          shouldTighten: true,
          affectedRunCount: 1,
          riskyNewKnowledgeCount: 1,
          reason: "review required",
        },
        scoreTuning: {
          productionEnabled: false,
          stableRunCount: 0,
          driftedRunCount: 1,
          lostBaselineRunCount: 0,
          negativeFeedbackRunCount: 1,
          highChurnRunCount: 0,
          lostUsedBaselineRunCount: 1,
          noCurrentMatchRunCount: 1,
          averageReplacementRate: 1 / 6,
          recommendations: [],
        },
        compileInterventionPlan: {
          productionEnabled: false,
          strategy: "retain_used_baseline",
          candidateRunCount: 1,
          reason: "retention first",
        },
        runs: [
          {
            runId: "run-1",
            createdAt: "2026-05-24T00:00:00.000Z",
            goal: "run 1 goal",
            retrievalMode: "task_context",
            status: "ok",
            taskFacets: {
              repoKey: "/repo",
              repoPath: "/repo",
              retrievalMode: "task_context",
              technologies: ["typescript"],
              changeTypes: ["feature"],
              domains: ["landscape"],
              source: "mcp",
              runStatus: "ok",
              degradedReasonBuckets: [],
            },
            baselineSelectedKnowledgeIds: ["k1", "k2", "k3", "k4"],
            currentRetrievedKnowledgeIds: ["k1", "k3", "k5"],
            retainedKnowledgeIds: ["k1", "k3"],
            missingFromCurrentKnowledgeIds: ["k2", "k4"],
            newlyRetrievedKnowledgeIds: ["k5"],
            baselineVerdicts: { used: 1, notUsed: 1, offTopic: 1, wrong: 1 },
            usedBaselineRetainedKnowledgeIds: ["k1"],
            usedBaselineLostKnowledgeIds: ["k2"],
            offTopicBaselineKnowledgeIds: ["k3"],
            wrongBaselineKnowledgeIds: ["k4"],
            overlapRate: 0.5,
            replacementRate: 1 / 3,
            comparison: "drifted",
            currentDegradedReasons: [],
            currentRetrievalStats: {
              textHitCount: 2,
              vectorHitCount: 1,
              mergedCount: 3,
              textFailed: false,
              vectorFailed: false,
              embeddingStatus: "generated",
              repoScopeFallbackUsed: false,
            },
          },
          {
            runId: "run-2",
            createdAt: "2026-05-24T02:00:00.000Z",
            goal: "run 2 goal",
            retrievalMode: "task_context",
            status: "degraded",
            taskFacets: {
              repoKey: "/repo",
              repoPath: "/repo",
              retrievalMode: "task_context",
              technologies: ["typescript"],
              changeTypes: ["bugfix"],
              domains: ["landscape"],
              source: "mcp",
              runStatus: "degraded",
              degradedReasonBuckets: ["no_content"],
            },
            baselineSelectedKnowledgeIds: ["k6"],
            currentRetrievedKnowledgeIds: [],
            retainedKnowledgeIds: [],
            missingFromCurrentKnowledgeIds: ["k6"],
            newlyRetrievedKnowledgeIds: [],
            baselineVerdicts: { used: 0, notUsed: 0, offTopic: 0, wrong: 0 },
            usedBaselineRetainedKnowledgeIds: [],
            usedBaselineLostKnowledgeIds: [],
            offTopicBaselineKnowledgeIds: [],
            wrongBaselineKnowledgeIds: [],
            overlapRate: 0,
            replacementRate: 0,
            comparison: "no_current_match",
            currentDegradedReasons: ["KNOWLEDGE_NO_CONTENT"],
            currentRetrievalStats: {
              textHitCount: 0,
              vectorHitCount: 0,
              mergedCount: 0,
              textFailed: true,
              vectorFailed: true,
              embeddingStatus: "disabled",
              repoScopeFallbackUsed: false,
            },
          },
        ],
      };
    });

    const report = await buildContextEvalReportFromReplay({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
    });

    expect(process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED).toBe("true");
    expect(report.source.readOnly).toBe(true);
    expect(report.source.cacheBypassed).toBe(true);
    expect(report.summary.status).toBe("needs_review");
    expect(report.scores.retentionScore.value).toBe(0.5);
    expect(report.scores.churnScore.value).toBeCloseTo(5 / 6, 6);
    expect(report.scores.repulsionScore.value).toBe(0.5);
    expect(report.scores.reachabilityScore.value).toBe(0.5);
    expect(report.scores.stabilityScore.value).toBe(0.5);
    expect(report.metrics.usedBaselineLostItemCount).toBe(1);
    expect(report.metrics.noCurrentMatchRunCount).toBe(1);
    expect(report.metrics.noContentRunCount).toBe(1);
    expect(report.usedBaselineLost.map((run) => run.runId)).toEqual(["run-1"]);
    expect(report.noCurrentMatchRuns.map((run) => run.runId)).toEqual(["run-2"]);
    expect(report.highChurnRuns).toHaveLength(0);
    expect(report.riskyRuns.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
    expect(report.recommendedNextAction.strategy).toBe("retain_used_baseline");
  });

  test("returns no_data summary when replay has no comparable runs", async () => {
    buildLandscapeReplayComparisonMock.mockResolvedValue({
      generatedAt: "2026-05-25T00:00:00.000Z",
      analysisAsOf: "2026-05-25T00:00:00.000Z",
      windowDays: 30,
      corpusWindow: {
        startAt: "2026-04-25T00:00:00.000Z",
        endAt: "2026-05-25T00:00:00.000Z",
      },
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
        gateMode: "normal",
        shouldTighten: false,
        affectedRunCount: 0,
        riskyNewKnowledgeCount: 0,
        reason: "normal",
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
        reason: "observe",
      },
      runs: [],
    });

    const report = await buildContextEvalReportFromReplay({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
    });

    expect(report.summary.status).toBe("no_data");
    expect(report.metrics.comparedRunCount).toBe(0);
    expect(report.riskyRuns).toHaveLength(0);
  });
});
