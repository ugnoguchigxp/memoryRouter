import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { listAuditLogsForApi } from "../api/modules/audit/audit.repository.js";
import { auditLogsRouter } from "../api/modules/audit/audit.routes.js";
import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";
import { candidatesRouter } from "../api/modules/candidates/candidates.routes.js";
import { contextCompilerRouter } from "../api/modules/context-compiler/context-compiler.routes.js";
import {
  compilePackForApi,
  getRunDetailForApi,
  getRunRankingTraceForApi,
  listRunsForApi,
  saveRunKnowledgeFeedbackForApi,
} from "../api/modules/context-compiler/context-compiler.service.js";
import { doctorRouter } from "../api/modules/doctor/doctor.routes.js";
import {
  getDoctorDomainForApi,
  getDoctorReportForApi,
} from "../api/modules/doctor/doctor.service.js";
import {
  bulkUpdateKnowledgeStatus,
  countKnowledgeItems,
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeTagDefinitionsForApi,
  recordKnowledgeFeedback,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import { knowledgeRouter } from "../api/modules/knowledge/knowledge.routes.js";
import {
  fetchOverviewDashboardForApi,
  fetchOverviewDomainForApi,
} from "../api/modules/overview/overview.repository.js";
import { overviewRouter } from "../api/modules/overview/overview.routes.js";
import { settingsRouter } from "../api/modules/settings/settings.routes.js";
import {
  getSettingsForApi,
  reloadRuntimeCacheForApi,
  testProviderForApi,
  updateSettingsForApi,
} from "../api/modules/settings/settings.service.js";
import { vibeMemoryRouter } from "../api/modules/vibe-memory/vibe-memory.routes.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";

vi.mock("../api/modules/context-compiler/context-compiler.service.js", () => ({
  compilePackForApi: vi.fn(),
  getRunDetailForApi: vi.fn(),
  getRunRankingTraceForApi: vi.fn(),
  runIdParamSchema: z.object({
    id: z.string().uuid(),
  }),
  runEpisodeDeprecateParamSchema: z.object({
    id: z.string().uuid(),
    episodeId: z.string().trim().min(1),
  }),
  listRunsForApi: vi.fn(),
  listRunsQuerySchema: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  saveRunKnowledgeFeedbackForApi: vi.fn(),
  saveRunEpisodeFeedbackForApi: vi.fn(),
  deprecateRunEpisodeForApi: vi.fn(),
}));

vi.mock("../api/modules/doctor/doctor.service.js", () => ({
  getDoctorDomainForApi: vi.fn(),
  getDoctorReportForApi: vi.fn(),
}));

vi.mock("../api/modules/overview/overview.repository.js", () => ({
  fetchOverviewDashboardForApi: vi.fn(),
  fetchOverviewDomainForApi: vi.fn(),
}));

vi.mock("../api/modules/settings/settings.service.js", () => ({
  getSettingsForApi: vi.fn(),
  updateSettingsForApi: vi.fn(),
  testProviderForApi: vi.fn(),
  reloadRuntimeCacheForApi: vi.fn(),
}));

vi.mock("../api/modules/candidates/candidates.repository.js", () => ({
  candidateListSortByValues: [
    "targetKey",
    "candidateTitle",
    "coverageStatus",
    "knowledgeStatus",
    "outcome",
    "qualityScore",
    "latestUpdatedAt",
  ] as const,
  candidateOutcomeValues: [
    "stored",
    "ready_not_finalized",
    "rejected",
    "retryable",
    "retained_failure",
    "candidate_only",
    "target_pending",
  ] as const,
  listCandidateItems: vi.fn(),
}));

vi.mock("../api/modules/knowledge/knowledge.repository.js", () => ({
  bulkUpdateKnowledgeStatus: vi.fn(),
  countKnowledgeItems: vi.fn(),
  createKnowledgeItem: vi.fn(),
  deleteKnowledgeItem: vi.fn(),
  listKnowledgeTagDefinitionsForApi: vi.fn(),
  listKnowledgeItems: vi.fn(),
  recordKnowledgeFeedback: vi.fn(),
  updateKnowledgeItem: vi.fn(),
}));

vi.mock("../api/modules/audit/audit.repository.js", () => ({
  listAuditLogsForApi: vi.fn(),
}));

vi.mock("../src/modules/vibe-memory/vibe-memory.service.js", () => ({
  recordVibeMemoryWithDiffEntries: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/audit-logs", auditLogsRouter);
  app.route("/api/candidates", candidatesRouter);
  app.route("/api/context", contextCompilerRouter);
  app.route("/api/doctor", doctorRouter);
  app.route("/api/knowledge", knowledgeRouter);
  app.route("/api/overview", overviewRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/vibe-memory", vibeMemoryRouter);
  return app;
};

import {
  validCompileResponse,
  validDoctorAiServiceTools,
  validDoctorCoreInfrastructure,
  validDoctorPipelineAutomation,
  validDoctorReport,
  validOverviewDashboard,
  validOverviewKnowledgeAssets,
  validOverviewLandscapeHealth,
  validOverviewLlmResources,
  validOverviewSystemQuality,
  validRunDetail,
  validRunKnowledgeFeedback,
} from "./fixtures/api-route-contract-fixtures.js";

describe("API route contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAuditLogsForApi).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
      availableEventTypes: [],
    });
    vi.mocked(compilePackForApi).mockResolvedValue(validCompileResponse);
    vi.mocked(listRunsForApi).mockResolvedValue([]);
    vi.mocked(getRunDetailForApi).mockResolvedValue(validRunDetail);
    vi.mocked(getRunRankingTraceForApi).mockResolvedValue({
      run: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        goal: "api contract goal",
        repoPath: null,
        retrievalMode: "task_context",
        status: "ok",
        input: {},
        createdAt: "2026-05-23T00:00:00.000Z",
      },
      evalSummary: { count: 0, latestAvg: null, latestOutcome: null },
      feedbackSummary: { used: 0, notUsed: 0, offTopic: 0, wrong: 0, noSignal: 0 },
      funnel: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        finalCount: 0,
        packedCount: 0,
        selectedCount: 0,
        suppressedCount: 0,
      },
      items: [],
    } as any);
    vi.mocked(saveRunKnowledgeFeedbackForApi).mockResolvedValue(validRunKnowledgeFeedback);
    vi.mocked(getDoctorReportForApi).mockResolvedValue(validDoctorReport);
    vi.mocked(getDoctorDomainForApi).mockImplementation(async (domain) => {
      if (domain === "core-infrastructure") return validDoctorCoreInfrastructure;
      if (domain === "ai-service-tools") return validDoctorAiServiceTools;
      return validDoctorPipelineAutomation;
    });
    vi.mocked(fetchOverviewDashboardForApi).mockResolvedValue(validOverviewDashboard);
    vi.mocked(fetchOverviewDomainForApi).mockImplementation(async (domain) => {
      if (domain === "knowledge-assets") return validOverviewKnowledgeAssets;
      if (domain === "landscape-health") return validOverviewLandscapeHealth;
      if (domain === "system-quality") return validOverviewSystemQuality;
      return validOverviewLlmResources;
    });
    vi.mocked(getSettingsForApi).mockResolvedValue({
      settings: {},
      effective: {},
      sources: {},
      revision: 1,
      loadedAt: "2026-05-23T00:00:00.000Z",
    } as any);
    vi.mocked(updateSettingsForApi).mockResolvedValue({
      settings: {},
      effective: {},
      sources: {},
      revision: 2,
      loadedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      cacheInvalidated: true,
      reloadRequired: true,
    } as any);
    vi.mocked(testProviderForApi).mockResolvedValue({
      provider: "openai",
      configured: true,
      reachable: true,
      model: "5.4mini",
      endpoint: "https://api.openai.com/v1",
    });
    vi.mocked(reloadRuntimeCacheForApi).mockResolvedValue({
      ok: true,
      reloadedAt: "2026-05-23T00:00:00.000Z",
    });
    vi.mocked(listCandidateItems).mockResolvedValue({
      items: [],
      total: 0,
      stats: {
        total: 0,
        stored: 0,
        readyNotFinalized: 0,
        rejected: 0,
        retryable: 0,
        retainedFailure: 0,
        targetPending: 0,
        candidateOnly: 0,
      },
    });
    vi.mocked(listKnowledgeItems).mockResolvedValue([]);
    vi.mocked(listKnowledgeTagDefinitionsForApi).mockResolvedValue([]);
    vi.mocked(countKnowledgeItems).mockResolvedValue(0);
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValue({
      targetStatus: "active",
      requestedIds: [],
      updatedIds: [],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    vi.mocked(createKnowledgeItem).mockResolvedValue({ id: "new-item-id" });
    vi.mocked(updateKnowledgeItem).mockResolvedValue({ id: "updated-item-id" });
    vi.mocked(deleteKnowledgeItem).mockResolvedValue({ id: "deleted-item-id" });
    vi.mocked(recordKnowledgeFeedback).mockResolvedValue({
      id: "updated-item-id",
      direction: "up",
      explicitUpvoteCount: 1,
      explicitDownvoteCount: 0,
      dynamicScore: 42,
      lastVerifiedAt: new Date("2026-05-15T00:00:00.000Z"),
    });
    vi.mocked(recordVibeMemoryWithDiffEntries).mockResolvedValue({
      memory: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        sessionId: "session-1",
        content: "saved memory",
        memoryType: "chat",
        dedupeKey: null,
        embedding: null,
        metadata: {},
        createdAt: "2026-05-15T00:00:00.000Z",
      } as never,
      diffEntries: [],
    });
  });

  test("PUT /api/knowledge/:id returns 404 when item does not exist", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce(null as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "rule",
        status: "active",
        scope: "repo",
        title: "Updated title",
        body: "Updated body",
        confidence: 70,
        importance: 70,
        metadata: {},
      }),
    });

    expect(response.status).toBe(404);
    const json = (await response.json()) as { error: string };
    expect(json.error).toBe("not found");
  });

  test("PUT /api/knowledge/:id accepts patch payload", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce({ id: "updated-item-id" } as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(200);
    expect(updateKnowledgeItem).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440003", {
      status: "deprecated",
    });
  });

  test("PUT /api/knowledge/:id keeps unknown appliesTo keys", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce({ id: "updated-item-id" } as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appliesTo: {
          general: true,
          customFacet: ["alpha", "beta"],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(updateKnowledgeItem).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440003", {
      appliesTo: {
        general: true,
        customFacet: ["alpha", "beta"],
      },
    });
  });

  test("POST /api/knowledge/bulk-status returns partial update summary", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "active",
      requestedIds: ["k1", "k2"],
      updatedIds: ["k1"],
      unchangedIds: [],
      notFoundIds: ["k2"],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["k1", "k2"],
        status: "active",
      }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
      notFoundIds: string[];
    };
    expect(json.outcome).toBe("partial");
    expect(json.updatedIds).toEqual(["k1"]);
    expect(json.notFoundIds).toEqual(["k2"]);
  });

  test("POST /api/knowledge/bulk-status accepts status selection", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "active",
      requestedIds: ["k1", "k2", "k3"],
      updatedIds: ["k1", "k2", "k3"],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: { status: "draft", query: "router" },
        status: "active",
      }),
    });

    expect(response.status).toBe(200);
    expect(bulkUpdateKnowledgeStatus).toHaveBeenCalledWith({
      selection: { status: "draft", query: "router" },
      status: "active",
    });
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
    };
    expect(json.outcome).toBe("ok");
    expect(json.updatedIds).toEqual(["k1", "k2", "k3"]);
  });

  test("POST /api/knowledge/bulk-status accepts all item selection", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "deprecated",
      requestedIds: ["k1", "k2"],
      updatedIds: ["k1", "k2"],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: {},
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(200);
    expect(bulkUpdateKnowledgeStatus).toHaveBeenCalledWith({
      selection: {},
      status: "deprecated",
    });
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
    };
    expect(json.outcome).toBe("ok");
    expect(json.updatedIds).toEqual(["k1", "k2"]);
  });

  test("POST /api/knowledge/bulk-status returns 409 when nothing can be updated", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "deprecated",
      requestedIds: ["k1"],
      updatedIds: [],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [{ id: "k1", fromStatus: "draft" }],
    });

    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["k1"],
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(409);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("none");
  });

  test("POST /api/knowledge/:id/feedback returns payload", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/knowledge/550e8400-e29b-41d4-a716-446655440003/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: "up" }),
      },
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      feedback: { id: string; direction: string };
    };
    expect(json.feedback.id).toBe("updated-item-id");
    expect(json.feedback.direction).toBe("up");
  });

  test("POST /api/vibe-memory rejects invalid payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "" }),
    });

    expect(response.status).toBe(400);
    expect(recordVibeMemoryWithDiffEntries).not.toHaveBeenCalled();
  });

  test("POST /api/vibe-memory returns created payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        content: "memory body",
      }),
    });

    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      memory: { sessionId: string; memoryType: string };
      diffEntries: unknown[];
    };
    expect(json.memory.sessionId).toBe("session-1");
    expect(json.memory.memoryType).toBe("chat");
    expect(Array.isArray(json.diffEntries)).toBe(true);
  });
});
