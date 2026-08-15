import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import { agenticRefine } from "../src/modules/context-compiler/agentic-refine.service.js";
import { upsertContextCompileTaskTrace } from "../src/modules/context-compiler/context-compile-task-trace.repository.js";
import {
  insertCompileRun,
  insertContextCompileCandidateTraces,
  insertContextPackItems,
  updateCompileRunFailure,
  updateCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { composeContextResponse } from "../src/modules/context-compiler/context-response-composer.service.js";
import {
  recordEpisodeUsage,
  searchEpisodes,
} from "../src/modules/episodic-memory/episode-card.service.js";
import { recordCompileRunKnowledgeUsageSignals } from "../src/modules/knowledge/knowledge-feedback.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../src/modules/knowledge/knowledge-value.service.js";
import { retrieveKnowledge } from "../src/modules/knowledge/knowledge.service.js";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";

vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/sources/source-retrieval.service.js");
vi.mock("../src/modules/episodic-memory/episode-card.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/knowledge/knowledge-feedback.service.js");
vi.mock("../src/modules/knowledge/knowledge-value.service.js");
vi.mock("../src/modules/audit/audit-log.service.js");
vi.mock("../src/modules/context-compiler/context-compile-task-trace.repository.js");
vi.mock("../src/modules/context-compiler/pack-renderer.js", () => ({
  renderContextPackMarkdown: vi.fn(() => "# Pack Content"),
}));
vi.mock("../src/modules/context-compiler/agentic-refine.service.js", () => ({
  agenticRefine: vi.fn(async (items) => ({ items, agenticUsed: false })),
}));
vi.mock("../src/modules/context-compiler/context-response-composer.service.js", () => ({
  composeContextResponse: vi.fn(({ rules, procedures }) => {
    const items = [...rules, ...procedures];
    return {
      markdown: "# Pack Content",
      agenticUsed: false,
      usedKnowledge: items.slice(0, 3).map((item) => ({
        id: item.itemId,
        confidence: 0.35,
        reason: "test_compose_reference",
      })),
    };
  }),
}));

describe("Context Compiler Service", () => {
  const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
  const originalBudget = groupedConfig.compile.defaultTokenBudget;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordAuditLogSafe).mockResolvedValue(undefined);
    vi.mocked(upsertContextCompileTaskTrace).mockResolvedValue(undefined);
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.compile.defaultTokenBudget = 240;
    vi.mocked(insertCompileRun).mockResolvedValue("550e8400-e29b-41d4-a716-446655440000");
    vi.mocked(insertContextPackItems).mockResolvedValue();
    vi.mocked(insertContextCompileCandidateTraces).mockResolvedValue();
    vi.mocked(updateCompileRunFailure).mockResolvedValue();
    vi.mocked(updateCompileRunSnapshot).mockResolvedValue();
    vi.mocked(recordCompileRunKnowledgeUsageSignals).mockResolvedValue({
      savedCount: 0,
      updatedCount: 0,
      queueCreatedCount: 0,
      queueDismissedCount: 0,
      affectedKnowledgeIds: [],
    });
    vi.mocked(recordKnowledgeCompileSelectionSafe).mockResolvedValue();
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(searchEpisodes).mockResolvedValue([]);
    vi.mocked(recordEpisodeUsage).mockResolvedValue(undefined);
  });

  afterAll(() => {
    groupedConfig.agenticCompile.enabled = originalAgenticCompileEnabled;
    groupedConfig.compile.defaultTokenBudget = originalBudget;
  });

  test("derives retrieval mode from changeTypes", async () => {
    const { pack: debugPack } = await compileContextPack({
      goal: "fix bug",
      changeTypes: ["debug"],
    });
    expect(debugPack.retrievalMode).toBe("debug_context");

    const { pack: reviewPack } = await compileContextPack({
      goal: "review changes",
      changeTypes: ["review"],
    });
    expect(reviewPack.retrievalMode).toBe("review_context");

    const { pack: architecturePack } = await compileContextPack({
      goal: "write migration plan",
      changeTypes: ["plan", "docs"],
    });
    expect(architecturePack.retrievalMode).toBe("architecture_context");
  });

  test("records run source for caller", async () => {
    await compileContextPack({ goal: "source test" }, { source: "mcp" });
    expect(insertCompileRun).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp" }));
  });

  test("persists normalized request identity instead of daemon cwd", async () => {
    const { markdown } = await compileContextPack({
      goal: "identity trace",
      projectRef: "project-A",
      repoKey: "ORG\\Repo-A",
      repoPath: "/work/./repo-a",
    });

    expect(insertCompileRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: "project-A",
        repoKey: "org/repo-a",
        repoPath: "/work/repo-a",
        matchBasis: "project_ref",
        identityContractVersion: 1,
        scopeMode: "project",
        input: expect.objectContaining({
          projectRef: "project-A",
          repoKey: "org/repo-a",
          repoPath: "/work/repo-a",
          projectIdentity: expect.objectContaining({
            matchBasis: "project_ref",
            bindingStatus: "unverified",
          }),
        }),
      }),
    );
    expect(upsertContextCompileTaskTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: "project-A",
        repoKey: "org/repo-a",
        repoPath: "/work/repo-a",
        matchBasis: "project_ref",
        identityContractVersion: 1,
        scopeMode: "project",
        identityFingerprint: "0513f9c3cf83583e36682ab931ecc66a70eafc5cd40b15123fab848a60cd7407",
        identityTrust: "request_hint",
        bindingStatus: "unverified",
      }),
    );
    expect(markdown).not.toContain("project-A");
    expect(markdown).not.toContain("/work/repo-a");
  });

  test("persists missing identity as global-only without process cwd", async () => {
    await compileContextPack({ goal: "global-only identity trace" });

    expect(insertCompileRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: null,
        repoKey: null,
        repoPath: undefined,
        matchBasis: "none",
        identityContractVersion: 1,
        scopeMode: "global_only",
        input: expect.objectContaining({
          projectIdentity: expect.objectContaining({
            matchBasis: "none",
            matchValue: null,
            identityFingerprint: null,
          }),
        }),
      }),
    );
    expect(upsertContextCompileTaskTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: null,
        repoKey: null,
        repoPath: null,
        matchBasis: "none",
        scopeMode: "global_only",
        identityFingerprint: null,
      }),
    );
  });

  test("applies internal token budget and marks compaction warning", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Long content ".repeat(260),
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "Another long content ".repeat(180),
          score: 0.8,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 2,
        vectorHitCount: 0,
        mergedCount: 2,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "budget test" });
    expect(pack.rules.length).toBeGreaterThan(0);
    expect(pack.status).toBe("ok");
    expect(pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
    expect(pack.warnings).toEqual([]);
  });

  test("builds fallback source ref when retrieval has no matches", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "no data" });
    expect(pack.sourceRefs[0]).toContain(
      "550e8400-e29b-41d4-a716-446655440000#task_context:NO_ACTIVE_KNOWLEDGE_MATCH",
    );
    expect(pack.status).toBe("degraded");
  });

  test("adds EpisodeCard precedents to compile procedures without recording them as knowledge", async () => {
    vi.mocked(searchEpisodes).mockResolvedValue([
      {
        id: "episode-1",
        title: "SQLite migration recovery",
        situation: "SQLite bootstrap missed a new table.",
        observations: "Runtime tests failed before MCP smoke could run.",
        action: "Added the table to SQLite core schema and reran runtime support tests.",
        outcome: "The compile path could reuse the schema precedent.",
        lesson: "Keep Postgres, SQLite, and smoke checks aligned for schema features.",
        applicability: {},
        antiApplicability: {},
        domains: ["episodic-memory"],
        technologies: ["sqlite", "typescript"],
        changeTypes: ["schema"],
        tools: [],
        scope: "global",
        classificationStatus: "classified",
        repoPath: null,
        repoKey: null,
        sourceKind: "manual",
        sourceKey: "episode-1",
        outcomeKind: "success",
        importance: 90,
        confidence: 92,
        compileUseCount: 0,
        decisionUseCount: 0,
        status: "active",
        staleAt: null,
        metadata: {},
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:00.000Z"),
        score: 11,
        refs: [
          {
            id: "ref-1",
            episodeCardId: "episode-1",
            refKind: "file",
            refValue: "src/db/sqlite/core-schema.ts",
            locator: "episode_cards",
            queryHint: null,
            metadata: {},
            createdAt: new Date("2026-06-20T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const { pack } = await compileContextPack({
      goal: "wire sqlite schema precedent into compile",
      technologies: ["sqlite"],
      changeTypes: ["schema"],
    });

    expect(pack.status).toBe("ok");
    expect(pack.procedures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemKind: "episode_card",
          itemId: "episode-1",
          title: "Past episode: SQLite migration recovery",
          sourceRefs: expect.arrayContaining([
            "context-still://episodes/episode-1",
            "src/db/sqlite/core-schema.ts#episode_cards",
          ]),
        }),
      ]),
    );
    expect(pack.sourceRefs).toEqual(
      expect.arrayContaining([
        "context-still://episodes/episode-1",
        "src/db/sqlite/core-schema.ts#episode_cards",
      ]),
    );
    expect(pack.diagnostics.degradedReasons).not.toContain("NO_RELEVANT_CONTEXT");
    expect(pack.diagnostics.retrievalStats.episodes).toEqual(
      expect.objectContaining({
        hitCount: 1,
        selectedCount: 1,
        searchFailed: false,
        selectedIds: ["episode-1"],
        selectedTitles: ["SQLite migration recovery"],
        scopedHitCount: 0,
        globalHitCount: 1,
        usedFor: "compile_precedent",
      }),
    );
    expect(recordKnowledgeCompileSelectionSafe).toHaveBeenCalledWith(
      expect.objectContaining({ selectedKnowledgeIds: [] }),
    );
    expect(recordEpisodeUsage).toHaveBeenCalledWith({
      usageKind: "compile",
      episodeIds: ["episode-1"],
    });
    expect(insertContextPackItems).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "episode-1",
          scopeSnapshot: expect.objectContaining({
            matchBasis: "none",
            candidateScope: "global",
            decision: "ALLOW_GLOBAL",
            allowed: true,
          }),
        }),
      ]),
    );
  });

  test("keeps source-only misses non-blocking when knowledge context is usable", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Useful rule",
          body: "Use the existing doctor signal categories.",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "source miss with useful knowledge" });
    const reasonBuckets = pack.diagnostics.retrievalStats.reasonBuckets as {
      blocking: string[];
      maintenanceWarnings: string[];
    };
    expect(pack.status).toBe("ok");
    expect(pack.diagnostics.degradedReasons).toContain("NO_SOURCE_MATCH");
    expect(reasonBuckets.blocking).not.toContain("NO_SOURCE_MATCH");
    expect(reasonBuckets.maintenanceWarnings).toContain("NO_SOURCE_MATCH");
  });

  test("records split embedding trace diagnostics across knowledge and sources", async () => {
    vi.mocked(retrieveKnowledge)
      .mockResolvedValueOnce({
        items: [
          {
            id: "k-positive",
            type: "rule",
            status: "active",
            title: "Positive rule",
            body: "Use relevant positive compile context.",
            score: 0.9,
            sourceRefs: [],
            hasSourceLinks: false,
          },
        ],
        degradedReasons: [],
        stats: {
          textHitCount: 1,
          vectorHitCount: 1,
          mergedCount: 1,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "generated",
          embeddingProvider: "local",
          embeddingModel: "test-embed",
          embeddingDimensions: 3,
          queryEmbedding: [0.1, 0.2, 0.3],
          scopedSearch: false,
          repoScopeFallbackUsed: false,
          queryText: "goal",
        },
      } as any)
      .mockResolvedValueOnce({
        items: [],
        degradedReasons: ["QUERY_EMBEDDING_UNAVAILABLE"],
        stats: {
          textHitCount: 0,
          vectorHitCount: 0,
          mergedCount: 0,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "unavailable",
          scopedSearch: false,
          repoScopeFallbackUsed: false,
          queryText: "goal",
        },
      } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["SOURCE_QUERY_EMBEDDING_UNAVAILABLE"],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "unavailable",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "embedding trace diagnostics" });
    expect(pack.diagnostics.retrievalStats.embeddingTrace).toEqual(
      expect.objectContaining({
        overallStatus: "embedding_unavailable",
        knowledgePositive: expect.objectContaining({
          compileStatus: "embedding_available",
          embeddingProvider: "local",
          embeddingModel: "test-embed",
          embeddingDimensions: 3,
          hasQueryEmbedding: true,
        }),
        knowledgeNegative: expect.objectContaining({
          compileStatus: "embedding_unavailable",
        }),
        sources: expect.objectContaining({
          compileStatus: "embedding_unavailable",
        }),
      }),
    );
    expect(upsertContextCompileTaskTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingStatus: "embedding_available",
        embeddingProvider: "local",
        embeddingModel: "test-embed",
        embeddingDimensions: 3,
        embedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  test("keeps agentic refine failures non-blocking when ranked knowledge is usable", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Useful rule",
          body: "Use the ranked fallback when agentic refinement is unavailable.",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(agenticRefine).mockResolvedValueOnce({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Useful rule",
          content: "Use the ranked fallback when agentic refinement is unavailable.",
          score: 0.9,
          sourceRefs: [],
        },
      ],
      agenticUsed: false,
      error: "AGENTIC_REFINE_FAILED: azure-openai:The operation was aborted.",
    });

    const { pack } = await compileContextPack({ goal: "agentic fallback with useful knowledge" });
    const reasonBuckets = pack.diagnostics.retrievalStats.reasonBuckets as {
      blocking: string[];
      maintenanceWarnings: string[];
    };
    expect(pack.status).toBe("ok");
    expect(pack.diagnostics.degradedReasons).toContain("AGENTIC_REFINE_FAILED");
    expect(reasonBuckets.blocking).not.toContain("AGENTIC_REFINE_FAILED");
    expect(reasonBuckets.maintenanceWarnings).toContain("AGENTIC_REFINE_FAILED");
  });

  test("respects agentic empty selection and degrades as no relevant context", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Unrelated rule",
          body: "This candidate is not relevant to the compile goal.",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(agenticRefine).mockResolvedValueOnce({
      items: [],
      agenticUsed: true,
      reasoning: "該当なし",
      selectionReason: "empty_selection",
    });

    const { pack } = await compileContextPack({ goal: "agentic empty selection" });
    expect(pack.status).toBe("degraded");
    expect(pack.rules).toEqual([]);
    expect(pack.diagnostics.degradedReasons).toContain("NO_RELEVANT_CONTEXT");
    expect(pack.diagnostics.retrievalStats).toEqual(
      expect.objectContaining({
        agenticUsed: true,
        agenticReasoning: "該当なし",
        agenticSelectionReason: "empty_selection",
      }),
    );
    expect(recordKnowledgeCompileSelectionSafe).toHaveBeenCalledWith(
      expect.objectContaining({ selectedKnowledgeIds: [] }),
    );
  });

  test("keeps response composer failures non-blocking when pack items are usable", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "procedure",
          status: "active",
          title: "Useful procedure",
          body: "Use when fallback pack rendering is enough.\nWorkflow:\n1. Keep the selected pack items.\nVerification:\n- Pack status remains usable.\nAvoid:\n- Treating composer failure as no content.",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(composeContextResponse).mockResolvedValueOnce({
      markdown: "",
      agenticUsed: false,
      usedKnowledge: [],
      error: "CONTEXT_RESPONSE_COMPOSE_FAILED: The operation was aborted.",
    });

    const { pack, markdown } = await compileContextPack({
      goal: "composer fallback with useful knowledge",
    });
    const reasonBuckets = pack.diagnostics.retrievalStats.reasonBuckets as {
      blocking: string[];
      maintenanceWarnings: string[];
    };
    expect(pack.status).toBe("ok");
    expect(markdown).toBe("# Pack Content");
    expect(pack.diagnostics.degradedReasons).toContain("CONTEXT_RESPONSE_COMPOSE_FAILED");
    expect(reasonBuckets.blocking).not.toContain("CONTEXT_RESPONSE_COMPOSE_FAILED");
    expect(reasonBuckets.maintenanceWarnings).toContain("CONTEXT_RESPONSE_COMPOSE_FAILED");
  });

  test("records compile usage signals from composed response on sqlite backend", async () => {
    const previousBackend = process.env.CONTEXT_STILL_DB_BACKEND;
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Keep API validation",
          score: 0.91,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "Keep repository boundaries",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k3",
          type: "rule",
          status: "active",
          title: "Rule 3",
          body: "Add targeted tests",
          score: 0.89,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k4",
          type: "rule",
          status: "active",
          title: "Rule 4",
          body: "Report verification output",
          score: 0.88,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 4,
        vectorHitCount: 0,
        mergedCount: 4,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    try {
      await compileContextPack({ goal: "usage signal capture" });

      expect(insertContextCompileCandidateTraces).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(recordCompileRunKnowledgeUsageSignals).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: "550e8400-e29b-41d4-a716-446655440000",
            items: expect.arrayContaining([
              expect.objectContaining({ knowledgeId: "k1", verdict: "used" }),
              expect.objectContaining({ knowledgeId: "k4", verdict: "not_used" }),
            ]),
          }),
        );
      });
    } finally {
      if (previousBackend === undefined) {
        Reflect.deleteProperty(process.env, "CONTEXT_STILL_DB_BACKEND");
      } else {
        process.env.CONTEXT_STILL_DB_BACKEND = previousBackend;
      }
    }
  });

  test("suppresses near-duplicate candidates before selection and records suppression trace", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k-high",
          type: "rule",
          status: "active",
          title: "Use queue supervisor for lane health",
          body: "Use queue supervisor for lane health and runtime visibility.",
          score: 0.95,
          sourceRefs: ["wiki://queue#runbook"],
          hasSourceLinks: true,
        },
        {
          id: "k-low",
          type: "rule",
          status: "active",
          title: "Use queue supervisor for lane health",
          body: "Use queue supervisor for lane health and operational visibility.",
          score: 0.82,
          sourceRefs: ["wiki://queue#runbook"],
          hasSourceLinks: true,
        },
        {
          id: "k-other",
          type: "rule",
          status: "active",
          title: "Run doctor after queue repair",
          body: "Run doctor after queue repair before resuming normal operations.",
          score: 0.81,
          sourceRefs: ["wiki://doctor#workflow"],
          hasSourceLinks: true,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 3,
        vectorHitCount: 0,
        mergedCount: 3,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "duplicate suppression behavior" });

    expect(recordKnowledgeCompileSelectionSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedKnowledgeIds: expect.arrayContaining(["k-high", "k-other"]),
      }),
    );
    const selectedKnowledgeIds = vi.mocked(recordKnowledgeCompileSelectionSafe).mock.calls[0]?.[0]
      ?.selectedKnowledgeIds;
    expect(selectedKnowledgeIds).not.toContain("k-low");

    const traceRows = vi.mocked(insertContextCompileCandidateTraces).mock.calls[0]?.[1] ?? [];
    const suppressedRow = traceRows.find((row) => row.itemId === "k-low");
    expect(suppressedRow).toBeTruthy();
    expect(suppressedRow).toEqual(
      expect.objectContaining({
        suppressed: true,
        suppressionReason: "near_duplicate_suppressed",
        rankingReason: "near_duplicate_suppressed:k-high",
      }),
    );
    expect(suppressedRow?.evidence).toEqual(
      expect.objectContaining({
        duplicateSuppression: expect.objectContaining({
          representativeId: "k-high",
        }),
      }),
    );
    expect(pack.diagnostics.retrievalStats).toEqual(
      expect.objectContaining({
        duplicateSuppressedCount: 1,
        duplicateSuppressedGroupCount: 1,
      }),
    );
  });

  test("stores unknown facet candidates in diagnostics", async () => {
    const { pack } = await compileContextPack({
      goal: "domain test",
      technologies: ["unknown-tech"],
      domains: ["unknown-domain"],
      changeTypes: ["unknown-change"],
    });

    const unknown = pack.diagnostics.inputFacets?.unknown;
    expect(Array.isArray(unknown?.technology)).toBe(true);
    expect(Array.isArray(unknown?.domain)).toBe(true);
    expect(Array.isArray(unknown?.change_type)).toBe(true);
  });

  test("does not suggest legacy repo/files retry actions", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "suggestions" });
    const calls = (pack.diagnostics.retrievalStats.suggestedNextCalls ?? []) as string[];
    expect(calls).not.toContain("context_compile (retry with explicit repoPath/files)");
    expect(calls).not.toContain("context_compile (retry with larger tokenBudget)");
  });

  test("short-circuits compile when goal contains design document reference", async () => {
    const { pack } = await compileContextPack({
      goal: "docs/context-compile-four-input-redesign-plan.md を実装する",
      changeTypes: ["refactor"],
    });

    expect(pack.status).toBe("degraded");
    expect(pack.rules).toEqual([]);
    expect(pack.procedures).toEqual([]);
    expect(pack.diagnostics.degradedReasons).toContain("GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE");
    expect(retrieveKnowledge).not.toHaveBeenCalled();
    expect(retrieveSources).not.toHaveBeenCalled();
  });

  test("suppresses low-confidence vector-only candidates", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k-vector-only",
          type: "rule",
          status: "active",
          title: "Weak vector-only knowledge",
          body: "not really relevant",
          score: 0.12,
          sourceRefs: [],
          hasSourceLinks: false,
          candidateEvidence: {
            textMatched: false,
            vectorMatched: true,
            vectorScore: 0.12,
            facetMatched: false,
          },
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 0,
        vectorHitCount: 1,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "actual compile behavior improvement" });
    expect(pack.rules).toEqual([]);
    expect(pack.procedures).toEqual([]);
    expect(pack.diagnostics.degradedReasons).toContain("LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
    expect(pack.diagnostics.degradedReasons).toContain("NO_RELEVANT_CONTEXT");
  });

  test("passes high-scoring negative knowledge to guardrails and response composer", async () => {
    vi.mocked(retrieveKnowledge)
      .mockResolvedValueOnce({
        items: [],
        degradedReasons: [],
        trace: { text: [], vector: [], merged: [] },
        stats: {
          textHitCount: 0,
          vectorHitCount: 0,
          mergedCount: 0,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "generated",
          scopedSearch: false,
          repoScopeFallbackUsed: false,
          queryText: "goal",
        },
      } as any)
      .mockResolvedValueOnce({
        items: [
          {
            id: "k-negative",
            type: "rule",
            status: "active",
            polarity: "negative",
            title: "Do not skip migration verification",
            body: "Do not proceed unless migration verification has been run.",
            score: 0.94,
            confidence: 92,
            importance: 88,
            dynamicScore: 80,
            decayFactor: 1,
            applicabilityScore: 35,
            sourceRefs: [],
            hasSourceLinks: false,
          },
        ],
        degradedReasons: [],
        trace: {
          text: [{ id: "k-negative", rank: 1, score: 0.94 }],
          vector: [],
          merged: [{ id: "k-negative", rank: 1, score: 0.94 }],
        },
        stats: {
          textHitCount: 1,
          vectorHitCount: 0,
          mergedCount: 1,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "generated",
          scopedSearch: false,
          repoScopeFallbackUsed: false,
          queryText: "goal",
        },
      } as any);

    const { pack } = await compileContextPack({ goal: "migration verification decision" });

    expect(retrieveKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ polarities: ["negative"] }),
    );
    expect(pack.guardrails).toEqual([
      expect.objectContaining({
        itemId: "k-negative",
        section: "guardrails",
      }),
    ]);
    expect(agenticRefine).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "k-negative",
          polarity: "negative",
          section: "guardrails",
        }),
      ]),
      expect.anything(),
      expect.anything(),
    );
    expect(composeContextResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        guardrails: expect.arrayContaining([
          expect.objectContaining({
            itemId: "k-negative",
            title: "Do not skip migration verification",
          }),
        ]),
      }),
    );
    const traceRows = vi.mocked(insertContextCompileCandidateTraces).mock.calls[0]?.[1] ?? [];
    expect(traceRows).toContainEqual(
      expect.objectContaining({
        itemId: "k-negative",
        textScore: 0.94,
        selected: true,
      }),
    );
  });

  test("records compile usage signals error handling and records audit log", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Body 1",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {} as any,
    } as any);

    // Force error in recordCompileRunKnowledgeUsageSignals
    vi.mocked(recordCompileRunKnowledgeUsageSignals).mockRejectedValue(
      new Error("Database write error"),
    );

    await compileContextPack({ goal: "trigger signal save error" });

    await vi.waitFor(() => {
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_USAGE_SIGNAL_SAVE_FAILED",
        }),
      );
    });
  });

  test("escalates status to failed when multiple hard failures occur", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["QUERY_EMBEDDING_UNAVAILABLE", "AGENTIC_REFINE_FAILED"],
      stats: {} as any,
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["SOURCE_QUERY_EMBEDDING_UNAVAILABLE", "SOURCE_RETRIEVAL_FAILED"],
      stats: {} as any,
    } as any);

    const { pack } = await compileContextPack({ goal: "failed status test" });
    expect(pack.status).toBe("failed");
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("doctor");
  });

  test("marks persisted run as failed when pack item persistence fails", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Body 1",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {} as any,
    } as any);
    vi.mocked(insertContextPackItems).mockRejectedValueOnce(
      new Error("context_pack_items constraint failed"),
    );

    await expect(compileContextPack({ goal: "pack persist failure" })).rejects.toThrow(
      "context_pack_items constraint failed",
    );

    expect(updateCompileRunFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "550e8400-e29b-41d4-a716-446655440000",
        degradedReasons: expect.arrayContaining(["CONTEXT_PACK_PERSIST_FAILED"]),
        pack: expect.objectContaining({
          status: "failed",
          diagnostics: expect.objectContaining({
            retrievalStats: expect.objectContaining({
              candidateTraceSavedCount: 1,
              candidateTraceSkippedReason: null,
              persistenceState: expect.objectContaining({
                contextPackItemsSaved: false,
                candidateTraceSavedCount: 1,
                candidateTraceSkippedReason: null,
              }),
              responseComposer: expect.objectContaining({
                outputMarkdown: "No Content",
              }),
            }),
          }),
        }),
      }),
    );
    expect(recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "CONTEXT_COMPILE_RUN",
        payload: expect.objectContaining({
          status: "failed",
          degradedReasons: expect.arrayContaining(["CONTEXT_PACK_PERSIST_FAILED"]),
        }),
      }),
    );
  });

  test("recommends next calls based on degraded reasons", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {} as any,
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {} as any,
    } as any);

    const { pack } = await compileContextPack({ goal: "recommends next calls test" });
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("search_knowledge");
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("search_memory");
  });

  test("uses legacy intent mapping correctly", async () => {
    const { pack: learningPack } = await compileContextPack({
      goal: "learn python",
      changeTypes: ["learning"],
    });
    expect(learningPack.retrievalMode).toBe("learning_context");
  });

  test("marks status as degraded when COMPOSED_CONTEXT_NO_ALIGNMENT occurs", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Body 1",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {} as any,
    } as any);
    vi.mocked(composeContextResponse).mockResolvedValueOnce({
      markdown: "No Content",
      agenticUsed: false,
      usedKnowledge: [],
    });

    const { pack } = await compileContextPack({ goal: "no alignment test" });
    expect(pack.status).toBe("degraded");
    expect(pack.diagnostics.degradedReasons).toContain("COMPOSED_CONTEXT_NO_ALIGNMENT");
  });

  test("marks status as degraded (not failed) when multiple search failures occur", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Body 1",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: ["KNOWLEDGE_TEXT_SEARCH_FAILED"],
      stats: {} as any,
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["SOURCE_SEARCH_FAILED"],
      stats: {} as any,
    } as any);

    const { pack } = await compileContextPack({ goal: "multiple search failures test" });
    expect(pack.status).toBe("degraded");
    expect(pack.diagnostics.degradedReasons).toContain("KNOWLEDGE_TEXT_SEARCH_FAILED");
    expect(pack.diagnostics.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
  });
});
