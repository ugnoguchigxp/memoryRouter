import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/client.js";
import { vibeMemories } from "../src/db/schema.js";
import {
  insertVibeMemory,
  searchVibeMemories,
} from "../src/modules/vibe-memory/vibe-memory.repository.js";

vi.mock("../src/db/client.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

describe("vibe-memory repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("insertVibeMemory", () => {
    test("inserts a vibe memory and returns the inserted record", async () => {
      const seed = {
        scope: "global" as const,
        sessionId: "s1",
        content: "test content",
        memoryType: "chat",
      };
      const mockInserted = { id: "v1", ...seed, createdAt: new Date() };

      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([mockInserted]),
      });

      const result = await insertVibeMemory(seed);

      expect(db.insert).toHaveBeenCalledWith(vibeMemories);
      expect(result).toEqual(mockInserted);
    });

    test("uses default values if optional fields are missing", async () => {
      const seed = {
        scope: "global" as const,
        sessionId: "s1",
        content: "test content",
      };
      const mockValues = vi.fn().mockReturnThis();
      (db.insert as any).mockReturnValue({
        values: mockValues,
        returning: vi.fn().mockResolvedValue([{}]),
      });

      await insertVibeMemory(seed);

      const inserted = mockValues.mock.calls.find(
        ([value]) => value?.content === "test content",
      )?.[0];
      expect(inserted).toEqual(
        expect.objectContaining({
          memoryType: "chat",
          metadata: expect.objectContaining({
            projectIdentity: expect.objectContaining({
              classificationStatus: "classified",
              scope: "global",
              projectRef: null,
              repoKey: null,
              repoPath: null,
            }),
          }),
        }),
      );
    });

    test("redacts content and metadata before insert", async () => {
      const mockValues = vi.fn().mockReturnThis();
      (db.insert as any).mockReturnValue({
        values: mockValues,
        returning: vi.fn().mockResolvedValue([{}]),
      });

      await insertVibeMemory({
        scope: "global",
        sessionId: "s1",
        content: "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789\nnormal",
        metadata: { authToken: "raw-token-value" },
      });

      const inserted = mockValues.mock.calls.find(([value]) => value?.sessionId === "s1")?.[0];
      const serialized = JSON.stringify(inserted);
      expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
      expect(serialized).toContain("normal");
      expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(serialized).not.toContain("raw-token-value");
    });
  });

  describe("searchVibeMemories", () => {
    test("returns empty array if query is empty", async () => {
      const result = await searchVibeMemories({ query: " ", limit: 10 });
      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    test("performs a search with filters and scoring", async () => {
      const mockResults = [{ id: "v1", sessionId: "s1", content: "hello", score: 0.9 }];

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockResults),
      });

      const result = await searchVibeMemories({ query: "hello", limit: 5, sessionId: "s1" });

      expect(db.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("v1");
    });
  });
});
