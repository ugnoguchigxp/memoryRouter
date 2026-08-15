import { beforeEach, describe, expect, test, vi } from "vitest";
import { getCompileRunDetail } from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  createEpisodeCard,
  getEpisodeCardBySource,
} from "../src/modules/episodic-memory/episode-card.repository.js";
import {
  backfillEpisodeFromCompileRun,
  buildEpisodeInputFromCompileRun,
} from "../src/modules/episodic-memory/episode-card.service.js";

vi.mock("../src/modules/context-compiler/context-compiler.repository.js", () => ({
  getCompileRunDetail: vi.fn(),
}));

vi.mock("../src/modules/episodic-memory/episode-card.repository.js", () => ({
  createEpisodeCard: vi.fn(),
  getEpisodeCard: vi.fn(),
  getEpisodeCardBySource: vi.fn(),
  searchEpisodeCards: vi.fn(),
}));

const baseCompileDetail = {
  run: {
    id: "550e8400-e29b-41d4-a716-446655440000",
    goal: "Wire EpisodeCard backfill into compile history",
    retrievalMode: "task_context",
    status: "ok",
    degradedReasons: [],
    durationMs: 123,
    source: "mcp",
    evalSummary: {
      count: 1,
      latestAvg: 93,
      averageAvg: 93,
      latestOutcome: "useful",
      latestEvaluatedAt: "2026-06-20T00:00:00.000Z",
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    tokenBudget: 1200,
    input: {
      technologies: ["typescript"],
      changeTypes: ["feature"],
      domains: ["episodic-memory"],
      projectIdentity: {
        contractVersion: 1,
        scopeMode: "project",
        matchBasis: "repo_key",
        matchValue: "contextstill",
        projectRef: null,
        repoPath: "/repo/contextStill",
        repoKey: "contextstill",
        identityFingerprint: "fixture",
        trust: "request_hint",
        bindingStatus: "unverified",
      },
    },
  },
  pack: {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    goal: "Wire EpisodeCard backfill into compile history",
    retrievalMode: "task_context",
    status: "ok",
    minimalTasks: [],
    rules: [
      {
        id: "knowledge:k1",
        itemKind: "rule",
        itemId: "k1",
        section: "rules",
        title: "Keep source refs",
        content: "Use sourceRefs consistently.",
        score: 0.9,
        rankingReason: "test",
        sourceRefs: ["src/modules/episodic-memory/episode-card.service.ts"],
      },
    ],
    procedures: [],
    guardrails: [],
    warnings: [],
    sourceRefs: ["context-still://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
    diagnostics: { degradedReasons: [], retrievalStats: {} },
  },
  outputMarkdown: "Use sourceRefs consistently when creating EpisodeCards.",
  selectedItems: [
    {
      itemKind: "rule",
      itemId: "k1",
      section: "rules",
      score: 0.9,
      rankingReason: "test",
      sourceRefs: ["src/modules/episodic-memory/episode-card.service.ts"],
    },
  ],
  knowledgeFeedback: [],
  knowledgeSignals: [],
  evaluations: [],
  snapshotAvailable: true,
};

describe("episode-card service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCompileRunDetail).mockResolvedValue(baseCompileDetail as never);
    vi.mocked(getEpisodeCardBySource).mockResolvedValue(null);
    vi.mocked(createEpisodeCard).mockImplementation(
      async (input) =>
        ({
          ...input,
          id: "episode-created",
          staleAt: null,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          updatedAt: new Date("2026-06-20T00:00:00.000Z"),
          refs: [],
        }) as never,
    );
  });

  test("builds an EpisodeCard input from a compile run", async () => {
    const input = await buildEpisodeInputFromCompileRun("550e8400-e29b-41d4-a716-446655440000");
    expect(input).toEqual(
      expect.objectContaining({
        sourceKind: "compile_run",
        sourceKey: "550e8400-e29b-41d4-a716-446655440000",
        outcomeKind: "success",
        importance: 82,
        confidence: 93,
        technologies: ["typescript"],
        changeTypes: ["feature"],
        domains: ["episodic-memory"],
        scope: "repo",
        repoPath: "/repo/contextStill",
        repoKey: "contextstill",
      }),
    );
    expect(input?.refs?.map((ref) => ref.refKind)).toContain("compile_run");
  });

  test("returns null if compile run is not found", async () => {
    vi.mocked(getCompileRunDetail).mockResolvedValue(null);
    const input = await buildEpisodeInputFromCompileRun("non-existent");
    expect(input).toBeNull();
  });

  test("rejects legacy root identity fields when the canonical snapshot is missing", async () => {
    vi.mocked(getCompileRunDetail).mockResolvedValue({
      ...baseCompileDetail,
      run: {
        ...baseCompileDetail.run,
        input: {
          repoPath: "/legacy/daemon-root",
          repoKey: "legacy",
        },
      },
    } as never);

    await expect(buildEpisodeInputFromCompileRun("legacy-run")).rejects.toThrow(
      "PROJECT_IDENTITY_REQUIRED",
    );
  });

  describe("compactText bounds and length checking", () => {
    test("handles long situations and observations by compacting them", async () => {
      const longGoal = "a".repeat(2000);
      const detail = {
        ...baseCompileDetail,
        run: {
          ...baseCompileDetail.run,
          goal: longGoal,
        },
      };
      vi.mocked(getCompileRunDetail).mockResolvedValue(detail as never);
      const input = await buildEpisodeInputFromCompileRun("550e8400-e29b-41d4-a716-446655440000");
      expect(input?.situation?.length).toBeLessThan(1300);
      expect(input?.situation).toContain("...");
    });
  });

  describe("inferOutcomeKind branches", () => {
    const makeDetail = (latestOutcome: string | null, status: string) => ({
      ...baseCompileDetail,
      run: {
        ...baseCompileDetail.run,
        status,
        degradedReasons: status === "degraded" ? ["slow"] : [],
        evalSummary: {
          ...baseCompileDetail.run.evalSummary,
          latestOutcome,
        },
      },
    });

    test("useful outcome maps to success (if ok) or mixed (if not ok)", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail("useful", "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("success");

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail("useful", "failed") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("mixed");
    });

    test("partial outcome maps to mixed", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail("partial", "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("mixed");
    });

    test("misleading or unused outcome maps to failure", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail("misleading", "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("failure");

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail("unused", "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("failure");
    });

    test("no outcome falls back to run status", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("success");

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "degraded") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("mixed");

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "failed") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("failure");

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "unknown-status") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.outcomeKind).toBe("unknown");
    });
  });

  describe("inferConfidence branches", () => {
    const makeDetail = (latestAvg: number | null, status: string) => ({
      ...baseCompileDetail,
      run: {
        ...baseCompileDetail.run,
        status,
        evalSummary: {
          ...baseCompileDetail.run.evalSummary,
          latestAvg,
        },
      },
    });

    test("uses latestAvg if number and limits between 0-100", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(120, "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(100);

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(-10, "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(0);

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(82.6, "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(83);
    });

    test("uses status fallback if latestAvg is not number", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "ok") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(70);

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "degraded") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(55);

      vi.mocked(getCompileRunDetail).mockResolvedValue(makeDetail(null, "failed") as never);
      expect((await buildEpisodeInputFromCompileRun("x"))?.confidence).toBe(35);
    });
  });

  describe("classifyRefKind and sourceRefs", () => {
    test("classifies files and other refs correctly", async () => {
      const detail = {
        ...baseCompileDetail,
        pack: {
          ...baseCompileDetail.pack,
          sourceRefs: [
            "context-still://packs/run/550e8400-e29b-41d4-a716-446655440000#full",
            "file:///path/to/some/script.js",
            "github://commit/12345",
          ],
        },
      };
      vi.mocked(getCompileRunDetail).mockResolvedValue(detail as never);
      const input = await buildEpisodeInputFromCompileRun("x");
      const refs = input?.refs;
      expect(refs?.find((r) => r.refValue.endsWith("script.js"))?.refKind).toBe("file");
      expect(refs?.find((r) => r.refValue.startsWith("github://"))?.refKind).toBe("compile_run");
    });
  });

  describe("backfillEpisodeFromCompileRun outcomes", () => {
    test("returns not_found if run detail is missing", async () => {
      vi.mocked(getCompileRunDetail).mockResolvedValue(null);
      const result = await backfillEpisodeFromCompileRun({ runId: "missing", write: true });
      expect(result.status).toBe("not_found");
    });

    test("returns dry_run if write parameter is false", async () => {
      const result = await backfillEpisodeFromCompileRun({ runId: "x", write: false });
      expect(result.status).toBe("dry_run");
      expect(result).toHaveProperty("episodeInput");
    });

    test("returns skipped_existing if episode card is already created", async () => {
      const existingEpisode = { id: "existing-episode-id" };
      vi.mocked(getEpisodeCardBySource).mockResolvedValue(existingEpisode as never);
      const result = await backfillEpisodeFromCompileRun({ runId: "x", write: true });
      expect(result.status).toBe("skipped_existing");
      expect(result).toHaveProperty("episode", existingEpisode);
    });

    test("creates new episode card when not existing and write is true", async () => {
      const result = await backfillEpisodeFromCompileRun({ runId: "x", write: true });
      expect(result.status).toBe("created");
      expect(result).toHaveProperty("episode");
    });
  });
});
