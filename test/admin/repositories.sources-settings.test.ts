import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSourceFolder,
  createSourcePage,
  deleteSourceFolder,
  deleteSourcePage,
  fetchAuditLogs,
  fetchCandidateItems,
  fetchRuntimeSettings,
  fetchSourceDiff,
  fetchSourceHealth,
  fetchSourceHistory,
  fetchSourcePage,
  fetchSourceTree,
  queueWebSourceUrl,
  queueWebSourceUrlsBulk,
  queueWebSourceUrlsUpload,
  reloadRuntimeSettingsCache,
  renameSourceFolder,
  runSourceReindex,
  searchSourcePages,
  testAzureOpenAiDeployment,
  testRuntimeProvider,
  updateRuntimeSettings,
  updateSourcePage,
} from "../../web/src/modules/admin/repositories/admin.repository.js";

describe("Admin Repository sources/settings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const runtime = globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: string };
    runtime.__MEMORY_ROUTER_ADMIN_API_KEY__ = undefined;
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("context_still_admin_api_key");
      window.localStorage.removeItem("memory_router_admin_api_key");
      window.history.replaceState(null, "", "/");
    }
  });

  describe("sources and pages", () => {
    it("fetchSourceTree", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], folders: [] }),
      } as Response);
      await fetchSourceTree();
      expect(spy).toHaveBeenCalledWith("/api/sources/tree");
    });

    it("fetchSourceHealth", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ app: "test" }),
      } as Response);
      await fetchSourceHealth();
      expect(spy).toHaveBeenCalledWith("/api/sources/health");
    });

    it("fetchSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ slug: "a/b" }),
      } as Response);
      await fetchSourcePage("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b");
    });

    it("createSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      const input = { slug: "new-slug", title: "New Page", body: "Hello" };
      await createSourcePage(input);
      expect(spy).toHaveBeenCalledWith("/api/sources/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("updateSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      const input = { body: "Updated body" };
      await updateSourcePage("a/b", input);
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("deleteSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await deleteSourcePage("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("createSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await createSourceFolder("folder-a");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "folder-a" }),
      });
    });

    it("renameSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await renameSourceFolder("folder-a", "folder-b");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders/folder-a", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "folder-b" }),
      });
    });

    it("deleteSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await deleteSourceFolder("folder-a");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders/folder-a", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("fetchSourceHistory", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ slug: "a", items: [] }),
      } as Response);
      await fetchSourceHistory("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/history/a/b");
    });

    it("fetchSourceDiff", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ diff: "diff-content" }),
      } as Response);
      await fetchSourceDiff("a/b", "c1", "c2");
      expect(spy).toHaveBeenCalledWith("/api/sources/diff/a/b?from=c1&to=c2");
    });

    it("searchSourcePages", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await searchSourcePages("query content");
      expect(spy).toHaveBeenCalledWith("/api/sources/search?q=query%20content");
    });

    it("runSourceReindex", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await runSourceReindex();
      expect(spy).toHaveBeenCalledWith("/api/sources/reindex", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });

    it("queueWebSourceUrl", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, item: {} }),
      } as Response);
      const payload = { url: "https://example.com/a" };
      await queueWebSourceUrl(payload);
      expect(spy).toHaveBeenCalledWith("/api/sources/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("queueWebSourceUrlsBulk", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          total: 1,
          queued: 1,
          invalid: 0,
          duplicateInRequest: 0,
          items: [],
        }),
      } as Response);
      const payload = { urls: ["https://example.com/a", "https://example.com/b"] };
      await queueWebSourceUrlsBulk(payload);
      expect(spy).toHaveBeenCalledWith("/api/sources/web/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("queueWebSourceUrlsUpload", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          total: 1,
          queued: 1,
          invalid: 0,
          duplicateInRequest: 0,
          items: [],
          file: { name: "urls.csv", size: 12, extractedUrls: 1 },
        }),
      } as Response);
      const file = new File(["https://example.com/a"], "urls.csv", { type: "text/csv" });
      await queueWebSourceUrlsUpload({ file });
      expect(spy).toHaveBeenCalledWith("/api/sources/web/upload", {
        method: "POST",
        body: expect.any(FormData),
      });
    });
  });

  describe("audit logs and candidates", () => {
    it("fetchAuditLogs", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await fetchAuditLogs({ page: 2, limit: 10, eventType: "create", actor: "agent" });
      expect(spy).toHaveBeenCalledWith(
        "/api/audit-logs?page=2&limit=10&eventType=create&actor=agent",
      );
    });

    it("fetchCandidateItems", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await fetchCandidateItems({
        page: 1,
        limit: 20,
        query: "candidate",
        targetKind: "wiki_file",
        outcome: "stored",
        hasKnowledge: "yes",
        targetStateId: "state-1",
        sortBy: "candidateTitle",
        sortDir: "asc",
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/candidates?page=1&limit=20&query=candidate&targetKind=wiki_file&outcome=stored&hasKnowledge=yes&targetStateId=state-1&sortBy=candidateTitle&sortDir=asc",
      );
    });
  });

  describe("settings", () => {
    it("fetchRuntimeSettings", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: {},
          effective: {},
          sources: {},
          revision: 1,
          loadedAt: null,
        }),
      } as Response);
      await fetchRuntimeSettings();
      expect(spy).toHaveBeenCalledWith("/api/settings");
    });

    it("updateRuntimeSettings", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: {},
          effective: {},
          sources: {},
          revision: 2,
          loadedAt: null,
        }),
      } as Response);
      const payload = {
        settings: {
          providers: {
            openai: { enabled: true, apiBaseUrl: "https://api.openai.com/v1", model: "5.4mini" },
            "azure-openai": {
              enabled: false,
              apiBaseUrl: "",
              apiPath: "/openai/deployments",
              apiVersion: "2025-04-01-preview",
              model: "",
            },
            bedrock: {
              enabled: false,
              region: "us-east-1",
              profile: "",
              model: "anthropic.claude-3-5-haiku-20241022-v1:0",
            },
            "local-llm": {
              enabled: true,
              apiBaseUrl: "http://127.0.0.1:44448",
              model: "gemma-4-e4b-it",
            },
          },
          taskRouting: {
            findCandidate: {
              source: { provider: "openai", model: "5.4mini", fallback: [] },
              vibe: { provider: "openai", model: "5.4mini", fallback: [] },
              throttling: {
                backgroundEnabled: true,
                interactiveWindowSeconds: 180,
                recentBlockSeconds: 30,
                minIntervalSeconds: 30,
                mediumIntervalSeconds: 90,
                busyIntervalSeconds: 180,
                maxIntervalSeconds: 300,
                rateLimitCooldownSeconds: 600,
                jitterSeconds: 10,
              },
            },
            webSourceResearch: {
              provider: "local-llm",
              model: "gemma-4-e4b-it",
              fallback: ["azure-openai"],
            },
            coverEvidence: {
              sourceSupport: {
                provider: "local-llm",
                model: "gemma-4-e4b-it",
                fallback: ["azure-openai"],
              },
              externalEvidence: {
                provider: "local-llm",
                model: "gemma-4-e4b-it",
                fallback: ["azure-openai"],
              },
              mcpEvidence: {
                provider: "local-llm",
                model: "gemma-4-e4b-it",
                fallback: ["azure-openai"],
              },
            },
            finalizeDistille: {
              provider: "local-llm",
              model: "gemma-4-e4b-it",
              fallback: ["azure-openai"],
            },
            agenticCompile: {
              enabled: true,
              provider: "openai",
              model: "5.4mini",
              fallback: ["local-llm"],
              timeoutMs: 15000,
              maxTokens: 4000,
            },
          },
          search: {
            providerOrder: ["brave", "exa", "duckduckgo"],
            maxProviderAttempts: 2,
            resultCount: 8,
            timeoutMs: 10000,
            rateLimitCooldownSeconds: 3600,
            providers: {
              brave: { enabled: true },
              exa: { enabled: true },
              duckduckgo: { enabled: true },
            },
          },
          embedding: {
            provider: "daemon",
            daemonUrl: "http://127.0.0.1:44512",
            openaiModel: "text-embedding-3-small",
            timeoutMs: 30000,
          },
          distillationRuntime: {
            timeoutMs: 30000,
            candidateTimeoutMs: 15000,
            maxToolRounds: 4,
            findCandidateTimeoutMs: 600000,
            findCandidateMaxToolCalls: 8,
            coverEvidenceTimeoutMs: 600000,
            coverEvidenceSearchMaxCalls: 3,
            coverEvidenceFetchMaxCalls: 5,
            coverEvidenceFetchMaxTokensPerSite: 3000,
            toolTimeoutMs: 10000,
            toolResultMaxChars: 12000,
            failureRetryDelaySeconds: 90,
            readerMaxReads: 12,
            readerMaxCharsPerRead: 12000,
            llmContextWindowTokens: 128000,
            llmMaxInputTokens: 80000,
            llmInputSafetyMarginTokens: 4096,
            lowImportanceRejectThreshold: 40,
          },
          advanced: {
            pipelineLockStaleSeconds: 1200,
            lockTtlSeconds: 1800,
            pipelineClaimLimit: 1,
            findingQueueTaskIntervalSeconds: 30,
            coveringQueueTaskIntervalSeconds: 10,
            continuousIdleSleepMs: 5000,
            continuousErrorSleepMs: 12000,
            inventoryRefreshIntervalMs: 30000,
            doctorFreshnessThresholdMinutes: 720,
            doctorDegradedRateThreshold: 0.5,
            doctorKnowledgeZeroUseWarningMinActiveCount: 10,
          },
        },
      };

      await updateRuntimeSettings(payload as any);
      expect(spy).toHaveBeenCalledWith("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("testRuntimeProvider", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ provider: "openai", health: { configured: true, reachable: true } }),
      } as Response);
      await testRuntimeProvider("openai");
      expect(spy).toHaveBeenCalledWith("/api/settings/providers/openai/test", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });

    it("testAzureOpenAiDeployment", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          provider: "azure-openai",
          deployment: 2,
          health: { configured: true, reachable: true },
        }),
      } as Response);
      await testAzureOpenAiDeployment(1);
      expect(spy).toHaveBeenCalledWith("/api/settings/providers/azure-openai/deployments/2/test", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });

    it("reloadRuntimeSettingsCache", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, reloadedAt: "2026-05-23T00:00:00.000Z" }),
      } as Response);
      await reloadRuntimeSettingsCache();
      expect(spy).toHaveBeenCalledWith("/api/settings/reload-runtime-cache", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });
  });
});
