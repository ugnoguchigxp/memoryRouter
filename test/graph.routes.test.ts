import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type DeadZoneKnowledgeReviewResponse,
  deadZoneKnowledgeReviewActionResultSchema,
  deadZoneKnowledgeReviewResponseSchema,
} from "../src/shared/schemas/landscape-deadzone-review.schema.js";
import {
  landscapeReplayComparisonResponseSchema,
  landscapeReplaySnapshotSchema,
} from "../src/shared/schemas/landscape-replay.schema.js";
import { landscapeSnapshotCacheStatusSchema } from "../src/shared/schemas/landscape-snapshot-cache.schema.js";
import { landscapeTrajectoryResultSchema } from "../src/shared/schemas/landscape-trajectory.schema.js";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.js";
import {
  validLandscapeSnapshot,
  validLandscapeSnapshotCacheStatus,
  validReplayComparison,
  validReplaySnapshot,
  validTrajectory,
} from "./fixtures/graph-route-fixtures.js";

const {
  buildLandscapeReplayComparisonMock,
  buildLandscapeReplaySnapshotMock,
  buildLandscapeSnapshotMock,
  getLandscapeSnapshotCacheStatusMock,
  buildLandscapeTrajectoryMock,
  createLandscapeReviewCandidatesMock,
  updateLandscapeReviewCandidateLinkMock,
  listLandscapeReviewItemsMock,
  listLandscapeContradictionOverlayMock,
  materializeLandscapeReviewItemsMock,
  updateLandscapeReviewItemStatusMock,
  buildDeadZoneKnowledgeReviewMock,
  applyDeadZoneKnowledgeReviewActionMock,
  maintainDeadZoneKnowledgeMock,
  enqueueLandscapeCurationForReviewMock,
  getLandscapeCurationJobMock,
  listLandscapeCurationJobsMock,
  LandscapeReviewCandidateLinkErrorMock,
  LandscapeReviewItemsErrorMock,
  LandscapeCurationErrorMock,
} = vi.hoisted(() => ({
  buildLandscapeReplayComparisonMock: vi.fn(),
  buildLandscapeReplaySnapshotMock: vi.fn(),
  buildLandscapeSnapshotMock: vi.fn(),
  getLandscapeSnapshotCacheStatusMock: vi.fn(),
  buildLandscapeTrajectoryMock: vi.fn(),
  createLandscapeReviewCandidatesMock: vi.fn(),
  updateLandscapeReviewCandidateLinkMock: vi.fn(),
  listLandscapeReviewItemsMock: vi.fn(),
  listLandscapeContradictionOverlayMock: vi.fn(),
  materializeLandscapeReviewItemsMock: vi.fn(),
  updateLandscapeReviewItemStatusMock: vi.fn(),
  buildDeadZoneKnowledgeReviewMock: vi.fn(),
  applyDeadZoneKnowledgeReviewActionMock: vi.fn(),
  maintainDeadZoneKnowledgeMock: vi.fn(),
  enqueueLandscapeCurationForReviewMock: vi.fn(),
  getLandscapeCurationJobMock: vi.fn(),
  listLandscapeCurationJobsMock: vi.fn(),
  LandscapeReviewCandidateLinkErrorMock: class LandscapeReviewCandidateLinkErrorMock extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "LandscapeReviewCandidateLinkError";
      this.statusCode = statusCode;
    }
  },
  LandscapeReviewItemsErrorMock: class LandscapeReviewItemsErrorMock extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "LandscapeReviewItemsError";
      this.statusCode = statusCode;
    }
  },
  LandscapeCurationErrorMock: class LandscapeCurationErrorMock extends Error {
    readonly statusCode: 400 | 404 | 409;

    constructor(message: string, statusCode: 400 | 404 | 409 = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: buildLandscapeReplayComparisonMock,
}));

vi.mock("../src/modules/landscape/landscape-replay.service.js", () => ({
  buildLandscapeReplaySnapshot: buildLandscapeReplaySnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-deadzone-review.service.js", () => ({
  DeadZoneKnowledgeMaintenanceError: class DeadZoneKnowledgeMaintenanceErrorMock extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  buildDeadZoneKnowledgeReview: buildDeadZoneKnowledgeReviewMock,
  applyDeadZoneKnowledgeReviewAction: applyDeadZoneKnowledgeReviewActionMock,
  maintainDeadZoneKnowledge: maintainDeadZoneKnowledgeMock,
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: buildLandscapeSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-snapshot-cache.service.js", () => ({
  getLandscapeSnapshotCacheStatus: getLandscapeSnapshotCacheStatusMock,
}));

