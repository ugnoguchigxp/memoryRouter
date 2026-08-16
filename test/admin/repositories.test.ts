import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkUpdateKnowledgeStatus,
  createKnowledgeItem,
  deleteKnowledgeItem,
  deleteVibeMemory,
  fetchAgentDiffEntries,
  fetchDoctorAiServiceToolsDomain,
  fetchDoctorCoreInfrastructureDomain,
  fetchDoctorPipelineAutomationDomain,
  fetchDoctorReport,
  fetchGraphCommunityLabels,
  fetchGraphNodeDetail,
  fetchGraphSnapshot,
  fetchKnowledgeItems,
  fetchLandscapeSnapshot,
  fetchOverviewDashboard,
  fetchOverviewKnowledgeAssetsDomain,
  fetchOverviewLandscapeHealthDomain,
  fetchOverviewLlmResourcesDomain,
  fetchOverviewSystemQualityDomain,
  fetchVibeMemories,
  queueWebSourceUrl,
  queueWebSourceUrlsUpload,
  sendKnowledgeFeedback,
  updateGraphCommunityLabel,
  updateKnowledgeItem,
} from "../../web/src/modules/admin/repositories/admin.repository.js";

describe("Admin Repository", () => {
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

  describe("error handling of getJson and requestJson", () => {
    it("getJson should throw error if response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);
      await expect(fetchDoctorReport()).rejects.toThrow("/api/doctor failed: 500");
    });

    it("getJson should preserve nested error payload code and message", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error: {
            code: "QUEUE_SCHEMA_NOT_READY",
            message: "queue schema is not ready",
          },
        }),
      } as unknown as Response);

      await expect(fetchDoctorReport()).rejects.toMatchObject({
        name: "AdminApiError",
        status: 503,
        code: "QUEUE_SCHEMA_NOT_READY",
        message: "queue schema is not ready",
      });
    });

    it("requestJson should throw custom error payload if response has outcome", async () => {
      const payload = { outcome: "invalid", message: "something wrong" };
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => payload,
      } as unknown as Response);
      await expect(deleteVibeMemory("123")).rejects.toThrow(JSON.stringify(payload));
    });

    it("requestJson should throw simple error message if response json fails or has no outcome", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response);
      await expect(deleteVibeMemory("123")).rejects.toThrow(
        "DELETE /api/vibe-memory/123 failed: 400",
      );
    });

    it("requestJson should prioritize reason/message from error payload", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ reason: "invalid url" }),
      } as unknown as Response);
      await expect(queueWebSourceUrl({ url: "bad" })).rejects.toThrow("invalid url");
    });

    it("requestForm should prioritize reason/message from error payload", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ reason: "no url found in upload file" }),
      } as unknown as Response);
      const file = new File(["not a url"], "urls.csv", { type: "text/csv" });
      await expect(queueWebSourceUrlsUpload({ file })).rejects.toThrow(
        "no url found in upload file",
      );
    });

    it("requestJson should prioritize error string from error payload", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      } as unknown as Response);
      await expect(deleteKnowledgeItem("k-1")).rejects.toThrow("unauthorized");
    });

    it("exchanges a global admin key for an HttpOnly session and clears it", async () => {
      const runtime = globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: string };
      runtime.__MEMORY_ROUTER_ADMIN_API_KEY__ = "test-admin-key";
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      await deleteKnowledgeItem("k-1");

      expect(spy).toHaveBeenNthCalledWith(1, "/api/admin-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "test-admin-key" }),
      });
      expect(spy).toHaveBeenNthCalledWith(2, "/api/knowledge/k-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
      expect(runtime.__MEMORY_ROUTER_ADMIN_API_KEY__).toBeUndefined();
      if (typeof window !== "undefined") {
        expect(window.localStorage.getItem("context_still_admin_api_key")).toBeNull();
      }
    });

    it("removes legacy query and localStorage keys without using them", async () => {
      if (typeof window === "undefined") return;
      window.history.replaceState(null, "", "/?admin_api_key=url-admin-key&foo=1");
      window.localStorage.setItem("context_still_admin_api_key", "stored-admin-key");
      window.localStorage.setItem("memory_router_admin_api_key", "legacy-admin-key");
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      await deleteKnowledgeItem("k-1");

      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
      expect(window.location.search).toBe("?foo=1");
      expect(window.localStorage.getItem("context_still_admin_api_key")).toBeNull();
      expect(window.localStorage.getItem("memory_router_admin_api_key")).toBeNull();
    });
  });

  describe("knowledge management", () => {
    it("fetchKnowledgeItems default limit", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems();
      expect(spy).toHaveBeenCalledWith("/api/knowledge?limit=80");
    });

    it("fetchKnowledgeItems with number", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems(10);
      expect(spy).toHaveBeenCalledWith("/api/knowledge?limit=10");
    });

    it("fetchKnowledgeItems with object", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems({
        limit: 20,
        page: 2,
        status: "active",
        query: "test",
        displayFilter: "stale",
        minQuality: 50,
        sortBy: "title",
        sortDir: "asc",
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/knowledge?limit=20&page=2&status=active&query=test&displayFilter=stale&minQuality=50&sortBy=title&sortDir=asc",
      );
    });

    it("createKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      const input = {
        type: "rule" as const,
        status: "active",
        scope: "global",
        title: "Rule title",
        body: "Rule body",
        confidence: 0.9,
        importance: 0.8,
      };
      await createKnowledgeItem(input);
      expect(spy).toHaveBeenCalledWith("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("updateKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await updateKnowledgeItem("k-1", { title: "New title" });
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      });
    });

    it("deleteKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await deleteKnowledgeItem("k-1");
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("bulkUpdateKnowledgeStatus with ids", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      const req = { ids: ["k-1"], status: "deprecated" as const };
      await bulkUpdateKnowledgeStatus(req);
      expect(spy).toHaveBeenCalledWith("/api/knowledge/bulk-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    });

    it("sendKnowledgeFeedback", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ feedback: { id: "f-1" } }),
      } as Response);
      const input = { direction: "up" as const, reason: "good" };
      const res = await sendKnowledgeFeedback("k-1", input);
      expect(res).toEqual({ id: "f-1" });
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });
  });

  describe("vibe memories", () => {
    it("fetchVibeMemories default", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ memories: [] }),
      } as Response);
      await fetchVibeMemories();
      expect(spy).toHaveBeenCalledWith("/api/vibe-memory?limit=120");
    });

    it("deleteVibeMemory", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await deleteVibeMemory("v-1");
      expect(spy).toHaveBeenCalledWith("/api/vibe-memory/v-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });
  });

  describe("agent diffs", () => {
    it("fetchAgentDiffEntries", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ entries: [] }),
      } as Response);
      await fetchAgentDiffEntries(50, {
        id: "d-1",
        vibeMemoryId: "v-1",
        vibeMemoryIds: ["v-1", "v-2"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/agent-diffs?limit=50&id=d-1&vibeMemoryId=v-1&vibeMemoryIds=v-1%2Cv-2",
      );
    });
  });

  describe("doctor and overview", () => {
    it("fetchDoctorReport", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);
      const res = await fetchDoctorReport();
      expect(res).toEqual({ status: "ok" });
      expect(spy).toHaveBeenCalledWith("/api/doctor");
    });

    it("fetchDoctorCoreInfrastructureDomain", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);
      const res = await fetchDoctorCoreInfrastructureDomain();
      expect(res).toEqual({ status: "ok" });
      expect(spy).toHaveBeenCalledWith("/api/doctor/domains/core-infrastructure");
    });

    it("fetchDoctorAiServiceToolsDomain", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);
      const res = await fetchDoctorAiServiceToolsDomain();
      expect(res).toEqual({ status: "ok" });
      expect(spy).toHaveBeenCalledWith("/api/doctor/domains/ai-service-tools");
    });

    it("fetchDoctorPipelineAutomationDomain", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);
      const res = await fetchDoctorPipelineAutomationDomain();
      expect(res).toEqual({ status: "ok" });
      expect(spy).toHaveBeenCalledWith("/api/doctor/domains/pipeline-automation");
    });

    it("fetchOverviewDashboard", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ checkedAt: "now" }),
      } as Response);
      const res = await fetchOverviewDashboard();
      expect(res).toEqual({ checkedAt: "now" });
      expect(spy).toHaveBeenCalledWith("/api/overview");

      await fetchOverviewDashboard("America/New_York");
      expect(spy).toHaveBeenLastCalledWith("/api/overview?timezone=America%2FNew_York");
    });

    it("fetchOverview domain payloads", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ checkedAt: "now" }),
      } as Response);

      await fetchOverviewKnowledgeAssetsDomain();
      await fetchOverviewLandscapeHealthDomain();
      await fetchOverviewSystemQualityDomain();
      await fetchOverviewLlmResourcesDomain();

      expect(spy).toHaveBeenNthCalledWith(1, "/api/overview/domains/knowledge-assets");
      expect(spy).toHaveBeenNthCalledWith(2, "/api/overview/domains/landscape-health");
      expect(spy).toHaveBeenNthCalledWith(3, "/api/overview/domains/system-quality");
      expect(spy).toHaveBeenNthCalledWith(4, "/api/overview/domains/llm-resources");

      await fetchOverviewKnowledgeAssetsDomain("Asia/Tokyo");
      expect(spy).toHaveBeenLastCalledWith(
        "/api/overview/domains/knowledge-assets?timezone=Asia%2FTokyo",
      );
    });
  });

  describe("graph", () => {
    it("fetchGraphSnapshot with number", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot(500);
      expect(spy).toHaveBeenCalledWith("/api/graph?limit=500");
    });

    it("fetchGraphSnapshot with object", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 100,
        status: "active",
        view: "semantic",
        relationAxes: ["session", "source"],
        minSimilarity: 0.5,
        semanticTopK: 5,
        maxContextEdgesPerNode: 3,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=100&status=active&view=semantic&relationAxes=session%2Csource&minSimilarity=0.5&semanticTopK=5&maxContextEdgesPerNode=3",
      );
    });

    it("fetchGraphSnapshot with community view", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 80,
        status: "all",
        view: "community",
        relationAxes: ["project", "source"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=80&status=all&view=community&relationAxes=project%2Csource",
      );
    });

    it("fetchGraphSnapshot with community supernode mode", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 60,
        status: "active",
        view: "community",
        communityDisplay: "supernode",
        relationAxes: ["session"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=60&status=active&view=community&communityDisplay=supernode&relationAxes=session",
      );
    });

    it("fetchGraphSnapshot with evidence view and sourceNodeLimit", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 120,
        status: "all",
        view: "evidence",
        sourceNodeLimit: 300,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=120&status=all&view=evidence&sourceNodeLimit=300",
      );
    });

    it("fetchLandscapeSnapshot default params", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ communities: [] }),
      } as Response);
      await fetchLandscapeSnapshot();
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/landscape?windowDays=30&limit=1000&status=active&format=full&relationAxes=session%2Cproject%2Csource",
      );
    });

    it("fetchLandscapeSnapshot with custom params", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ communities: [] }),
      } as Response);
      await fetchLandscapeSnapshot({
        windowDays: 14,
        limit: 120,
        status: "all",
        relationAxes: ["project", "source"],
        minSelectedCount: 5,
        minFeedbackCount: 7,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/landscape?windowDays=14&limit=120&status=all&format=full&relationAxes=project%2Csource&minSelectedCount=5&minFeedbackCount=7",
      );
    });

    it("fetchGraphCommunityLabels", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ labels: [] }),
      } as Response);
      await fetchGraphCommunityLabels({
        limit: 100,
        status: "all",
        relationAxes: ["project", "source"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/community-labels?limit=100&status=all&relationAxes=project%2Csource",
      );
    });

    it("updateGraphCommunityLabel", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          label: {
            communityKey: "a".repeat(64),
            label: "Data Quality",
            note: null,
            updatedAt: "2026-05-23T00:00:00.000Z",
          },
        }),
      } as Response);
      await updateGraphCommunityLabel({
        communityKey: "a".repeat(64),
        label: "Data Quality",
      });
      expect(spy).toHaveBeenCalledWith(`/api/graph/community-labels/${"a".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Data Quality", note: "" }),
      });
    });

    it("fetchGraphNodeDetail success", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ id: "node-1" }),
      } as Response);
      const res = await fetchGraphNodeDetail("node-1");
      expect(res).toEqual({ id: "node-1" });
      expect(spy).toHaveBeenCalledWith("/api/graph/nodes/node-1");
    });

    it("fetchGraphNodeDetail failure returns null", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);
      const res = await fetchGraphNodeDetail("node-1");
      expect(res).toBeNull();
    });
  });
});
