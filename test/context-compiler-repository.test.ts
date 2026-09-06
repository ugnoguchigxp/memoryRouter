import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { contextCompileRuns, contextPackItems } from "../src/db/schema.js";
import {
  getCompileRunDetail,
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
  updateCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import type { ContextPack } from "../src/shared/schemas/context-pack.schema.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

const validPack: ContextPack = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  goal: "detail goal",
  retrievalMode: "task_context",
  status: "ok",
  minimalTasks: ["Inspect context"],
  rules: [],
  procedures: [],
  guardrails: [],
  warnings: [],
  sourceRefs: ["context-still://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
  diagnostics: {
    degradedReasons: [],
    retrievalStats: { tokenBudget: 5000 },
  },
};

function createSelectChain<T>(input: { limitResult?: T; orderByResult?: T; whereResult?: T }) {
  let terminal: "limit" | "orderBy" | "where" | null = null;
  const resolveTerminal = () => {
    if (terminal === "limit") return input.limitResult;
    if (terminal === "orderBy") return input.orderByResult;
    if (terminal === "where") return input.whereResult;
    return undefined;
  };
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    then: vi.fn((resolve: (value: T | undefined) => unknown) => resolve(resolveTerminal())),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockImplementation(() => {
    terminal = "where";
    return chain;
  });
  chain.orderBy.mockImplementation(() => {
    terminal = "orderBy";
    return chain;
  });
  chain.limit.mockImplementation(() => {
    terminal = "limit";
    return Promise.resolve(input.limitResult);
  });
  return chain;
}

describe("context-compiler repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as any).mockReturnValue(
      createSelectChain({ limitResult: [], orderByResult: [], whereResult: [] }),
    );
  });

  describe("insertCompileRun", () => {
    test("inserts a compile run and returns the ID", async () => {
      const mockInserted = [{ id: "run-123" }];
      const mockValues = vi.fn().mockReturnThis();
      (db.insert as any).mockReturnValue({
        values: mockValues,
        returning: vi.fn().mockResolvedValue(mockInserted),
      });

      const params = {
        goal: "test goal",
        intent: "plan",
        input: { foo: "bar" },
        retrievalMode: "task_context",
        status: "ok" as const,
        degradedReasons: [],
        tokenBudget: 1000,
        durationMs: 500,
        source: "mcp" as const,
      };

      const result = await insertCompileRun(params);

      expect(db.insert).toHaveBeenCalledWith(contextCompileRuns);
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp" }));
      expect(result).toBe("run-123");
    });
  });

  describe("updateCompileRunSnapshot", () => {
    test("updates the persisted pack snapshot", async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      (db.update as any).mockReturnValue({ set: mockSet });

      await updateCompileRunSnapshot(validPack.runId, validPack);

      expect(db.update).toHaveBeenCalledWith(contextCompileRuns);
      expect(mockSet).toHaveBeenCalledWith({ packSnapshot: validPack });
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe("insertContextPackItems", () => {
    test("inserts items if array is not empty", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as any).mockReturnValue({ values: mockValues });

      await insertContextPackItems("run-1", [
        {
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          score: 100,
          rankingReason: "test",
          sourceRefs: [],
        },
      ]);

      expect(db.insert).toHaveBeenCalledWith(contextPackItems);
      expect(mockValues).toHaveBeenCalled();
    });

    test("does nothing if array is empty", async () => {
      await insertContextPackItems("run-1", []);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("listRecentCompileRuns", () => {
    test("returns formatted summaries", async () => {
      const mockRows = [
        {
          id: "r1",
          goal: "g1",
          intent: "i1",
          retrievalMode: "m1",
          status: "ok",
          degradedReasons: [],
          durationMs: 123.45,
          source: "ui",
          createdAt: new Date(),
        },
      ];

      (db.select as any).mockReturnValue(createSelectChain({ limitResult: mockRows }));

      const result = await listRecentCompileRuns(1);

      expect(result).toHaveLength(1);
      expect(result[0].durationMs).toBe(123); // Rounded
      expect(result[0].source).toBe("ui");
    });

    test("handles missing input or diagnostics gracefully", async () => {
      const mockRows = [
        {
          id: "r1",
          goal: "g1",
          intent: "i1",
          input: null,
          retrievalMode: "m1",
          status: "ok",
          degradedReasons: null,
          durationMs: null,
          source: "unexpected",
          createdAt: new Date(),
        },
      ];

      (db.select as any).mockReturnValue(createSelectChain({ limitResult: mockRows }));

      const result = await listRecentCompileRuns(1);
      expect(result[0].degradedReasons).toEqual([]);
      expect(result[0].durationMs).toBe(0);
      expect(result[0].source).toBe("unknown");
    });
  });

  describe("getCompileRunSnapshot", () => {
    test("returns null if run not found", async () => {
      (db.select as any).mockReturnValue(createSelectChain({ limitResult: [] }));

      const result = await getCompileRunSnapshot("missing");
      expect(result).toBeNull();
    });

    test("returns run and items if found", async () => {
      const mockRun = {
        id: "r1",
        goal: "g",
        intent: "i",
        retrievalMode: "task_context",
        status: "ok",
        degradedReasons: [],
        durationMs: 100,
        source: "mcp",
        createdAt: new Date(),
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 100,
          rankingReason: "r",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: mockItems }));

      const result = await getCompileRunSnapshot("r1");

      expect(result?.run.id).toBe("r1");
      expect(result?.run.source).toBe("mcp");
      expect(result?.items).toHaveLength(1);
    });
  });

  describe("getCompileRunDetail", () => {
    test("returns null if run not found", async () => {
      (db.select as any).mockReturnValue(createSelectChain({ limitResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);
      expect(result).toBeNull();
    });

    test("returns detail with valid pack snapshot", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "cli",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, changeTypes: ["feature"] },
        packSnapshot: validPack,
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 100,
          rankingReason: "r",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: mockItems }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(true);
      expect(result?.pack?.runId).toBe(validPack.runId);
      expect(result?.run.source).toBe("cli");
      expect(result?.selectedItems).toHaveLength(1);
    });

    test("returns legacy detail when pack snapshot is unavailable", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "unknown",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, lastErrorContext: {}, retrievalMode: "legacy_mode" },
        packSnapshot: null,
      };

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(false);
      expect(result?.pack).toBeNull();
      expect(result?.run.input).toEqual(mockRun.input);
      expect(result?.selectedItems).toEqual([]);
    });

    test("does not expose a pack snapshot from a different run", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "ui",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, changeTypes: ["feature"] },
        packSnapshot: {
          ...validPack,
          runId: "550e8400-e29b-41d4-a716-446655440001",
        },
      };

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(false);
      expect(result?.pack).toBeNull();
      expect(result?.selectedItems).toEqual([]);
    });

    test("deduplicates knowledge signals for repeated selected knowledge IDs", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "ui",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, changeTypes: ["feature"] },
        packSnapshot: {
          ...validPack,
          rules: [
            {
              id: "knowledge:i1",
              itemKind: "rule",
              itemId: "i1",
              section: "rules",
              title: "Dedup Rule",
              content: "Rule content",
              score: 0.9,
              rankingReason: "ranked",
              sourceRefs: [],
            },
          ],
        },
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 100,
          rankingReason: "high score",
          sourceRefs: ["s1"],
        },
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 90,
          rankingReason: "duplicate lower score",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: mockItems }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ whereResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.selectedItems).toHaveLength(2);
      expect(result?.knowledgeSignals).toHaveLength(1);
      expect(result?.knowledgeSignals[0]?.knowledgeId).toBe("i1");
      expect(result?.knowledgeSignals[0]?.title).toBe("Dedup Rule");
    });

    test("keeps guardrail knowledge signals with guardrail titles", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "ui",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, changeTypes: ["review"] },
        packSnapshot: {
          ...validPack,
          guardrails: [
            {
              id: "knowledge:g1",
              itemKind: "rule",
              itemId: "g1",
              section: "guardrails",
              title: "Guardrail Rule",
              content: "Avoid unsafe flow",
              score: 0.95,
              rankingReason: "ranked",
              sourceRefs: [],
            },
          ],
        },
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "g1",
          section: "guardrails",
          score: 95,
          rankingReason: "guardrail score",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: mockItems }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ whereResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.knowledgeSignals).toHaveLength(1);
      expect(result?.knowledgeSignals[0]?.section).toBe("guardrails");
      expect(result?.knowledgeSignals[0]?.title).toBe("Guardrail Rule");
    });

    test("exposes EpisodeCard selected items as episode signals without knowledge signals", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "ui",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, changeTypes: ["schema"] },
        packSnapshot: {
          ...validPack,
          procedures: [
            {
              id: "episode_card:episode-1",
              itemKind: "episode_card",
              itemId: "episode-1",
              section: "procedures",
              title: "Past episode: SQLite migration recovery",
              content: "Use when: precedent only.",
              score: 0.72,
              rankingReason: "supplemental EpisodeCard precedent",
              sourceRefs: ["context-still://episodes/episode-1"],
            },
          ],
        },
      };
      const mockItems = [
        {
          itemKind: "episode_card",
          itemId: "episode-1",
          section: "procedures",
          score: 72,
          rankingReason: "supplemental EpisodeCard precedent",
          sourceRefs: ["context-still://episodes/episode-1"],
        },
      ];

      (db.select as any)
        .mockReturnValueOnce(createSelectChain({ limitResult: [mockRun] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: mockItems }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ orderByResult: [] }))
        .mockReturnValueOnce(createSelectChain({ whereResult: [] }));

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.selectedItems).toEqual([
        expect.objectContaining({ itemKind: "episode_card", itemId: "episode-1" }),
      ]);
      expect(result?.episodeSignals).toEqual([
        {
          episodeId: "episode-1",
          title: "Past episode: SQLite migration recovery",
          section: "procedures",
          sourceRefs: ["context-still://episodes/episode-1"],
          effectiveVerdict: null,
          effectiveActor: null,
          effectiveReason: null,
          updatedAt: null,
        },
      ]);
      expect(result?.knowledgeSignals).toEqual([]);
    });
  });
});