vi.mock("../src/modules/landscape/landscape-trajectory.service.js", () => ({
  buildLandscapeTrajectory: buildLandscapeTrajectoryMock,
}));

vi.mock("../src/modules/landscape/landscape-review-items.service.js", () => ({
  listLandscapeReviewItems: listLandscapeReviewItemsMock,
  listLandscapeContradictionOverlay: listLandscapeContradictionOverlayMock,
  materializeLandscapeReviewItems: materializeLandscapeReviewItemsMock,
  updateLandscapeReviewItemStatus: updateLandscapeReviewItemStatusMock,
  LandscapeReviewItemsError: LandscapeReviewItemsErrorMock,
}));

vi.mock("../src/modules/landscape/landscape-review-candidate.service.js", () => ({
  createLandscapeReviewCandidates: createLandscapeReviewCandidatesMock,
  updateLandscapeReviewCandidateLink: updateLandscapeReviewCandidateLinkMock,
  LandscapeReviewCandidateLinkError: LandscapeReviewCandidateLinkErrorMock,
}));

vi.mock("../src/modules/landscape/landscape-curation.service.js", () => ({
  LandscapeCurationError: LandscapeCurationErrorMock,
  enqueueLandscapeCurationForReview: enqueueLandscapeCurationForReviewMock,
  getLandscapeCurationJob: getLandscapeCurationJobMock,
  listLandscapeCurationJobs: listLandscapeCurationJobsMock,
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: vi.fn(),
  fetchGraphNodeDetail: vi.fn(),
  listGraphCommunityLabels: vi.fn(),
  upsertGraphCommunityLabel: vi.fn(),
}));

import { graphRouter } from "../api/modules/graph/graph.routes.js";

function buildApp() {
  const app = new Hono();
  app.route("/api/graph", graphRouter);
  return app;
}

function validDeadZoneReview(): DeadZoneKnowledgeReviewResponse {
  return {
    generatedAt: "2026-05-24T00:00:00.000Z",
    windowDays: 30,
    minSimilarity: 0.9,
    similarTopK: 5,
    communityCount: 1,
    itemCount: 1,
    unavailableReason: null,
    items: [
      {
        knowledge: {
          id: "knowledge-dead-1",
          title: "DeadZone procedure",
          bodyPreview: "Use when...",
          type: "procedure",
          status: "active",
          appliesTo: { domains: ["landscape"] },
          confidence: 80,
          importance: 75,
          compileSelectCount: 0,
          lastCompiledAt: null,
          sourceRefCount: 0,
          sourceRefDensity: 0,
          communityKey: "a".repeat(64),
          communityLabel: "DeadZone community",
        },
        classification: {
          primary: "dead_zone_stale",
          confidence: "medium",
          reason: "unused and thin evidence",
        },
        indicators: {
          deadZoneScore: 82,
          evidenceStrength: "thin",
          usageStrength: "none",
          structureQuality: "partial",
          graphHealth: "thin",
          badges: ["Evidence thin", "Stale"],
        },
        bestCanonicalCandidate: {
          id: "knowledge-active-1",
          title: "Active canonical knowledge",
          status: "active",
          similarity: 0.94,
          applicabilityMatch: "high",
          evidenceStrength: "strong",
          usageStrength: "moderate",
          suggestedAction: "merge_into_similar",
          reasons: ["applicability aligns", "similarity 94%"],
        },
        alternativeCandidates: [],
        recommendation: {
          action: "merge_deadzone_into_canonical",
          confidence: "high",
          reasons: ["applicability aligns", "similarity 94%"],
          blockers: [],
        },
        allowedActions: [
          "keep_separate",
          "needs_evidence",
          "merge_deadzone_into_canonical",
          "deprecate_deadzone",
        ],
        similarKnowledge: [
          {
            id: "knowledge-active-1",
            title: "Active canonical knowledge",
            status: "active",
            similarity: 0.94,
            applicabilityMatch: "high",
            evidenceStrength: "strong",
            usageStrength: "moderate",
            suggestedAction: "merge_into_similar",
            reasons: ["applicability aligns", "similarity 94%"],
          },
        ],
        reviewItemId: null,
      },
    ],
  };
}

