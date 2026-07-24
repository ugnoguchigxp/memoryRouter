import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";
import { parseCoverEvidenceResult } from "../src/modules/coverEvidence/parser.js";
import { buildCoverEvidenceSearchQuery } from "../src/modules/coverEvidence/search-query.service.js";
import { renderSystemContext } from "../src/modules/system-context/system-context.service.js";

const mocks = vi.hoisted(() => ({
  getFindCandidateResultById: vi.fn(),
  readFileDomain: vi.fn(),
  readVibeMemoryByTokenWindow: vi.fn(),
  searchKnowledge: vi.fn(),
  findSimilarKnowledge: vi.fn(),
  recordAuditLogSafe: vi.fn(),
  selectCoverEvidenceResultById: vi.fn(),
  saveCoverEvidenceResult: vi.fn(),
  coverEvidenceResultFromRow: vi.fn(),
  resolveDistillationModel: vi.fn(() => "test-model"),
  resolveRouteModelForProvider: vi.fn(
    (params: { routeModel?: string; localLlmModel?: string }) =>
      params.localLlmModel ?? params.routeModel ?? "test-model",
  ),
  runDistillationCompletion: vi.fn(),
  executeDistillationToolCall: vi.fn(),
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  getFindCandidateResultById: mocks.getFindCandidateResultById,
}));

vi.mock("../src/modules/readFile/domain.js", () => ({
  readFileDomain: mocks.readFileDomain,
}));

vi.mock("../src/modules/memoryReader/reader.service.js", () => ({
  readVibeMemoryByTokenWindow: mocks.readVibeMemoryByTokenWindow,
}));

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  searchKnowledge: mocks.searchKnowledge,
}));

vi.mock("../src/lib/knowledge-dedup.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/knowledge-dedup.js")>(
    "../src/lib/knowledge-dedup.js",
  );
  return {
    ...actual,
    findSimilarKnowledge: mocks.findSimilarKnowledge,
  };
});

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    coverEvidenceStarted: "COVER_EVIDENCE_STARTED",
    coverEvidenceCompleted: "COVER_EVIDENCE_COMPLETED",
    coverEvidenceFailed: "COVER_EVIDENCE_FAILED",
    coverEvidenceProcedureRepairStarted: "COVER_EVIDENCE_PROCEDURE_REPAIR_STARTED",
    coverEvidenceProcedureRepairCompleted: "COVER_EVIDENCE_PROCEDURE_REPAIR_COMPLETED",
    coverEvidenceProcedureDemotedToRule: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

vi.mock("../src/modules/coverEvidence/repository.js", () => ({
  selectCoverEvidenceResultById: mocks.selectCoverEvidenceResultById,
  saveCoverEvidenceResult: mocks.saveCoverEvidenceResult,
  coverEvidenceResultFromRow: mocks.coverEvidenceResultFromRow,
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  resolveDistillationModel: mocks.resolveDistillationModel,
  resolveRouteModelForProvider: mocks.resolveRouteModelForProvider,
  runDistillationCompletion: mocks.runDistillationCompletion,
  distillationToolEventsFromError: (error: unknown) =>
    error && typeof error === "object" && "distillationToolEvents" in error
      ? (error as { distillationToolEvents: unknown[] }).distillationToolEvents
      : [],
}));

vi.mock("../src/modules/distillation/distillation-tools.service.js", () => ({
  executeDistillationToolCall: mocks.executeDistillationToolCall,
}));

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "find-1",
    targetStateId: "target-1",
    targetKind: "wiki_file",
    targetKey: "rules/testing.md",
    sourceUri: "/wiki/pages/rules/testing.md",
    provider: "local-llm",
    model: "gemma",
    candidateIndex: 0,
    title: "Run smoke tests before finalizing coverEvidence",
    content:
      "Run smoke tests before finalizing coverEvidence so source references and evidence status stay verifiable.",
    origin: { readRanges: [{ from: 0, toExclusive: 120 }] },
    status: "selected",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function skillLikeProcedureBody(): string {
  return [
    "Use when: Use this when coverEvidence changes are ready to finalize and the result must remain traceable to source evidence.",
    "",
    "Workflow:",
    "1. Run the focused smoke or unit test for the changed coverEvidence path.",
    "2. Inspect the returned output and confirm source references are present.",
    "3. Finalize only after the evidence status is knowledge_ready.",
    "",
    "Verification: Confirm the command output shows the focused test passed and the saved result keeps source references.",
    "",
    "Avoid: Do not finalize when the source reference is missing or the test output was not inspected.",
  ].join("\n");
}

