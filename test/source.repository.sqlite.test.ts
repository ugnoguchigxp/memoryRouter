import { beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteCoreRepository } from "../src/db/sqlite/core-repository.js";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import {
  deleteStaleSourcesForRootSqlite,
  searchSourceContentSqlite,
  upsertSourceDocumentSqlite,
  vectorSearchSourceContentSqlite,
} from "../src/modules/sources/source.repository.sqlite.js";

vi.mock("../src/db/sqlite/runtime.js", () => {
  const mockSelect = vi.fn().mockReturnThis();
  const mockFrom = vi.fn().mockReturnThis();
  const mockWhere = vi.fn().mockReturnThis();
  const mockInnerJoin = vi.fn().mockReturnThis();
  const mockOrderBy = vi.fn().mockReturnThis();
  const mockGet = vi.fn();
  const mockAll = vi.fn();
  const mockDelete = vi.fn().mockReturnThis();
  const mockRun = vi.fn();

  const mockOrm = {
    select: mockSelect,
    from: mockFrom,
    where: mockWhere,
    innerJoin: mockInnerJoin,
    orderBy: mockOrderBy,
    get: mockGet,
    all: mockAll,
    delete: mockDelete,
    run: mockRun,
  };

  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
  };

  return {
    getRuntimeSqliteCoreDatabase: vi.fn(() =>
      Promise.resolve({
        db: mockDb,
        orm: mockOrm,
        path: "/dummy/sqlite.db",
      }),
    ),
  };
});

vi.mock("../src/db/sqlite/core-repository.js", () => {
  const mockUpsertSource = vi.fn();
  const mockUpsertSourceFragment = vi.fn();
  const mockVectorSearch = vi.fn(() => []);
  return {
    SqliteCoreRepository: class {
      upsertSource = mockUpsertSource;
      upsertSourceFragment = mockUpsertSourceFragment;
      vectorSearchSourceFragments = mockVectorSearch;
    },
  };
});

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));

describe("source.repository.sqlite", () => {
  let mockOrm: any;
  let mockRepo: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = await getRuntimeSqliteCoreDatabase();
    mockOrm = db.orm;
    mockRepo = new SqliteCoreRepository(db as any);
  });

  const dummySource = {
    id: "source-id",
    sourceKind: "wiki",
    classificationStatus: "classified",
    scope: "repo",
    projectRef: null,
    repoKey: "contextstill",
    repoPath: null,
    uri: "file:///sqlite.md",
    title: "SQLite Notes",
    body: "This is a body of SQLite notes",
    metadata: { repoKey: "contextstill" },
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };

  const dummyFragment = {
    id: "frag-id",
    sourceId: "source-id",
    locator: "chunk:0001",
    heading: "Section 1",
    content: "This is SQLite content in chunk",
    metadata: { repoKey: "contextstill" },
    createdAt: "2026-06-20T00:00:00.000Z",
  };

  test("upsertSourceDocumentSqlite inserts source and fragments", async () => {
    mockOrm.get.mockReturnValue(null); // No existing source
    vi.mocked(embedOne).mockResolvedValue([0.1, 0.2, 0.3]);

    const sourceId = await upsertSourceDocumentSqlite({
      sourceKind: "wiki",
      scope: "repo",
      uri: "file:///sqlite.md",
      title: "SQLite Notes",
      body: "This is a body of SQLite notes",
      metadata: { repoKey: "contextstill" },
    });

    expect(sourceId).toBeDefined();
    expect(mockRepo.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sourceId,
        sourceKind: "wiki",
      }),
    );
    expect(mockRepo.upsertSourceFragment).toHaveBeenCalled();
  });

  test("deleteStaleSourcesForRootSqlite deletes non-keep sources under root", async () => {
    mockOrm.all.mockReturnValue([dummySource]);

    const deleted = await deleteStaleSourcesForRootSqlite({
      rootPath: "/workspace/project",
      keepUris: ["file:///sqlite.md"], // keep this
    });

    expect(deleted).toBe(0); // Kept

    const deletedStale = await deleteStaleSourcesForRootSqlite({
      rootPath: "", // match everything
      keepUris: [], // keep nothing
    });

    expect(deletedStale).toBe(1);
    expect(mockOrm.delete).toHaveBeenCalled();
  });

  test("searchSourceContentSqlite performs textual search on fragments and full source", async () => {
    mockOrm.all.mockImplementation(() => {
      // Drizzle join returns objects with key mapping to tables
      // For fragments query (join):
      if (mockOrm.all.mock.calls.length === 1) {
        return [
          {
            fragment: dummyFragment,
            source: dummySource,
          },
        ];
      }
      // For fallback full text query:
      return [dummySource];
    });

    const results = await searchSourceContentSqlite("SQLite", 5, ["wiki"], {
      repoKey: "contextstill",
    });

    expect(results).toHaveLength(2); // fragment hit + source full hit
    expect(results[0].sourceUri).toBe("file:///sqlite.md");
  });

  test("vectorSearchSourceContentSqlite is disabled until scope can be filtered before top-K", async () => {
    mockOrm.all.mockReturnValue([dummySource]);
    mockRepo.vectorSearchSourceFragments.mockReturnValue([
      {
        id: "frag-id",
        sourceId: "source-id",
        sourceUri: "file:///sqlite.md",
        locator: "chunk:0001",
        heading: "Section 1",
        content: "This is content in chunk",
        score: 0.9,
      },
    ]);

    const results = await vectorSearchSourceContentSqlite([0.1, 0.2, 0.3], 5, ["wiki"], {
      repoKey: "contextstill",
    });

    expect(results).toEqual([]);
  });
});
