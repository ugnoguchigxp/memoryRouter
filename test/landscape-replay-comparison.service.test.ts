import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildLandscapeReplayComparison } from "../src/modules/landscape/landscape-replay-comparison.service.js";

// モック定義
const mockRetrieveKnowledge = vi.fn();
const mockLoadLandscapeReplayCorpus = vi.fn();
const mockRunWithLandscapeSnapshotCache = vi.fn();

vi.mock("../src/modules/knowledge/knowledge.service.js", () => ({
  retrieveKnowledge: (...args: any[]) => mockRetrieveKnowledge(...args),
}));

vi.mock("../src/modules/landscape/landscape-replay.repository.js", () => ({
  loadLandscapeReplayCorpus: (...args: any[]) => mockLoadLandscapeReplayCorpus(...args),
}));

vi.mock("../src/modules/landscape/landscape-snapshot-cache.service.js", () => ({
  runWithLandscapeSnapshotCache: (options: any) => mockRunWithLandscapeSnapshotCache(options),
}));

function comparableRepoPathRun(repoPath: string, input: Record<string, unknown> = {}) {
  return {
    projectRef: null,
    repoKey: null,
    repoPath,
    matchBasis: "repo_path",
    identityContractVersion: 1,
    scopeMode: "project",
    input: {
      ...input,
      projectIdentity: {
        contractVersion: 1,
        scopeMode: "project",
        matchBasis: "repo_path",
        matchValue: repoPath,
        projectRef: null,
        repoKey: null,
        repoPath,
      },
    },
  };
}

function comparableGlobalRun(input: Record<string, unknown> = {}) {
  return {
    projectRef: null,
    repoKey: null,
    repoPath: null,
    matchBasis: "none",
    identityContractVersion: 1,
    scopeMode: "global_only",
    input: {
      ...input,
      projectIdentity: {
        contractVersion: 1,
        scopeMode: "global_only",
        matchBasis: "none",
        matchValue: null,
        projectRef: null,
        repoKey: null,
        repoPath: null,
      },
    },
  };
}