describe("graph routes landscape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue(validLandscapeSnapshot());
    getLandscapeSnapshotCacheStatusMock.mockResolvedValue(validLandscapeSnapshotCacheStatus());
    buildLandscapeReplaySnapshotMock.mockResolvedValue(validReplaySnapshot());
    buildLandscapeReplayComparisonMock.mockResolvedValue(validReplayComparison());
    buildDeadZoneKnowledgeReviewMock.mockResolvedValue(validDeadZoneReview());
    maintainDeadZoneKnowledgeMock.mockResolvedValue({
      action: "deprecate_deadzone",
      keptKnowledgeId: null,
      deprecatedKnowledgeId: "knowledge-dead-1",
    });
    applyDeadZoneKnowledgeReviewActionMock.mockResolvedValue({
      action: "deprecate_deadzone",
      status: "applied",
      message: 'Deprecated DeadZone "DeadZone procedure".',
      deprecatedKnowledgeId: "knowledge-dead-1",
    });
    buildLandscapeTrajectoryMock.mockResolvedValue(validTrajectory());
    listLandscapeCurationJobsMock.mockResolvedValue([]);
    materializeLandscapeReviewItemsMock.mockResolvedValue({
      dryRun: true,
      generatedAt: "2026-05-24T00:00:00.000Z",
      candidateCount: 1,
      insertedCount: 0,
      existingCount: 0,
      skippedCount: 0,
      items: [],
      candidates: [
        {
          source: "replay_compare",
          reason: "baseline_wrong",
          proposedAction: "review_wrong",
          priority: 95,
          confidence: "medium",
          idempotencyKey: "replay_compare:baseline_wrong:run-1:knowledge-1",
          knowledgeId: "knowledge-1",
          runId: "run-1",
          triggerEventId: null,
          communityKey: null,
          communityLabel: null,
          suggestedAppliesTo: {
            retrievalMode: "task_context",
          },
          evidence: ["wrong baseline"],
          payload: {
            generatedBy: "landscape_replay_compare",
          },
          note: null,
        },
      ],
    });
    createLandscapeReviewCandidatesMock.mockResolvedValue({
      dryRun: true,
      processedCount: 1,
      createdCount: 0,
      existingCount: 0,
      missingIds: [],
      items: [
        {
          reviewItemId: "review-item-1",
          reason: "baseline_wrong",
          proposedAction: "review_wrong",
          candidateType: "rule",
          candidateKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
          targetKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
          targetStateId: null,
          findCandidateResultId: null,
          linkId: null,
          linkStatus: null,
          draftLinked: false,
        },
      ],
    });
    updateLandscapeReviewCandidateLinkMock.mockResolvedValue({
      link: {
        id: "link-1",
        reviewItemId: "review-item-1",
        targetStateId: "target-1",
        findCandidateResultId: "candidate-1",
        candidateKey: "landscape-review-item:review-item-1:baseline_wrong:abc",
        status: "approved",
        approvalNote: "approved manually",
        approvedBy: "reviewer",
        approvedAt: "2026-05-24T00:20:00.000Z",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:20:00.000Z",
      },
    });
    listLandscapeReviewItemsMock.mockResolvedValue({
      count: 1,
      items: [
        {
          id: "review-item-1",
          source: "replay_compare",
          reason: "baseline_wrong",
          status: "pending",
          proposedAction: "review_wrong",
          priority: 95,
          confidence: "medium",
          knowledgeId: "knowledge-1",
          runId: "run-1",
          triggerEventId: null,
          communityKey: null,
          communityLabel: null,
          suggestedAppliesTo: {
            retrievalMode: "task_context",
          },
          evidence: ["wrong baseline"],
          payload: {
            generatedBy: "landscape_replay_compare",
          },
          note: null,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });
    listLandscapeContradictionOverlayMock.mockResolvedValue({
      count: 1,
      items: [
        {
          reviewItemId: "review-item-3",
          leftKnowledgeId: "knowledge-1",
          rightKnowledgeId: "knowledge-2",
          pairKey: "knowledge-1::knowledge-2",
          confidence: 0.74,
          confidenceLabel: "medium",
          status: "pending",
          evidence: ["pair=knowledge-1::knowledge-2"],
          communityKey: "a".repeat(64),
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    });
    updateLandscapeReviewItemStatusMock.mockResolvedValue({
      id: "review-item-1",
      source: "replay_compare",
      reason: "baseline_wrong",
      status: "resolved",
      proposedAction: "review_wrong",
      priority: 95,
      confidence: "medium",
      knowledgeId: "knowledge-1",
      runId: "run-1",
      triggerEventId: null,
      communityKey: null,
      communityLabel: null,
      suggestedAppliesTo: {
        retrievalMode: "task_context",
      },
      evidence: ["wrong baseline"],
      payload: {
        generatedBy: "landscape_replay_compare",
      },
      note: "manually reviewed",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:10:00.000Z",
      resolvedAt: "2026-05-24T00:10:00.000Z",
    });
  });

  test("GET /api/graph/landscape applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeSnapshotSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeSnapshotMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 1000,
      status: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
    });
  });

  test("GET /api/graph/landscape parses custom query", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape?windowDays=14&limit=120&status=all&relationAxes=project,source&minSelectedCount=5&minFeedbackCount=7&format=full",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeSnapshotMock).toHaveBeenCalledWith({
      windowDays: 14,
      limit: 120,
      status: "all",
      relationAxes: ["project", "source"],
      minSelectedCount: 5,
      minFeedbackCount: 7,
    });
  });

  test("GET /api/graph/landscape/replay applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeReplaySnapshotSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeReplaySnapshotMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 500,
      landscapeLimit: 1000,
      runStatus: "all",
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      includeRuns: true,
    });
  });

  test("GET /api/graph/landscape/replay parses run and landscape filters separately", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/replay?windowDays=7&limit=20&landscapeLimit=200&runStatus=degraded&landscapeStatus=current&relationAxes=session&minSelectedCount=2&minFeedbackCount=4&minSimilarity=0.8&semanticTopK=5&includeRuns=false",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeReplaySnapshotMock).toHaveBeenCalledWith({
      windowDays: 7,
      limit: 20,
      landscapeLimit: 200,
      runStatus: "degraded",
      landscapeStatus: "current",
      relationAxes: ["session"],
      minSelectedCount: 2,
      minFeedbackCount: 4,
      minSimilarity: 0.8,
      semanticTopK: 5,
      includeRuns: false,
    });
  });

  test("GET /api/graph/landscape/replay/compare applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/compare");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeReplayComparisonResponseSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeReplayComparisonMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      includeRuns: true,
    });
  });

  test("GET /api/graph/landscape/cache-status returns cache status", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/cache-status");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeSnapshotCacheStatusSchema.safeParse(json).success).toBe(true);
    expect(getLandscapeSnapshotCacheStatusMock).toHaveBeenCalledTimes(1);
  });

  test("GET /api/graph/landscape/dead-zone-knowledge applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/dead-zone-knowledge");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(deadZoneKnowledgeReviewResponseSchema.safeParse(json).success).toBe(true);
    expect(buildDeadZoneKnowledgeReviewMock).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 50,
      page: 1,
      status: "active",
      reason: "all",
      minSimilarity: 0.9,
      similarTopK: 5,
      relationAxes: ["session", "project", "source"],
      badge: "all",
      sortBy: "deadZoneScore",
      sortDir: "desc",
    });
  });

  test("POST /api/graph/landscape/dead-zone-knowledge/maintenance runs maintenance action", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/dead-zone-knowledge/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "deprecate_deadzone",
        deadZoneKnowledgeId: "knowledge-dead-1",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "deprecate_deadzone",
      keptKnowledgeId: null,
      deprecatedKnowledgeId: "knowledge-dead-1",
    });
    expect(maintainDeadZoneKnowledgeMock).toHaveBeenCalledWith({
      action: "deprecate_deadzone",
      deadZoneKnowledgeId: "knowledge-dead-1",
    });
  });

  test("POST /api/graph/landscape/dead-zone-knowledge/actions runs review action", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/dead-zone-knowledge/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "deprecate_deadzone",
        deadZoneKnowledgeId: "knowledge-dead-1",
      }),
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(deadZoneKnowledgeReviewActionResultSchema.safeParse(json).success).toBe(true);
    expect(json).toEqual({
      action: "deprecate_deadzone",
      status: "applied",
      message: 'Deprecated DeadZone "DeadZone procedure".',
      deprecatedKnowledgeId: "knowledge-dead-1",
    });
    expect(applyDeadZoneKnowledgeReviewActionMock).toHaveBeenCalledWith({
      action: "deprecate_deadzone",
      deadZoneKnowledgeId: "knowledge-dead-1",
    });
  });

  test("GET /api/graph/landscape/replay/compare parses comparison filters", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/replay/compare?windowDays=14&limit=25&runStatus=failed&currentLimit=8&includeRuns=false",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeReplayComparisonMock).toHaveBeenCalledWith({
      windowDays: 14,
      limit: 25,
      runStatus: "failed",
      currentLimit: 8,
      includeRuns: false,
    });
  });

  test("GET /api/graph/landscape/curation-jobs delegates unresolved filtering to persistence", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/curation-jobs?status=unresolved&findingType=all&limit=100",
    );

    expect(response.status).toBe(200);
    expect(listLandscapeCurationJobsMock).toHaveBeenCalledWith({
      status: "unresolved",
      findingType: "all",
      limit: 100,
    });
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  test("does not expose a human-decision endpoint for Curation jobs", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/curation-jobs/curation-1/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });

    expect(response.status).toBe(404);
  });

  test("POST /api/graph/landscape/curation-jobs maps missing review items to 404", async () => {
    enqueueLandscapeCurationForReviewMock.mockRejectedValueOnce(
      new LandscapeCurationErrorMock("review item not found", 404),
    );
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/curation-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewItemId: "missing-review" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "review item not found" });
  });

  test("GET /api/graph/landscape/trajectory/:runId applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/trajectory/run-1");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(landscapeTrajectoryResultSchema.safeParse(json).success).toBe(true);
    expect(buildLandscapeTrajectoryMock).toHaveBeenCalledWith({
      runId: "run-1",
      includeCandidates: true,
      limit: 200,
    });
  });

  test("GET /api/graph/landscape/trajectory/:runId parses query", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/trajectory/run-1?includeCandidates=false&limit=25",
    );
    expect(response.status).toBe(200);
    expect(buildLandscapeTrajectoryMock).toHaveBeenCalledWith({
      runId: "run-1",
      includeCandidates: false,
      limit: 25,
    });
  });

  test("POST /api/graph/landscape/replay/queue applies defaults", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    expect(materializeLandscapeReviewItemsMock).toHaveBeenCalledWith({
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "active",
      relationAxes: ["session", "project", "source"],
      minSelectedCount: 3,
      minFeedbackCount: 3,
      minSimilarity: 0.72,
      semanticTopK: 3,
      sources: ["replay_compare"],
      materializeLimit: 50,
    });
  });

  test("POST /api/graph/landscape/replay/queue returns status from review-items error", async () => {
    const app = buildApp();
    materializeLandscapeReviewItemsMock.mockRejectedValueOnce(
      new LandscapeReviewItemsErrorMock(400, "unsupported sources in AQ-1A"),
    );

    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dryRun: true,
        sources: ["landscape_snapshot"],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported sources in AQ-1A",
    });
  });

  test("POST /api/graph/landscape/replay/queue accepts contradiction source", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/replay/queue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        dryRun: true,
        sources: ["contradiction_detection"],
      }),
    });
    expect(response.status).toBe(200);
    expect(materializeLandscapeReviewItemsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        sources: ["contradiction_detection"],
      }),
    );
  });

  test("POST /api/graph/landscape/review-items/candidates parses body and returns result", async () => {
    const app = buildApp();
    const response = await app.request("/api/graph/landscape/review-items/candidates", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "pending",
        limit: 10,
        dryRun: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(createLandscapeReviewCandidatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        limit: 10,
        dryRun: true,
      }),
    );
    const json = await response.json();
    expect(json.result.processedCount).toBe(1);
    expect(json.result.items).toHaveLength(1);
  });

  test("PATCH /api/graph/landscape/review-items/:id/candidate-links/:linkId updates approval status", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/graph/landscape/review-items/review-item-1/candidate-links/link-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "approved",
          note: "approved manually",
          actor: "reviewer",
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(updateLandscapeReviewCandidateLinkMock).toHaveBeenCalledWith("review-item-1", "link-1", {
      status: "approved",
      note: "approved manually",
      actor: "reviewer",
    });
    const json = await response.json();
    expect(json.link.status).toBe("approved");
    expect(json.link.id).toBe("link-1");
  });

  test("PATCH /api/graph/landscape/review-items/:id/candidate-links/:linkId returns 409 on invalid transition", async () => {
    const app = buildApp();
    updateLandscapeReviewCandidateLinkMock.mockRejectedValueOnce(
      new LandscapeReviewCandidateLinkErrorMock(
        409,
        "invalid link status transition: finalized -> approved",
      ),
    );
    const response = await app.request(
      "/api/graph/landscape/review-items/review-item-1/candidate-links/link-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "approved",
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "invalid link status transition: finalized -> approved",
    });
  });
});