function completion(content: string, toolEvents: unknown[] = []) {
  return { content, toolEvents, messages: [] };
}

function defaultExternalFinalOutput() {
  return JSON.stringify({
    schemaVersion: 1,
    status: "knowledge_ready",
    stage: "source",
    candidate: {
      type: "procedure",
      title: "Run smoke tests before finalizing coverEvidence",
      body: skillLikeProcedureBody(),
      importance: 80,
      confidence: 85,
      technologies: "typescript, vitest",
      changeTypes: "test",
      domains: "distillation, testing",
    },
    references: [],
    duplicateRefs: [],
    toolEvents: [],
    reason: null,
  });
}

function mockExternalEvidenceRounds(finalOutput: string, extraOutputs: string[] = []) {
  mocks.runDistillationCompletion.mockReset();
  mocks.runDistillationCompletion
    .mockResolvedValueOnce(completion("| coverEvidence | testing |"))
    .mockResolvedValueOnce(completion("1"))
    .mockResolvedValueOnce(completion(finalOutput));
  for (const output of extraOutputs) {
    mocks.runDistillationCompletion.mockResolvedValueOnce(completion(output));
  }
}

function mockSourceValueAssessment(finalOutput: string, extraOutputs: string[] = []) {
  mocks.runDistillationCompletion.mockReset();
  mocks.runDistillationCompletion.mockResolvedValueOnce(completion(finalOutput));
  for (const output of extraOutputs) {
    mocks.runDistillationCompletion.mockResolvedValueOnce(completion(output));
  }
}