describe("landscape-replay-comparison.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWithLandscapeSnapshotCache.mockImplementation((options: any) => options.build());
  });

  test("buildLandscapeReplayComparison analyzes replay drift and score tuning correctly", async () => {
    // 1件のダミー実行 (run) が含まれるコーパス
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-abc",
          createdAt: new Date(),
          goal: "test goal",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo", { decisionPoint: "test-point" }),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [{ runId: "run-abc", itemId: "kb-1", sortOrder: 0 }],
      usageEvents: [
        { runId: "run-abc", knowledgeId: "kb-1", verdict: "used" }, // used フィードバック
      ],
    });

    // retrieveKnowledge (新規実行の検索結果) のダミー戻り値
    mockRetrieveKnowledge.mockResolvedValue({
      items: [
        { id: "kb-1", title: "Dummy Knowledge" }, // 同じ kb-1 がヒットするので overlap は 100%
      ],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "unavailable",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const input = {
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    };

    const result = await buildLandscapeReplayComparison(input);

    expect(result.replayRunCount).toBe(1);
    expect(result.comparedRunCount).toBe(1);
    expect(result.retainedItemCount).toBe(1);
    expect(result.averageOverlapRate).toBe(1);
    expect(result.comparisonCounts.stable).toBe(1);
    expect(result.scoreTuning).toBeDefined();
    expect(result.promotionGateSummary.gateMode).toBe("normal");
  });

  test("buildLandscapeReplayComparison triggers review required gate when baseline loss or wrong verdicts occur", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-abc",
          createdAt: new Date(),
          goal: "test goal",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo", { decisionPoint: "test-point" }),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [{ runId: "run-abc", itemId: "kb-1", sortOrder: 0 }],
      usageEvents: [
        { runId: "run-abc", knowledgeId: "kb-1", verdict: "wrong" }, // wrong フィードバック
      ],
    });

    // 今回の検索では kb-1 がヒットせず、別の kb-2 がヒットする（ロストの発生）
    mockRetrieveKnowledge.mockResolvedValue({
      items: [{ id: "kb-2", title: "Different Knowledge" }],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "unavailable",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const input = {
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    };

    const result = await buildLandscapeReplayComparison(input);

    expect(result.retainedItemCount).toBe(0);
    expect(result.missingFromCurrentItemCount).toBe(1);
    expect(result.comparisonCounts.lost_baseline).toBe(1);

    // wrong フィードバックがあり、ロストが発生したため、プロモーションゲートが review_required になることを確認
    expect(result.promotionGateSummary.gateMode).toBe("review_required");
    expect(result.promotionGateSummary.shouldTighten).toBe(true);
    expect(result.appliesToRefineCandidates.length).toBeGreaterThan(0);
  });

  test("buildLandscapeReplayComparison handles complex drift scenarios and builds recommendations / experiments", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-churn-1",
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          goal: "run churn",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo-a", { decisionPoint: "pt-1" }),
          source: "mcp",
          degradedReasons: [],
        },
        {
          id: "run-nomatch-2",
          createdAt: new Date("2026-05-24T01:00:00.000Z"),
          goal: "run no match",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo-b", { decisionPoint: "pt-2" }),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [
        {
          runId: "run-churn-1",
          itemId: "kb-retained",
          sortOrder: 0,
          createdAt: new Date(),
          score: 70,
        },
        {
          runId: "run-churn-1",
          itemId: "kb-lost-used",
          sortOrder: 1,
          createdAt: new Date(),
          score: 70,
        },
        {
          runId: "run-churn-1",
          itemId: "kb-offtopic",
          sortOrder: 2,
          createdAt: new Date(),
          score: 70,
        },
        { runId: "run-nomatch-2", itemId: "kb-3", sortOrder: 0, createdAt: new Date(), score: 70 },
      ],
      usageEvents: [
        { runId: "run-churn-1", knowledgeId: "kb-retained", verdict: "used" },
        { runId: "run-churn-1", knowledgeId: "kb-lost-used", verdict: "used" },
        { runId: "run-churn-1", knowledgeId: "kb-offtopic", verdict: "off_topic" },
      ],
    });

    mockRetrieveKnowledge.mockImplementation(async (compileInput, options) => {
      if (compileInput.goal === "run churn") {
        return {
          items: [
            { id: "kb-retained", title: "Retained" },
            { id: "kb-new-1", title: "New 1" },
            { id: "kb-new-2", title: "New 2" },
            { id: "kb-new-3", title: "New 3" },
          ],
          stats: {
            textHitCount: 4,
            vectorHitCount: 0,
            mergedCount: 4,
            textFailed: false,
            vectorFailed: false,
            embeddingStatus: "unavailable",
            repoScopeFallbackUsed: false,
          },
          degradedReasons: [],
        };
      }
      return {
        items: [],
        stats: {
          textHitCount: 0,
          vectorHitCount: 0,
          mergedCount: 0,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "unavailable",
          repoScopeFallbackUsed: false,
        },
        degradedReasons: ["timeout"],
      };
    });

    const input = {
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    };

    const result = await buildLandscapeReplayComparison(input);

    expect(result.replayRunCount).toBe(2);
    expect(result.comparedRunCount).toBe(2);
    expect(result.currentNoMatchRunCount).toBe(1);

    expect(result.scoreTuning.highChurnRunCount).toBe(1);
    expect(result.scoreTuning.negativeFeedbackRunCount).toBe(1);
    expect(result.scoreTuning.lostUsedBaselineRunCount).toBe(1);
    expect(result.scoreTuning.noCurrentMatchRunCount).toBe(1);
    expect(result.scoreTuning.recommendations.length).toBeGreaterThan(0);

    expect(result.rankingExperiments.length).toBe(4);

    expect(result.appliesToRefineCandidates.length).toBeGreaterThan(0);
    const hasLostUsed = result.appliesToRefineCandidates.some(
      (c) => c.reason === "used_baseline_lost",
    );
    const hasOffTopic = result.appliesToRefineCandidates.some(
      (c) => c.reason === "baseline_off_topic",
    );
    expect(hasLostUsed).toBe(true);
    expect(hasOffTopic).toBe(true);

    expect(result.compileInterventionPlan.strategy).toBe("retain_used_baseline");
  });

  test("buildLandscapeReplayComparison falls back compileInterventionPlan strategies when lost baseline is 0", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-neg-only",
          createdAt: new Date(),
          goal: "neg only",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo"),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [
        { runId: "run-neg-only", itemId: "kb-1", sortOrder: 0, createdAt: new Date(), score: 70 },
      ],
      usageEvents: [{ runId: "run-neg-only", knowledgeId: "kb-1", verdict: "wrong" }],
    });
    mockRetrieveKnowledge.mockResolvedValue({
      items: [{ id: "kb-1", title: "Retained" }],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "unavailable",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const result = await buildLandscapeReplayComparison({
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    });

    expect(result.scoreTuning.negativeFeedbackRunCount).toBe(1);
    expect(result.scoreTuning.lostUsedBaselineRunCount).toBe(0);
    expect(result.compileInterventionPlan.strategy).toBe("repel_negative_candidates");

    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-churn-only",
          createdAt: new Date(),
          goal: "churn only",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo"),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [
        { runId: "run-churn-only", itemId: "kb-1", sortOrder: 0, createdAt: new Date(), score: 70 },
      ],
      usageEvents: [],
    });
    mockRetrieveKnowledge.mockResolvedValue({
      items: [
        { id: "kb-2", title: "New 1" },
        { id: "kb-3", title: "New 2" },
      ],
      stats: {
        textHitCount: 2,
        vectorHitCount: 0,
        mergedCount: 2,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "unavailable",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const result2 = await buildLandscapeReplayComparison({
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    });

    expect(result2.scoreTuning.highChurnRunCount).toBe(1);
    expect(result2.scoreTuning.lostUsedBaselineRunCount).toBe(0);
    expect(result2.scoreTuning.negativeFeedbackRunCount).toBe(0);
    expect(result2.compileInterventionPlan.strategy).toBe("repel_negative_candidates");
  });

  test("buildLandscapeReplayComparison handles stable runs, wrong feedback and low overlap scenarios", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-stable",
          createdAt: new Date(),
          goal: "stable test",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo"),
          source: "mcp",
          degradedReasons: [],
        },
        {
          id: "run-low-overlap",
          createdAt: new Date(),
          goal: "low overlap test",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo"),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [
        {
          runId: "run-stable",
          itemId: "kb-retained",
          sortOrder: 0,
          createdAt: new Date(),
          score: 70,
        },
        {
          runId: "run-low-overlap",
          itemId: "kb-lost-1",
          sortOrder: 0,
          createdAt: new Date(),
          score: 70,
        },
        {
          runId: "run-low-overlap",
          itemId: "kb-lost-2",
          sortOrder: 1,
          createdAt: new Date(),
          score: 70,
        },
      ],
      usageEvents: [
        { runId: "run-stable", knowledgeId: "kb-retained", verdict: "used" },
        { runId: "run-low-overlap", knowledgeId: "kb-lost-1", verdict: "wrong" },
      ],
    });

    mockRetrieveKnowledge.mockImplementation(async (compileInput, options) => {
      if (compileInput.goal === "stable test") {
        return {
          items: [{ id: "kb-retained", title: "Retained" }],
          stats: {
            textHitCount: 1,
            vectorHitCount: 0,
            mergedCount: 1,
            textFailed: false,
            vectorFailed: false,
            embeddingStatus: "unavailable",
            repoScopeFallbackUsed: false,
          },
          degradedReasons: [],
        };
      }
      return {
        items: [{ id: "kb-other", title: "Other" }],
        stats: {
          textHitCount: 1,
          vectorHitCount: 0,
          mergedCount: 1,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "unavailable",
          repoScopeFallbackUsed: false,
        },
        degradedReasons: [],
      };
    });

    const result = await buildLandscapeReplayComparison({
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    });

    const hasWrong = result.appliesToRefineCandidates.some((c) => c.reason === "baseline_wrong");
    expect(hasWrong).toBe(true);

    const hasMissing = result.appliesToRefineCandidates.some(
      (c) => c.reason === "baseline_missing_after_recompile",
    );
    expect(hasMissing).toBe(true);

    expect(result.scoreTuning.recommendations).toContain(
      "Use off-topic and wrong replay verdicts as a repulsion sandbox signal.",
    );
  });

  test("buildLandscapeReplayComparison handles completely stable runs with no signals (observe_only)", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-perfect",
          createdAt: new Date(),
          goal: "perfect test",
          retrievalMode: "keyword",
          status: "completed",
          ...comparableRepoPathRun("/repo"),
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [
        { runId: "run-perfect", itemId: "kb-1", sortOrder: 0, createdAt: new Date(), score: 70 },
      ],
      usageEvents: [{ runId: "run-perfect", knowledgeId: "kb-1", verdict: "used" }],
    });

    mockRetrieveKnowledge.mockResolvedValue({
      items: [{ id: "kb-1", title: "Retained" }],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "unavailable",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const result = await buildLandscapeReplayComparison({
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "ok" as const,
      includeRuns: true,
    });

    expect(result.compileInterventionPlan.strategy).toBe("observe_only");
    expect(result.scoreTuning.recommendations).toContain(
      "Keep score tuning in observe-only mode until more replay drift appears.",
    );
  });

  test("preserves Repo A/B/global identity and excludes legacy identity-unknown runs", async () => {
    mockLoadLandscapeReplayCorpus.mockResolvedValue({
      runs: [
        {
          id: "run-repo-a",
          createdAt: new Date(),
          goal: "repo a",
          retrievalMode: "keyword",
          status: "ok",
          ...comparableRepoPathRun("/repo-a"),
          source: "mcp",
          degradedReasons: [],
        },
        {
          id: "run-repo-b",
          createdAt: new Date(),
          goal: "repo b",
          retrievalMode: "keyword",
          status: "ok",
          ...comparableRepoPathRun("/repo-b"),
          source: "mcp",
          degradedReasons: [],
        },
        {
          id: "run-global",
          createdAt: new Date(),
          goal: "global",
          retrievalMode: "keyword",
          status: "ok",
          ...comparableGlobalRun(),
          source: "mcp",
          degradedReasons: [],
        },
        {
          id: "run-legacy",
          createdAt: new Date(),
          goal: "legacy",
          retrievalMode: "keyword",
          status: "ok",
          projectRef: null,
          repoKey: null,
          repoPath: "/legacy-daemon-root",
          matchBasis: "none",
          identityContractVersion: 1,
          scopeMode: "global_only",
          input: {},
          source: "mcp",
          degradedReasons: [],
        },
      ],
      packItems: [],
      usageEvents: [],
    });
    mockRetrieveKnowledge.mockResolvedValue({
      items: [],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "disabled",
        repoScopeFallbackUsed: false,
      },
      degradedReasons: [],
    });

    const result = await buildLandscapeReplayComparison({
      windowDays: 7,
      limit: 10,
      currentLimit: 5,
      runStatus: "all" as const,
      includeRuns: true,
    });

    expect(mockRetrieveKnowledge).toHaveBeenCalledTimes(3);
    expect(mockRetrieveKnowledge.mock.calls.map(([compileInput]) => compileInput)).toEqual([
      expect.objectContaining({ goal: "repo a", repoPath: "/repo-a" }),
      expect.objectContaining({ goal: "repo b", repoPath: "/repo-b" }),
      { goal: "global" },
    ]);
    expect(result.replayRunCount).toBe(4);
    expect(result.comparedRunCount).toBe(3);
    expect(result.comparisonCounts.not_comparable).toBe(1);
    expect(result.runs.find((run) => run.runId === "run-legacy")).toMatchObject({
      identityCompatibility: "legacy_identity_unknown",
      comparison: "not_comparable",
      currentDegradedReasons: ["LEGACY_IDENTITY_UNKNOWN"],
    });
    expect(result.recompilePlan.blockers.join("\n")).toContain("identity snapshot is unknown");
  });
});
