import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  searchSourceContent,
  upsertSourceDocument,
} from "../src/modules/sources/source.repository.js";

vi.mock("../src/modules/sources/source.repository.js", async (importOriginal) => {
  return {
    ...(await importOriginal<any>()),
  };
});

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(() => Promise.resolve(new Array(1536).fill(0.1))),
}));

vi.mock("../src/db/index.js", () => {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "sid" }])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    query: {
      sources: {
        findFirst: vi.fn(),
      },
    },
  };
  return { db: chain };
});

describe("Source Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("upsertSourceDocument inserts and returns id", async () => {
    vi.mocked(db.query.sources.findFirst).mockResolvedValue(undefined as any);

    const id = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "test-uri",
      body: "content",
      metadata: {},
    });
    expect(id).toBe("sid");
    expect(db.insert).toHaveBeenCalled();
  });

  test("redacts source uri, title, body, and metadata before insert", async () => {
    vi.mocked(db.query.sources.findFirst).mockResolvedValue(undefined as any);

    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "https://example.com/docs?token=abcdef0123456789",
      title: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      body: "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789\nnormal",
      metadata: { authToken: "raw-token-value" },
    });

    const inserted = vi
      .mocked(db.insert)
      .mock.results.flatMap((result) => (result.value as any).values.mock.calls)
      .map(([value]) => value as Record<string, unknown>)
      .find((value) => typeof value.body === "string");
    expect(JSON.stringify(inserted)).toContain("[REMOVED SENSITIVE DATA]");
    expect(JSON.stringify(inserted)).toContain("normal");
    expect(JSON.stringify(inserted)).not.toContain("abcdef0123456789");
    expect(JSON.stringify(inserted)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(inserted)).not.toContain("raw-token-value");
  });

  test("searchSourceContent calls select", async () => {
    await searchSourceContent("query", 10);
    expect(db.select).toHaveBeenCalled();
  });
});
