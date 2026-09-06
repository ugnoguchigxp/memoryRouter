import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import app from "../api/app.js";
import { adminApiKeyAuth } from "../api/middleware/admin-auth.js";
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
  testAzureOpenAiDeploymentForApi,
  testLocalLlmModelForApi,
  testProviderForApi,
  updateSettingsForApi,
} from "../api/modules/settings/settings.service.js";
import { vibeMemoryRouter } from "../api/modules/vibe-memory/vibe-memory.routes.js";
import { groupedConfig } from "../src/config.js";
import { requestCoverEvidenceReprocess } from "../src/modules/coverEvidence/reprocess-candidate.service.js";
import { cloneDefaultSettings } from "../src/modules/settings/settings.defaults.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";
import { compileRunDetailSchema } from "../src/shared/schemas/compile-run.schema.js";
import { type ContextPack, contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import {
  type DoctorAiServiceToolsDomain,
  type DoctorCoreInfrastructureDomain,
  type DoctorPipelineAutomationDomain,
  type DoctorReport,
  doctorAiServiceToolsDomainSchema,
  doctorCoreInfrastructureDomainSchema,
  doctorPipelineAutomationDomainSchema,
  doctorReportSchema,
} from "../src/shared/schemas/doctor.schema.js";
import {
  type OverviewDashboard,
  overviewDashboardSchema,
  overviewKnowledgeAssetsDomainSchema,
  overviewLandscapeHealthDomainSchema,
  overviewLlmResourcesDomainSchema,
  overviewSystemQualityDomainSchema,
} from "../src/shared/schemas/overview.schema.js";

vi.mock("../api/modules/context-compiler/context-compiler.service.js", () => ({
  compilePackForApi: vi.fn(),
  getRunDetailForApi: vi.fn(),
  getRunRankingTraceForApi: vi.fn(),
  getRunDetailParamSchema: z.object({
    id: z.string().uuid(),
  }),
  getRunRankingTraceParamSchema: z.object({
    id: z.string().uuid(),
  }),
  runKnowledgeFeedbackParamSchema: z.object({
    id: z.string().uuid(),
  }),
  runEpisodeFeedbackParamSchema: z.object({
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
  testAzureOpenAiDeploymentForApi: vi.fn(),
  testLocalLlmModelForApi: vi.fn(),
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

vi.mock("../src/modules/coverEvidence/reprocess-candidate.service.js", () => ({
  CoverEvidenceReprocessError: class CoverEvidenceReprocessError extends Error {
    statusCode: 404 | 409;
    reason: string;

    constructor(statusCode: 404 | 409, reason: string) {
      super(reason);
      this.name = "CoverEvidenceReprocessError";
      this.statusCode = statusCode;
      this.reason = reason;
    }
  },
  requestCoverEvidenceReprocess: vi.fn(),
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
    vi.mocked(testAzureOpenAiDeploymentForApi).mockResolvedValue({
      provider: "azure-openai",
      configured: true,
      reachable: true,
      model: "5.4mini",
      endpoint: "https://example.openai.azure.com",
    });
    vi.mocked(testLocalLlmModelForApi).mockResolvedValue({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "qwen-3.6-14b-it",
      endpoint: "http://127.0.0.1:44449",
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
    vi.mocked(requestCoverEvidenceReprocess).mockResolvedValue({
      findCandidateResultId: "candidate-1",
      coverEvidenceResultId: "candidate-1",
      targetStateId: "target-1",
      status: "queued",
      mode: "cloud_api",
      previousStatus: "insufficient",
      previousReason: "rule_body_not_actionable",
    });
  });

  test("GET /api/doctor returns contract-compatible response", async () => {
    const app = buildApp();
    const response = await app.request("/api/doctor");

    expect(response.status).toBe(200);
    const json = await response.json();
    const parsed = doctorReportSchema.parse(json);
    expect(parsed.status).toBe("ok");
    expect(getDoctorReportForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/doctor/domains/:domain returns domain-compatible responses", async () => {
    const app = buildApp();

    const coreResponse = await app.request("/api/doctor/domains/core-infrastructure");
    const aiResponse = await app.request("/api/doctor/domains/ai-service-tools");
    const pipelineResponse = await app.request("/api/doctor/domains/pipeline-automation");

    expect(coreResponse.status).toBe(200);
    expect(aiResponse.status).toBe(200);
    expect(pipelineResponse.status).toBe(200);
    expect(doctorCoreInfrastructureDomainSchema.parse(await coreResponse.json()).db.reachable).toBe(
      true,
    );
    expect(
      doctorAiServiceToolsDomainSchema.parse(await aiResponse.json()).mcp.exposedTools,
    ).toEqual(["context_compile", "compile_eval"]);
    expect(
      doctorPipelineAutomationDomainSchema.parse(await pipelineResponse.json()).runs.totalRuns,
    ).toBe(1);
    expect(getDoctorDomainForApi).toHaveBeenCalledWith("core-infrastructure");
    expect(getDoctorDomainForApi).toHaveBeenCalledWith("ai-service-tools");
    expect(getDoctorDomainForApi).toHaveBeenCalledWith("pipeline-automation");
  });

  test("GET /api/doctor/domains/:domain returns 404 for unknown domain", async () => {
    const app = buildApp();
    const response = await app.request("/api/doctor/domains/unknown");

    expect(response.status).toBe(404);
    expect(getDoctorDomainForApi).not.toHaveBeenCalled();
  });

  test("GET /api/overview returns contract-compatible response", async () => {
    const app = buildApp();
    const response = await app.request("/api/overview");

    expect(response.status).toBe(200);
    const json = await response.json();
    const parsed = overviewDashboardSchema.parse(json);
    expect(parsed.kpis.knowledgeTotal).toBe(334);
    expect(parsed.charts.dynamicScoreBuckets).toHaveLength(10);
    expect(fetchOverviewDashboardForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/overview/domains/:domain returns domain payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/overview/domains/knowledge-assets");

    expect(response.status).toBe(200);
    const json = await response.json();
    const parsed = overviewKnowledgeAssetsDomainSchema.parse(json);
    expect(parsed.kpis.knowledgeTotal).toBe(334);
    expect(parsed.charts.dynamicScoreBuckets).toHaveLength(10);
    expect(fetchOverviewDomainForApi).toHaveBeenCalledWith("knowledge-assets");
  });

  test("GET /api/overview/domains/:domain rejects unknown domain", async () => {
    const app = buildApp();
    const response = await app.request("/api/overview/domains/unknown");

    expect(response.status).toBe(404);
    expect(fetchOverviewDomainForApi).not.toHaveBeenCalled();
  });

  test("GET /api/settings returns payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings");
    const json = (await response.json()) as {
      settings: unknown;
      revision: number;
    };

    expect(response.status).toBe(200);
    expect(json.revision).toBe(1);
    expect(getSettingsForApi).toHaveBeenCalledTimes(1);
  });

  test("PUT /api/settings rejects invalid payload", async () => {
    const app = buildApp();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      expect(response.status).toBe(400);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[settings] update rejected",
        expect.stringContaining("validation_failed"),
      );
      expect(updateSettingsForApi).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test("PUT /api/settings backfills legacy task routing fields", async () => {
    const app = buildApp();
    const settings = cloneDefaultSettings() as any;
    settings.taskRouting.episodeDistiller = undefined;
    settings.taskRouting.mergeActivationFinalize = undefined;

    const response = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings, updatedBy: "api-routes-test" }),
    });

    expect(response.status).toBe(200);
    expect(updateSettingsForApi).toHaveBeenCalledTimes(1);
    const update = vi.mocked(updateSettingsForApi).mock.calls[0]?.[0];
    expect(update?.updatedBy).toBe("api-routes-test");
    expect(update?.settings.taskRouting.episodeDistiller).toMatchObject({
      provider: settings.taskRouting.webSourceResearch.provider,
      model: settings.taskRouting.webSourceResearch.model,
      fallback: settings.taskRouting.webSourceResearch.fallback,
    });
    expect(update?.settings.taskRouting.mergeActivationFinalize).toMatchObject({
      provider: settings.taskRouting.finalizeDistille.provider,
      model: settings.taskRouting.finalizeDistille.model,
      fallback: settings.taskRouting.finalizeDistille.fallback,
    });
    const episodeRoute = update?.settings.taskRouting.episodeDistiller;
    const mergeRoute = update?.settings.taskRouting.mergeActivationFinalize;
    expect(
      episodeRoute && "providerPoolId" in episodeRoute ? episodeRoute.providerPoolId : undefined,
    ).toBeUndefined();
    expect(
      mergeRoute && "providerPoolId" in mergeRoute ? mergeRoute.providerPoolId : undefined,
    ).toBeUndefined();
  });

  test("POST /api/settings/providers/:provider/test returns provider health", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/providers/openai/test", {
      method: "POST",
    });
    const json = (await response.json()) as {
      provider: string;
      health: {
        configured: boolean;
        reachable: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.provider).toBe("openai");
    expect(json.health.configured).toBe(true);
    expect(testProviderForApi).toHaveBeenCalledWith("openai");
  });

  test("POST /api/settings/providers/azure-openai/deployments/:deployment/test returns deployment health", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/providers/azure-openai/deployments/2/test", {
      method: "POST",
    });
    const json = (await response.json()) as {
      provider: string;
      deployment: number;
      health: {
        configured: boolean;
        reachable: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.provider).toBe("azure-openai");
    expect(json.deployment).toBe(2);
    expect(json.health.configured).toBe(true);
    expect(testAzureOpenAiDeploymentForApi).toHaveBeenCalledWith(2);
  });

  test("POST /api/settings/providers/local-llm/models/test returns model health", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/providers/local-llm/models/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-3.6-14b-it" }),
    });
    const json = (await response.json()) as {
      provider: string;
      model: string;
      health: {
        configured: boolean;
        reachable: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.provider).toBe("local-llm");
    expect(json.model).toBe("qwen-3.6-14b-it");
    expect(json.health.configured).toBe(true);
    expect(testLocalLlmModelForApi).toHaveBeenCalledWith({ model: "qwen-3.6-14b-it" });
  });

  test("POST /api/settings/reload-runtime-cache returns reload result", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/reload-runtime-cache", {
      method: "POST",
    });
    const json = (await response.json()) as {
      ok: boolean;
      reloadedAt: string;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.reloadedAt).toBe("2026-05-23T00:00:00.000Z");
    expect(reloadRuntimeCacheForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/knowledge rejects invalid query", async () => {
    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=0");

    expect(response.status).toBe(400);
    expect(listKnowledgeItems).not.toHaveBeenCalled();
    expect(countKnowledgeItems).not.toHaveBeenCalled();
  });

  test("GET /api/knowledge/tags returns tag definitions", async () => {
    vi.mocked(listKnowledgeTagDefinitionsForApi).mockResolvedValueOnce([
      {
        id: "550e8400-e29b-41d4-a716-446655440004",
        kind: "technology",
        slug: "typescript",
        label: "TypeScript",
        description: null,
        aliases: ["ts"],
        status: "active",
        sortOrder: 10,
      },
    ]);
    const app = buildApp();
    const response = await app.request("/api/knowledge/tags?kind=technology&status=active");
    const json = (await response.json()) as {
      tags: Array<{ slug: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.tags).toHaveLength(1);
    expect(json.tags[0]?.slug).toBe("typescript");
    expect(listKnowledgeTagDefinitionsForApi).toHaveBeenCalledWith({
      kind: "technology",
      status: "active",
    });
  });

  test("GET /api/knowledge returns list shape used by web repository", async () => {
    vi.mocked(listKnowledgeItems).mockResolvedValueOnce([
      {
        id: "550e8400-e29b-41d4-a716-446655440002",
        type: "rule",
        status: "active",
        scope: "repo",
        title: "Knowledge title",
        body: "Knowledge body",
        confidence: 80,
        importance: 70,
        appliesTo: {},
        metadata: {},
        sourceRefs: [],
        sourceVibeMemoryIds: [],
        compileSelectCount: 0,
        lastCompiledAt: null,
        agenticAcceptCount: 0,
        explicitUpvoteCount: 0,
        explicitDownvoteCount: 0,
        dynamicScore: 0,
        decayFactor: 1,
        lastVerifiedAt: null,
        polarity: "positive",
        intentTags: [],
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);
    vi.mocked(countKnowledgeItems).mockResolvedValueOnce(260);

    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=1&page=2");
    const json = (await response.json()) as {
      items: Array<{ id: string; title: string }>;
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };

    expect(response.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.total).toBe(260);
    expect(json.page).toBe(2);
    expect(json.limit).toBe(1);
    expect(json.totalPages).toBe(260);
    expect(json.items[0]?.id).toBe("550e8400-e29b-41d4-a716-446655440002");
    expect(json.items[0]?.title).toBe("Knowledge title");
    expect(listKnowledgeItems).toHaveBeenCalledWith({
      limit: 1,
      page: 2,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
    expect(countKnowledgeItems).toHaveBeenCalledWith({
      limit: 1,
      page: 2,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
  });

  test("GET /api/knowledge passes server-side sort parameters", async () => {
    vi.mocked(listKnowledgeItems).mockResolvedValueOnce([]);
    vi.mocked(countKnowledgeItems).mockResolvedValueOnce(0);

    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=20&page=3&sortBy=title&sortDir=asc");

    expect(response.status).toBe(200);
    expect(listKnowledgeItems).toHaveBeenCalledWith({
      limit: 20,
      page: 3,
      sortBy: "title",
      sortDir: "asc",
    });
  });

  test("GET /api/knowledge passes displayFilter and minQuality parameters", async () => {
    vi.mocked(listKnowledgeItems).mockResolvedValueOnce([]);
    vi.mocked(countKnowledgeItems).mockResolvedValueOnce(0);

    const app = buildApp();
    const response = await app.request(
      "/api/knowledge?limit=20&page=1&displayFilter=stale&minQuality=70",
    );

    expect(response.status).toBe(200);
    expect(listKnowledgeItems).toHaveBeenCalledWith({
      limit: 20,
      page: 1,
      displayFilter: "stale",
      minQuality: 70,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
    expect(countKnowledgeItems).toHaveBeenCalledWith({
      limit: 20,
      page: 1,
      displayFilter: "stale",
      minQuality: 70,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
  });

  test("PUT /api/knowledge/:id rejects invalid payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/knowledge/invalid-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "rule",
        status: "active",
        scope: "repo",
        title: "",
        body: "body",
      }),
    });

    expect(response.status).toBe(400);
    expect(updateKnowledgeItem).not.toHaveBeenCalled();
  });
});
