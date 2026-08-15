import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { listStaticResources, readStaticResource } from "../src/mcp/server.js";
import { compileEvalTool } from "../src/mcp/tools/compile-eval.tool.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
import {
  contextDecisionFeedbackTool,
  contextDecisionTool,
} from "../src/mcp/tools/context-decision.tool.js";
import { getCallableToolEntries, getExposedToolEntries } from "../src/mcp/tools/index.js";
import { searchKnowledgeTool } from "../src/mcp/tools/knowledge.tool.js";
import { initialInstructionsTool } from "../src/mcp/tools/system.tool.js";
import {
  getCompileRunDetail,
  insertCompileRun,
  insertContextPackItems,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("mcp contract", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    process.env.CONTEXT_STILL_MCP_V2 = "1";
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("context_compile tool input schema contract", () => {
    expect(contextCompileTool.inputSchema).toMatchObject({
      type: "object",
      required: ["goal"],
    });
    const properties = (contextCompileTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeTruthy();
    expect(properties?.goal).toEqual({ type: "string" });
    expect(properties?.changeTypes).toEqual({ type: "array", items: { type: "string" } });
    expect(properties?.technologies).toEqual({ type: "array", items: { type: "string" } });
    expect(properties?.domains).toEqual({ type: "array", items: { type: "string" } });
    expect(properties?.projectRef).toMatchObject({ type: "string", minLength: 1, maxLength: 256 });
    expect(properties?.repoKey).toMatchObject({ type: "string", minLength: 1, maxLength: 1024 });
    expect(properties?.repoPath).toMatchObject({ type: "string", minLength: 1, maxLength: 4096 });
    expect(properties).not.toHaveProperty("intent");
    expect(properties).not.toHaveProperty("files");
    expect(properties).not.toHaveProperty("tokenBudget");
    expect(properties).not.toHaveProperty("includeDraft");
    expect(properties).not.toHaveProperty("queryEmbedding");
  });

  test("context_decision tool input schema contract", () => {
    expect(contextDecisionTool.inputSchema).toMatchObject({
      type: "object",
      required: ["decisionPoint"],
    });
    expect(contextDecisionTool.description).toContain("pre-question gate");
    expect(contextDecisionTool.description).toContain("Treat reject as a stop condition");
    const properties = (contextDecisionTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties?.retrievalHints).toMatchObject({
      type: "object",
      properties: {
        technologies: { type: "array", items: { type: "string" } },
        changeTypes: { type: "array", items: { type: "string" } },
        domains: { type: "array", items: { type: "string" } },
      },
    });
    expect(properties).not.toHaveProperty("premise");
    expect(properties).not.toHaveProperty("proposedAction");
    expect(properties).not.toHaveProperty("options");
    expect(properties).not.toHaveProperty("knowledgePolicy");
    expect(properties).not.toHaveProperty("autonomyLevel");
    expect(properties).not.toHaveProperty("riskBudget");
    expect(properties).not.toHaveProperty("availableRollback");
    expect(properties).not.toHaveProperty("verificationPlan");
  });

  test("context_decision_feedback tool input schema contract", () => {
    expect(contextDecisionFeedbackTool.inputSchema).toMatchObject({
      type: "object",
      required: ["decisionId", "source"],
    });
    const properties = (
      contextDecisionFeedbackTool.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    expect(properties?.value).toEqual({ type: "string", enum: ["good", "bad"] });
    expect(properties?.source).toEqual({ type: "string", enum: ["human", "ai", "system"] });
  });

  test("compile_eval tool input schema contract", () => {
    expect(compileEvalTool.inputSchema).toMatchObject({
      type: "object",
      required: [
        "outcome",
        "body",
        "relevance",
        "actionability",
        "coverage",
        "clarity",
        "specificity",
      ],
    });
    const properties = (compileEvalTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties?.relevance).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "目的に合っていたか (0-100)",
    });
    expect(properties?.clarity).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Context clarity (100 = clean, 0 = noisy).",
    });
    expect(properties?.outcome).toEqual({
      type: "string",
      enum: ["useful", "partial", "misleading", "unused"],
    });
  });

  test("public tools list contract", () => {
    const toolNames = getExposedToolEntries().map((tool) => tool.name);
    expect(toolNames).toEqual([
      "initial_instructions",
      "context_compile",
      "compile_eval",
      "context_decision",
      "context_decision_feedback",
      "search_knowledge",
      "register_candidates",
      "search_memory",
      "fetch_memory",
      "search_episodes",
      "fetch_episode",
      "doctor",
    ]);
  });

  test("legacy memory aliases are callable but not exposed", () => {
    const exposed = getExposedToolEntries().map((tool) => tool.name);
    const callable = getCallableToolEntries().map((tool) => tool.name);
    expect(exposed).not.toContain("memory_search");
    expect(exposed).not.toContain("memory_fetch");
    expect(callable).toContain("memory_search");
    expect(callable).toContain("memory_fetch");
  });

  test("initial_instructions contains usage-first MCP flow", async () => {
    const response = await initialInstructionsTool.handler();
    const text = response.content[0]?.text ?? "";
    expect(text).toContain("## 常用ルール");
    expect(text).toContain("## 主要MCPツール");
    expect(text).toContain("initial_instructions");
    expect(text).toContain("context_compile");
    expect(text).toContain("context_decision");
    expect(text).toContain("context_decision_feedback");
    expect(text).not.toContain("`register_candidate`");
    expect(text).not.toContain("`register_candidates`");
    expect(text).not.toContain("`session_memo`");
    expect(text).toContain("compile_eval");
    expect(text).toContain("各 runId ごと");
    expect(text).toContain("その他の公開ツールは補助機能");
    expect(text).not.toContain("SKILL.md 相当");
    expect(text).not.toContain("title / body / avoid / prefer の自然文は日本語");
    expect(text).not.toContain("プロジェクト依存の記述を除いて");
    expect(text).toContain("design.md");
  });

  test("search_knowledge tool input schema contract", () => {
    expect(searchKnowledgeTool.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
    });
    const properties = (searchKnowledgeTool.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeTruthy();
    expect(properties?.statuses).toEqual({
      type: "array",
      items: { type: "string", enum: ["draft", "active", "deprecated"] },
    });
  });

  test("resources/list contract", () => {
    const resources = listStaticResources().map((item) => ({
      name: item.name,
      uri: item.uri,
      mimeType: item.mimeType,
    }));
    expect(resources).toEqual([
      {
        name: "context-compiler-summary",
        uri: "context-still://summary/context-compiler",
        mimeType: "text/plain",
      },
      {
        name: "context-pack-runs-list",
        uri: "context-still://packs/list",
        mimeType: "application/json",
      },
      {
        name: "context-pack-latest",
        uri: "context-still://packs/latest",
        mimeType: "application/json",
      },
      {
        name: "doctor-health",
        uri: "context-still://health/doctor",
        mimeType: "application/json",
      },
    ]);
  });

  test("resources/read returns stable content shapes", async () => {
    const runId = await insertCompileRun({
      goal: "mcp contract run",
      intent: "review",
      input: { goal: "mcp contract run" },
      retrievalMode: "review_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 2048,
      durationMs: 42,
    });
    await insertContextPackItems(runId, [
      {
        itemKind: "rule",
        itemId: "rule-1",
        section: "rules",
        score: 0.7,
        rankingReason: "contract",
        sourceRefs: ["file:///docs/rule.md#line:1-2"],
      },
    ]);

    const summary = (await readStaticResource("context-still://summary/context-compiler")) as {
      contents: Array<{ text: string }>;
    };
    expect(summary.contents[0]?.text).toContain("retrieval modes");

    const latest = (await readStaticResource("context-still://packs/latest")) as {
      contents: Array<{ text: string }>;
    };
    const latestJson = JSON.parse(latest.contents[0]?.text ?? "{}") as Record<string, unknown>;
    expect((latestJson.run as { id?: string }).id).toBe(runId);
    expect(Array.isArray(latestJson.items)).toBe(true);

    const doctor = (await readStaticResource("context-still://health/doctor")) as {
      contents: Array<{ text: string }>;
    };
    const doctorJson = JSON.parse(doctor.contents[0]?.text ?? "{}") as Record<string, unknown>;
    expect(
      doctorJson.status === "ok" ||
        doctorJson.status === "degraded" ||
        doctorJson.status === "failed",
    ).toBe(true);
    expect(Array.isArray(doctorJson.reasons)).toBe(true);
    const mcp = doctorJson.mcp as Record<string, unknown>;
    expect(Array.isArray(mcp?.exposedTools)).toBe(true);
    expect(Array.isArray(mcp?.requiredPrimaryTools)).toBe(true);
    expect(Array.isArray(mcp?.missingPrimaryTools)).toBe(true);
  });

  test("context_compile returns markdown only", async () => {
    const response = await contextCompileTool.handler({
      goal: "fresh repo no knowledge",
      changeTypes: ["debug"],
    });
    expect(response.content.length).toBe(1);
    expect(response.content[0]?.type).toBe("text");
    expect(response.content[0]?.text.length).toBeGreaterThan(0);
  });

  test("compile_eval saves score and appears in run detail", async () => {
    const runId = await insertCompileRun({
      goal: "compile eval contract",
      intent: "edit",
      sessionId: "contract-session",
      input: { goal: "compile eval contract" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 2048,
      durationMs: 21,
    });
    const response = await compileEvalTool.handler(
      {
        runId,
        relevance: 90,
        actionability: 80,
        coverage: 70,
        clarity: 100,
        specificity: 80,
        outcome: "useful",
        body: "worked well",
        title: "good fit",
      },
      { toolName: "compile_eval", requestMeta: { sessionId: "contract-session" } },
    );
    const json = JSON.parse(response.content[0]?.text ?? "{}") as {
      evaluation: { runId: string; avg: number; outcome: string };
    };
    expect(json.evaluation.runId).toBe(runId);
    expect(json.evaluation.avg).toBe(84);
    expect(json.evaluation.outcome).toBe("useful");

    const detail = await getCompileRunDetail(runId);
    expect(detail?.evaluations.length).toBe(1);
    expect(detail?.evaluations[0]?.avg).toBe(84);
    expect(detail?.run.evalSummary.count).toBe(1);
    expect(detail?.run.evalSummary.latestAvg).toBe(84);
  });
});
