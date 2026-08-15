import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../api/app.js";
import { db } from "../src/db/client.js";
import { vibeMemories } from "../src/db/schema.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import {
  getRuntimeSettingsSnapshot,
  saveRuntimeSettings,
} from "../src/modules/settings/settings.service.js";
import { compileRunDetailSchema } from "../src/shared/schemas/compile-run.schema.js";
import { contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("api route integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
    const settings = getRuntimeSettingsSnapshot();
    settings.taskRouting.agenticCompile.enabled = false;
    await saveRuntimeSettings({
      settings,
      updatedBy: "integration-test",
    });
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("POST /api/context/compile returns context-pack and markdown", async () => {
    const response = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "integration compile token",
        intent: "edit",
        repoPath: "/workspace/repo-a",
      }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { pack: unknown; markdown: unknown };
    const parsed = contextPackSchema.parse(json.pack);
    expect(parsed.goal).toBe("integration compile token");
    expect(parsed.retrievalMode).toBe("task_context");
    expect(typeof json.markdown).toBe("string");
  });

  test("POST /api/context/runs/:id/knowledge-feedback persists verdict", async () => {
    const ruleId = await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/feedback-rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      repoPath: "/workspace/repo-a",
      title: "Feedback rule",
      body: "feedback compile token",
    });

    const compileResponse = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "feedback compile token",
        repoPath: "/workspace/repo-a",
      }),
    });
    expect(compileResponse.status).toBe(200);
    const compileJson = (await compileResponse.json()) as { pack: { runId: string } };
    const runId = compileJson.pack.runId;

    const feedbackResponse = await app.request(`/api/context/runs/${runId}/knowledge-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ knowledgeId: ruleId, verdict: "used" }],
      }),
    });
    expect(feedbackResponse.status).toBe(200);

    const detailResponse = await app.request(`/api/context/runs/${runId}`);
    expect(detailResponse.status).toBe(200);
    const detailJson = (await detailResponse.json()) as { detail: unknown };
    const parsedDetail = compileRunDetailSchema.parse(detailJson.detail);
    expect(parsedDetail.knowledgeFeedback.some((item) => item.knowledgeId === ruleId)).toBe(true);
  }, 15000);

  test("GET /api/knowledge returns persisted items", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/knowledge.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Integration Knowledge Rule",
      body: "integration api knowledge token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });

    const response = await app.request("/api/knowledge?limit=20&query=Integration%20Knowledge");
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      items: Array<{ title: string }>;
      total: number;
      totalPages: number;
    };
    expect(json.items.some((item) => item.title === "Integration Knowledge Rule")).toBe(true);
    expect(json.total).toBe(1);
    expect(json.totalPages).toBe(1);
  });

  test("GET /api/knowledge query matches applicability facets", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/applicability.md",
      type: "rule",
      status: "active",
      scope: "repo",
      repoPath: "/workspace/repo-a",
      title: "Applicability Facet Rule",
      body: "body without the searched facet token",
      appliesTo: {
        technologies: ["typescript"],
        changeTypes: ["schema"],
        domains: ["knowledge-ui"],
      },
    });

    for (const query of ["typescript", "schema", "knowledge-ui"]) {
      const response = await app.request(`/api/knowledge?limit=20&query=${query}`);
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        items: Array<{ title: string }>;
        total: number;
      };
      expect(json.items.some((item) => item.title === "Applicability Facet Rule")).toBe(true);
      expect(json.total).toBe(1);
    }
  });

  test("POST /api/context-decisions persists decision detail and Good feedback", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/context-decision.md",
      type: "procedure",
      status: "active",
      scope: "global",
      title: "Context decision integration evidence",
      body: "context decision integration token should continue autonomously before asking user",
    });

    const createResponse = await app.request("/api/context-decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisionPoint: "continue autonomously before asking user",
        retrievalHints: {
          technologies: ["typescript"],
          changeTypes: ["implementation"],
        },
      }),
    });
    expect(createResponse.status).toBe(200);
    const createJson = (await createResponse.json()) as { decisionId: string; confidence: number };
    expect(createJson.decisionId).toBeTruthy();
    expect(createJson.confidence).toBeGreaterThan(0);

    const detailResponse = await app.request(`/api/context-decisions/${createJson.decisionId}`);
    expect(detailResponse.status).toBe(200);
    const detailJson = (await detailResponse.json()) as {
      detail: {
        run: {
          confidenceTrace: {
            knowledgeAssessment?: unknown;
            knowledgePrior?: unknown;
            outcomePredictor?: unknown;
            mlSignal?: unknown;
            llmJudgmentStatus?: string;
          };
        };
        evidence: unknown[];
        coverage: unknown[];
      };
    };
    expect(detailJson.detail.evidence.length).toBeGreaterThan(0);
    expect(detailJson.detail.coverage.length).toBeGreaterThan(0);
    expect(detailJson.detail.run.confidenceTrace.knowledgeAssessment).toBeTruthy();
    expect(detailJson.detail.run.confidenceTrace.knowledgePrior).toBeTruthy();
    expect(detailJson.detail.run.confidenceTrace.outcomePredictor).toBeTruthy();
    expect(detailJson.detail.run.confidenceTrace.mlSignal).toBeTruthy();
    expect(detailJson.detail.run.confidenceTrace.llmJudgmentStatus).toBeTruthy();

    const feedbackResponse = await app.request(
      `/api/context-decisions/${createJson.decisionId}/human-feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "good" }),
      },
    );
    expect(feedbackResponse.status).toBe(200);
    const feedbackJson = (await feedbackResponse.json()) as {
      detail: { run: { humanFeedback: string | null }; effects: unknown[] } | null;
    };
    expect(feedbackJson.detail?.run.humanFeedback).toBe("good");
    expect(feedbackJson.detail?.effects).toEqual([]);
  }, 15000);

  test("POST /api/vibe-memory persists memory and GET /api/vibe-memory lists it", async () => {
    const createResponse = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "repo",
        repoPath: "/workspace/repo-a",
        sessionId: "integration-session-newer",
        content: "integration vibe memory newer token",
        metadata: {
          timestamp: "2026-05-21T10:00:00.000Z",
          sourceId: "codex_logs",
        },
      }),
    });
    expect(createResponse.status).toBe(201);

    const createOlderResponse = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "repo",
        repoPath: "/workspace/repo-a",
        sessionId: "integration-session-older",
        content: "integration vibe memory older token",
        metadata: {
          timestamp: "2026-05-18T10:00:00.000Z",
          sourceId: "codex_logs",
        },
      }),
    });
    expect(createOlderResponse.status).toBe(201);

    await db.insert(vibeMemories).values({
      sessionId: "goal:integration-goal-list-hidden",
      content: "capsule should not appear in raw vibe sessions",
      memoryType: "capsule",
    });

    const listResponse = await app.request("/api/vibe-memory?limit=10");
    expect(listResponse.status).toBe(200);
    const json = (await listResponse.json()) as {
      memories: Array<{ sessionId: string; content: string; memoryType: string }>;
    };
    expect(json.memories[0]?.sessionId).toBe("integration-session-newer");
    expect(
      json.memories.some(
        (memory) =>
          memory.sessionId === "integration-session-newer" &&
          memory.content.includes("integration vibe memory newer token"),
      ),
    ).toBe(true);
    expect(
      json.memories.some(
        (memory) =>
          memory.sessionId === "integration-session-older" &&
          memory.content.includes("integration vibe memory older token"),
      ),
    ).toBe(true);
    expect(json.memories.some((memory) => memory.memoryType === "capsule")).toBe(false);
    expect(
      json.memories.some((memory) =>
        memory.content.includes("capsule should not appear in raw vibe sessions"),
      ),
    ).toBe(false);
  });
});
