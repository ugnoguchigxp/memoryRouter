import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  type AgenticCandidate,
  agenticRefine,
} from "../src/modules/context-compiler/agentic-refine.service.js";
import { checkAgenticLlmHealth } from "../src/modules/llm/agentic-llm.service.js";
import type { CompileInput } from "../src/shared/schemas/compile.schema.js";

const settingsMocks = vi.hoisted(() => ({
  ensureRuntimeSettingsLoaded: vi.fn(async () => {}),
  resolveAgenticCompileRouting: vi.fn(),
}));

vi.mock("../src/modules/llm/llm-usage-logger.js", () => ({
  recordLlmUsage: vi.fn(),
}));
vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: settingsMocks.ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting: settingsMocks.resolveAgenticCompileRouting,
}));

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = mockFetch as any;

describe("agentic-refine.service", () => {
  const originalConfig = {
    agenticCompileEnabled: groupedConfig.agenticCompile.enabled,
    agenticCompileProvider: groupedConfig.agenticCompile.provider,
    openAiApiKey: groupedConfig.openAi.apiKey,
    openAiApiBaseUrl: groupedConfig.openAi.apiBaseUrl,
    openAiModel: groupedConfig.openAi.model,
    azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey,
    azureOpenAiApiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
    azureOpenAiApiPath: groupedConfig.azureOpenAi.apiPath,
    azureOpenAiModel: groupedConfig.azureOpenAi.model,
    azureOpenAiApiVersion: groupedConfig.azureOpenAi.apiVersion,
    localLlmApiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
    localLlmApiKey: groupedConfig.localLlm.apiKey,
    localLlmModel: groupedConfig.localLlm.model,
    localLlmModels: groupedConfig.localLlm.models,
    bedrockModel: groupedConfig.bedrock.model,
    bedrockRegion: groupedConfig.bedrock.region,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    groupedConfig.agenticCompile.enabled = true;
    groupedConfig.agenticCompile.provider = "azure-openai";
    groupedConfig.openAi.apiKey = "";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.com/v1";
    groupedConfig.openAi.model = "gpt-4.1-mini";
    groupedConfig.azureOpenAi.apiKey = "test-key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://test.openai.azure.com";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.model = "test-model";
    groupedConfig.azureOpenAi.apiVersion = "2024-04-01-preview";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.apiKey = "";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.localLlm.models = [];
    groupedConfig.bedrock.model = "";
    groupedConfig.bedrock.region = "us-east-1";
    settingsMocks.resolveAgenticCompileRouting.mockImplementation(() => ({
      enabled: groupedConfig.agenticCompile.enabled,
      provider: groupedConfig.agenticCompile.provider as any,
      model:
        groupedConfig.agenticCompile.provider === "openai"
          ? groupedConfig.openAi.model
          : groupedConfig.agenticCompile.provider === "azure-openai"
            ? groupedConfig.azureOpenAi.model
            : groupedConfig.agenticCompile.provider === "bedrock"
              ? groupedConfig.bedrock.model
              : groupedConfig.localLlm.model,
      fallback: [],
      timeoutMs: groupedConfig.agenticCompile.timeoutMs,
      maxTokens: groupedConfig.agenticCompile.maxTokens,
    }));
  });

  afterEach(() => {
    groupedConfig.agenticCompile.enabled = originalConfig.agenticCompileEnabled;
    groupedConfig.agenticCompile.provider = originalConfig.agenticCompileProvider;
    groupedConfig.openAi.apiKey = originalConfig.openAiApiKey;
    groupedConfig.openAi.apiBaseUrl = originalConfig.openAiApiBaseUrl;
    groupedConfig.openAi.model = originalConfig.openAiModel;
    groupedConfig.azureOpenAi.apiKey = originalConfig.azureOpenAiApiKey;
    groupedConfig.azureOpenAi.apiBaseUrl = originalConfig.azureOpenAiApiBaseUrl;
    groupedConfig.azureOpenAi.apiPath = originalConfig.azureOpenAiApiPath;
    groupedConfig.azureOpenAi.model = originalConfig.azureOpenAiModel;
    groupedConfig.azureOpenAi.apiVersion = originalConfig.azureOpenAiApiVersion;
    groupedConfig.localLlm.apiBaseUrl = originalConfig.localLlmApiBaseUrl;
    groupedConfig.localLlm.apiKey = originalConfig.localLlmApiKey;
    groupedConfig.localLlm.model = originalConfig.localLlmModel;
    groupedConfig.localLlm.models = originalConfig.localLlmModels;
    groupedConfig.bedrock.model = originalConfig.bedrockModel;
    groupedConfig.bedrock.region = originalConfig.bedrockRegion;
  });

  const candidates: AgenticCandidate[] = [
    {
      id: "1",
      type: "rule",
      status: "active",
      title: "Rule 1",
      content: "Content 1",
      score: 0.9,
      sourceRefs: [],
    },
    {
      id: "2",
      type: "procedure",
      status: "active",
      title: "Proc 1",
      content: "Content 2",
      score: 0.8,
      sourceRefs: [],
    },
    {
      id: "3",
      type: "rule",
      status: "draft",
      title: "Rule 3",
      content: "Content 3",
      score: 0.7,
      sourceRefs: [],
    },
  ];

  const input: CompileInput = {
    goal: "Test goal",
    changeTypes: ["feature"],
    technologies: ["typescript"],
    domains: ["context-compiler"],
  };

  describe("agenticRefine", () => {
    it("returns candidates directly if agenticCompileEnabled is false", async () => {
      groupedConfig.agenticCompile.enabled = false;
      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.items).toEqual(candidates);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns candidates directly if provider is not configured", async () => {
      groupedConfig.azureOpenAi.apiKey = "";
      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.items).toEqual(candidates);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns empty array if candidates are empty", async () => {
      const result = await agenticRefine([], input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.items).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("calls Azure OpenAI and reorders candidates based on JSON response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["2", "1"],
                  reasoning: "Rule 3 is draft, Proc 1 is most relevant",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.reasoning).toBe("Rule 3 is draft, Proc 1 is most relevant");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("2");
      expect(result.items[1].id).toBe("1");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe(
        "https://test.openai.azure.com/openai/deployments/test-model/chat/completions?api-version=2024-04-01-preview",
      );
      const request = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(request.messages[0].content).not.toContain("Test goal");
      const userPayload = JSON.parse(request.messages[1].content);
      expect(userPayload.goal).toBe("Test goal");
      expect(userPayload.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: "1" })]));
    });

    it("passes negative guardrail metadata to the refine prompt", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["neg-1"],
                  reasoning: "negative guardrail applies",
                }),
              },
            },
          ],
        }),
      });
      const guardedCandidates: AgenticCandidate[] = [
        {
          id: "neg-1",
          type: "rule",
          status: "active",
          title: "Do not skip verification",
          content: "Avoid proceeding before migration verification has run.",
          score: 0.94,
          sourceRefs: [],
          polarity: "negative",
          section: "guardrails",
        },
      ];

      const result = await agenticRefine(guardedCandidates, input, "task_context");

      expect(result.items.map((item) => item.id)).toEqual(["neg-1"]);
      const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const systemPrompt = body.messages[0]?.content ?? "";
      const userPrompt = body.messages[1]?.content ?? "";
      expect(systemPrompt).toContain("protected=trueはincludeまたはconditionalにし、omitにしません");
      expect(systemPrompt).toContain("negativeを実行の後押しに読み替えず");
      const payload = JSON.parse(userPrompt);
      expect(payload.candidates[0]).toMatchObject({ polarity: "negative", section: "guardrails" });
    });

    it("handles HTTP error gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toContain("AGENTIC_REFINE_FAILED");
      expect(result.error).toContain("HTTP 401");
      expect(result.items).toEqual(candidates);
    });

    it("handles markdown code block JSON response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Here is the result:\n```json\n{\n  "selectedIds": ["3"]\n}\n```',
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("3");
    });

    it("accepts loose JSON-like output without response_format", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "selectedIds: ['2', '1',], reasoning: 'loose output'",
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.reasoning).toBe("loose output");
      expect(result.items.map((item) => item.id)).toEqual(["2", "1"]);

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.response_format).toBeUndefined();
    });

    it("accepts raw JSON array output as selectedIds fallback", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '["2","1"]',
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.id).toBe("2");
      expect(result.items[1]?.id).toBe("1");
    });

    it("treats non-string array output as parse failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "[1,2]",
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toBe("AGENTIC_OUTPUT_PARSE_FAILED");
      expect(result.items).toEqual(candidates);
    });

    it("filters out invalid IDs returned by LLM", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["1", "unknown-id", "2"],
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("1");
      expect(result.items[1].id).toBe("2");
    });

    it("respects empty selection when LLM actively selects nothing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: [],
                  reasoning: "該当なし",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.reasoning).toBe("該当なし");
      expect(result.selectionReason).toBe("empty_selection");
      expect(result.items).toEqual([]);
    });

    it("treats only invalid selected IDs as an empty agentic selection", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["invalid-id-123"],
                  reasoning: "無効なID",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.selectionReason).toBe("no_valid_selected_ids");
      expect(result.items).toEqual([]);
    });

    it("falls back from azure-openai to local-llm when provider is auto", async () => {
      groupedConfig.agenticCompile.provider = "auto";

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "server error",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    selectedIds: ["1"],
                    reasoning: "local selected",
                  }),
                },
              },
            ],
          }),
        });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("1");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe("http://127.0.0.1:44448/v1/chat/completions");
    });

    it("uses the routed Local LLM model when provider is local-llm", async () => {
      settingsMocks.resolveAgenticCompileRouting.mockReturnValue({
        enabled: true,
        provider: "local-llm",
        model: "qwen-3.6-14b-it",
        localLlmModel: "qwen-3.6-14b-it",
        fallback: [],
        timeoutMs: groupedConfig.agenticCompile.timeoutMs,
        maxTokens: groupedConfig.agenticCompile.maxTokens,
      });
      groupedConfig.localLlm.models = [
        {
          name: "Qwen",
          apiBaseUrl: "http://127.0.0.1:44449",
          apiPath: "/v1/chat/completions",
          model: "qwen-3.6-14b-it",
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["2"],
                  reasoning: "routed local model selected",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");

      expect(result.agenticUsed).toBe(true);
      expect(mockFetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44449/v1/chat/completions");
      const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
      expect(body.model).toBe("qwen-3.6-14b-it");
    });

    it("uses the configured Local LLM API when agentic fallback routes to local-llm", async () => {
      settingsMocks.resolveAgenticCompileRouting.mockReturnValue({
        enabled: true,
        provider: "azure-openai",
        model: "test-model",
        localLlmModel: "qwen-3.6-14b-it",
        fallback: ["local-llm"],
        timeoutMs: groupedConfig.agenticCompile.timeoutMs,
        maxTokens: groupedConfig.agenticCompile.maxTokens,
      });
      groupedConfig.localLlm.models = [
        {
          name: "Qwen",
          apiBaseUrl: "http://127.0.0.1:44449",
          apiPath: "/v1/chat/completions",
          model: "qwen-3.6-14b-it",
        },
      ];
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "azure down",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    selectedIds: ["1"],
                    reasoning: "fallback local selected",
                  }),
                },
              },
            ],
          }),
        });

      const result = await agenticRefine(candidates, input, "task_context");

      expect(result.agenticUsed).toBe(true);
      expect(mockFetch.mock.calls[1]?.[0]).toBe("http://127.0.0.1:44449/v1/chat/completions");
      const body = JSON.parse(String(mockFetch.mock.calls[1]?.[1]?.body));
      expect(body.model).toBe("qwen-3.6-14b-it");
    });

    it("returns aggregate error when all auto providers fail", async () => {
      groupedConfig.agenticCompile.provider = "auto";

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "azure down",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "local down",
        });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toContain("AGENTIC_REFINE_FAILED");
      expect(result.error).toContain("azure-openai");
      expect(result.error).toContain("local-llm");
    });
  });

  describe("checkAgenticLlmHealth", () => {
    it("returns configured=false when selected provider is not configured", async () => {
      groupedConfig.agenticCompile.provider = "azure-openai";
      groupedConfig.azureOpenAi.apiKey = "";

      const result = await checkAgenticLlmHealth();
      expect(result.providerSetting).toBe("azure-openai");
      expect(result.configured).toBe(false);
      expect(result.reachable).toBe(false);
      expect(result.error).toContain("not configured");
    });

    it("returns reachable=true when selected provider responds", async () => {
      groupedConfig.agenticCompile.provider = "azure-openai";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        }),
      });

      const result = await checkAgenticLlmHealth();
      expect(result.configured).toBe(true);
      expect(result.reachable).toBe(true);
      expect(result.selectedProvider).toBe("azure-openai");
    });

    it("auto fallback selects local-llm when azure-openai is unreachable", async () => {
      groupedConfig.agenticCompile.provider = "auto";

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "azure unavailable",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: "ok",
            ready: true,
            loaded: true,
            modelId: "gemma-4-e4b-it",
          }),
        });

      const result = await checkAgenticLlmHealth();
      expect(result.providerSetting).toBe("auto");
      expect(result.selectedProvider).toBe("local-llm");
      expect(result.provider).toBe("local-llm");
      expect(result.reachable).toBe(true);
    });
  });
});
