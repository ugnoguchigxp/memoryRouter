import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        });
      }),
      limit: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock("../src/modules/vibe-memory/vibe-memory.service.js");
vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.service.js");
vi.mock("../src/modules/context-compiler/context-compile-eval.service.js");
vi.mock("../src/modules/doctor/doctor.service.js");
vi.mock("../src/modules/episodic-memory/episode-card.service.js");
vi.mock("../src/modules/registerCandidate/register-candidate.service.js");
vi.mock("../src/modules/settings/settings.service.js");
vi.mock("../api/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/context-decision/context-decision.service.js");
vi.mock("../src/modules/context-decision/context-decision.feedback.service.js");
vi.mock("../src/modules/readFile/domain.js");
vi.mock("../src/db/client.js", () => ({
  db: mockDb,
}));

import {
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import type { ToolHandlerContext } from "../src/mcp/registry.js";
import { compileEvalTool } from "../src/mcp/tools/compile-eval.tool.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
import {
  contextDecisionFeedbackTool,
  contextDecisionTool,
} from "../src/mcp/tools/context-decision.tool.js";
import { fetchEpisodeTool, searchEpisodesTool } from "../src/mcp/tools/episode.tool.js";
import {
  listKnowledgeTool,
  registerCandidateTool,
  registerCandidatesTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "../src/mcp/tools/knowledge.tool.js";
import {
  memoryFetchTool as fetchMemoryLegacyTool,
  fetchMemoryTool as fetchMemoryPrimaryTool,
  memorySearchTool as searchMemoryLegacyTool,
  searchMemoryTool as searchMemoryPrimaryTool,
} from "../src/mcp/tools/memory.tool.js";
import { readFileTool } from "../src/mcp/tools/read-file.tool.js";
import { doctorTool, initialInstructionsTool } from "../src/mcp/tools/system.tool.js";
import { recordCompileEval } from "../src/modules/context-compiler/context-compile-eval.service.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { recordContextDecisionFeedback } from "../src/modules/context-decision/context-decision.feedback.service.js";
import { decideContext } from "../src/modules/context-decision/context-decision.service.js";
import { runDoctor } from "../src/modules/doctor/doctor.service.js";
import {
  fetchEpisode,
  searchEpisodes,
} from "../src/modules/episodic-memory/episode-card.service.js";
import { searchKnowledgeCandidates } from "../src/modules/knowledge/knowledge.service.js";
import { readFileDomain } from "../src/modules/readFile/domain.js";
import { registerCandidate } from "../src/modules/registerCandidate/register-candidate.service.js";
import { registerCandidatesBulk } from "../src/modules/registerCandidate/register-candidate.service.js";
import { reloadRuntimeSettingsCache } from "../src/modules/settings/settings.service.js";
import { retrieveVibeMemoryContext } from "../src/modules/vibe-memory/vibe-memory.service.js";

describe("MCP Tools Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ROUTER_LANG = undefined;
    process.env.MEMORY_ROUTER_MCP_V2 = "1";
    vi.mocked(reloadRuntimeSettingsCache).mockResolvedValue();
    vi.mocked(mockDb.where).mockImplementation(() => {
      return Object.assign(Promise.resolve([]), {
        orderBy: vi.fn().mockResolvedValue([]),
        limit: vi.fn().mockResolvedValue([]),
      });
    });
  });

  describe("search_memory", () => {
    test("calls retrieveVibeMemoryContext and returns JSON", async () => {
      const mockResults = [{ id: "1", content: "first line\ndetail body", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryPrimaryTool.handler({ query: "test query", limit: 5 });
      const payload = JSON.parse(response.content[0].text);

      expect(retrieveVibeMemoryContext).toHaveBeenCalledWith({
        query: "test query",
        limit: 5,
        sessionId: undefined,
      });
      expect(payload.items[0].id).toBe("1");
      expect(payload.items[0].title).toBe("first line");
      expect(payload.items[0].content).toBeUndefined();
    });

    test("throws if query is missing", async () => {
      await expect(searchMemoryPrimaryTool.handler({})).rejects.toThrow();
    });

    test("returns contentPreview when includeContent=true", async () => {
      const mockResults = [{ id: "1", content: "hello world", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryPrimaryTool.handler({
        query: "test query",
        includeContent: true,
        previewChars: 5,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.items[0].contentPreview).toBe("hello");
      expect(payload.items[0].contentTruncated).toBe(true);
    });

    test("legacy alias memory_search points to the same handler", async () => {
      const mockResults = [{ id: "1", content: "test", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryLegacyTool.handler({ query: "test query" });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.items[0].id).toBe("1");
    });
  });

  describe("search_episodes", () => {
    test("does not expose draft search controls", async () => {
      const properties = searchEpisodesTool.inputSchema.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty("includeDraft");
      expect(properties.status).toMatchObject({
        enum: ["active", "deprecated"],
      });
      expect(properties.statuses).toMatchObject({
        items: { enum: ["active", "deprecated"] },
      });
      await expect(searchEpisodesTool.handler({ status: "draft" })).rejects.toThrow();
    });

    test("calls searchEpisodes and returns compact JSON", async () => {
      vi.mocked(searchEpisodes).mockResolvedValue([
        {
          id: "episode-1",
          title: "Episode title",
          situation: "Situation",
          observations: "",
          action: "",
          outcome: "Outcome",
          lesson: "Lesson",
          applicability: {},
          antiApplicability: {},
          domains: ["episodic-memory"],
          technologies: ["typescript"],
          changeTypes: ["schema"],
          tools: [],
          scope: "global",
          classificationStatus: "classified",
          repoPath: null,
          repoKey: null,
          sourceKind: "manual",
          sourceKey: "source-1",
          outcomeKind: "success",
          importance: 84,
          confidence: 88,
          compileUseCount: 0,
          decisionUseCount: 0,
          status: "active",
          staleAt: null,
          metadata: {},
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          updatedAt: new Date("2026-06-20T00:00:00.000Z"),
          score: 12,
          refs: [
            {
              id: "ref-1",
              episodeCardId: "episode-1",
              refKind: "file",
              refValue: "src/db/schema-core.ts",
              locator: null,
              queryHint: null,
              metadata: {},
              createdAt: new Date("2026-06-20T00:00:00.000Z"),
            },
          ],
        },
      ]);

      const response = await searchEpisodesTool.handler({
        query: "episode",
        technologies: ["typescript"],
      });
      const payload = JSON.parse(response.content[0].text);

      expect(searchEpisodes).toHaveBeenCalledWith({
        query: "episode",
        technologies: ["typescript"],
      });
      expect(payload.items[0].id).toBe("episode-1");
      expect(payload.items[0].refs[0].refKind).toBe("file");
      expect(payload.items[0]).not.toHaveProperty("evidenceStatus");
    });
  });

  describe("fetch_episode", () => {
    test("returns an episode by id", async () => {
      vi.mocked(fetchEpisode).mockResolvedValue({
        id: "episode-1",
        title: "Episode title",
        situation: "Situation",
        observations: "",
        action: "",
        outcome: "",
        lesson: "",
        applicability: {},
        antiApplicability: {},
        domains: [],
        technologies: [],
        changeTypes: [],
        tools: [],
        scope: "global",
        classificationStatus: "classified",
        repoPath: null,
        repoKey: null,
        sourceKind: "manual",
        sourceKey: "source-1",
        outcomeKind: "unknown",
        importance: 50,
        confidence: 50,
        compileUseCount: 0,
        decisionUseCount: 0,
        status: "active",
        staleAt: null,
        metadata: {},
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:00.000Z"),
        refs: [],
      });

      const response = await fetchEpisodeTool.handler({ id: "episode-1" });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.id).toBe("episode-1");
      expect(payload).not.toHaveProperty("evidenceStatus");
    });

    test("returns an error when missing", async () => {
      vi.mocked(fetchEpisode).mockResolvedValue(null);
      const response = await fetchEpisodeTool.handler({ id: "missing" });
      expect(response.isError).toBe(true);
    });
  });

  describe("fetch_memory", () => {
    test("fetches memory and its diffs", async () => {
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Promise.resolve([
          { id: "mem-1", content: "Memory content", sessionId: "session-1" },
        ]) as unknown as never;
      });
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Object.assign(Promise.resolve([{ id: "diff-1" }]), {
          orderBy: vi.fn().mockResolvedValue([{ id: "diff-1" }]),
        }) as unknown as never;
      });

      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        includeAgentDiffs: true,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
      expect(data.agentDiffs).toBeDefined();
    });

    test("supports query-based slicing and maxChars", async () => {
      const longContent = `${"abc ".repeat(100)}TARGET_KEYWORD${" def".repeat(100)}`;
      vi.mocked(mockDb.where).mockResolvedValueOnce([
        { id: "mem-1", content: longContent },
      ] as unknown as never);
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockResolvedValue([]),
        }) as unknown as never;
      });

      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        query: "TARGET_KEYWORD",
        maxChars: 100,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.content).toContain("TARGET_KEYWORD");
      expect(data.content.length).toBeLessThanOrEqual(100);
      expect(data.sliceStart).toBeTypeOf("number");
      expect(data.sliceEnd).toBeTypeOf("number");
    });

    test("returns error if memory not found", async () => {
      vi.mocked(mockDb.where).mockResolvedValueOnce([] as unknown as never);
      const response = await fetchMemoryPrimaryTool.handler({ id: "non-existent" });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toBe("Memory not found.");
    });

    test("supports returnMetaOnly", async () => {
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "mem-1",
              content: "Memory content",
              sessionId: "session-1",
              memoryType: "chat",
            },
          ]),
        }),
      } as unknown as never);
      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        returnMetaOnly: true,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
      expect(data.content).toBeUndefined();
      expect(data.contentLength).toBeGreaterThan(0);
    });

    test("legacy alias memory_fetch points to the same handler", async () => {
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "mem-1",
              content: "Memory content",
              sessionId: "session-1",
              memoryType: "chat",
            },
          ]),
        }),
      } as unknown as never);
      const response = await fetchMemoryLegacyTool.handler({ id: "mem-1" });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
    });
  });

  describe("search_knowledge", () => {
    test("calls searchKnowledgeCandidates and returns ranked results", async () => {
      vi.mocked(searchKnowledgeCandidates).mockResolvedValue({
        items: [
          {
            id: "k1",
            body: "body 1",
            sourceRefs: [],
            status: "active",
            confidence: 80,
            importance: 80,
          },
        ],
        stats: { queryText: "test" },
        degradedReasons: [],
      } as unknown as never);

      const response = await searchKnowledgeTool.handler({ query: "test" });
      const data = JSON.parse(response.content[0].text);
      expect(data.items[0].id).toBe("k1");
    });
  });

  describe("register_candidate", () => {
    test("tool descriptions require Japanese natural language in Japanese-operated contexts", () => {
      const properties = registerCandidateTool.inputSchema.properties as Record<
        string,
        { description?: string }
      >;

      expect(registerCandidateTool.description).toContain("natural language in Japanese");
      expect(properties.body?.description).toContain("section bodies in Japanese");
      expect(properties.avoid?.description).toContain("natural language in Japanese");
      expect(properties.prefer?.description).toContain("natural language in Japanese");
    });

    test("registers a lightweight candidate without synchronous knowledge persistence", async () => {
      vi.mocked(registerCandidate).mockResolvedValue({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        sourceUri: "agent://candidate/candidate-id",
        status: "candidate_registered",
        title: "New Rule",
        type: "rule",
        warnings: [],
        next: "distillation_pipeline",
      });

      const response = await registerCandidateTool.handler({
        title: "New Rule",
        body: "Detailed body of the rule",
        type: "rule",
        scope: "global",
      });

      expect(registerCandidate).toHaveBeenCalledWith(
        {
          title: "New Rule",
          body: "Detailed body of the rule",
          type: "rule",
          scope: "global",
          metadata: {},
        },
        { strictProcedureSections: true },
      );
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        status: "candidate_registered",
      });
    });

    test("accepts text-only candidate notes for normalization", async () => {
      vi.mocked(registerCandidate).mockResolvedValue({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        sourceUri: "agent://candidate/candidate-id",
        status: "candidate_registered",
        title: "Failure note",
        type: "procedure",
        warnings: ["text_parsed_to_candidate_json"],
        next: "distillation_pipeline",
      });

      await registerCandidateTool.handler({
        text: '{"type":"procedure","title":"Failure note","body":"Use when:\\n- ..."}',
        scope: "global",
      });

      expect(registerCandidate).toHaveBeenCalledWith(
        {
          text: '{"type":"procedure","title":"Failure note","body":"Use when:\\n- ..."}',
          scope: "global",
          metadata: {},
        },
        { strictProcedureSections: true },
      );
    });

    test("throws validation error for invalid procedure candidate body", async () => {
      vi.mocked(registerCandidate).mockRejectedValue(
        new Error("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS"),
      );

      await expect(
        registerCandidateTool.handler({
          title: "Bad Procedure",
          body: "just memo text",
          type: "procedure",
        }),
      ).rejects.toThrow("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS");
    });

    test("passes negative minimal input with applicability", async () => {
      vi.mocked(registerCandidate).mockResolvedValue({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        sourceUri: "agent://candidate/candidate-id",
        status: "candidate_registered",
        title: "Avoid stale queue assumptions",
        type: "rule",
        warnings: [],
        next: "distillation_pipeline",
      });

      await registerCandidateTool.handler({
        title: "Avoid stale queue assumptions",
        polarity: "negative",
        avoid: "Assume queue count proves worker progress.",
        prefer: "Check persisted queue state and worker events together.",
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
        scope: "global",
      });

      expect(registerCandidate).toHaveBeenCalledWith(
        {
          title: "Avoid stale queue assumptions",
          polarity: "negative",
          avoid: "Assume queue count proves worker progress.",
          prefer: "Check persisted queue state and worker events together.",
          technologies: ["sqlite"],
          changeTypes: ["diagnosis"],
          domains: ["queue"],
          scope: "global",
          metadata: {},
        },
        { strictProcedureSections: true },
      );
    });
  });

  describe("register_candidates", () => {
    test("bulk tool descriptions require Japanese candidate natural language", () => {
      const properties = registerCandidatesTool.inputSchema.properties as Record<
        string,
        { items?: unknown }
      >;
      const itemSchema = properties.items?.items as
        | { properties?: Record<string, { description?: string }> }
        | undefined;

      expect(registerCandidatesTool.description).toContain("natural language in Japanese");
      expect(itemSchema?.properties?.body?.description).toContain(
        "section bodies should be Japanese",
      );
      expect(itemSchema?.properties?.avoid?.description).toContain("missing Avoid section");
      expect(itemSchema?.properties?.avoid?.description).toContain("natural language in Japanese");
      expect(itemSchema?.properties?.prefer?.description).toContain("natural language in Japanese");
    });

    test("registers multiple candidates", async () => {
      vi.mocked(registerCandidatesBulk).mockResolvedValue({
        status: "bulk_candidates_registered",
        registeredCount: 2,
        failedCount: 0,
        items: [],
        next: "distillation_pipeline",
      } as never);

      const response = await registerCandidatesTool.handler({
        items: [
          { body: "A", scope: "global" },
          { body: "B", scope: "global" },
        ],
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.registeredCount).toBe(2);
      expect(registerCandidatesBulk).toHaveBeenCalledWith(
        [
          { body: "A", scope: "global", metadata: {} },
          { body: "B", scope: "global", metadata: {} },
        ],
        { strictProcedureSections: true },
      );
    });
  });

  describe("compile_eval", () => {
    test("records compile evaluation and returns JSON", async () => {
      vi.mocked(recordCompileEval).mockResolvedValue({
        evaluation: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          runId: "550e8400-e29b-41d4-a716-446655440001",
          sessionId: "s-1",
          avg: 82,
          outcome: "useful",
          title: "good",
          body: "helped",
          source: "mcp",
          relevance: 90,
          actionability: 80,
          coverage: 70,
          clarity: 90,
          specificity: 80,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        resolvedFrom: "latest_session_run",
      } as never);
      const response = await compileEvalTool.handler(
        {
          relevance: 90,
          actionability: 80,
          coverage: 70,
          clarity: 90,
          specificity: 80,
          outcome: "useful",
          body: "helped",
        },
        { toolName: "compile_eval", requestMeta: { sessionId: "s-1" } },
      );
      const json = JSON.parse(response.content[0].text);
      expect(json.evaluation.avg).toBe(82);
      expect(recordCompileEval).toHaveBeenCalledWith({
        input: {
          relevance: 90,
          actionability: 80,
          coverage: 70,
          clarity: 90,
          specificity: 80,
          outcome: "useful",
          body: "helped",
        },
        requestMeta: { sessionId: "s-1" },
        source: "mcp",
      });
    });
  });

  describe("list_knowledge", () => {
    test("lists knowledge with filters", async () => {
      vi.mocked(listKnowledgeItems).mockResolvedValue([
        {
          id: "k-1",
          title: "Rule",
          status: "draft",
        },
      ] as unknown as never);

      const response = await listKnowledgeTool.handler({ status: "draft", limit: 20 });
      const data = JSON.parse(response.content[0].text);
      expect(data.count).toBe(1);
      expect(data.items[0].id).toBe("k-1");
      expect(listKnowledgeItems).toHaveBeenCalledWith({
        status: "draft",
        limit: 20,
      });
    });
  });

  describe("update_knowledge", () => {
    test("updates knowledge with merged fields", async () => {
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "k-1",
                type: "rule",
                status: "draft",
                scope: "repo",
                title: "Old title",
                body: "Old body",
                confidence: 70,
                importance: 70,
                metadata: { a: 1 },
              },
            ]),
          }),
        }),
      } as unknown as never);
      vi.mocked(updateKnowledgeItem).mockResolvedValue({ id: "k-1" } as unknown as never);

      const response = await updateKnowledgeTool.handler({
        id: "550e8400-e29b-41d4-a716-446655440000",
        status: "active",
        title: "New title",
        metadata: { b: 2 },
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(data.status).toBe("active");
      expect(updateKnowledgeItem).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        expect.objectContaining({
          status: "active",
          title: "New title",
          metadata: { a: 1, b: 2 },
        }),
      );
    });
  });

  describe("context_compile", () => {
    test("calls compileContextPack and returns markdown only", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: {
          rules: [{ id: "k1", itemKind: "rule", title: "r", content: "b", sourceRefs: [] }],
          procedures: [],
          warnings: [],
        },
        markdown: "# Context",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content.length).toBe(1);
      expect(response.content[0].text).toBe("# Context");
      expect(reloadRuntimeSettingsCache).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reloadRuntimeSettingsCache).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(compileContextPack).mock.invocationCallOrder[0],
      );
    });

    test("does not crash when pack fields are partially missing", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: {
          rules: [{ id: "k1", itemKind: "rule", title: "r", content: "b", sourceRefs: [] }],
          procedures: [],
        },
        markdown: "# Context",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content.length).toBe(1);
      expect(response.content[0].text).toBe("# Context");
    });

    test("returns markdown even when sections are empty", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: { rules: [], procedures: [], warnings: [] },
        markdown: "No Content",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content).toEqual([{ type: "text", text: "No Content" }]);
    });
  });

  describe("system tools", () => {
    test("initial_instructions returns Japanese text by default", async () => {
      process.env.MEMORY_ROUTER_LANG = undefined;
      const response = await initialInstructionsTool.handler();
      expect(response.content[0].text).toContain("## 常用ルール");
      expect(response.content[0].text).toContain("## 主要MCPツール");
      expect(response.content[0].text).toContain("その他の公開ツールは補助機能");
      expect(response.content[0].text).not.toContain("`register_candidates`");
      expect(response.content[0].text).not.toContain("hooksLLM");
    });

    test("initial_instructions returns English text when MEMORY_ROUTER_LANG=en", async () => {
      process.env.MEMORY_ROUTER_LANG = "en";
      const response = await initialInstructionsTool.handler();
      expect(response.content[0].text).toContain("## Operational Rules");
      expect(response.content[0].text).toContain("## Primary MCP Tools");
      expect(response.content[0].text).toContain("Other exposed tools are supplemental");
      expect(response.content[0].text).not.toContain("`register_candidates`");
      expect(response.content[0].text).not.toContain("hooksLLM");
    });

    test("doctor calls runDoctor and returns JSON", async () => {
      const mockReport = { ok: true, health: "good" };
      vi.mocked(runDoctor).mockResolvedValue(mockReport as unknown as never);

      const response = await doctorTool.handler();
      expect(JSON.parse(response.content[0].text)).toEqual(mockReport);
    });
  });

  describe("context_decision & context_decision_feedback", () => {
    test("context_decision handler passes arguments to decideContext", async () => {
      const mockResult = { decision: "proceed", decisionId: "d1" };
      vi.mocked(decideContext).mockResolvedValue(mockResult as never);

      const args = { decisionPoint: "test point", sessionId: "session-123" };
      const response = await contextDecisionTool.handler(args);
      expect(decideContext).toHaveBeenCalledWith(args);
      expect(JSON.parse(response.content[0].text)).toEqual(mockResult);
    });

    test("context_decision handler works with undefined args", async () => {
      vi.mocked(decideContext).mockResolvedValue({ decision: "proceed" } as never);
      await contextDecisionTool.handler(undefined);
      expect(decideContext).toHaveBeenCalledWith({});
    });

    test("context_decision_feedback handler passes arguments to recordContextDecisionFeedback", async () => {
      const mockResult = { success: true };
      vi.mocked(recordContextDecisionFeedback).mockResolvedValue(mockResult as never);

      const args = { decisionId: "d1", source: "ai", value: "good", outcome: "success" };
      const response = await contextDecisionFeedbackTool.handler(args);
      expect(recordContextDecisionFeedback).toHaveBeenCalledWith(args);
      expect(JSON.parse(response.content[0].text)).toEqual(mockResult);
    });
  });

  describe("read_file tool", () => {
    test("read_file handler parses and passes arguments to readFileDomain", async () => {
      const mockResult = { content: "file content", tokens: 10 };
      vi.mocked(readFileDomain).mockResolvedValue(mockResult as never);

      const args = { path: "wiki/rule.md", fromToken: 0, readTokens: 100, minify: true };
      const response = await readFileTool.handler(args);
      expect(readFileDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "wiki/rule.md",
          fromToken: 0,
          readTokens: 100,
          minify: true,
        }),
      );
      expect(JSON.parse(response.content[0].text)).toEqual(mockResult);
    });
  });

  describe("context_compile session ID resolution", () => {
    const contextCompileHandlerContext = (
      requestMeta: Record<string, unknown>,
    ): ToolHandlerContext => ({
      toolName: "context_compile",
      requestMeta,
    });

    beforeEach(() => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: { rules: [], procedures: [] },
        markdown: "# Context",
      } as unknown as never);
    });

    test("resolves sessionId from requestMeta fields", async () => {
      // sessionId key
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ sessionId: " s1 " }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: "s1" }),
      );

      // threadId key
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ threadId: " t1 " }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: "t1" }),
      );

      // conversationId key
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ conversationId: " c1 " }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: "c1" }),
      );

      // codexSessionId key
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ codexSessionId: " cs1 " }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: "cs1" }),
      );

      // fallback order
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ threadId: "t", conversationId: "c" }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: "t" }),
      );

      // non-string / empty fields fallback to undefined
      await contextCompileTool.handler(
        { goal: "g" },
        contextCompileHandlerContext({ sessionId: 123, threadId: " " }),
      );
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: undefined }),
      );

      // no requestMeta
      await contextCompileTool.handler({ goal: "g" }, undefined);
      expect(compileContextPack).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({ sessionId: undefined }),
      );
    });
  });
});
