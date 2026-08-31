import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";

const originalEmbeddingConfig = {
  provider: groupedConfig.embedding.provider,
  daemonUrl: groupedConfig.embedding.daemonUrl,
  accessToken: groupedConfig.embedding.accessToken,
  timeoutMs: groupedConfig.embedding.timeoutMs,
  dimension: groupedConfig.embedding.dimension,
};

describe("Embedding Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());

    groupedConfig.embedding.provider = "auto";
    groupedConfig.embedding.daemonUrl = "http://daemon";
    groupedConfig.embedding.accessToken = "key";
    groupedConfig.embedding.timeoutMs = 1000;
    groupedConfig.embedding.dimension = 3;
  });

  afterEach(() => {
    groupedConfig.embedding.provider = originalEmbeddingConfig.provider;
    groupedConfig.embedding.daemonUrl = originalEmbeddingConfig.daemonUrl;
    groupedConfig.embedding.accessToken = originalEmbeddingConfig.accessToken;
    groupedConfig.embedding.timeoutMs = originalEmbeddingConfig.timeoutMs;
    groupedConfig.embedding.dimension = originalEmbeddingConfig.dimension;

    vi.unstubAllGlobals();
  });

  test("embedOne uses daemon if available", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2, 0.3]],
          dimension: 3,
        }),
    } as never);

    const result = await embedOne("hello", "query");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/embed"), expect.any(Object));
  });

  test("embedOne does not fall back to a local process if daemon fails", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as never);

    await expect(embedOne("hello", "query")).rejects.toThrow("daemon: HTTP 500");
  });

  test("embedOne throws if input is empty", async () => {
    await expect(embedOne("  ", "query")).rejects.toThrow(
      "embedding input must include at least one non-empty text",
    );
  });

  test("embedOne throws when provider is disabled", async () => {
    groupedConfig.embedding.provider = "disabled";
    await expect(embedOne("hello", "query")).rejects.toThrow("embedding provider is disabled");
  });

  test("validateEmbeddingShape throws on dimension mismatch", async () => {
    groupedConfig.embedding.provider = "daemon";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2]],
          dimension: 2,
        }),
    } as never);

    await expect(embedOne("hello", "query")).rejects.toThrow("dimension mismatch");
  });

  test("embeddingHealth checks the external daemon", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as never);

    const health = await embeddingHealth();
    expect(health.daemon.reachable).toBe(true);
  });

  test("embedOne reports an external daemon failure in auto mode", async () => {
    groupedConfig.embedding.provider = "auto";
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as never);

    await expect(embedOne("hello", "query")).rejects.toThrow("daemon: HTTP 503");
  });
});
