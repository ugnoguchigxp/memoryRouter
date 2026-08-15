import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";
import {
  searchSourceContent,
  vectorSearchSourceContent,
} from "../src/modules/sources/source.repository.js";

vi.mock("../src/modules/sources/source.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/context-compiler/query-context.js", () => ({
  buildRetrievalQueryText: vi.fn((input) => input.goal),
  fileHintsFromInput: vi.fn(() => []),
  normalizeRepoKey: vi.fn((path) => path),
  normalizeRepoPath: vi.fn((path) => path),
}));

describe("Source Retrieval Service", () => {
  const originalEnableVectorSearch = groupedConfig.compile.enableVectorSearch;

  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.compile.enableVectorSearch = true;
    vi.mocked(searchSourceContent).mockResolvedValue([]);
    vi.mocked(vectorSearchSourceContent).mockResolvedValue([]);
    vi.mocked(embedOne).mockResolvedValue(new Array(384).fill(0.1));
  });

  afterAll(() => {
    groupedConfig.compile.enableVectorSearch = originalEnableVectorSearch;
  });

  test("combines text and vector search results", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([
      { id: "s1", score: 0.8, sourceUri: "test.ts" } as any,
    ]);
    vi.mocked(vectorSearchSourceContent).mockResolvedValue([
      { id: "s2", score: 0.9, sourceUri: "other.ts" } as any,
    ]);

    const result = await retrieveSources({ goal: "test goal" }, { retrievalMode: "task_context" });

    expect(result.items).toHaveLength(2);
    expect(result.stats.textHitCount).toBe(1);
    expect(result.stats.vectorHitCount).toBe(1);
    expect(result.stats.embeddingStatus).toBe("generated");
  });

  test("returns no repo fallback markers in four-input mode", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([]);

    const result = await retrieveSources({ goal: "test goal" }, { retrievalMode: "task_context" });

    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.degradedReasons).not.toContain("SOURCE_REPO_SCOPE_FALLBACK");
  });

  test("handles search failure", async () => {
    vi.mocked(searchSourceContent).mockRejectedValue(new Error("Timeout"));

    const result = await retrieveSources({ goal: "test" }, { retrievalMode: "task_context" });

    expect(result.stats.searchFailed).toBe(true);
    expect(result.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
  });

  test("handles vector embedding generation failure", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([
      { id: "s1", score: 0.8, sourceUri: "test.ts" } as any,
    ]);
    // Force embedOne to throw an error
    vi.mocked(embedOne).mockRejectedValue(new Error("Embedding daemon unreachable"));

    const result = await retrieveSources({ goal: "test goal" }, { retrievalMode: "task_context" });

    expect(result.items).toHaveLength(1); // Still has text hit
    expect(result.stats.embeddingStatus).toBe("unavailable");
    expect(result.degradedReasons).toContain("SOURCE_QUERY_EMBEDDING_UNAVAILABLE");
  });

  test("uses correct limits for different retrieval modes", async () => {
    // We will test limits by checking parameters of searchSourceContent calls
    const mockSearch = vi.mocked(searchSourceContent).mockResolvedValue([]);

    const modes = [
      { mode: "review_context" as const, limit: 10 },
      { mode: "debug_context" as const, limit: 12 },
      { mode: "architecture_context" as const, limit: 10 },
      { mode: "procedure_context" as const, limit: 10 },
      { mode: "learning_context" as const, limit: 10 },
      { mode: "unknown-mode" as any, limit: 8 }, // Default limit
    ];

    for (const item of modes) {
      mockSearch.mockClear();
      await retrieveSources({ goal: "test" }, { retrievalMode: item.mode });
      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        item.limit,
        undefined,
        expect.objectContaining({
          projectIdentity: expect.objectContaining({
            matchBasis: "none",
            scopeMode: "global_only",
          }),
        }),
      );
    }
  });

  test("returns NO_SOURCE_MATCH degraded reason when search runs fine but yields zero results", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([]);
    vi.mocked(vectorSearchSourceContent).mockResolvedValue([]);

    const result = await retrieveSources({ goal: "test" }, { retrievalMode: "task_context" });
    expect(result.degradedReasons).toContain("NO_SOURCE_MATCH");
  });
});