describe("coverEvidence parser", () => {
  test("parses a knowledge-ready result", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Keep evidence",
          body: "coverEvidence must keep source evidence before finalization.",
          importance: 72,
          confidence: 81,
          technologies: "typescript, vitest",
          changeTypes: "test",
          domains: "distillation, context-compiler",
        },
        references: [
          {
            kind: "source",
            uri: "file.md",
            note: "source range",
            evidenceRole: "supports_candidate",
          },
        ],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate?.confidence).toBe(81);
    expect(parsed.candidate).toMatchObject({
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "context-compiler"],
    });
    expect(parsed.references).toHaveLength(1);
  });

  test("does not require applicability fields", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Keep evidence",
          body: "coverEvidence must keep source evidence before finalization.",
          importance: 72,
          confidence: 81,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    expect(parsed.candidate).not.toHaveProperty("technologies");
    expect(parsed.candidate).not.toHaveProperty("changeTypes");
  });

  test("normalizes bracketed label applicability values", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS: knowledge_ready",
        "STAGE: web",
        "TYPE: rule",
        "TITLE: Use explicit auth errors",
        "BODY: Protected routes should raise AuthError when user context is missing.",
        "IMPORTANCE: 80",
        "CONFIDENCE: 90",
        "TECHNOLOGIES: [AuthError]",
        "CHANGE_TYPES: []",
        "DOMAINS: なし",
      ].join("\n"),
    );

    expect(parsed.candidate).toMatchObject({
      technologies: ["AuthError"],
    });
    expect(parsed.candidate).not.toHaveProperty("changeTypes");
    expect(parsed.candidate).not.toHaveProperty("domains");
  });

  test("parses uppercase-key JSON emitted despite label instructions", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        STATUS: "knowledge_ready",
        STAGE: "Finalization",
        TYPE: "Procedure",
        TITLE: "Reduce recursive helper argument count via context structs",
        BODY: [
          "Use when:",
          "- Recursive helpers accumulate many related parameters.",
          "",
          "Workflow:",
          "1. Group shared dependencies into a context struct.",
          "2. Pass the context through recursive calls.",
          "",
          "Verification:",
          "- Recursive behavior remains unchanged in tests.",
          "",
          "Avoid:",
          "- Suppressing argument-count warnings without cleanup.",
        ].join("\n"),
        IMPORTANCE: 92,
        CONFIDENCE: 93,
        TECHNOLOGIES: "Rust",
        CHANGE_TYPES: "refactor, quality",
        DOMAINS: "code-quality",
      }),
      {
        candidateDefaults: {
          type: "procedure",
        },
      },
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.stage).toBe("final");
    expect(parsed.candidate).toMatchObject({
      type: "procedure",
      title: "Reduce recursive helper argument count via context structs",
      technologies: ["Rust"],
      changeTypes: ["refactor", "quality"],
      domains: ["code-quality"],
    });
  });

  test("fills omitted candidate fields from caller defaults", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          title: "Preserve registration hints",
          body: "Registration hints should survive when the assessor only rewrites title and body.",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      {
        candidateDefaults: {
          type: "procedure",
          importance: 91,
          confidence: 77,
          technologies: ["typescript"],
          changeTypes: ["bugfix"],
          domains: ["candidate-registration"],
          repoPath: "/Users/y.noguchi/Code/memoryRouter",
          repoKey: "memoryRouter",
        },
      },
    );

    expect(parsed.candidate).toMatchObject({
      type: "procedure",
      importance: 91,
      confidence: 77,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["candidate-registration"],
      repoPath: "/Users/y.noguchi/Code/memoryRouter",
      repoKey: "memoryRouter",
    });
  });

  test("accepts flat output and normalizes non-integer score scales", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        status: "knowledge_ready",
        stage: "final",
        type: "rule",
        title: "Bad score",
        body: "Score should use integer percent values.",
        importance: 0.8,
        confidence: "79.6",
        references: [],
        duplicateRefs: [],
        toolEvents: [],
      }),
    );
    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate?.importance).toBe(80);
    expect(parsed.candidate?.confidence).toBe(80);
  });

  test("parses labeled plain-text fallback output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS: knowledge_ready",
        "STAGE: final",
        "TYPE: procedure",
        "TITLE: Verify before finalize",
        "BODY: 1. Run typecheck.",
        "2. Run focused tests.",
        "3. Confirm evidence payload.",
        "CONFIDENCE: 82.4",
        "IMPORTANCE: 0.79",
        "TECHNOLOGIES: typescript, vitest",
        "CHANGE_TYPES: test",
        "DOMAINS: distillation, context-compiler",
      ].join("\n"),
    );
    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate).toMatchObject({
      type: "procedure",
      title: "Verify before finalize",
      confidence: 82,
      importance: 79,
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "context-compiler"],
    });
    expect(parsed.candidate?.body).toContain("Run focused tests.");
  });

  test("repairs lowercase final metadata output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "Never run production DELETE or UPDATE without dry run",
        "Do not execute production `DELETE` or `UPDATE` statements without first running a dry run or preview query, confirming the affected row count, and obtaining explicit approval.",
        "",
        "rule",
        "title: Never run production DELETE or UPDATE without dry run",
        "body: Do not execute production `DELETE` or `UPDATE` statements without first running a dry run or preview query, confirming the affected row count, and obtaining explicit approval.",
        "importance: 99",
        "confidence: 95",
        "applicabilityGeneral: true",
        "technologies: sql, postgresql, database",
        "changeTypes: data-deletion, data-migration",
        "domains: database, production-safety",
      ].join("\n"),
      {
        candidateDefaults: {
          type: "rule",
        },
      },
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate).toMatchObject({
      type: "rule",
      title: "Never run production DELETE or UPDATE without dry run",
      importance: 99,
      confidence: 95,
      applicabilityGeneral: true,
      technologies: ["sql", "postgresql", "database"],
      changeTypes: ["data-deletion", "data-migration"],
      domains: ["database", "production-safety"],
    });
  });

  test("does not treat slash header labels as candidate body", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS / STAGE / TYPE / TITLE / BODY / IMPORTANCE / CONFIDENCE / TECHNOLOGIES / CHANGE_TYPES / DOMAINS / REASON",
        "",
        "knowledge_ready / web / rule / Keep parser labels out of body / The candidate body must remain the actual reusable rule text. / 82 / 91 / typescript / bugfix / cover-evidence / source_supported",
      ].join("\n"),
      {
        candidateDefaults: {
          type: "rule",
          title: "Keep parser labels out of body",
          body: "The candidate body must remain the actual reusable rule text.",
          importance: 80,
          confidence: 80,
        },
      },
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate).toMatchObject({
      title: "Keep parser labels out of body",
      body: "The candidate body must remain the actual reusable rule text.",
      importance: 82,
      confidence: 91,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["cover-evidence"],
    });
    expect(parsed.candidate?.body).not.toBe("IMPORTANCE");
  });

  test("parses simple title body and final slash metadata output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "Keep parser labels out of body",
        "The candidate body can contain spaces and / slash characters.",
        "It should stay body text until the final metadata line.",
        "TYPE / rule / STATUS / knowledge_ready / STAGE / web / IMPORTANCE / 82 / CONFIDENCE / 91 / TECHNOLOGIES / typescript / CHANGE_TYPES / bugfix / DOMAINS / cover-evidence / REASON / source_supported",
      ].join("\n"),
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.stage).toBe("web");
    expect(parsed.candidate).toMatchObject({
      title: "Keep parser labels out of body",
      body: [
        "The candidate body can contain spaces and / slash characters.",
        "It should stay body text until the final metadata line.",
      ].join("\n"),
      type: "rule",
      importance: 82,
      confidence: 91,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["cover-evidence"],
    });
  });

  test("repairs mixed slash metadata output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "Never run destructive git reset without explicit user request",
        "Do not run `git reset --hard`, `git checkout --`, or equivalent commands that discard worktree changes unless the user explicitly requested that destructive operation.",
        "rule / rule / SUCCESS / knowledge_ready / web / IMPORTANCE / 98 / CONFIDENCE / 95 / technologies / git / CHANGE_TYPES / destructive-change, cleanup / DOMAINS / workspace-safety, version-control / applicabilityGeneral / true",
      ].join("\n"),
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.stage).toBe("web");
    expect(parsed.candidate).toMatchObject({
      type: "rule",
      title: "Never run destructive git reset without explicit user request",
      body: "Do not run `git reset --hard`, `git checkout --`, or equivalent commands that discard worktree changes unless the user explicitly requested that destructive operation.",
      importance: 98,
      confidence: 95,
      applicabilityGeneral: true,
      technologies: ["git"],
      changeTypes: ["destructive-change", "cleanup"],
      domains: ["workspace-safety", "version-control"],
    });
  });

  test("recovers newline-separated label output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS",
        "knowledge_ready",
        "STAGE",
        "web",
        "TYPE",
        "rule",
        "TITLE",
        "Keep parser and prompt label formats aligned",
        "BODY",
        "When prompts ask for labels, parsers should accept the same label layout.",
        "IMPORTANCE",
        "70",
        "CONFIDENCE",
        "90",
        "TECHNOLOGIES",
        "typescript",
        "CHANGE_TYPES",
        "bugfix",
        "DOMAINS",
        "cover-evidence",
        "REASON",
        "source_supported",
      ].join("\n"),
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.stage).toBe("web");
    expect(parsed.reason).toBe("source_supported");
    expect(parsed.candidate).toMatchObject({
      type: "rule",
      title: "Keep parser and prompt label formats aligned",
      body: "When prompts ask for labels, parsers should accept the same label layout.",
      importance: 70,
      confidence: 90,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["cover-evidence"],
    });
  });

  test("uses caller defaults for status-only knowledge_ready recovery", () => {
    const parsed = parseCoverEvidenceResult("knowledge_ready", {
      candidateDefaults: {
        type: "rule",
        title: "Keep the source-supported candidate",
        body: "If final formatting collapses to status only, reuse the already source-supported candidate.",
        importance: 80,
        confidence: 75,
        technologies: ["typescript"],
        changeTypes: ["bugfix"],
        domains: ["cover-evidence"],
      },
    });

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.reason).toBeNull();
    expect(parsed.candidate).toMatchObject({
      title: "Keep the source-supported candidate",
      technologies: ["typescript"],
    });
  });

  test("keeps status-only knowledge_ready insufficient without caller defaults", () => {
    const parsed = parseCoverEvidenceResult("knowledge_ready");

    expect(parsed.status).toBe("insufficient");
    expect(parsed.candidate).toBeNull();
    expect(parsed.reason).toBe("candidate_missing");
  });

  test("does not fill explicit insufficient results from caller defaults", () => {
    const parsed = parseCoverEvidenceResult("insufficient", {
      candidateDefaults: {
        type: "rule",
        title: "Do not resurrect this candidate",
        body: "Explicit insufficient output should not become knowledge_ready through defaults.",
      },
    });

    expect(parsed.status).toBe("insufficient");
    expect(parsed.candidate).toBeNull();
    expect(parsed.reason).toBe("insufficient");
  });

  test("drops candidate fields from explicit insufficient results", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS",
        "insufficient",
        "STAGE",
        "web",
        "TITLE",
        "Do not store partial candidates",
        "BODY",
        "Partial candidates should not survive an explicit insufficient status.",
        "REASON",
        "unsupported_by_source",
      ].join("\n"),
    );

    expect(parsed.status).toBe("insufficient");
    expect(parsed.candidate).toBeNull();
    expect(parsed.reason).toBe("unsupported_by_source");
  });

  test("does not recover status-only duplicate as a candidate", () => {
    const parsed = parseCoverEvidenceResult("duplicate", {
      candidateDefaults: {
        type: "rule",
        title: "Existing rule",
        body: "This default candidate should not be stored for duplicate status.",
      },
    });

    expect(parsed.status).toBe("duplicate");
    expect(parsed.candidate).toBeNull();
  });

  test("parses slash-delimited status fallbacks as non-parse failures", () => {
    const parsed = parseCoverEvidenceResult(
      "STATUS/insufficient/N/A/N/A/N/A/N/A/Evidence URI could not be parsed as a valid URL.",
    );

    expect(parsed.status).toBe("insufficient");
    expect(parsed.reason).toBe("Evidence URI could not be parsed as a valid URL.");
  });
});

