import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";

// Mock config
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    embedding: {
      dimension: 384,
      provider: "auto",
      daemonUrl: "http://localhost:44512",
      accessToken: "test-token",
      timeoutMs: 1000,
      openaiModel: "text-embedding-3-small",
    },
    azureOpenAi: {
      apiKey: "test-api-key",
      apiBaseUrl: "https://api.openai.com/v1",
      apiVersion: "2025-04-01-preview",
      model: "text-embedding-3-small",
    },
  },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = Object.assign(mockFetch, { preconnect: vi.fn() }) as unknown as typeof fetch;

describe("embedding service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.embedding.provider = "auto";
  });

  describe("embedOne", () => {
    test("calls daemon provider if available and provider is auto", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: [new Array(384).fill(0.1)],
          dimension: 384,
        }),
      });

      const result = await embedOne("test text", "query");

      expect(result).toHaveLength(384);
      expect(result[0]).toBe(0.1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/embed"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    test("reports the external daemon failure without a local fallback", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      await expect(embedOne("test text", "query")).rejects.toThrow("daemon: Connection refused");
    });

    test("throws error if provider is disabled", async () => {
      groupedConfig.embedding.provider = "disabled";
      await expect(embedOne("test", "query")).rejects.toThrow("embedding provider is disabled");
    });

    test("throws error if response shape is invalid", async () => {
      groupedConfig.embedding.provider = "daemon";
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: "not an array",
        }),
      });

      await expect(embedOne("test", "query")).rejects.toThrow(
        "daemon embedding response did not include an array",
      );
    });

    test("calls openai provider with standard endpoint if provider is openai and not azure", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "test-key";
      groupedConfig.azureOpenAi.apiBaseUrl = "https://api.openai.com/v1";

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(384).fill(0.3) }],
        }),
      });

      const result = await embedOne("test text", "query");

      expect(result).toHaveLength(384);
      expect(result[0]).toBe(0.3);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
          body: JSON.stringify({
            input: ["test text"],
            model: "text-embedding-3-small",
            dimensions: 384,
          }),
        }),
      );
    });

    test("calls openai provider with azure endpoint if provider is openai and azure baseUrl is configured", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "azure-key";
      groupedConfig.azureOpenAi.apiBaseUrl = "https://my-resource.openai.azure.com/";
      groupedConfig.azureOpenAi.apiVersion = "2023-05-15";

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(384).fill(0.4) }],
        }),
      });

      const result = await embedOne("test text", "query");

      expect(result).toHaveLength(384);
      expect(result[0]).toBe(0.4);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://my-resource.openai.azure.com/openai/deployments/text-embedding-3-small/embeddings?api-version=2023-05-15",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "api-key": "azure-key",
          }),
          body: JSON.stringify({
            input: ["test text"],
            dimensions: 384,
          }),
        }),
      );
    });

    test("throws error if provider is openai and apiKey is missing", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "";

      await expect(embedOne("test text", "query")).rejects.toThrow(
        "OpenAI Embedding failed: API key (azureOpenAi.apiKey) is not configured",
      );
    });

    test("throws detailed error parsed from JSON if OpenAI provider fails with JSON error", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "test-key";
      groupedConfig.azureOpenAi.apiBaseUrl = "https://api.openai.com/v1";

      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message: "The model 'text-embedding-3-small' does not exist",
            },
          }),
      });

      await expect(embedOne("test text", "query")).rejects.toThrow(
        "HTTP 400: The model 'text-embedding-3-small' does not exist",
      );
    });

    test("throws detailed error if Daemon provider fails with plain text error", async () => {
      groupedConfig.embedding.provider = "daemon";

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Daemon Error",
      });

      await expect(embedOne("test text", "query")).rejects.toThrow(
        "HTTP 500: Internal Daemon Error",
      );
    });
  });

  describe("embeddingHealth", () => {
    test("returns reachable true if daemon health check succeeds", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const health = await embeddingHealth();

      expect(health.configured).toBe(true);
      expect(health.daemon.reachable).toBe(true);
      expect(health.daemon.status).toBe("external_ready");
      expect(health.effectiveMode).toBe("daemon");
    });

    test("always reports a reachable daemon as externally managed", async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const health = await embeddingHealth();

      expect(health.daemon.status).toBe("external_ready");
      expect(health.daemon.managedBy).toBe("external");
    });

    test("returns reachable false and error if daemon health check fails", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const health = await embeddingHealth();

      expect(health.daemon.reachable).toBe(false);
      expect(health.daemon.error).toBe("HTTP 500");
      expect(health.effectiveMode).toBe("unavailable");
    });

    test("returns configured false or error if openai provider is active but apiKey is empty", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "";
      mockFetch.mockResolvedValue({ ok: true }); // daemon health ok

      const health = await embeddingHealth();

      expect(health.configured).toBe(true);
      expect(health.openai.configured).toBe(false);
      expect(health.openai.error).toBe("API key (azureOpenAi.apiKey) is empty");
    });

    test("returns healthy status if openai provider is active and API test succeeds", async () => {
      groupedConfig.embedding.provider = "openai";
      groupedConfig.azureOpenAi.apiKey = "valid-key";
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(384).fill(0.5) }],
        }),
      });

      const health = await embeddingHealth();

      expect(health.configured).toBe(true);
      expect(health.openai.configured).toBe(true);
      expect(health.openai.error).toBeUndefined();
    });
  });
});
