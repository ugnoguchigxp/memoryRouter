import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  insertVibeMemory,
  searchVibeMemories,
} from "../src/modules/vibe-memory/vibe-memory.repository.js";

import { db } from "../src/db/client.js";

vi.mock("../src/db/client.js", () => {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "vid", sessionId: "s1", content: "test" }])),
      })),
    })),
  };
  return { db: chain };
});

describe("Vibe Memory Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("insertVibeMemory inserts and returns record", async () => {
    const record = await insertVibeMemory({
      scope: "global",
      sessionId: "s1",
      content: "test",
      memoryType: "chat",
    });
    expect(record.id).toBe("vid");
    expect(db.insert).toHaveBeenCalled();
  });

  test("searchVibeMemories calls select", async () => {
    await searchVibeMemories({ query: "test", sessionId: "s1", limit: 5 });
    expect(db.select).toHaveBeenCalled();
  });
});
