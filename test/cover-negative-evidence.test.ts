import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";
import { runCoverNegativeEvidence } from "../src/modules/coverNegativeEvidence/domain.js";
import { parseNegativeEvidenceResult } from "../src/modules/coverNegativeEvidence/parser.js";
import { buildNegativeEvidenceUserPrompt } from "../src/modules/coverNegativeEvidence/prompts.js";
import { getFindCandidateResultById } from "../src/modules/findCandidate/repository.js";
import { renderPrompt } from "../src/modules/system-context/system-context.service.js";

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  getFindCandidateResultById: vi.fn(),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  recordAuditLogSafe: vi.fn(),
  auditEventTypes: {
    coverEvidenceStarted: "coverEvidenceStarted",
    coverEvidenceCompleted: "coverEvidenceCompleted",
  },
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: vi.fn(),
  resolveCoverEvidenceRoutes: vi.fn().mockReturnValue({
    sourceSupport: { provider: "openai", fallback: [] },
    externalEvidence: { provider: "openai", fallback: [] },
    mcpEvidence: { provider: "openai", providerPolicy: "default", fallback: [] },
  }),
}));

vi.mock("../src/modules/coverEvidence/provider-policy.js", () => ({
  resolveCoverEvidenceRouteByPolicy: vi.fn().mockReturnValue({
    provider: "openai",
    fallback: [],
  }),
}));