describe("coverEvidence search query", () => {
  test("keeps search terms short and drops prompt heading filler", () => {
    const query = buildCoverEvidenceSearchQuery(
      "仕様変更時は段階的テスト実行で検証する Use when Workflow Verification Avoid",
    );

    expect(query.searchTerms.length).toBeLessThanOrEqual(3);
    expect(query.searchTerms).not.toContain("use");
    expect(query.searchTerms).not.toContain("when");
    expect(query.query).toBe("仕様変更時 段階的テスト実行 検証");
  });
});

describe("coverEvidence prompts", () => {
  test("asks applicability facets to prefer ASCII tags", () => {
    expect(
      renderSystemContext("coverEvidence.externalFinal", {
        webEvidenceTokenBudget: 15_000,
      }).content.text,
    ).toContain("lowercase kebab-case の ASCII tag");
    expect(renderSystemContext("coverEvidence.applicabilityRefinement", {}).content.text).toContain(
      "lowercase kebab-case の ASCII tag",
    );
  });

  test("nudges reusable knowledge title and body toward Japanese in Japanese contexts", () => {
    expect(
      renderSystemContext("coverEvidence.externalFinal", {
        webEvidenceTokenBudget: 15_000,
      }).content.text,
    ).toContain("knowledge_ready の title と body の自然文を必ず日本語");
    expect(
      renderSystemContext("coverEvidence.valueAssessment", {
        lowImportanceRejectThreshold: 30,
      }).content.text,
    ).toContain("入力や source evidence が英語の場合も");
    expect(renderSystemContext("coverEvidence.applicabilityRefinement", {}).content.text).toContain(
      "説明文は日本語へ言い換えてください",
    );
  });

  test("instructs simple title body and final metadata output", () => {
    const prompt = renderSystemContext("coverEvidence.externalFinal", {
      webEvidenceTokenBudget: 15_000,
    }).content.text;

    expect(prompt).toContain("1行目: タイトル");
    expect(prompt).toContain("2行目から最終行の前まで: 本文");
    expect(prompt).toContain("最終行: TYPE / rule|procedure");
    expect(prompt).toContain("/ 区切りとして読むのは最終行だけ");
    expect(prompt).not.toContain("TITLE\n<タイトル>");
    expect(prompt).not.toContain("BODY\n<本文");
  });

  test("asks external evidence final pass to enrich supported candidates", () => {
    const prompt = renderSystemContext("coverEvidence.externalFinal", {
      webEvidenceTokenBudget: 15_000,
    }).content.text;

    expect(prompt).toContain("候補の title/body を肉付け・補完・清書");
    expect(prompt).toContain("再利用可能な knowledge_ready 候補へ補正");
    expect(prompt).toContain("insufficient にせず知識として再構成");
    expect(prompt).toContain("推測で足してはいけません");
  });

  test("lets source-only value assessment accept faithful agent-log generalizations", () => {
    const prompt = renderSystemContext("coverEvidence.valueAssessment", {
      lowImportanceRejectThreshold: 30,
    }).content.text;

    expect(prompt).toContain("agent log や vibe memory の断片");
    expect(prompt).toContain("忠実に一般化");
    expect(prompt).toContain("逐語一致しないだけで unsupported_by_source にしない");
    expect(prompt).toContain("中核主張が source evidence に存在しない");
  });

  test("allows conservative applicability tags from candidate and source context", () => {
    const valuePrompt = renderSystemContext("coverEvidence.valueAssessment", {
      lowImportanceRejectThreshold: 30,
    }).content.text;
    const refinementPrompt = renderSystemContext("coverEvidence.applicabilityRefinement", {})
      .content.text;

    expect(valuePrompt).toContain("source evidence と candidate から保守的に推定");
    expect(refinementPrompt).toContain("保守的に推定できるカテゴリ");
    expect(refinementPrompt).toContain("狭く正確な tag");
  });
});

