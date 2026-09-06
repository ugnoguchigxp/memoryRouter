import { beforeEach, describe, expect, test, vi } from "vitest";
import { contextCompilerRouter } from "../api/modules/context-compiler/context-compiler.routes.js";

const repository = vi.hoisted(() => ({
  compilePack: vi.fn(),
  listRuns: vi.fn(),
  getRunDetail: vi.fn(),
  getRunRankingTrace: vi.fn(),
  saveRunKnowledgeFeedback: vi.fn(),
  saveRunEpisodeFeedbackForRepository: vi.fn(),
  deprecateRunEpisodeForRepository: vi.fn(),
}));

vi.mock("../api/modules/context-compiler/context-compiler.repository.js", () => repository);

const runId = "550e8400-e29b-41d4-a716-446655440000";

describe("context compiler HTTP validation", () => {
  beforeEach(() => vi.clearAllMocks());

  test.each([
    { method: "GET", path: "/runs?limit=0" },
    { method: "GET", path: "/runs/not-a-uuid" },
    { method: "GET", path: "/runs/not-a-uuid/ranking-trace" },
    { method: "POST", path: "/compile", body: { goal: " " } },
    { method: "POST", path: `/runs/${runId}/knowledge-feedback`, body: { items: [] } },
    { method: "POST", path: `/runs/${runId}/episode-feedback`, body: { items: [] } },
    { method: "POST", path: `/runs/${runId}/episodes/%20/deprecate` },
  ])("rejects invalid $method $path before repository access", async ({ method, path, body }) => {
    const response = await contextCompilerRouter.request(path, {
      method,
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });

    expect(response.status).toBe(400);
    for (const operation of Object.values(repository)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  test("passes default and coerced limits through the service", async () => {
    repository.listRuns.mockResolvedValue([]);
    expect((await contextCompilerRouter.request("/runs")).status).toBe(200);
    expect(repository.listRuns).toHaveBeenLastCalledWith(20);
    expect((await contextCompilerRouter.request("/runs?limit=7")).status).toBe(200);
    expect(repository.listRuns).toHaveBeenLastCalledWith(7);
  });

  test("passes normalized compile input through the service", async () => {
    repository.compilePack.mockResolvedValue({ pack: null, markdown: "No Content" });
    const response = await contextCompilerRouter.request("/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "  inspect this change  " }),
    });

    expect(response.status).toBe(200);
    expect(repository.compilePack).toHaveBeenCalledWith({ goal: "inspect this change" });
  });
});
