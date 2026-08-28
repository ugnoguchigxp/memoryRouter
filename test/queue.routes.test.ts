import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as repo from "../api/modules/queue/queue.repository.js";
import { queueRouter } from "../api/modules/queue/queue.routes.js";

vi.mock("../api/modules/queue/queue.repository.js", () => ({
  fetchQueueDashboardStats: vi.fn(),
  listQueueItems: vi.fn(),
  fetchActiveTasks: vi.fn(),
  pauseQueueLane: vi.fn(),
  pauseTarget: vi.fn(),
  resumeQueueLane: vi.fn(),
  resumeTarget: vi.fn(),
  retryTarget: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/queue", queueRouter);
  return app;
};

describe("queue routes v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("GET /api/queue/stats returns queue stats", async () => {
    vi.mocked(repo.fetchQueueDashboardStats).mockResolvedValueOnce({
      queueControls: {
        findingCandidate: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        episodeDistiller: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        coveringEvidence: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        deadZoneMergeReview: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        landscapeCuration: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        finalizeDistille: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      },
      queues: {
        findingCandidate: {
          counters: { pending: 1, running: 1, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 1,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        episodeDistiller: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        coveringEvidence: {
          counters: { pending: 2, running: 0, completed: 0, skipped: 0, failed: 1, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 1,
          offline: 1,
          nonRegistered: 1,
        },
        deadZoneMergeReview: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        landscapeCuration: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        finalizeDistille: {
          counters: { pending: 0, running: 0, completed: 3, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
      },
      totals: {
        counters: { pending: 3, running: 1, completed: 3, skipped: 0, failed: 1, paused: 0 },
        oldestPendingAt: null,
        running: 1,
        failed: 1,
        offline: 1,
        nonRegistered: 1,
      },
    });

    const app = buildApp();
    const response = await app.request("/api/queue/stats");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.totals.counters.pending).toBe(3);
    expect(json.queues.coveringEvidence.nonRegistered).toBe(1);
    expect(repo.fetchQueueDashboardStats).toHaveBeenCalled();
  });

  test("GET /api/queue validates filters and proxies to repository", async () => {
    vi.mocked(repo.listQueueItems).mockResolvedValueOnce({
      queue: "findingCandidate",
      items: [],
      total: 0,
      page: 2,
      limit: 15,
    });

    const app = buildApp();
    const response = await app.request(
      "/api/queue?page=2&limit=15&queue=findingCandidate&status=pending",
    );
    expect(response.status).toBe(200);
    expect(repo.listQueueItems).toHaveBeenCalledWith({
      page: 2,
      limit: 15,
      queue: "findingCandidate",
      status: "pending",
      query: undefined,
    });
  });

  test("GET /api/queue rejects unknown queue name", async () => {
    const app = buildApp();
    const response = await app.request("/api/queue?queue=invalidQueue");
    expect(response.status).toBe(400);
  });

  test("POST /api/queue/:queue/:id/pause routes action", async () => {
    vi.mocked(repo.pauseTarget).mockResolvedValueOnce({ id: "job-1", status: "paused" });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/job-1/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual pause" }),
    });
    expect(response.status).toBe(200);
    expect(repo.pauseTarget).toHaveBeenCalledWith("findingCandidate", "job-1", "manual pause");
  });

  test("POST /api/queue/:queue/pause toggles lane pause", async () => {
    vi.mocked(repo.pauseQueueLane).mockResolvedValueOnce({
      queueName: "findingCandidate",
      state: {
        paused: true,
        updatedAt: "2026-05-26T10:00:00.000Z",
        updatedBy: "queue-dashboard",
        reason: "manual lane pause",
      },
      pausedRunningCount: 1,
    });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual lane pause" }),
    });

    expect(response.status).toBe(200);
    expect(repo.pauseQueueLane).toHaveBeenCalledWith("findingCandidate", "manual lane pause");
  });

  test("POST /api/queue/:queue/resume toggles lane resume", async () => {
    vi.mocked(repo.resumeQueueLane).mockResolvedValueOnce({
      queueName: "findingCandidate",
      state: {
        paused: false,
        updatedAt: "2026-05-26T10:10:00.000Z",
        updatedBy: "queue-dashboard",
        reason: "manual lane resume",
      },
      reason: "manual lane resume",
    });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual lane resume" }),
    });

    expect(response.status).toBe(200);
    expect(repo.resumeQueueLane).toHaveBeenCalledWith("findingCandidate", "manual lane resume");
  });

  test("POST /api/queue/:queue/:id/resume routes action", async () => {
    vi.mocked(repo.resumeTarget).mockResolvedValueOnce({ id: "job-1", status: "pending" });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/job-1/resume", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(repo.resumeTarget).toHaveBeenCalledWith("findingCandidate", "job-1");
  });

  test("POST /api/queue/:queue/:id/retry routes action", async () => {
    vi.mocked(repo.retryTarget).mockResolvedValueOnce({ id: "job-1", status: "pending" });

    const app = buildApp();
    const response = await app.request("/api/queue/coveringEvidence/job-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cloud_api", forceRefreshEvidence: true }),
    });
    expect(response.status).toBe(200);
    expect(repo.retryTarget).toHaveBeenCalledWith({
      queueName: "coveringEvidence",
      id: "job-1",
      mode: "cloud_api",
      forceRefreshEvidence: true,
      reason: undefined,
    });
  });

  test("GET /api/queue returns 503 when queue schema is not migrated", async () => {
    const error = new Error('relation "covering_evidence_queue" does not exist') as Error & {
      code?: string;
    };
    error.code = "42P01";
    vi.mocked(repo.listQueueItems).mockRejectedValueOnce(error);

    const app = buildApp();
    const response = await app.request("/api/queue?queue=coveringEvidence&status=running");
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.code).toBe("QUEUE_SCHEMA_NOT_READY");
  });

  test("GET /api/queue/active does not hide non-migration 42P01 query bugs as schema-not-ready", async () => {
    const error = new Error('missing FROM-clause entry for table "e"') as Error & {
      code?: string;
    };
    error.code = "42P01";
    vi.mocked(repo.fetchActiveTasks).mockRejectedValueOnce(error);

    const app = buildApp();
    app.onError((caughtError, c) =>
      c.json({ code: "INTERNAL_ERROR", error: caughtError.message }, 500),
    );

    const response = await app.request("/api/queue/active");
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.code).toBe("INTERNAL_ERROR");
  });
});
