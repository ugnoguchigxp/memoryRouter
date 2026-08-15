import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { sourceFragments, sources } from "../src/db/schema.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import {
  deleteStaleSourcesForRoot,
  searchSourceContent,
  upsertSourceDocument,
  vectorSearchSourceContent,
} from "../src/modules/sources/source.repository.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    }),
    query: {
      sources: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    sourceImported: "SOURCE_IMPORTED",
    sourceUpdated: "SOURCE_UPDATED",
    sourceDeleted: "SOURCE_DELETED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

describe("source repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("upsertSourceDocument", () => {
    test("inserts new source and chunks it", async () => {
      (db.query.sources.findFirst as any).mockResolvedValue(null);
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "s1" }]),
      });

      const params = {
        sourceKind: "wiki" as const,
        scope: "global" as const,
        uri: "wiki://test",
        title: "Test Wiki",
        body: "Line 1\nLine 2\n# Heading 1\nContent under heading",
      };

      const id = await upsertSourceDocument(params);

      expect(id).toBe("s1");
      expect(db.insert).toHaveBeenCalledWith(sources);
      // Verify chunking (sourceFragments insert)
      expect(db.insert).toHaveBeenCalledWith(sourceFragments);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "SOURCE_IMPORTED",
        }),
      );
    });

    test("updates existing source and replaces fragments", async () => {
      (db.query.sources.findFirst as any).mockResolvedValue({ id: "s1" });
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      });
      (db.delete as any).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const params = {
        sourceKind: "wiki" as const,
        scope: "global" as const,
        uri: "wiki://test",
        body: "New content",
      };

      await upsertSourceDocument(params);

      expect(db.update).toHaveBeenCalledWith(sources);
      expect(db.delete).toHaveBeenCalledWith(sourceFragments);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "SOURCE_UPDATED",
        }),
      );
    });
  });

  describe("deleteStaleSourcesForRoot", () => {
    test("deletes sources not in keep list", async () => {
      (db.delete as any).mockReturnValue({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "deleted-1" }]),
      });

      const count = await deleteStaleSourcesForRoot({
        rootPath: "/root",
        keepUris: ["/root/keep.md"],
      });

      expect(count).toBe(1);
      expect(db.delete).toHaveBeenCalledWith(sources);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "SOURCE_DELETED",
        }),
      );
    });
  });

  describe("vectorSearchSourceContent", () => {
    test("performs vector similarity search on fragments", async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValue([{ id: "f1", sourceUri: "uri1", score: 0.8, content: "chunk1" }]),
      });

      const results = await vectorSearchSourceContent([0.1], 5);
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0.8);
    });
  });

  describe("searchSourceContent", () => {
    test("performs text search on both fragments and sources", async () => {
      // Mock for fragments search
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValue([
            { id: "f1", sourceId: "s1", sourceUri: "u1", locator: "l1", score: 0.9, content: "c1" },
          ]),
      });
      // Mock for sources search
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValue([{ id: "s1", sourceUri: "u1", title: "t1", body: "b1", score: 0.8 }]),
      });

      const results = await searchSourceContent("query", 5);
      expect(results).toHaveLength(2); // fragment (s1:l1) and full document (s1:full)
      expect(results[0].locator).toBe("l1");
      expect(results[0].score).toBe(0.9);
    });

    test("returns empty if query is empty", async () => {
      const results = await searchSourceContent(" ", 5);
      expect(results).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });
});
