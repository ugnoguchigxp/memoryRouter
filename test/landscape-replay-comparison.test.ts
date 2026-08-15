import { beforeEach, describe, expect, test, vi } from "vitest";

const { loadLandscapeReplayCorpusMock, retrieveKnowledgeMock } = vi.hoisted(() => ({
  loadLandscapeReplayCorpusMock: vi.fn(),
  retrieveKnowledgeMock: vi.fn(),
}));

vi.mock("../src/modules/landscape/landscape-replay.repository.js", () => ({
  loadLandscapeReplayCorpus: loadLandscapeReplayCorpusMock,
}));

vi.mock("../src/modules/knowledge/knowledge.service.js", () => ({
  retrieveKnowledge: retrieveKnowledgeMock,
}));

import { buildLandscapeReplayComparison } from "../src/modules/landscape/landscape-replay-comparison.service.js";
import { landscapeReplayComparisonResponseSchema } from "../src/shared/schemas/landscape-replay.schema.js";

describe("landscape replay comparison service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadLandscapeReplayCorpusMock.mockResolvedValue({
      runs: [
        {
          id: "run-1",
          goal: "Compare replay retrieval",
          intent: "test",
          projectRef: null,
          repoKey: null,
          repoPath: "/repo",
          matchBasis: "repo_path",
          identityContractVersion: 1,
          scopeMode: "project",
          input: {
            technologies: ["TypeScript"],
            domains: ["landscape"],
            changeTypes: ["feature"],
            projectIdentity: {
              contractVersion: 1,
              scopeMode: "project",
              matchBasis: "repo_path",
              matchValue: "/repo",
              projectRef: null,
              repoKey: null,
              repoPath: "/repo",
            },
          },
          retrievalMode: "task_context",
          status: "ok",
          degradedReasons: [],
          source: "mcp",
          packSnapshot: null,
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
      packItems: [
        {
          runId: "run-1",
          itemKind: "rule",
          itemId: "k1",
          score: 0.9,
          rankingReason: "",
          sourceRefs: [],
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          runId: "run-1",
          itemKind: "rule",
          itemId: "k2",
          score: 0.8,
          rankingReason: "",
          sourceRefs: [],
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
      usageEvents: [
        {
          runId: "run-1",
          knowledgeId: "k1",
          verdict: "used",
          actor: "agent",
          reason: null,
          metadata: {},
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          runId: "run-1",
          knowledgeId: "k2",
          verdict: "off_topic",
          actor: "user",
          reason: null,
          metadata: {},
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ],
    });
    retrieveKnowledgeMock.mockResolvedValue({
      items: [
        { id: "k1", score: 0.95 },
        { id: "k3", score: 0.7 },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 2,
        vectorHitCount: 1,
        mergedCount: 2,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "Compare replay retrieval",
      },
    });
  });

  test("compares baseline selected knowledge with current retrieval without writing compile runs", async () => {
    const response = await buildLandscapeReplayComparison({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      includeRuns: true,
    });

    expect(loadLandscapeReplayCorpusMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
    });
    expect(retrieveKnowledgeMock).toHaveBeenCalledWith(
      {
        goal: "Compare replay retrieval",
        repoPath: "/repo",
        technologies: ["typescript"],
        changeTypes: ["feature"],
        domains: ["landscape"],
      },
      {
        retrievalMode: "task_context",
        limit: 12,
        facetFilters: {
          technologies: ["typescript"],
          changeTypes: ["feature"],
          domains: ["landscape"],
        },
      },
    );
    expect(response.comparedRunCount).toBe(1);
    expect(landscapeReplayComparisonResponseSchema.safeParse(response).success).toBe(true);
    expect(response.baselineSelectedItemCount).toBe(2);
    expect(response.currentRetrievedItemCount).toBe(2);
    expect(response.retainedItemCount).toBe(1);
    expect(response.missingFromCurrentItemCount).toBe(1);
    expect(response.newlyRetrievedItemCount).toBe(1);
    expect(response.averageOverlapRate).toBe(0.5);
    expect(response.comparisonCounts.drifted).toBe(1);
    expect(response.recompilePlan).toEqual({
      mode: "current_retrieval_dry_run",
      writesCompileRuns: false,
      replayRunCount: 1,
      comparedRunCount: 1,
      blockers: [],
    });
    expect(response.rankingExperiments.map((experiment) => experiment.experiment)).toEqual([
      "current_retrieval",
      "used_baseline_retention",
      "negative_repulsion",
      "diversity_exploration",
    ]);
    expect(response.scoreTuning).toEqual(
      expect.objectContaining({
        productionEnabled: false,
        driftedRunCount: 1,
        highChurnRunCount: 1,
        negativeFeedbackRunCount: 1,
        lostUsedBaselineRunCount: 0,
      }),
    );
    expect(response.appliesToRefineCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-1",
          knowledgeId: "k2",
          reason: "baseline_off_topic",
          confidence: "medium",
          suggestedAppliesTo: {
            repoPath: "/repo",
            retrievalMode: "task_context",
            technologies: ["typescript"],
            changeTypes: ["feature"],
            domains: ["landscape"],
          },
        }),
        expect.objectContaining({
          runId: "run-1",
          knowledgeId: "k2",
          reason: "baseline_missing_after_recompile",
          confidence: "low",
        }),
      ]),
    );
    expect(response.promotionGateSummary).toEqual(
      expect.objectContaining({
        productionEnabled: false,
        gateMode: "review_required",
        shouldTighten: true,
        affectedRunCount: 1,
      }),
    );
    expect(response.compileInterventionPlan).toEqual(
      expect.objectContaining({
        productionEnabled: false,
        strategy: "repel_negative_candidates",
        candidateRunCount: 1,
      }),
    );
    expect(response.runs[0]).toEqual(
      expect.objectContaining({
        runId: "run-1",
        baselineSelectedKnowledgeIds: ["k1", "k2"],
        currentRetrievedKnowledgeIds: ["k1", "k3"],
        retainedKnowledgeIds: ["k1"],
        missingFromCurrentKnowledgeIds: ["k2"],
        newlyRetrievedKnowledgeIds: ["k3"],
        baselineVerdicts: {
          used: 1,
          notUsed: 0,
          offTopic: 1,
          wrong: 0,
        },
        usedBaselineRetainedKnowledgeIds: ["k1"],
        usedBaselineLostKnowledgeIds: [],
        offTopicBaselineKnowledgeIds: ["k2"],
        wrongBaselineKnowledgeIds: [],
        comparison: "drifted",
      }),
    );
  });
});
