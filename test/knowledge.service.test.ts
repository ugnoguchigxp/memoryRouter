import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import * as repo from "../src/modules/knowledge/knowledge.repository.js";
import {
  registerKnowledgeFromMarkdown,
  retrieveKnowledge,
  searchKnowledgeCandidates,
} from "../src/modules/knowledge/knowledge.service.js";

vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
const originalEnableVectorSearch = groupedConfig.compile.enableVectorSearch;

describe("Knowledge Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.compile.enableVectorSearch = true;
  });

  test("retrieveKnowledge uses correct profile based on mode", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    const input = { goal: "test", includeDraft: false } as any;

    await retrieveKnowledge(input, { retrievalMode: "review_context" });
    expect(repo.searchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ types: ["rule", "procedure"], limit: 12 }),
      expect.any(Object),
    );
  });

  test("retrieveKnowledge honors explicit limit for replay comparison dry-runs", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);

    await retrieveKnowledge({ goal: "test", includeDraft: false } as any, {
      retrievalMode: "review_context",
      limit: 20,
    });

    expect(repo.searchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
      expect.any(Object),
    );
  });

  test("retrieveKnowledge uses unscoped search in four-input mode", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    vi.mocked(repo.searchKnowledge).mockResolvedValue([{ id: "item1", score: 0.9 }] as any);

    const result = await retrieveKnowledge({ goal: "test" }, { retrievalMode: "learning_context" });

    expect(result.items).toHaveLength(1);
    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    const call = vi.mocked(repo.searchKnowledge).mock.calls[0];
    expect(call?.[0]?.repoPath).toBeUndefined();
    expect(call?.[1]?.repoPath).toBeUndefined();
  });

  test("does not use legacy metadata or unscoped fallback for scoped search candidates", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    let calls = 0;
    vi.mocked(repo.searchKnowledge).mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        return [
          {
            id: "legacy-item",
            type: "rule",
            status: "active",
            scope: "repo",
            title: "Legacy Repo Rule",
            body: "legacy scope token",
            confidence: 70,
            importance: 70,
            score: 0.9,
            appliesTo: {},
            metadata: {
              repoPath: "/workspace/repo-a",
              repoKey: "/workspace/repo-a",
            },
            sourceRefs: [],
            hasSourceLinks: false,
          },
        ] as any;
      }
      return [];
    });

    const result = await searchKnowledgeCandidates({
      query: "legacy scope token",
      repoPath: "/workspace/repo-a",
      includeDraft: false,
      limit: 10,
    });

    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.degradedReasons).toContain("NO_ACTIVE_KNOWLEDGE_MATCH");
    expect(result.degradedReasons).not.toContain("KNOWLEDGE_APPLIES_TO_FALLBACK");
    expect(result.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    expect(vi.mocked(repo.searchKnowledge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.searchKnowledge).mock.calls[0]?.[1]?.projectIdentity?.matchBasis).toBe(
      "repo_path",
    );
  });

  test("registerKnowledgeFromMarkdown generates embedding if missing", async () => {
    vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(repo.upsertKnowledgeFromSource).mockResolvedValue("new-id");

    const id = await registerKnowledgeFromMarkdown({
      sourceUri: "test.md",
      title: "Title",
      body: "Body",
    });

    expect(id).toBe("new-id");
    expect(embedding.embedOne).toHaveBeenCalledWith("Title\nBody", "passage");
  });

  test("executeKnowledgeSearch performs vector search if enabled", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(repo.vectorSearchKnowledge).mockResolvedValue([{ id: "v1", score: 0.8 }] as any);

    const input = { goal: "test", includeDraft: false } as any;
    const result = await retrieveKnowledge(input, { retrievalMode: "learning_context" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("v1");
    expect(repo.vectorSearchKnowledge).toHaveBeenCalled();
  });

  test("annotates merged candidates with text/vector evidence", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([
      {
        id: "k1",
        score: 0.4,
        applicabilityMatches: {
          technologies: ["typescript"],
          changeTypes: [],
          domains: [],
          general: false,
        },
      },
    ] as any);
    vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(repo.vectorSearchKnowledge).mockResolvedValue([
      {
        id: "k1",
        score: 0.82,
        applicabilityMatches: {
          technologies: [],
          changeTypes: [],
          domains: [],
          general: false,
        },
      },
    ] as any);

    const result = await retrieveKnowledge({ goal: "typed compile task" } as any, {
      retrievalMode: "task_context",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.candidateEvidence).toMatchObject({
      textMatched: true,
      vectorMatched: true,
      facetMatched: true,
      vectorScore: 0.82,
    });
  });

  test("searchKnowledgeCandidates parses input and searches", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([{ id: "c1", score: 0.7 }] as any);
    vi.mocked(repo.vectorSearchKnowledge).mockResolvedValue([]);
    const result = await searchKnowledgeCandidates({
      query: "task",
      limit: 5,
      includeDraft: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("c1");
  });

  test("registerKnowledgeFromMarkdown rejects embedding failure before storage", async () => {
    vi.mocked(embedding.embedOne).mockRejectedValue(new Error("Failed"));
    vi.mocked(repo.upsertKnowledgeFromSource).mockResolvedValue("no-embed-id");

    await expect(
      registerKnowledgeFromMarkdown({
        sourceUri: "test.md",
        title: "Title",
        body: "Body",
      }),
    ).rejects.toThrow("Failed");
    expect(repo.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("handles search failures gracefully", async () => {
    vi.mocked(repo.searchKnowledge).mockRejectedValue(new Error("Search failed"));
    const input = { goal: "test", includeDraft: false } as any;
    const result = await retrieveKnowledge(input, { retrievalMode: "review_context" });
    expect(result.degradedReasons).toContain("KNOWLEDGE_TEXT_SEARCH_FAILED");
  });

  test("covers all retrieval profiles", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    const modes = [
      "debug_context",
      "architecture_context",
      "procedure_context",
      "unknown",
    ] as any[];
    for (const mode of modes) {
      await retrieveKnowledge({ goal: "test", includeDraft: false } as any, {
        retrievalMode: mode,
      });
    }
    expect(repo.searchKnowledge).toHaveBeenCalled();
  });

  test("retrieveKnowledge executes intent and domain query rounds from multi-clause goals", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    const goal = "shadcn/ui + tailwindcss でデザインシステムを実装する、詳細の設計書を作る";
    vi.mocked(repo.searchKnowledge).mockImplementation(async (input) => {
      if (input.query === "詳細の設計書を作る") {
        return [{ id: "intent-doc", score: 0.93 }] as any;
      }
      if (input.query === "shadcn/ui + tailwindcss でデザインシステムを実装する") {
        return [{ id: "domain-tech", score: 0.88 }] as any;
      }
      return [];
    });

    const result = await retrieveKnowledge({ goal } as any, { retrievalMode: "learning_context" });

    expect(result.items.map((item) => item.id)).toEqual(["intent-doc", "domain-tech"]);
    expect(result.stats.roundsExecuted).toBe(2);
    expect(result.stats.laneCoverage).toEqual(["intent", "domain"]);
    const searchedQueries = result.stats.searchedQueries ?? [];
    expect(searchedQueries).toContain("詳細の設計書を作る");
    expect(searchedQueries).toContain("shadcn/ui + tailwindcss でデザインシステムを実装する");
  });

  test("NO_ACTIVE_KNOWLEDGE_MATCH is cleared when later rounds find matches", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    const goal = "frontend 実装を行う、設計書を作る";
    vi.mocked(repo.searchKnowledge).mockImplementation(async (input) => {
      if (input.query === "frontend 実装を行う") {
        return [{ id: "domain-only", score: 0.9 }] as any;
      }
      return [];
    });

    const result = await retrieveKnowledge({ goal } as any, { retrievalMode: "learning_context" });

    expect(result.items.map((item) => item.id)).toContain("domain-only");
    expect(result.degradedReasons).not.toContain("NO_ACTIVE_KNOWLEDGE_MATCH");
  });

  test("retrieveKnowledge keeps at least one item per required lane when ranking is imbalanced", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    const goal = "domain 実装を進める、設計書を作る";
    vi.mocked(repo.searchKnowledge).mockImplementation(async (input) => {
      if (input.query === "設計書を作る") {
        return [{ id: "intent-low", score: 0.12 }] as any;
      }
      if (input.query === "domain 実装を進める") {
        return [
          { id: "domain-1", score: 0.99 },
          { id: "domain-2", score: 0.98 },
          { id: "domain-3", score: 0.97 },
        ] as any;
      }
      return [];
    });

    const result = await retrieveKnowledge({ goal } as any, {
      retrievalMode: "learning_context",
      limit: 3,
    });

    expect(result.items.map((item) => item.id)).toContain("intent-low");
    expect(result.items).toHaveLength(3);
  });

  afterAll(() => {
    groupedConfig.compile.enableVectorSearch = originalEnableVectorSearch;
  });
});
