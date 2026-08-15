import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveDatabaseBackendConfig } from "../src/db/backend.js";
import { getDefaultDbSession } from "../src/db/session.js";
import {
  createEpisodeCard,
  getEpisodeCard,
  getEpisodeCardBySource,
  searchEpisodeCards,
} from "../src/modules/episodic-memory/episode-card.repository.js";

vi.mock("../src/db/session.js", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  };
  return {
    getDefaultDbSession: vi.fn(() => ({
      db: mockDb,
    })),
  };
});

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: vi.fn(() => ({ kind: "postgres" })),
}));

describe("episode-card.repository (PostgreSQL)", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = getDefaultDbSession().db;
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({ kind: "postgres" } as any);
  });

  const dummyEpisode = {
    id: "test-id",
    title: "Test Episode",
    situation: "Test Situation",
    observations: "Test Observations",
    action: "Test Action",
    outcome: "Test Outcome",
    lesson: "Test Lesson",
    applicability: {},
    antiApplicability: {},
    domains: ["test-domain"],
    technologies: ["vitest"],
    changeTypes: ["test-change"],
    tools: ["antigravity"],
    classificationStatus: "classified",
    scope: "repo",
    projectRef: null,
    repoPath: "/repo",
    repoKey: "key",
    sourceKind: "compile_run",
    sourceKey: "key",
    outcomeKind: "success",
    confidence: 90,
    status: "active",
    staleAt: null,
    metadata: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };

  const dummyRef = {
    id: "ref-id",
    episodeCardId: "test-id",
    refKind: "compile_run",
    refValue: "rule-1",
    locator: "L10",
    queryHint: "hint",
    metadata: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
  };

  test("createEpisodeCard inserts row and refs via transaction", async () => {
    const mockTx = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation((table) => {
        return Promise.resolve([dummyEpisode]);
      }),
    };

    vi.mocked(mockDb.transaction).mockImplementation(async (cb: (tx: unknown) => unknown) => {
      return cb(mockTx as any);
    });

    const mockReturning = vi
      .fn()
      .mockResolvedValueOnce([dummyEpisode])
      .mockResolvedValueOnce([dummyRef]);

    mockTx.returning = mockReturning;

    const result = await createEpisodeCard({
      title: "Test Episode",
      situation: "Test Situation",
      observations: "Test Observations",
      action: "Test Action",
      outcome: "Test Outcome",
      lesson: "Test Lesson",
      applicability: {},
      antiApplicability: {},
      domains: ["test-domain"],
      technologies: ["vitest"],
      changeTypes: ["test-change"],
      tools: ["antigravity"],
      repoPath: "/repo",
      repoKey: "key",
      sourceKind: "compile_run",
      sourceKey: "key",
      outcomeKind: "success",
      confidence: 90,
      status: "active",
      refs: [
        {
          refKind: "compile_run",
          refValue: "rule-1",
          locator: "L10",
          queryHint: "hint",
          metadata: {},
        },
      ],
      metadata: {},
    });

    expect(result.title).toBe("Test Episode");
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  test("getEpisodeCard returns card or null", async () => {
    const mockSelectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([dummyEpisode]),
    };

    const mockSelectRefsResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([dummyRef]),
    };

    vi.mocked(mockDb.select).mockImplementation(() => {
      if (vi.mocked(mockDb.select).mock.calls.length === 1) {
        return mockSelectResult as any;
      }
      return mockSelectRefsResult as any;
    });

    const result = await getEpisodeCard("test-id");
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test Episode");

    vi.mocked(mockDb.select).mockImplementation(
      () =>
        ({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        }) as any,
    );

    const nullResult = await getEpisodeCard("non-existent");
    expect(nullResult).toBeNull();
  });

  test("getEpisodeCardBySource returns card or null", async () => {
    const mockSelectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([dummyEpisode]),
    };

    const mockSelectRefsResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([dummyRef]),
    };

    vi.mocked(mockDb.select).mockImplementation(() => {
      if (vi.mocked(mockDb.select).mock.calls.length === 1) {
        return mockSelectResult as any;
      }
      return mockSelectRefsResult as any;
    });

    const result = await getEpisodeCardBySource({
      sourceKind: "compile_run",
      sourceKey: "key",
    });
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test Episode");
  });

  test("searchEpisodeCards performs filtering", async () => {
    const mockSelectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([dummyEpisode]),
    };

    const mockSelectRefsResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([dummyRef]),
    };

    vi.mocked(mockDb.select).mockImplementation(() => {
      if (vi.mocked(mockDb.select).mock.calls.length === 1) {
        return mockSelectResult as any;
      }
      return mockSelectRefsResult as any;
    });

    const results = await searchEpisodeCards({
      query: "Test",
      status: "active",
      repoPath: "/repo",
      repoKey: "key",
      outcomeKinds: ["success"],
      domains: ["test-domain"],
      technologies: ["vitest"],
      changeTypes: ["test-change"],
      tools: ["antigravity"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Episode");
  });

  test("searchEpisodeCards returns newest episodes first without search criteria", async () => {
    const olderHighScoreEpisode = {
      ...dummyEpisode,
      id: "older-high-score",
      title: "Older high score episode",
      scope: "global",
      projectRef: null,
      repoKey: null,
      repoPath: null,
      outcomeKind: "success",
      importance: 100,
      confidence: 100,
      createdAt: new Date("2026-06-26T07:41:01.000Z"),
      updatedAt: new Date("2026-06-26T07:41:01.000Z"),
    };
    const newestLowScoreEpisode = {
      ...dummyEpisode,
      id: "newest-low-score",
      title: "Newest low score episode",
      scope: "global",
      projectRef: null,
      repoKey: null,
      repoPath: null,
      outcomeKind: "unknown",
      importance: 0,
      confidence: 0,
      createdAt: new Date("2026-06-26T08:40:02.000Z"),
      updatedAt: new Date("2026-06-26T08:40:02.000Z"),
    };
    const mockSelectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([olderHighScoreEpisode, newestLowScoreEpisode]),
    };
    const mockSelectRefsResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };

    vi.mocked(mockDb.select).mockImplementation(() => {
      if (vi.mocked(mockDb.select).mock.calls.length === 1) {
        return mockSelectResult as any;
      }
      return mockSelectRefsResult as any;
    });

    const results = await searchEpisodeCards({
      status: "active",
      limit: 2,
    });

    expect(results.map((episode) => episode.id)).toEqual(["newest-low-score", "older-high-score"]);
  });
});