describe("runCoverEvidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getFindCandidateResultById.mockResolvedValue(candidateRow());
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Run smoke tests before finalizing coverEvidence so source references and evidence status stay verifiable.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.searchKnowledge.mockResolvedValue([]);
    mocks.findSimilarKnowledge.mockResolvedValue([]);
    mocks.selectCoverEvidenceResultById.mockResolvedValue(null);
    mocks.saveCoverEvidenceResult.mockImplementation(async ({ result }) => ({
      id: "cover-1",
      ...result,
    }));
    mockSourceValueAssessment(defaultExternalFinalOutput());
    mocks.executeDistillationToolCall.mockImplementation(async (toolCall) => {
      if (toolCall.function.name === "search_web") {
        return {
          callId: toolCall.id,
          name: "search_web",
          ok: true,
          content: JSON.stringify({
            query: "coverEvidence testing",
            results: [
              {
                title: "Example docs",
                url: "https://example.com/docs",
                snippet: "Fetched docs for coverEvidence testing.",
              },
            ],
          }),
          metadata: { query: "coverEvidence testing", resultCount: 1, provider: "test" },
        };
      }
      return {
        callId: toolCall.id,
        name: "fetch_content",
        ok: true,
        content: JSON.stringify({
          selected: [
            {
              index: 1,
              url: "https://example.com/docs",
              ok: true,
              content: "Fetched docs",
            },
          ],
        }),
        metadata: {
          selection: "1",
          selectedUrls: ["https://example.com/docs"],
          selectedCount: 1,
        },
      };
    });
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "";
    process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
  });

  test("returns source-backed knowledge_ready without creating a draft", async () => {
    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate).toMatchObject({
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "testing"],
    });
    expect(result.result.references[0]).toMatchObject({
      kind: "source",
      evidenceRole: "supports_candidate",
    });
    expect(mocks.saveCoverEvidenceResult).not.toHaveBeenCalled();
  });

  test("keeps route fallback when provider override is supplied", async () => {
    await runCoverEvidence({ id: "find-1", provider: "local-llm" });

    const runtimeOptions = mocks.runDistillationCompletion.mock.calls.map(
      (call) => call[1] as { providerSetting: string; fallbackOrder?: string[] },
    );

    expect(runtimeOptions.length).toBeGreaterThan(0);
    expect(runtimeOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerSetting: "local-llm",
          fallbackOrder: ["azure-openai"],
        }),
      ]),
    );
  });

  test("uses resolved route model for all covering LLM calls", async () => {
    mocks.resolveRouteModelForProvider.mockReturnValue("qwen-route-target");

    await runCoverEvidence({ id: "find-1" });

    expect(mocks.runDistillationCompletion).toHaveBeenCalled();
    expect(
      mocks.runDistillationCompletion.mock.calls.every(
        (call) => call[0]?.model === "qwen-route-target",
      ),
    ).toBe(true);
  });

  test("disables fallback only when single-provider mode is requested", async () => {
    await runCoverEvidence({
      id: "find-1",
      provider: "local-llm",
      providerFallbackMode: "single",
    });

    const runtimeOptions = mocks.runDistillationCompletion.mock.calls.map(
      (call) => call[1] as { providerSetting: string; fallbackOrder?: string[] },
    );

    expect(runtimeOptions.length).toBeGreaterThan(0);
    expect(
      runtimeOptions.every(
        (options) =>
          options.providerSetting === "local-llm" &&
          Array.isArray(options.fallbackOrder) &&
          options.fallbackOrder.length === 0,
      ),
    ).toBe(true);
  });

  test("records provider route diagnostics in coverEvidence started audit", async () => {
    await runCoverEvidence({ id: "find-1", provider: "local-llm" });

    const startedAudit = mocks.recordAuditLogSafe.mock.calls.find(
      (call) => call[0]?.eventType === "COVER_EVIDENCE_STARTED",
    );
    expect(startedAudit).toBeDefined();
    expect(startedAudit?.[0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          id: "find-1",
          providerOverride: "local-llm",
          providerFallbackMode: "fallback",
          providerRoutes: expect.objectContaining({
            sourceSupport: expect.objectContaining({
              provider: "local-llm",
              fallbackOrder: ["azure-openai"],
            }),
            externalEvidence: expect.objectContaining({
              provider: "local-llm",
              fallbackOrder: ["azure-openai"],
            }),
            mcpEvidence: expect.objectContaining({
              provider: "local-llm",
              fallbackOrder: ["azure-openai"],
            }),
          }),
        }),
      }),
    );
  });

  test("uses LLM verification instead of terminal source_support failure when source content is available", async () => {
    mocks.readFileDomain.mockResolvedValue({
      content:
        "This unrelated paragraph describes release notes and dashboard copy but still gives the assessor source text to verify against.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(1);
    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "source_support",
          ok: false,
          metadata: expect.objectContaining({
            reason: "unsupported_by_source",
            mode: "llm_verification",
          }),
        }),
      ]),
    );
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[0]?.content).toContain("knowledge value 判定器");
    expect(request.messages[1]?.content).toContain("source evidence excerpt:");
  });

  test("uses primary source evidence even when legacy sourceSummary exists", async () => {
    const sourceSummary =
      "Run smoke tests before finalizing coverEvidence; verify source references and evidence status.";
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        origin: {
          readRanges: [{ from: 0, toExclusive: 120 }],
          sourceSummary,
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content: `${sourceSummary} ${"raw-source-filler ".repeat(400)}`,
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });

    await runCoverEvidence({ id: "find-1" });

    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[1]?.content).toContain("source evidence excerpt:");
    expect(request.messages[1]?.content).not.toContain("source summary:");
    expect(request.messages[1]?.content).toContain(sourceSummary);
    expect(request.messages[1]?.content).toContain("raw-source-filler");
  });

  test("keeps empty source reads as terminal source_support failures", async () => {
    mocks.readFileDomain.mockResolvedValue({
      content: "",
      totalTokens: 0,
      from: 0,
      toExclusive: 0,
      returnedTokens: 0,
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.stage).toBe("source_support");
    expect(result.result.reason).toBe("unsupported_by_source");
    expect(mocks.runDistillationCompletion).not.toHaveBeenCalled();
  });

  test("does not use legacy sourceSummary fallback when the original vibe memory source is unavailable", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        targetKind: "vibe_memory",
        targetKey: "missing-memory",
        sourceUri: "vibe_memory:missing-memory",
        origin: {
          sourceSummary:
            "Run smoke tests before finalizing coverEvidence and verify source references are preserved.",
          readRanges: [{ from: 0, toExclusive: 80 }],
        },
      }),
    );
    mocks.readVibeMemoryByTokenWindow.mockRejectedValue(new Error("vibe memory not found"));

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("tool_failed");
    expect(result.result.stage).toBe("source_support");
    expect(result.result.reason).toBe("source_read_failed");
    expect(mocks.readVibeMemoryByTokenWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        vibeMemoryId: "missing-memory",
      }),
    );
    expect(mocks.runDistillationCompletion).not.toHaveBeenCalled();
  });

  test("does not use candidate content as source evidence when vibe memory is unavailable", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        targetKind: "vibe_memory",
        targetKey: "missing-memory",
        sourceUri: "vibe_memory:missing-memory",
        content:
          "Run smoke tests before finalizing coverEvidence so source references and evidence status stay verifiable.",
        origin: {
          readRanges: [{ from: 0, toExclusive: 80 }],
        },
      }),
    );
    mocks.readVibeMemoryByTokenWindow.mockRejectedValue(new Error("vibe memory not found"));

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("tool_failed");
    expect(result.result.stage).toBe("source_support");
    expect(result.result.reason).toBe("source_read_failed");
    expect(mocks.readVibeMemoryByTokenWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        vibeMemoryId: "missing-memory",
      }),
    );
    expect(mocks.runDistillationCompletion).not.toHaveBeenCalled();
  });

  test("preserves register_candidate origin hints through value assessment", async () => {
    const body = skillLikeProcedureBody();
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        targetKind: "knowledge_candidate",
        targetKey: "candidate-1",
        sourceUri: "agent://candidate/candidate-1",
        title: "Preserve register_candidate metadata",
        content: body,
        origin: {
          candidateType: "procedure",
          importance: 91,
          confidence: 77,
          technologies: ["typescript"],
          changeTypes: ["bugfix"],
          domains: ["candidate-registration"],
          repoPath: "/Users/y.noguchi/Code/memoryRouter",
          repoKey: "memoryRouter",
        },
      }),
    );
    mockSourceValueAssessment(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          title: "Preserve register_candidate metadata",
          body,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.candidate).toMatchObject({
      type: "procedure",
      importance: 91,
      confidence: 77,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["candidate-registration"],
      repoPath: "/Users/y.noguchi/Code/memoryRouter",
      repoKey: "memoryRouter",
    });
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(mocks.runDistillationCompletion.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        usageSource: "cover-evidence:value-assessment",
      }),
    );
    expect(request.messages[1]?.content).toContain('"technologies":["typescript"]');
    expect(request.messages[1]?.content).toContain('"candidate-registration"');
    expect(request.messages[1]?.content).toContain('"/Users/y.noguchi/Code/memoryRouter"');
  });

  test("reclassifies command workflows as procedures when assessment returns rule", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Run focused verify before finalizing",
        content:
          "Run `bun run typecheck`, then run `bun run test:unit`, and verify the returned evidence before finalizing.",
        origin: {
          readRanges: [{ from: 0, toExclusive: 120 }],
          candidateType: "procedure",
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Run `bun run typecheck`, then run `bun run test:unit`, and verify the returned evidence before finalizing.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mockSourceValueAssessment(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Run focused verify before finalizing",
          body: [
            "Use when: Use this when a code change is ready for final verification.",
            "",
            "Workflow:",
            "1. Run `bun run typecheck`.",
            "2. Run `bun run test:unit`.",
            "3. Inspect the returned evidence before finalizing.",
            "",
            "Verification: Confirm both commands pass and the output no longer contains the original failure.",
            "",
            "Avoid: Do not finalize from memory or from a stale terminal output.",
          ].join("\n"),
          importance: 82,
          confidence: 86,
          technologies: "typescript, bun",
          changeTypes: "verification",
          domains: "distillation",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate?.body).toContain("Workflow:");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          candidate: expect.objectContaining({ type: "procedure" }),
        }),
      }),
    );
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[0]?.content).toContain("source evidence に支えられるか");
    expect(request.messages[0]?.content).toContain("日本語で運用されている文脈");
    expect(request.messages[0]?.content).toContain("Use when:");
    expect(request.messages[0]?.content).toContain("Workflow:");
    expect(request.messages[0]?.content).toContain("domains");
  });

  test("rejects procedure candidates that are not written as reusable steps", async () => {
    mockSourceValueAssessment(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Document rollout procedure",
          body: "1. Gather notes.\n2. Compare screenshots.",
          importance: 80,
          confidence: 85,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("procedure_repair_failed");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          status: "insufficient",
          reason: "procedure_repair_failed",
          candidate: null,
        }),
      }),
    );
  });

  test("demotes repair-failed procedures when the original body is a valid rule", async () => {
    mockSourceValueAssessment(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Preserve source references during finalization",
          body: "First, coverEvidence must preserve source references, then verify the saved result before finalization.",
          importance: 86,
          confidence: 84,
          technologies: "typescript",
          changeTypes: "verification",
          domains: "distillation",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("rule");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "procedure_repair",
          ok: false,
        }),
        expect.objectContaining({
          name: "procedure_demoted_to_rule",
          ok: true,
        }),
      ]),
    );
  });
});
