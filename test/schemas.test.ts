import { describe, expect, test } from "vitest";
import { compileInputSchema } from "../src/shared/schemas/compile.schema.ts";
import { doctorReportSchema } from "../src/shared/schemas/doctor.schema.ts";
import { episodeCardCreateSchema } from "../src/shared/schemas/episode-card.schema.ts";
import {
  knowledgeSearchInputSchema,
  registerCandidateInputSchema,
  registerCandidatesBulkInputSchema,
  registerCandidatesToolInputSchema,
  registerKnowledgeInputSchema,
  updateKnowledgeInputSchema,
} from "../src/shared/schemas/knowledge.schema.ts";
import {
  landscapeReviewItemSchema,
  landscapeReviewItemsMaterializeInputSchema,
} from "../src/shared/schemas/landscape-review.schema.ts";
import { landscapeSnapshotSchema } from "../src/shared/schemas/landscape.schema.ts";
import { overviewDashboardSchema } from "../src/shared/schemas/overview.schema.ts";
import { recordVibeMemoryInputSchema } from "../src/shared/schemas/vibe-memory.schema.ts";
import {
  doctorReportValidInput,
  landscapeSnapshotValidInput,
  overviewDashboardUnavailableLandscapeInput,
  overviewDashboardValidInput,
} from "./fixtures/schema-fixtures.ts";

