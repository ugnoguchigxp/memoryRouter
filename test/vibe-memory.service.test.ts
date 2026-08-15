import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/client.js";
import { searchVibeMemories } from "../src/modules/vibe-memory/vibe-memory.repository.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";

vi.mock("../src/db/client.js", () => ({
  db: {
    transaction: vi.fn((cb) =>
      cb({
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi
              .fn()
              .mockResolvedValue([
                { id: "m1", sessionId: "s1", content: "Recorded content", memoryType: "manual" },
              ]),
          })),
        })),
      }),
    ),
  },
}));

vi.mock("../src/modules/vibe-memory/vibe-memory.repository.js", () => ({
  searchVibeMemories: vi.fn(),
  insertVibeMemory: vi.fn(),
}));

describe("Vibe Memory Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("records vibe memory without diff entries", async () => {
    const result = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "s1",
      content: "Hello world",
      memoryType: "chat",
    });

    expect(result.memory.id).toBe("m1");
    expect(result.diffEntries).toHaveLength(0);
    expect(db.transaction).toHaveBeenCalled();
  });

  test("records vibe memory with diff entries", async () => {
    // Mocking the nested calls for diff entries
    const mockTx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValueOnce([
              { id: "m1", sessionId: "s1", content: "Agent diff recorded.", memoryType: "action" },
            ]) // For memory
            .mockResolvedValueOnce([{ id: "d1", filePath: "test.ts" }]), // For diff entries
        }),
      }),
    };
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));

    const result = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "s1",
      content: "Changes made",
      memoryType: "action",
      diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new",
    });

    expect(result.memory.id).toBe("m1");
    expect(result.diffEntries).toHaveLength(1);
    expect(mockTx.insert).toHaveBeenCalledTimes(2);
  });

  test("redacts direct memory content, metadata, and diff entries", async () => {
    const memoryValues = vi.fn().mockReturnValue({
      returning: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "m1", sessionId: "s1", content: "Stored", memoryType: "action" },
        ]),
    });
    const diffValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValueOnce([{ id: "d1", filePath: "secret.ts" }]),
    });
    const mockTx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({ values: memoryValues })
        .mockReturnValueOnce({ values: diffValues }),
    };
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as any));

    await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "s1",
      content: "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789\nnormal",
      memoryType: "action",
      metadata: { authToken: "raw-token-value" },
      agentDiffs: [
        {
          filePath: "secret.ts",
          diffHunk: "+const token = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';",
          metadata: { privateKey: "raw-private-key" },
        },
      ],
    });

    const serialized = JSON.stringify([
      memoryValues.mock.calls[0]?.[0],
      diffValues.mock.calls[0]?.[0],
    ]);
    expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
    expect(serialized).toContain("normal");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("raw-private-key");
  });

  test("retrieves vibe memory context", async () => {
    vi.mocked(searchVibeMemories).mockResolvedValue([
      {
        id: "m1",
        sessionId: "s1",
        content: "Mem 1",
        memoryType: "manual",
        createdAt: new Date(),
        score: 0.9,
        metadata: {},
      },
    ]);

    const results = await retrieveVibeMemoryContext({ query: "test", sessionId: "s1" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("m1");
    expect(results[0].score).toBe(0.9);
  });
});
