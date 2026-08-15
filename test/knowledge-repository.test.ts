import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { knowledgeItems } from "../src/db/schema.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "../src/modules/knowledge/knowledge.repository.js";
import {
  buildKnowledgeScopeMetadata,
  computeApplicability,
} from "../src/modules/knowledge/knowledge.repository.shared.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    query: {
      knowledgeItems: {
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    knowledgeCreated: "KNOWLEDGE_CREATED",
    knowledgeUpdated: "KNOWLEDGE_UPDATED",
    knowledgeStatusChanged: "KNOWLEDGE_STATUS_CHANGED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/modules/knowledge/source-linking.service.js", () => ({
  linkKnowledgeFromMetadata: vi.fn().mockResolvedValue({
    candidateReferenceCount: 0,
    resolvedReferenceCount: 0,
    insertedLinkCount: 0,
    skippedExistingLinkCount: 0,
    unresolvedReferenceCount: 0,
  }),
}));

describe("knowledge repository", () => {
  test("does not derive repoKey or an absolute path from a relative metadata path", () => {
    expect(() =>
      buildKnowledgeScopeMetadata("fixture://relative", { repoPath: "../repo" }),
    ).toThrow("repoPath must be absolute");
    const scoped = buildKnowledgeScopeMetadata("fixture://absolute", {
      repoPath: "/workspace/repo-a",
    });
    expect(scoped).toMatchObject({ appliesTo: { repoPath: "/workspace/repo-a" } });
    expect(scoped.appliesTo).not.toHaveProperty("repoKey");
  });

  beforeEach(() => {
    vi.resetAllMocks();
    (recordAuditLogSafe as any).mockResolvedValue(undefined);
  });

  describe("searchKnowledge", () => {
    test("returns formatted search results", async () => {
      const mockRows = [
        {
          id: "k1",
          type: "rule",
          status: "active",
          scope: "repo",
          title: "Test Title",
          body: "Test Body",
          confidence: 0.8,
          importance: 0.9,
          appliesTo: { repoPath: "/test" },
          metadata: { sourceUri: "file:///test.md" },
          dynamicScore: 10,
          compileSelectCount: 5,
          agenticAcceptCount: 2,
          explicitUpvoteCount: 1,
          explicitDownvoteCount: 0,
          lastCompiledAt: null,
          lastVerifiedAt: new Date(),
          updatedAt: new Date(),
          score: 0.95,
        },
      ];

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(mockRows),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([]), // No source refs
        });

      const result = await searchKnowledge({
        query: "test",
        limit: 10,
        status: "active",
        includeDraft: false,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("k1");
      expect(result[0].confidence).toBe(80); // Normalized
      expect(result[0].importance).toBe(90); // Normalized
      expect(result[0].sourceRefs).toContain("file:///test.md#full"); // Fallback from metadata
    });

    test("adds applicability score on the same scale as text rank", async () => {
      const mockRows = [
        {
          id: "k1",
          type: "rule",
          status: "active",
          scope: "repo",
          title: "Never run destructive git reset",
          body: "Do not discard user worktree changes.",
          confidence: 95,
          importance: 98,
          appliesTo: {
            technologies: ["git"],
            changeTypes: ["destructive-change", "cleanup"],
            domains: ["workspace-safety", "version-control"],
            general: true,
          },
          metadata: {},
          dynamicScore: 0,
          compileSelectCount: 0,
          agenticAcceptCount: 0,
          explicitUpvoteCount: 0,
          explicitDownvoteCount: 0,
          lastCompiledAt: null,
          lastVerifiedAt: null,
          updatedAt: new Date(),
          score: 0,
        },
      ];

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(mockRows),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([]),
        });

      const result = await searchKnowledge(
        {
          query: "git clean destructive cleanup",
          limit: 10,
          status: "active",
          includeDraft: false,
        },
        {
          technologies: ["git"],
          changeTypes: ["destructive-change", "cleanup"],
          domains: ["workspace-safety", "version-control"],
          includeGeneral: true,
        },
      );

      expect(result[0].applicabilityScore).toBe(92);
      expect(result[0].score).toBe(0.92);
    });
  });

  describe("computeApplicability", () => {
    test("scores exact technology, change type, and domain matches", () => {
      const result = computeApplicability(
        {
          technologies: ["git"],
          changeTypes: ["destructive-change", "cleanup"],
          domains: ["workspace-safety", "version-control"],
          general: true,
        },
        {
          technologies: ["git"],
          changeTypes: ["destructive-change", "cleanup"],
          domains: ["workspace-safety", "version-control"],
          includeGeneral: true,
        },
      );

      expect(result.score).toBe(92);
      expect(result.matches).toEqual({
        technologies: ["git"],
        changeTypes: ["destructive-change", "cleanup"],
        domains: ["workspace-safety", "version-control"],
        general: true,
      });
    });

    test("does not score general-only applicability as a facet match", () => {
      const result = computeApplicability(
        { general: true },
        {
          technologies: ["git"],
          changeTypes: ["destructive-change"],
          domains: ["workspace-safety"],
          includeGeneral: true,
        },
      );

      expect(result.score).toBe(0);
      expect(result.matches.general).toBe(true);
    });
  });

  describe("upsertKnowledgeFromSource", () => {
    test("inserts new knowledge if not exists", async () => {
      (db.query.knowledgeItems.findFirst as any).mockResolvedValue(null);
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: "new-k" }]),
      });

      const params = {
        sourceUri: "agent://test",
        type: "rule" as const,
        status: "active" as const,
        scope: "repo" as const,
        repoKey: "test/knowledge-repository",
        title: "New Rule",
        body: "Body",
      };

      const id = await upsertKnowledgeFromSource(params);

      expect(id).toBe("new-k");
      expect(db.insert).toHaveBeenCalledWith(knowledgeItems);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_CREATED",
          actor: "agent",
        }),
      );
    });

    test("preserves non-ASCII applicability facets while normalizing separators", async () => {
      (db.query.knowledgeItems.findFirst as any).mockResolvedValue(null);
      const values = vi.fn().mockReturnThis();
      (db.insert as any).mockReturnValue({
        values,
        returning: vi.fn().mockResolvedValue([{ id: "new-k" }]),
      });

      await upsertKnowledgeFromSource({
        sourceUri: "cover-evidence-result://evidence-1",
        type: "rule",
        status: "draft",
        scope: "repo",
        repoKey: "test/knowledge-repository",
        title: "Feature flag rollout",
        body: "Body",
        appliesTo: {
          technologies: ["feature flag"],
          changeTypes: ["機能追加"],
          domains: ["リリース管理"],
        },
      });

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          appliesTo: {
            technologies: ["feature-flag"],
            changeTypes: ["機能追加"],
            domains: ["リリース管理"],
          },
        }),
      );
    });

    test("updates existing knowledge", async () => {
      const existing = { id: "old-k", status: "draft" };
      (db.query.knowledgeItems.findFirst as any).mockResolvedValue(existing);
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      });

      const params = {
        sourceUri: "system://test",
        type: "rule" as const,
        status: "active" as const,
        scope: "repo" as const,
        repoKey: "test/knowledge-repository",
        title: "Updated Rule",
        body: "Body",
      };

      const id = await upsertKnowledgeFromSource(params);

      expect(id).toBe("old-k");
      expect(db.update).toHaveBeenCalledWith(knowledgeItems);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_UPDATED",
        }),
      );
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_STATUS_CHANGED",
          payload: expect.objectContaining({ fromStatus: "draft", toStatus: "active" }),
        }),
      );
    });
  });

  describe("vectorSearchKnowledge", () => {
    test("performs vector similarity search and returns rows", async () => {
      const mockRows = [
        {
          id: "kv1",
          type: "rule",
          status: "active",
          scope: "repo",
          title: "VTitle",
          body: "VBody",
          confidence: 0.7,
          importance: 0.8,
          appliesTo: {},
          metadata: {},
          dynamicScore: 0,
          compileSelectCount: 0,
          agenticAcceptCount: 0,
          explicitUpvoteCount: 0,
          explicitDownvoteCount: 0,
          lastCompiledAt: null,
          lastVerifiedAt: null,
          updatedAt: new Date(),
          score: 0.88,
        },
      ];
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(mockRows),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([]),
        });

      const result = await vectorSearchKnowledge(new Array(1536).fill(0), 5, ["active"], {
        repoKey: "rk",
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("kv1");
      expect(result[0].score).toBe(0.88);
    });

    test("performs vector similarity search", async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

      const result = await vectorSearchKnowledge(new Array(1536).fill(0), 5);
      expect(db.select).toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });
});