describe("Shared Schemas", () => {
  test("episodeCardCreateSchema parses refs and defaults", () => {
    const parsed = episodeCardCreateSchema.parse({
      title: "SQLite compile failure recovery",
      situation: "SQLite compile failed after a schema change.",
      sourceKind: "compile_run",
      sourceKey: "550e8400-e29b-41d4-a716-446655440000",
      refs: [
        {
          refKind: "compile_run",
          refValue: "550e8400-e29b-41d4-a716-446655440000",
        },
      ],
    });
    expect(parsed.status).toBe("active");
    expect(parsed.outcomeKind).toBe("unknown");
    expect(parsed.refs[0]?.refKind).toBe("compile_run");
  });

  test("knowledgeSearchInputSchema parses valid input", () => {
    const input = { query: "test", limit: 10 };
    expect(knowledgeSearchInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("registerKnowledgeInputSchema parses valid input", () => {
    const input = { title: "T", body: "B" };
    expect(registerKnowledgeInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("registerCandidateInputSchema accepts title/body or text", () => {
    expect(
      registerCandidateInputSchema.parse({
        title: "T",
        body: "B",
        technologies: "bun,typescript",
      }),
    ).toEqual(
      expect.objectContaining({
        title: "T",
        body: "B",
        technologies: ["bun", "typescript"],
      }),
    );
    expect(registerCandidateInputSchema.parse({ text: "TITLE: T\nCONTENT: B" })).toEqual(
      expect.objectContaining({ text: "TITLE: T\nCONTENT: B" }),
    );
    expect(registerCandidateInputSchema.safeParse({ title: "T" }).success).toBe(false);
  });

  test("registerCandidateInputSchema requires applicability for negative candidates", () => {
    expect(
      registerCandidateInputSchema.parse({
        title: "Avoid stale queue assumptions",
        polarity: "negative",
        avoid: "Assuming queue count proves worker progress.",
        prefer: "Check worker events and persisted queue state together.",
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      }),
    ).toEqual(
      expect.objectContaining({
        polarity: "negative",
        avoid: "Assuming queue count proves worker progress.",
        prefer: "Check worker events and persisted queue state together.",
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      }),
    );
    expect(
      registerCandidateInputSchema.safeParse({
        title: "Avoid stale queue assumptions",
        polarity: "negative",
        avoid: "Assuming queue count proves worker progress.",
        prefer: "Check worker events and persisted queue state together.",
      }).success,
    ).toBe(false);
    expect(
      registerCandidateInputSchema.safeParse({
        title: "T",
        body: "B",
        avoid: "A",
      }).success,
    ).toBe(false);
    expect(
      registerCandidateInputSchema.parse({
        title: "Procedure",
        body: "Use when:\n- Need a workflow.\n\nWorkflow:\n1. Do one.\n2. Do two.\n\nVerification:\n- Confirm it.",
        type: "procedure",
        avoid: "Skipping the verification step.",
      }),
    ).toEqual(
      expect.objectContaining({
        type: "procedure",
        avoid: "Skipping the verification step.",
      }),
    );
  });

  test("registerCandidatesToolInputSchema requires strict wrapper", () => {
    expect(
      registerCandidatesToolInputSchema.parse({
        items: [{ body: "A" }],
      }),
    ).toEqual({
      items: [{ body: "A", scope: "repo", metadata: {} }],
    });
    expect(
      registerCandidatesToolInputSchema.safeParse({
        items: [{ body: "A" }],
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("registerCandidatesBulkInputSchema enforces min/max", () => {
    expect(registerCandidatesBulkInputSchema.safeParse([]).success).toBe(false);
    expect(
      registerCandidatesBulkInputSchema.safeParse(
        Array.from({ length: 11 }, (_, index) => ({ body: `body-${index}` })),
      ).success,
    ).toBe(false);
    expect(registerCandidatesBulkInputSchema.safeParse([{ body: "A" }]).success).toBe(true);
  });

  test("compileInputSchema parses valid input", () => {
    const input = {
      goal: "test",
      projectRef: "project-A",
      repoKey: "org/repo-a",
      repoPath: "/work/repo-a",
    };
    expect(compileInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("compileInputSchema rejects control characters in project identity", () => {
    expect(
      compileInputSchema.safeParse({ goal: "test", projectRef: "project-A\nproject-B" }).success,
    ).toBe(false);
    expect(compileInputSchema.safeParse({ goal: "test", repoKey: "repo-A\trepo-B" }).success).toBe(
      false,
    );
  });

  test("doctorReportSchema parses valid input", () => {
    expect(doctorReportSchema.parse(doctorReportValidInput)).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
  });

  test("recordVibeMemoryInputSchema parses valid input", () => {
    const input = {
      sessionId: "s1",
      content: "C",
      memoryType: "chat",
    };
    expect(recordVibeMemoryInputSchema.parse(input)).toEqual(expect.objectContaining(input));
  });

  test("overviewDashboardSchema parses valid input", () => {
    expect(overviewDashboardSchema.parse(overviewDashboardValidInput)).toEqual(
      expect.objectContaining(overviewDashboardValidInput),
    );
  });

  test("overviewDashboardSchema parses unavailable landscape summary", () => {
    const parsed = overviewDashboardSchema.parse(overviewDashboardUnavailableLandscapeInput);
    expect(parsed.landscape).toEqual(overviewDashboardUnavailableLandscapeInput.landscape);
  });

  test("landscape review schemas parse valid input", () => {
    const item = {
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
      evidence: ["wrong feedback observed in baseline replay"],
      payload: {
        generatedBy: "landscape_replay_compare",
      },
      note: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
      resolvedAt: null,
    };
    expect(landscapeReviewItemSchema.parse(item)).toEqual(expect.objectContaining(item));

    const materializeInput = {
      dryRun: true,
      windowDays: 30,
      limit: 100,
      runStatus: "all",
      currentLimit: 12,
      relationAxes: "session,project,source",
      sources: ["replay_compare"],
      materializeLimit: 50,
    };
    expect(landscapeReviewItemsMaterializeInputSchema.parse(materializeInput)).toEqual(
      expect.objectContaining({
        dryRun: true,
        relationAxes: ["session", "project", "source"],
        sources: ["replay_compare"],
      }),
    );
  });

  test("landscapeSnapshotSchema parses valid input", () => {
    expect(landscapeSnapshotSchema.parse(landscapeSnapshotValidInput)).toEqual(
      expect.objectContaining(landscapeSnapshotValidInput),
    );
  });

  test("contextPackSchema parses valid input", async () => {
    const { contextPackSchema } = await import("../src/shared/schemas/context-pack.schema.ts");
    const input = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      intent: "edit",
      retrievalMode: "learning_context",
      status: "ok",
      goal: "Goal",
      minimalTasks: [],
      rules: [],
      procedures: [],
      codeContext: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: {
        degradedReasons: [],
        retrievalStats: {
          textHitCount: 0,
          vectorHitCount: 0,
          mergedCount: 0,
          textFailed: false,
          vectorFailed: false,
          embeddingStatus: "provided",
          queryText: "q",
          scopedSearch: false,
          repoScopeFallbackUsed: false,
        },
      },
    };

    expect(contextPackSchema.parse(input)).toEqual(
      expect.objectContaining({ runId: "550e8400-e29b-41d4-a716-446655440000" }),
    );
  });

  test("compileRunKnowledgeSignalSchema accepts guardrail sections", async () => {
    const { compileRunKnowledgeSignalSchema } = await import(
      "../src/shared/schemas/compile-run.schema.ts"
    );

    expect(
      compileRunKnowledgeSignalSchema.parse({
        knowledgeId: "g1",
        rawId: "knowledge:g1",
        itemKind: "rule",
        section: "guardrails",
        title: "Guardrail Rule",
        score: 0.95,
        rankingReason: "ranked",
        autoVerdict: null,
        autoActor: null,
        autoReason: null,
        effectiveVerdict: null,
        effectiveActor: null,
        effectiveReason: null,
        hasUserOverride: false,
        updatedAt: null,
      }),
    ).toEqual(expect.objectContaining({ section: "guardrails" }));
  });

  test("recordVibeMemoryInputSchema transforms and refines diffs", () => {
    const input = {
      sessionId: "s1",
      content: "C",
      agentDiffs: [
        { filePath: "a.ts", diff: "some diff" }, // transforms diff to diffHunk
      ],
    };
    const result = recordVibeMemoryInputSchema.parse(input);
    expect(result.agentDiffs[0].diffHunk).toBe("some diff");

    // refine check (must have content)
    expect(() =>
      recordVibeMemoryInputSchema.parse({
        sessionId: "s1",
        content: "C",
        agentDiffs: [{ filePath: "a.ts", diff: " " }],
      }),
    ).toThrow("Agent diff entry requires diffHunk or diff");
  });

  test("knowledge.schema preprocess and refine edge cases", () => {
    // test optionalKnowledgeScoreSchema preprocess
    const reg1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      confidence: "", // empty string should map to undefined
      importance: "85", // numeric string should map to 85
    });
    expect(reg1.confidence).toBeUndefined();
    expect(reg1.importance).toBe(85);

    const reg2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      confidence: null, // null should map to undefined
      importance: 90,
    });
    expect(reg2.confidence).toBeUndefined();
    expect(reg2.importance).toBe(90);

    const regInvalidScore = registerKnowledgeInputSchema.safeParse({
      title: "T",
      body: "B",
      confidence: "invalid-number", // should result in undefined
    });
    expect(regInvalidScore.success).toBe(true);
    if (regInvalidScore.success) {
      expect(regInvalidScore.data.confidence).toBeUndefined();
    }

    // test optionalApplicabilityBooleanSchema preprocess
    const regBool1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "true",
    });
    expect(regBool1.general).toBe(true);

    const regBool2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "false",
    });
    expect(regBool2.general).toBe(false);

    const regBoolInvalid = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      general: "not-a-boolean",
    });
    expect(regBoolInvalid.general).toBeUndefined();

    // test optionalApplicabilityArraySchema preprocess
    const regArr1 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: "node, bun, typescript", // split comma
    });
    expect(regArr1.technologies).toEqual(["node", "bun", "typescript"]);

    const regArr2 = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: ["node", "bun"],
    });
    expect(regArr2.technologies).toEqual(["node", "bun"]);

    const regArrEmpty = registerKnowledgeInputSchema.parse({
      title: "T",
      body: "B",
      technologies: "",
    });
    expect(regArrEmpty.technologies).toBeUndefined();

    // test updateKnowledgeInputSchema refine
    const updateValid = updateKnowledgeInputSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Updated Title",
    });
    expect(updateValid.success).toBe(true);

    const updateInvalid = updateKnowledgeInputSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      // no update fields
    });
    expect(updateInvalid.success).toBe(false);
  });

  test("landscapeContradictionDetectionInputSchema parses and pre-processes relationAxes", async () => {
    const { landscapeContradictionDetectionInputSchema } = await import(
      "../src/shared/schemas/landscape-contradiction.schema.ts"
    );

    const input = {
      relationAxes: "Session, Project",
    };
    const parsed = landscapeContradictionDetectionInputSchema.parse(input);
    expect(parsed.relationAxes).toEqual(["session", "project"]);

    const parsedDefault = landscapeContradictionDetectionInputSchema.parse({});
    expect(parsedDefault.relationAxes).toEqual(["session", "project", "source"]);
  });

  test("distillation target metadata schemas parse correctly", async () => {
    const { parseWebIngestTargetMetadata, parseCoverEvidenceReprocessRequest } = await import(
      "../src/shared/schemas/distillation-target-metadata.schema.ts"
    );

    // 1. parseWebIngestTargetMetadata
    const validMeta = { sourceUrl: "http://example.com" };
    expect(parseWebIngestTargetMetadata(validMeta)).toEqual(validMeta);
    expect(parseWebIngestTargetMetadata(null)).toEqual({});

    // 2. parseCoverEvidenceReprocessRequest
    const reprocessObj = {
      coverEvidenceReprocessRequest: {
        mode: "cloud_api",
        requestedAt: "2026-06-11T12:00:00Z",
      },
    };
    expect(parseCoverEvidenceReprocessRequest(reprocessObj)).toEqual(
      expect.objectContaining({
        mode: "cloud_api",
        requestedAt: "2026-06-11T12:00:00Z",
        findCandidateResultIds: [],
        coverEvidenceResultIds: [],
      }),
    );
    expect(parseCoverEvidenceReprocessRequest(null)).toBeNull();
    expect(parseCoverEvidenceReprocessRequest({})).toBeNull();
  });
});
