import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "../src/modules/knowledge/knowledge.repository.js";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    innerJoin: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

vi.mock("../src/db/index.js", () => {
  return {
    db: {
      select: (...args: any[]) => mockSelect(...args),
      insert: (...args: any[]) => mockInsert(...args),
      update: (...args: any[]) => mockUpdate(...args),
      query: {
        knowledgeItems: {
          findFirst: vi.fn(),
        },
      },
    },
  };
});

describe("Knowledge Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const now = new Date();
  const mockRow = {
    id: "k-1",
    type: "rule",
    status: "active",
    scope: "repo",
    title: "Test Title",
    body: "Test Body",
    confidence: 85,
    importance: 90,
    appliesTo: {
      technologies: ["typescript", "vitest"],
      changeTypes: ["refactoring"],
      domains: ["testing"],
      general: false,
    },
    metadata: {
      sourceUri: "file:///a.ts",
      repoPath: "/workspace/project",
      repoKey: "my-project",
    },
    dynamicScore: 10,
    compileSelectCount: 5,
    agenticAcceptCount: 3,
    explicitUpvoteCount: 2,
    explicitDownvoteCount: 0,
    lastCompiledAt: now,
    lastVerifiedAt: now,
    updatedAt: now,
    score: 8.5,
  };

  describe("searchKnowledge", () => {
    test("calls select and maps results correctly with empty database", async () => {
      mockSelect.mockReturnValue(makeChain([]));
      const results = await searchKnowledge({
        query: "test",
        limit: 10,
        status: "active",
        includeDraft: false,
      });
      expect(results).toEqual([]);
      expect(mockSelect).toHaveBeenCalled();
    });

    test("maps result rows correctly with mapping functions and applicability calculation", async () => {
      mockSelect
        .mockReturnValueOnce(makeChain([mockRow])) // Main query
        .mockReturnValueOnce(makeChain([])) // Applicability facet query
        .mockReturnValueOnce(
          makeChain([
            {
              knowledgeId: "k-1",
              sourceUri: "file:///a.ts",
              locator: "L12-30",
              confidence: 90,
            },
          ]),
        ); // listKnowledgeSourceRefs query

      const results = await searchKnowledge(
        {
          query: "test",
          limit: 10,
          status: "active",
          includeDraft: false,
          technologies: ["typescript"],
          changeTypes: ["refactoring"],
          domains: ["testing"],
        },
        {
          repoPath: "/workspace/project",
          repoKey: "my-project",
          includeGeneral: true,
        },
      );

      expect(results.length).toBe(1);
      const res = results[0];
      expect(res.id).toBe("k-1");
      expect(res.title).toBe("Test Title");
      expect(res.sourceRefs).toEqual(["file:///a.ts#L12-30"]);
      expect(res.hasSourceLinks).toBe(true);
      expect(res.decayFactor).toBeCloseTo(1, 4);
    });
  });

  describe("upsertKnowledgeFromSource", () => {
    test("inserts new item if not exists", async () => {
      vi.mocked(db.query.knowledgeItems.findFirst).mockResolvedValue(undefined as any);

      const mockInsertChain = {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "new-id" }]),
      };
      mockInsert.mockReturnValue(mockInsertChain);

      const id = await upsertKnowledgeFromSource({
        sourceUri: "uri",
        type: "rule",
        status: "active",
        scope: "repo",
        repoKey: "test/knowledge-repository",
        title: "T",
        body: "B",
      });
      expect(id).toBe("new-id");
      expect(mockInsert).toHaveBeenCalled();
    });

    test("updates existing item if exists", async () => {
      vi.mocked(db.query.knowledgeItems.findFirst).mockResolvedValue({ id: "ex-id" } as any);

      const mockUpdateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };
      mockUpdate.mockReturnValue(mockUpdateChain);

      const id = await upsertKnowledgeFromSource({
        sourceUri: "uri",
        type: "rule",
        status: "active",
        scope: "repo",
        repoKey: "test/knowledge-repository",
        title: "T",
        body: "B",
      });
      expect(id).toBe("ex-id");
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("vectorSearchKnowledge", () => {
    test("calls similarity search", async () => {
      mockSelect.mockReturnValue(makeChain([mockRow]));
      await vectorSearchKnowledge(new Array(1536).fill(0), 5);
      expect(mockSelect).toHaveBeenCalled();
    });
  });
});
