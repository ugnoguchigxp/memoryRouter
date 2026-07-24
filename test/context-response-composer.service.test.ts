import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { composeContextResponse } from "../src/modules/context-compiler/context-response-composer.service.js";
import { getAgenticLlmProviders } from "../src/modules/llm/agentic-llm.service.js";

vi.mock("../src/modules/llm/agentic-llm.service.js");

describe("context response composer", () => {
  const originalEnabled = groupedConfig.agenticCompile.enabled;
  const originalProviderSetting = groupedConfig.agenticCompile.provider;

  const mockProvider = {
    name: "mock-llm",
    isConfigured: vi.fn().mockReturnValue(true),
    chat: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.agenticCompile.provider = "mock-llm" as any;
    vi.mocked(getAgenticLlmProviders).mockReturnValue([mockProvider] as any);
  });

  afterAll(() => {
    groupedConfig.agenticCompile.enabled = originalEnabled;
    groupedConfig.agenticCompile.provider = originalProviderSetting;
  });

  test("returns No Content when no selected knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "HonoでAPIルートを追加する",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [],
    });

    expect(result.markdown).toBe("No Content");
    expect(result.agenticUsed).toBe(false);
    expect(result.usedKnowledge).toEqual([]);
    expect(result.noContentReason).toBe("fallback_no_candidates");
  });

  test("builds natural-language implementation context when knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "Hono APIでcompile runs一覧にstatusフィルタを追加し、React一覧へ連動させる",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "HonoではzValidatorを使う",
          content: "HonoではzValidatorでqueryを検証する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "一覧フィルタ追加手順",
          content:
            "Workflow:\n1. API query schemaにstatusを追加する。\n2. 一覧UIでstatus選択を反映する。\nVerification:\n- status変更で一覧結果が一致する。\nAvoid:\n- バリデーションなしでqueryを受け取らない。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).toContain("## 実装手順");
    expect(result.markdown).toContain("## 検証観点");
    expect(result.markdown).not.toContain("## Rules");
    expect(result.markdown).not.toContain("## Procedures");
    expect(result.usedKnowledge.length).toBeGreaterThan(0);
    expect(result.usedKnowledge[0]?.id).toBe("r1");
  });

  test("keeps EpisodeCard precedents separate in fallback compose", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "SQLite migration の復旧方針を確認する",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [
        {
          id: "episode_card:episode-1",
          itemKind: "episode_card",
          itemId: "episode-1",
          section: "procedures",
          title: "Past episode: SQLite migration recovery",
          content:
            "Use when: A similar past task may inform the current compile context.\nWorkflow:\n1. Reuse the old command.",
          score: 0.7,
          rankingReason: "supplemental EpisodeCard precedent",
          sourceRefs: ["context-still://episodes/episode-1"],
        },
      ],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.usedKnowledge).toEqual([]);
    expect(result.markdown).toContain("過去事例として Past episode: SQLite migration recovery");
    expect(result.markdown).toContain("現在のコードで適用可否を確認する");
    expect(result.markdown).toContain(
      "EpisodeCard precedent を現在の source truth や Knowledge rule として扱わない。",
    );
    expect(result.markdown).not.toContain("1. Past episode: SQLite migration recovery");
    expect(result.markdown).not.toContain("Reuse the old command");
  });

  test("does not switch to test headings just because goal contains specificity", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "compile_evalとWebUIの評価指標（relevance, actionability, coverage, clarity, specificity, avg）の実装計画を作る",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "実装計画はスコープを明確化する",
          content: "実装計画には対象と非対象を明記する。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).not.toContain("## テスト方針");
  });

  test("uses SKILL-style output when planner requests skill with enough candidates", async () => {
    groupedConfig.agenticCompile.enabled = true;
    mockProvider.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          headings: {
            focus: "実装フォーカス",
            steps: "実装手順",
            verification: "検証観点",
            avoid: "注意点",
          },
          includeAvoidSection: true,
          ruleQueryHints: ["設計", "手順"],
          procedureQueryHints: ["Workflow"],
          exclusionHints: [],
          responseStyle: "skill",
          styleReason: "goal requests reusable procedure",
          styleConfidence: 0.91,
          candidateSufficiency: "enough",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          markdown:
            "## Use when\n- 手順化が必要なとき。\n\n## Workflow\n1. 要件を整理する。\n2. 実装順序を固定する。\n\n## Verification\n- 手順が再利用可能であること。\n\n## Avoid\n- 目的外の一般論を混ぜない。",
          usedKnowledge: [{ id: "p1", confidence: 0.87 }],
        }),
      });

    const result = await composeContextResponse({
      input: {
        goal: "再利用可能な手順書として実装ガイドを作る",
      },
      retrievalMode: "procedure_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "目的を明確化する",
          content: "手順は目的に紐づける。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "手順整備",
          content: "Workflow:\n1. 手順を定義する。\nVerification:\n- 再利用できる。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toContain("## Use when");
    expect(result.markdown).toContain("## Workflow");
    expect(result.markdown).toContain("## Verification");
    expect(result.markdown).toContain("## Avoid");
  });

  test("downgrades skill to narrative when planner reports limited candidates", async () => {
    groupedConfig.agenticCompile.enabled = true;
    mockProvider.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          headings: {
            focus: "実装フォーカス",
            steps: "実装手順",
            verification: "検証観点",
            avoid: "注意点",
          },
          includeAvoidSection: false,
          ruleQueryHints: [],
          procedureQueryHints: [],
          exclusionHints: [],
          responseStyle: "skill",
          styleReason: "goal asks procedure",
          styleConfidence: 0.95,
          candidateSufficiency: "limited",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          markdown: "## 実装フォーカス\n- 候補不足のため narrative で返す。",
          usedKnowledge: [{ id: "r1", confidence: 0.7 }],
        }),
      });

    const result = await composeContextResponse({
      input: {
        goal: "手順を整理する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "範囲を先に決める",
          content: "実装範囲を先に決める。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toContain("## 実装フォーカス");
    const composeRequest = mockProvider.chat.mock.calls[1]?.[0];
    const composeSystemPrompt = composeRequest?.messages?.[0]?.content ?? "";
    expect(composeSystemPrompt).not.toContain("## Use when");
  });

  test("falls back to narrative when skill output misses required sections", async () => {
    groupedConfig.agenticCompile.enabled = true;
    mockProvider.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          headings: {
            focus: "実装フォーカス",
            steps: "実装手順",
            verification: "検証観点",
            avoid: "注意点",
          },
          includeAvoidSection: true,
          ruleQueryHints: [],
          procedureQueryHints: ["Workflow"],
          exclusionHints: [],
          responseStyle: "skill",
          styleReason: "procedure-ready",
          styleConfidence: 0.9,
          candidateSufficiency: "enough",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          markdown: "## Use when\n- 手順が必要。\n\n## Workflow\n1. 実行する。",
          usedKnowledge: [{ id: "p1", confidence: 0.8 }],
        }),
      });

    const result = await composeContextResponse({
      input: {
        goal: "運用手順を作る",
      },
      retrievalMode: "procedure_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "手順は検証可能にする",
          content: "Verification を必ず定義する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "運用手順",
          content: "Workflow:\n1. 前提確認\nVerification:\n- 完了条件確認",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.error).toContain("COMPOSER_SKILL_SECTION_MISSING");
    expect(result.markdown).toContain("## 実装フォーカス");
  });

  test("uses agentic LLM composer successfully when enabled and output is valid JSON", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Successful JSON composition response aligned with goal (contains "Hono" / "API")
    const mockJson = {
      markdown: "## 実装フォーカス\n- Hono APIにフィルタを追加します。",
      usedKnowledge: [
        {
          id: "r1",
          confidence: 0.95,
          evidence: "Hono requirement matches",
          outputSection: "focus",
          reason: "crucial rule",
        },
      ],
    };
    mockProvider.chat.mockResolvedValue({
      content: JSON.stringify(mockJson),
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIにフィルタを追加する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "HonoではzValidatorを使う",
          content: "HonoではzValidatorでqueryを検証する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIにフィルタを追加します。");
    expect(result.usedKnowledge).toHaveLength(1);
    expect(result.usedKnowledge[0]).toEqual(
      expect.objectContaining({
        id: "r1",
        confidence: 0.95,
        evidence: "Hono requirement matches",
      }),
    );
    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: "json",
        maxTokens: expect.any(Number),
      }),
    );
    expect(mockProvider.chat).toHaveBeenCalledTimes(2);
    const chatRequest = mockProvider.chat.mock.calls[1]?.[0];
    const plannerRequest = mockProvider.chat.mock.calls[0]?.[0];
    const systemPrompt = chatRequest?.messages?.[0]?.content ?? "";
    const markdownTargetTokens = Number(systemPrompt.match(/本文は (\d+) トークン/u)?.[1]);
    expect(systemPrompt).toContain("JSON は必ず完結");
    expect(systemPrompt).toContain('<S11TNEXT_DELIMITED_CONTEXT variable="headingRule">');
    expect(markdownTargetTokens).toBeGreaterThan(0);
    expect(chatRequest?.maxTokens).toBeGreaterThan(markdownTargetTokens);
    expect(plannerRequest?.systemContexts?.[0]?.key).toBe("contextCompiler.plan");
    expect(chatRequest?.systemContexts?.[0]?.key).toBe("contextCompiler.compose");
  });

  test("treats negative guardrails as negative evidence in composer SystemContext", async () => {
    groupedConfig.agenticCompile.enabled = true;
    mockProvider.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          headings: {
            focus: "判断フォーカス",
            steps: "判断手順",
            verification: "確認観点",
            avoid: "避ける条件",
          },
          includeAvoidSection: true,
          ruleQueryHints: [],
          procedureQueryHints: [],
          exclusionHints: [],
          responseStyle: "narrative",
          styleReason: "negative guardrail applies",
          styleConfidence: 0.9,
          candidateSufficiency: "enough",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          markdown: "## 判断フォーカス\n- migration verification を先に確認してから進める。",
          usedKnowledge: [
            {
              id: "g1",
              confidence: 0.91,
              evidence: "negative guardrail applies to the migration decision",
              outputSection: "避ける条件",
              reason: "negative_evidence",
            },
          ],
        }),
      });

    const result = await composeContextResponse({
      input: {
        goal: "migration verification の実行判断をする",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [],
      guardrails: [
        {
          id: "knowledge:g1",
          itemKind: "rule",
          itemId: "g1",
          section: "guardrails",
          title: "Do not skip migration verification",
          content: "Do not proceed unless migration verification has been run.",
          score: 0.94,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.usedKnowledge).toEqual([
      expect.objectContaining({
        id: "g1",
        reason: "negative_evidence",
      }),
    ]);
    const composeRequest = mockProvider.chat.mock.calls[1]?.[0];
    const systemPrompt = composeRequest?.messages?.[0]?.content ?? "";
    const userPrompt = composeRequest?.messages?.[1]?.content ?? "";
    expect(systemPrompt).toContain(
      "`negative guardrails` は参考情報ではなく、実行可否・修正条件・確認条件を制約する negative evidence として扱う。",
    );
    expect(systemPrompt).toContain("実行を後押しする根拠として使わず");
    expect(userPrompt).toContain("negative guardrails:");
    expect(userPrompt).toContain("Do not skip migration verification");
  });

  test("separates EpisodeCard precedents from knowledge candidates in composer prompt", async () => {
    groupedConfig.agenticCompile.enabled = true;
    mockProvider.chat
      .mockResolvedValueOnce({
        content: JSON.stringify({
          headings: {
            focus: "実装フォーカス",
            steps: "実装手順",
            verification: "検証観点",
            avoid: "注意点",
          },
          includeAvoidSection: false,
          ruleQueryHints: [],
          procedureQueryHints: [],
          exclusionHints: [],
          responseStyle: "narrative",
          styleReason: "episode precedent available",
          styleConfidence: 0.9,
          candidateSufficiency: "enough",
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          markdown:
            "## 実装フォーカス\n- SQLite schema migration では過去の類似ケースを参考にしつつ現在のコードを確認する。",
          usedKnowledge: [{ id: "p1", confidence: 0.8 }],
        }),
      });

    const result = await composeContextResponse({
      input: {
        goal: "SQLite schema migration の方針を決める",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "Migration procedure",
          content: "Workflow:\n1. schema を確認する。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
        {
          id: "episode_card:episode-1",
          itemKind: "episode_card",
          itemId: "episode-1",
          section: "procedures",
          title: "Past episode: SQLite migration recovery",
          content:
            "Use when: A similar past task may inform the current compile context; treat this as precedent, not primary evidence.",
          score: 0.7,
          rankingReason: "supplemental EpisodeCard precedent",
          sourceRefs: ["context-still://episodes/episode-1"],
        },
      ],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.usedKnowledge).toEqual([expect.objectContaining({ id: "p1" })]);
    const composeRequest = mockProvider.chat.mock.calls[1]?.[0];
    const systemPrompt = composeRequest?.messages?.[0]?.content ?? "";
    const userPrompt = composeRequest?.messages?.[1]?.content ?? "";
    expect(systemPrompt).toContain("`episode precedents` は過去の類似ケース");
    expect(userPrompt).toContain("episode precedents:");
    expect(userPrompt).toContain("Past episode: SQLite migration recovery");
    const knowledgeSection = userPrompt.split("knowledge candidates:")[1] ?? "";
    expect(knowledgeSection).toContain("Migration procedure");
    expect(knowledgeSection).not.toContain("SQLite migration recovery");
  });

  test("falls back to plain markdown text when LLM outputs non-JSON content", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Output is plain Markdown text (not JSON) but goal-aligned
    mockProvider.chat.mockResolvedValue({
      content: "## 実装フォーカス\n- Hono APIを検証します。",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIを検証します。");
    expect(result.usedKnowledge).toEqual([]);
  });

  test("falls back to local template when LLM returns truncated JSON", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockResolvedValue({
      content:
        '{"markdown":"## 実装フォーカス\\n- Hono APIを検証します。","usedKnowledge":[{"id":"r1"',
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).not.toContain('{"markdown"');
    expect(result.error).toContain("COMPOSER_JSON_PARSE_FAILED");
  });

  test("uses valid JSON even when LLM reports token limit finish reason", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockResolvedValue({
      content: JSON.stringify({
        markdown: "## 実装フォーカス\n- Hono APIを検証します。",
        usedKnowledge: [],
      }),
      finishReason: "length",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIを検証します。");
    expect(result.error).toBeUndefined();
  });

  test("returns No Content if agentic output is not aligned with goal", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Output does not contain Hono / API keywords from goal
    mockProvider.chat.mockResolvedValue({
      content: "## 実装フォーカス\n- Completely unrelated text here.",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.markdown).toBe("No Content");
    expect(result.agenticUsed).toBe(true);
    expect(result.noContentReason).toBe("agentic_goal_alignment_failed");
  });

  test("falls back to local template when all LLM providers throw error", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockRejectedValue(new Error("API quota exceeded"));

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono requirement",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    // Should fall back to template composition
    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.error).toContain("CONTEXT_RESPONSE_COMPOSE_FAILED: API quota exceeded");
  });

  test("handles multiple providers fallback on error", async () => {
    groupedConfig.agenticCompile.enabled = true;

    const failingProvider = {
      name: "failing-llm",
      isConfigured: vi.fn().mockReturnValue(true),
      chat: vi.fn().mockRejectedValue(new Error("Timeout")),
    };

    const succeedingProvider = {
      name: "succeeding-llm",
      isConfigured: vi.fn().mockReturnValue(true),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          markdown: "## 実装フォーカス\n- Hono API composed successfully",
          usedKnowledge: [],
        }),
      }),
    };

    vi.mocked(getAgenticLlmProviders).mockReturnValue([failingProvider, succeedingProvider] as any);

    const result = await composeContextResponse({
      input: {
        goal: "Hono API",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono API composed successfully");
  });

  test("skips unconfigured LLM providers", async () => {
    groupedConfig.agenticCompile.enabled = true;

    const unconfiguredProvider = {
      name: "unconfigured-llm",
      isConfigured: vi.fn().mockReturnValue(false),
      chat: vi.fn(),
    };

    vi.mocked(getAgenticLlmProviders).mockReturnValue([unconfiguredProvider] as any);

    const result = await composeContextResponse({
      input: {
        goal: "Hono API",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(false); // Fell back to template
    expect(unconfiguredProvider.chat).not.toHaveBeenCalled();
  });
});