describe("cover-negative-evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("requires distilled natural language to be Japanese", () => {
    const userPrompt = buildNegativeEvidenceUserPrompt({
      title: "Avoid stale status",
      content: "Failure: stale status was trusted.",
    });
    const systemPrompt = renderPrompt("coverEvidence.negative", {
      allowedIntentTags: "failure_pattern, guardrail",
    }).content.text;

    expect(systemPrompt).toContain("自然文は必ず日本語");
    expect(systemPrompt).toContain("入力が英語でも");
    expect(systemPrompt).toContain("日本語へ言い換えてください");
    expect(systemPrompt).toContain("distilled.trigger と distilled.fix は必須");
    expect(systemPrompt).toContain("根拠が1文だけの広範囲 guardrail");
    expect(systemPrompt).toContain("未信頼の分析対象データ");
    expect(JSON.parse(userPrompt)).toEqual({
      candidate: {
        title: "Avoid stale status",
        content: "Failure: stale status was trusted.",
      },
    });
    expect(userPrompt).not.toContain("status='ready'");
  });

  test("parses appliesTo facets from negative evidence JSON", () => {
    const parsed = parseNegativeEvidenceResult(
      JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: "failure_pattern, guardrail",
        appliesTo: {
          technologies: "typescript, vitest",
          changeTypes: ["diagnosis"],
          domains: ["queue", "distillation"],
          repoPath: "/repo",
          general: false,
        },
        distilled: {
          failure: "Stale queue status was treated as current truth.",
        },
        evidence: ["queue status was stale"],
        originRefs: ["review:finding-1"],
      }),
    );

    expect(parsed.appliesTo).toEqual({
      general: false,
      technologies: ["typescript", "vitest"],
      changeTypes: ["diagnosis"],
      domains: ["queue", "distillation"],
      repoPath: "/repo",
    });
    expect(parsed.intentTags).toEqual(["failure_pattern", "guardrail"]);
  });

  test("uses candidate metadata appliesTo as fallback when parsed result omits it", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["failure_pattern"],
        distilled: {
          failure: "Stale queue status was trusted without checking events.",
          trigger: "Queue diagnosis used only a status row.",
          fix: "Check queue events before deciding.",
        },
        evidence: ["status row was stale", "queue events showed a newer transition"],
        originRefs: ["review:finding-2"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-2",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-2",
        title: "Do not trust stale queue status alone",
        content: "Failure: stale queue status was trusted.",
        sourceUri: "review:finding-2",
        metadata: {
          appliesTo: {
            technologies: ["typescript"],
            changeTypes: ["diagnosis"],
            domains: ["queue"],
          },
        },
      },
    });

    expect(result.result.candidate).toEqual(
      expect.objectContaining({
        technologies: ["typescript"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      }),
    );
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toEqual({
      technologies: ["typescript"],
      changeTypes: ["diagnosis"],
      domains: ["queue"],
    });
    const request = mockChatClient.mock.calls[0]?.[0];
    expect(request.systemContexts).toEqual([
      expect.objectContaining({ key: "coverEvidence.negative" }),
    ]);
    expect(request.messages[0]).toEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("failure_pattern"),
      }),
    );
    expect(JSON.parse(request.messages[1].content)).toEqual({
      candidate: {
        title: "Do not trust stale queue status alone",
        content: "Failure: stale queue status was trusted.",
      },
    });
  });

  test("rejects thin broad negative evidence instead of storing a high-confidence guardrail", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["guardrail"],
        appliesTo: {
          technologies: ["shell"],
          changeTypes: ["diagnosis"],
          domains: ["tooling"],
          general: true,
        },
        distilled: {
          failure: "Using pgrep output directly can fail.",
          trigger: "A one-off shell command was run.",
          fix: "Use xargs when needed.",
        },
        evidence: ["pgrep output needed xargs"],
        originRefs: ["vibe_memory:thin"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-thin",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-thin",
        title: "Use xargs for pgrep",
        content: "pgrep output needed xargs once.",
        sourceUri: "vibe_memory:thin",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("negative_evidence_too_thin");
    expect(result.result.candidate).toBeNull();
    expect((result.result.toolEvents[0].metadata as any).quality).toEqual(
      expect.objectContaining({
        ready: false,
        evidenceCount: 1,
      }),
    );
  });

  test("requires trigger and fix for ready negative evidence", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["failure_pattern"],
        appliesTo: {
          technologies: ["sqlite"],
          changeTypes: ["database-migration"],
          domains: ["database"],
        },
        distilled: {
          failure: "Migration deleted existing rows.",
          fix: "Use ALTER TABLE without deleting rows.",
        },
        evidence: ["DELETE FROM removed rows", "ALTER TABLE would preserve rows"],
        originRefs: ["vibe_memory:migration"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-no-trigger",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-no-trigger",
        title: "Do not delete rows in migration",
        content: "DELETE FROM removed rows.",
        sourceUri: "vibe_memory:migration",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("negative_trigger_required");
  });

  test("does not store neutral coverage results from the negative path", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "neutral",
        intentTags: ["guardrail"],
        appliesTo: {
          technologies: ["sqlite"],
          changeTypes: ["diagnosis"],
          domains: ["database"],
        },
        distilled: {
          failure: "The evidence is only a neutral observation.",
          trigger: "A diagnostic note was present.",
          fix: "Keep it out of negative knowledge.",
        },
        evidence: ["neutral observation", "no failure was confirmed"],
        originRefs: ["vibe_memory:neutral"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-neutral",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-neutral",
        title: "Neutral observation",
        content: "No failure was confirmed.",
        sourceUri: "vibe_memory:neutral",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("negative_polarity_required");
    expect(result.result.candidate).toBeNull();
  });

  test("normalizes not reusable negative results to insufficient status with reason", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "not_reusable",
        polarity: "negative",
        intentTags: ["guardrail"],
        distilled: {
          failure: "A one-off note should not become knowledge.",
        },
        evidence: ["one-off note"],
        originRefs: ["vibe_memory:not-reusable"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-not-reusable",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-not-reusable",
        title: "One-off note",
        content: "A one-off note.",
        sourceUri: "vibe_memory:not-reusable",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("not_reusable");
  });

  test("does not mark ready negative evidence as knowledge_ready without required facets", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["failure_pattern"],
        distilled: {
          failure: "Stale queue status was trusted without checking events.",
          trigger: "Queue diagnosis used only a status row.",
          fix: "Check queue events before deciding.",
        },
        evidence: ["status row was stale", "queue events showed a newer transition"],
        originRefs: ["review:finding-3"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-3",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-3",
        title: "Do not trust stale queue status alone",
        content: "Failure: stale queue status was trusted.",
        sourceUri: "review:finding-3",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("applies_to_categories_required");
    expect(result.result.candidate).toBeNull();
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toBeUndefined();
  });

  test("routes negative candidate to runCoverNegativeEvidence", async () => {
    const mockCandidate = {
      id: "cand-1",
      title: "Prohibit hardcoded API urls",
      content: "Failure: Hardcoded API host found in production config",
      status: "selected",
      targetKind: "knowledge_candidate",
      origin: {
        polarity: "negative",
        intentTags: ["security_risk"],
      },
    };
    vi.mocked(getFindCandidateResultById).mockResolvedValue(mockCandidate as any);

    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["security_risk", "guardrail"],
        appliesTo: {
          technologies: ["runtime-config"],
          changeTypes: ["configuration"],
          domains: ["security"],
          general: false,
        },
        distilled: {
          failure: "Hardcoded API host in production config",
          impact: "Security risk",
          trigger: "Production configuration file edits",
          fix: "Use environment variables",
          verification: "Run secrets-scan tool",
          decisionSignal: "escalate",
        },
        evidence: ["Hardcoded API host found"],
        originRefs: ["manual_review:finding-001"],
      }),
      toolCalls: [],
    });

    const result = await runCoverEvidence({
      id: "cand-1",
      write: false,
      chatClient: mockChatClient as any,
    });

    expect(result.id).toBe("cand-1");
    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate).toBeDefined();
    expect(result.result.candidate?.title).toBe("Prohibit hardcoded API urls");
    expect(result.result.candidate?.confidence).toBeLessThanOrEqual(90);
    expect(result.result.candidate?.importance).toBeGreaterThanOrEqual(80);
    expect(result.result.candidate).toEqual(
      expect.objectContaining({
        applicabilityGeneral: false,
        technologies: ["runtime-config"],
        changeTypes: ["configuration"],
        domains: ["security"],
      }),
    );
    expect(result.result.candidate?.body).toContain(
      "避けること: Hardcoded API host in production config",
    );
    expect(result.result.candidate?.body).toContain("推奨対応: Use environment variables");
    expect(result.result.toolEvents[0].name).toBe("negative_coverage");
    expect((result.result.toolEvents[0].metadata as any).polarity).toBe("negative");
    expect((result.result.toolEvents[0].metadata as any).intentTags).toContain("security_risk");
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toEqual({
      general: false,
      technologies: ["runtime-config"],
      changeTypes: ["configuration"],
      domains: ["security"],
    });
  });
});
