import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  resolveDistillationModel,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import { recordLlmUsage } from "../src/modules/llm/llm-usage-logger.js";
import { resetAzureOpenAiDeploymentPoolForTests } from "../src/modules/llm/providers/azure-openai-config.js";
import { renderPrompt } from "../src/modules/system-context/system-context.service.js";

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    coverEvidenceLlmStarted: "COVER_EVIDENCE_LLM_STARTED",
    coverEvidenceLlmCompleted: "COVER_EVIDENCE_LLM_COMPLETED",
    coverEvidenceLlmFailed: "COVER_EVIDENCE_LLM_FAILED",
    systemContextSubmitted: "SYSTEM_CONTEXT_SUBMITTED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/modules/llm/llm-usage-logger.js", () => ({
  recordLlmUsage: vi.fn(),
}));

const originalConfig = {
  distillationProvider: groupedConfig.distillation.provider,
  distillationTimeoutMs: groupedConfig.distillation.timeoutMs,
  openAiApiKey: groupedConfig.openAi.apiKey,
  openAiApiBaseUrl: groupedConfig.openAi.apiBaseUrl,
  openAiModel: groupedConfig.openAi.model,
  localLlmApiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
  localLlmApiKey: groupedConfig.localLlm.apiKey,
  localLlmModel: groupedConfig.localLlm.model,
  localLlmModels: [...groupedConfig.localLlm.models],
  azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey,
  azureOpenAiApiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
  azureOpenAiApiPath: groupedConfig.azureOpenAi.apiPath,
  azureOpenAiApiVersion: groupedConfig.azureOpenAi.apiVersion,
  azureOpenAiModel: groupedConfig.azureOpenAi.model,
  azureOpenAiDeployments: groupedConfig.azureOpenAi.deployments,
  bedrockRegion: groupedConfig.bedrock.region,
  bedrockModel: groupedConfig.bedrock.model,
  llmContextWindowTokens: groupedConfig.distillation.llmContextWindowTokens,
  llmMaxInputTokens: groupedConfig.distillation.llmMaxInputTokens,
  llmInputSafetyMarginTokens: groupedConfig.distillation.llmInputSafetyMarginTokens,
};

describe("Distillation Runtime Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetAzureOpenAiDeploymentPoolForTests();

    groupedConfig.distillation.provider = "local-llm";
    groupedConfig.distillation.timeoutMs = 300_000;
    groupedConfig.distillation.llmContextWindowTokens = 128_000;
    groupedConfig.distillation.llmMaxInputTokens = 80_000;
    groupedConfig.distillation.llmInputSafetyMarginTokens = 4096;
    groupedConfig.openAi.apiKey = "";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.com/v1";
    groupedConfig.openAi.model = "gpt-5-4-mini";
    groupedConfig.localLlm.apiBaseUrl = "http://llm";
    groupedConfig.localLlm.apiKey = "test-key";
    groupedConfig.localLlm.model = "mock-local-model";
    groupedConfig.localLlm.models = [];

    groupedConfig.azureOpenAi.apiKey = "";
    groupedConfig.azureOpenAi.apiBaseUrl = "";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.apiVersion = "2025-04-01-preview";
    groupedConfig.azureOpenAi.model = "";
    groupedConfig.azureOpenAi.deployments = [];

    groupedConfig.bedrock.region = "";
    groupedConfig.bedrock.model = "";
  });

  test("runDistillationCompletion returns content immediately if no tools", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: "Hello result",
      toolCalls: [],
    });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient },
    );

    expect(result.content).toBe("Hello result");
    expect(chatClient).toHaveBeenCalledTimes(1);
  });

  test("awaits manifest-only SystemContext audit persistence after provider success", async () => {
    const systemContext = renderPrompt("contextCompiler.agenticRefine", {
      goal: "secret runtime goal",
      retrievalMode: "task_context",
      technologies: "",
      changeTypes: "",
      domains: "",
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    let releaseAudit: (() => void) | undefined;
    vi.mocked(recordAuditLogSafe).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAudit = resolve;
        }),
    );

    let completed = false;
    const completion = runDistillationCompletion(
      {
        model: "mock-local-model",
        messages: [{ role: "system", content: systemContext.content.text }],
        maxTokens: 128,
        systemContexts: [systemContext.manifest],
      },
      {
        providerSetting: "local-llm",
        enableTools: false,
      },
    ).then((result) => {
      completed = true;
      return result;
    });

    await vi.waitFor(() => expect(releaseAudit).toBeTypeOf("function"));
    expect(completed).toBe(false);
    releaseAudit?.();
    await expect(completion).resolves.toEqual(
      expect.objectContaining({ content: '{"candidates":[]}' }),
    );

    expect(recordAuditLogSafe).toHaveBeenCalledWith({
      eventType: "SYSTEM_CONTEXT_SUBMITTED",
      actor: "system",
      payload: expect.objectContaining({
        provider: "local-llm",
        manifests: [expect.objectContaining({ key: "contextCompiler.agenticRefine" })],
      }),
    });
    expect(JSON.stringify(vi.mocked(recordAuditLogSafe).mock.calls)).not.toContain(
      "secret runtime goal",
    );
  });

  test("truncates oversized distillation input before calling the provider", async () => {
    groupedConfig.distillation.llmContextWindowTokens = 128;
    groupedConfig.distillation.llmMaxInputTokens = 80;
    groupedConfig.distillation.llmInputSafetyMarginTokens = 10;
    const longToolResult = "provider evidence ".repeat(400);
    const chatClient = vi.fn().mockResolvedValue({
      content: "trimmed result",
      toolCalls: [],
    });

    await runDistillationCompletion(
      {
        model: "test",
        maxTokens: 10,
        messages: [
          { role: "system", content: "Keep system guidance." },
          {
            role: "tool",
            tool_call_id: "read-1",
            name: "memory_reader",
            content: longToolResult,
          },
          { role: "user", content: "Use the evidence and return JSON." },
        ],
      },
      { chatClient, enableTools: false },
    );

    const sentMessages = (chatClient.mock.calls[0]?.[0]?.messages ?? []) as Array<{
      role: string;
      content?: unknown;
    }>;
    expect(sentMessages[0]).toMatchObject({ role: "system", content: "Keep system guidance." });
    expect(sentMessages.at(-1)).toMatchObject({
      role: "user",
      content: "Use the evidence and return JSON.",
    });
    const sentTool = sentMessages.find((message) => message.role === "tool");
    expect(String(sentTool?.content)).toContain("truncated to LLM input budget");
    expect(String(sentTool?.content).length).toBeLessThan(longToolResult.length);
  });

  test("truncates oversized last user input as a last resort", async () => {
    groupedConfig.distillation.llmContextWindowTokens = 64;
    groupedConfig.distillation.llmMaxInputTokens = 32;
    groupedConfig.distillation.llmInputSafetyMarginTokens = 8;
    const chatClient = vi.fn().mockResolvedValue({
      content: "trimmed last user",
      toolCalls: [],
    });

    await runDistillationCompletion(
      {
        model: "test",
        maxTokens: 8,
        messages: [{ role: "user", content: "large evidence payload ".repeat(300) }],
      },
      { chatClient, enableTools: false },
    );

    const sentMessages = (chatClient.mock.calls[0]?.[0]?.messages ?? []) as Array<{
      role: string;
      content?: unknown;
    }>;
    expect(String(sentMessages[0]?.content)).toContain("truncated to LLM input budget");
    expect(String(sentMessages[0]?.content).length).toBeLessThan(
      "large evidence payload ".repeat(300).length,
    );
  });

  test("rejects distillation input that cannot fit after truncating non-system messages", async () => {
    groupedConfig.distillation.llmContextWindowTokens = 64;
    groupedConfig.distillation.llmMaxInputTokens = 32;
    groupedConfig.distillation.llmInputSafetyMarginTokens = 8;
    const chatClient = vi.fn().mockResolvedValue({
      content: "unreachable",
      toolCalls: [],
    });

    await expect(
      runDistillationCompletion(
        {
          model: "test",
          maxTokens: 8,
          messages: [
            { role: "system", content: "protected system guidance ".repeat(300) },
            { role: "user", content: "short task" },
          ],
        },
        { chatClient, enableTools: false },
      ),
    ).rejects.toThrow("distillation input exceeds configured LLM max input tokens");
    expect(chatClient).not.toHaveBeenCalled();
  });

  test("runDistillationCompletion can treat unexpected no-tools tool call arguments as content", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [
        {
          id: "c1",
          function: { name: "search_web", arguments: '{"query":"json repair parser"}' },
        },
      ],
    });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient, enableTools: false, fallbackToolCallArguments: true },
    );

    expect(result.content).toBe("json repair parser");
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "json repair parser",
    });
    expect(chatClient).toHaveBeenCalledWith(expect.objectContaining({ toolChoice: "none" }));
    expect(chatClient).toHaveBeenCalledTimes(1);
  });

  test("runDistillationCompletion still rejects unexpected no-tools tool calls without fallback", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [
        {
          id: "c1",
          function: { name: "search_web", arguments: '{"query":"json repair parser"}' },
        },
      ],
    });

    await expect(
      runDistillationCompletion(
        { model: "test", messages: [], maxTokens: 100 },
        { chatClient, enableTools: false },
      ),
    ).rejects.toThrow("distillation tool loop exceeded max rounds");
  });

  test("records coverEvidence LLM audit events with input and output diagnostics", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: "Hello result",
      finishReason: "stop",
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      toolCalls: [],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      },
    });

    await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "Verify candidate." },
        ],
        maxTokens: 100,
      },
      {
        chatClient,
        providerSetting: "local-llm",
        timeoutMs: 12_345,
        auditContext: {
          domain: "coverEvidence",
          id: "cover-1",
          stage: "web",
          assessment: "external-evidence",
        },
      },
    );

    expect(recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_LLM_STARTED",
        actor: "system",
        payload: expect.objectContaining({
          id: "cover-1",
          stage: "web",
          providerSetting: "local-llm",
          providerOrder: ["local-llm"],
          model: "gemma-4-e4b-it",
          timeoutMs: 12_345,
          messageCount: 2,
          inputChars: "Return JSON.Verify candidate.".length,
          estimatedInputTokens: expect.any(Number),
          effectiveMaxInputTokens: expect.any(Number),
          inputTruncated: false,
          droppedOrTruncatedMessageCount: 0,
          llmContextWindowTokens: 128_000,
          llmMaxInputTokens: 80_000,
          llmInputSafetyMarginTokens: 4096,
          toolChoice: "auto",
          allowTools: true,
        }),
      }),
    );
    expect(recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_LLM_COMPLETED",
        actor: "system",
        payload: expect.objectContaining({
          id: "cover-1",
          stage: "web",
          provider: "local-llm",
          resolvedModel: "gemma-4-e4b-it",
          finishReason: "stop",
          outputChars: "Hello result".length,
          responseToolCallCount: 0,
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        }),
      }),
    );
  });

  test("records coverEvidence LLM failure audit events", async () => {
    const chatClient = vi.fn().mockRejectedValue(new Error("distillation LLM request timed out"));

    await expect(
      runDistillationCompletion(
        {
          model: "gemma-4-e4b-it",
          messages: [{ role: "user", content: "Verify candidate." }],
          maxTokens: 100,
        },
        {
          chatClient,
          providerSetting: "local-llm",
          auditContext: {
            domain: "coverEvidence",
            id: "cover-2",
            stage: "final",
            assessment: "value",
          },
        },
      ),
    ).rejects.toThrow("distillation LLM request timed out");

    expect(recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_LLM_FAILED",
        actor: "system",
        payload: expect.objectContaining({
          id: "cover-2",
          stage: "final",
          providerSetting: "local-llm",
          providerOrder: ["local-llm"],
          errorKind: "timeout",
          error: "distillation LLM request timed out",
        }),
      }),
    );
  });

  test("runDistillationCompletion loops for tool calls", async () => {
    const chatClient = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [{ id: "c1", function: { name: "tool", arguments: "{}" } }],
      })
      .mockResolvedValueOnce({
        content: "Final answer",
        toolCalls: [],
      });

    const toolExecutor = vi.fn().mockResolvedValue({
      name: "tool",
      content: "tool result",
      ok: true,
    });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient, toolExecutor },
    );

    expect(result.content).toBe("Final answer");
    expect(chatClient).toHaveBeenCalledTimes(2);
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.toolEvents).toHaveLength(1);
  });

  test("throws error when max rounds exceeded", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [{ id: "c1", function: { name: "tool", arguments: "{}" } }],
    });

    await expect(
      runDistillationCompletion(
        { model: "test", messages: [], maxTokens: 100 },
        { chatClient, maxToolRounds: 1 },
      ),
    ).rejects.toThrow("distillation tool loop exceeded max rounds");
  });

  test("throws error if content is missing and no tools", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [],
    });

    await expect(
      runDistillationCompletion({ model: "test", messages: [], maxTokens: 100 }, { chatClient }),
    ).rejects.toThrow("distillation response did not include assistant content");
  });

  test("reprompts empty-string content so caller receives parseable JSON", async () => {
    const chatClient = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: '{"candidates":[]}',
        toolCalls: [],
      });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient },
    );
    expect(result.content).toBe('{"candidates":[]}');
    expect(chatClient).toHaveBeenCalledTimes(2);
  });

  test("callLocalLlmChat performs fetch and parses response", async () => {
    groupedConfig.localLlm.apiBaseUrl = "http://llm/v1";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Fetched content", tool_calls: [] } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const result = await callLocalLlmCompletionForDistillation({
      model: "m1",
      messages: [],
      maxTokens: 50,
    });

    expect(result.content).toBe("Fetched content");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://llm/v1/chat/completions",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-llm",
        model: "m1",
        promptMessages: [],
        completionText: "Fetched content",
        source: "distillation",
      }),
    );
  });

  test("callLocalLlmChat forwards required tool choice", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Fetched content", tool_calls: [] } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await runDistillationCompletion(
      {
        model: "m1",
        messages: [],
        maxTokens: 50,
      },
      { requireToolCall: true },
    );

    const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
    expect(body.tool_choice).toBe("required");
  });

  test("callLocalLlmChat handles HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Error"),
      }),
    );

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    await expect(
      callLocalLlmCompletionForDistillation({ model: "m1", messages: [], maxTokens: 50 }),
    ).rejects.toThrow("local-llm HTTP 500");
  });

  test("callLocalLlmChat handles complex/malformed tool calls", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { function: { name: " valid ", arguments: { a: 1 } } },
                    { function: { name: "no-args" } },
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "with-id", arguments: '{"b":2}' },
                    },
                    null,
                    { function: { name: "" } },
                  ],
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Done", tool_calls: [] } }],
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const result = await callLocalLlmCompletionForDistillation({
      model: "m1",
      messages: [],
      maxTokens: 50,
    });

    expect(result.messages.find((m) => m.role === "assistant")?.tool_calls).toHaveLength(3);
  });

  test("callLocalLlmChat recovers content-embedded tool call JSON", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: '{"name":"tool_from_content","arguments":{"x":1}}',
                  tool_calls: [],
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const result = await callLocalLlmCompletionForDistillation({
      model: "m1",
      messages: [],
      maxTokens: 50,
    });

    expect(result.content).toBe('{"candidates":[]}');
    const assistantWithToolCall = result.messages.find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
    );
    expect(assistantWithToolCall?.tool_calls).toHaveLength(1);
    expect(assistantWithToolCall?.tool_calls?.[0]?.function.name).toBe("tool_from_content");
  });

  test("parseOpenAiStyleResponse recovers malformed content-embedded tool call JSON", async () => {
    const { parseOpenAiStyleResponse } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const malformedToolCall =
      '{"name":"search_web","arguments":{"query":"compileContextPack は呼び出し元 source run に記録する"}akad}}';

    const parsed = parseOpenAiStyleResponse({
      choices: [{ message: { content: malformedToolCall, tool_calls: [] } }],
    });

    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe("search_web");
    expect(parsed.toolCalls[0]?.function.arguments).toContain("compileContextPack");
  });

  test("parseOpenAiStyleResponse recovers slash-delimited search_web format", async () => {
    const { parseOpenAiStyleResponse } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const parsed = parseOpenAiStyleResponse({
      choices: [
        {
          message: {
            content: "name/search_web/query/JSON repair package for malformed output",
            tool_calls: [],
          },
        },
      ],
    });

    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe("search_web");
    expect(parsed.toolCalls[0]?.function.arguments).toContain("JSON repair package");
  });

  test("parseOpenAiStyleResponse recovers pipe-delimited keyword format", async () => {
    const { parseOpenAiStyleResponse } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const parsed = parseOpenAiStyleResponse({
      choices: [
        {
          message: {
            content: "| json repair | llm output parser |",
            tool_calls: [],
          },
        },
      ],
    });

    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe("search_web");
    expect(parsed.toolCalls[0]?.function.arguments).toContain("json repair");
  });

  test("parseOpenAiStyleResponse compacts long pipe-delimited keyword text", async () => {
    const { parseOpenAiStyleResponse } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const parsed = parseOpenAiStyleResponse({
      choices: [
        {
          message: {
            content: "| 仕様変更時は段階的テスト実行で検証する |",
            tool_calls: [],
          },
        },
      ],
    });

    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    const args = JSON.parse(parsed.toolCalls[0]?.function.arguments ?? "{}") as {
      query?: string;
      normalizedFrom?: string;
      rawQueryPreview?: string;
    };
    expect(args.query).toBe("仕様変更時 段階的テスト実行 検証");
    expect(args.normalizedFrom).toBe("pipe_keywords");
    expect(args.rawQueryPreview).toContain("仕様変更時は");
  });

  test("parseOpenAiStyleResponse recovers numeric selection format for fetch_content", async () => {
    const { parseOpenAiStyleResponse } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const parsed = parseOpenAiStyleResponse({
      choices: [
        {
          message: {
            content: "2,3,4",
            tool_calls: [],
          },
        },
      ],
    });

    expect(parsed.content).toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.function.name).toBe("fetch_content");
    expect(parsed.toolCalls[0]?.function.arguments).toContain("2,3,4");
  });

  test("resolveDistillationModel uses selected provider model", () => {
    groupedConfig.distillation.provider = "azure-openai";
    groupedConfig.azureOpenAi.apiKey = "key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://example.openai.azure.com";
    groupedConfig.azureOpenAi.model = "gpt-5-4-mini";

    expect(resolveDistillationModel()).toBe("gpt-5-4-mini");
  });

  test("resolveDistillationModel auto picks first configured provider", () => {
    groupedConfig.distillation.provider = "auto";
    groupedConfig.localLlm.apiBaseUrl = "";
    groupedConfig.localLlm.model = "";
    groupedConfig.azureOpenAi.apiKey = "key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://example.openai.azure.com";
    groupedConfig.azureOpenAi.model = "gpt-5-4-mini";

    expect(resolveDistillationModel()).toBe("gpt-5-4-mini");
  });

  test("runDistillationCompletion can fall back to the configured secondary provider", async () => {
    groupedConfig.openAi.apiKey = "openai-key";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.test/v1";
    groupedConfig.openAi.model = "gpt-5-4-mini";
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "openai failure",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gpt-5-4-mini",
        messages: [{ role: "user", content: "fallback smoke" }],
        maxTokens: 128,
      },
      {
        providerSetting: "openai",
        fallbackOrder: ["local-llm"],
        enableTools: false,
      },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)).model).toBe("gpt-5-4-mini");
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("127.0.0.1:44448");
    expect(JSON.parse(String(mockFetch.mock.calls[1]?.[1]?.body)).model).toBe("gemma-4-e4b-it");
  });

  test("does not fall back to the next provider when the parent signal aborts", async () => {
    groupedConfig.openAi.apiKey = "openai-key";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.test/v1";
    groupedConfig.openAi.model = "gpt-5-4-mini";
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";

    const mockFetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          rejectAbort();
          return;
        }
        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const controller = new AbortController();
    const pending = runDistillationCompletion(
      {
        model: "gpt-5-4-mini",
        messages: [{ role: "user", content: "abort smoke" }],
        maxTokens: 128,
      },
      {
        providerSetting: "openai",
        fallbackOrder: ["local-llm"],
        enableTools: false,
        signal: controller.signal,
      },
    );
    controller.abort();

    await expect(pending).rejects.toThrow("distillation request aborted");
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(1);
    expect(
      mockFetch.mock.calls.every((call) => String(call[0]).includes("api.openai.test/v1")),
    ).toBe(true);
  });

  test("runDistillationCompletion uses Azure OpenAI only after local-llm fails", async () => {
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.azureOpenAi.apiKey = "azure-key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://first.openai.azure.com";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.apiVersion = "2025-04-01-preview";
    groupedConfig.azureOpenAi.model = "gpt-4o-mini";
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "azure-key",
        apiBaseUrl: "https://first.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-4o-mini",
      },
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "local failure",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [{ role: "user", content: "fallback smoke" }],
        maxTokens: 128,
      },
      {
        providerSetting: "local-llm",
        fallbackOrder: ["azure-openai"],
        enableTools: false,
        auditContext: {
          domain: "coverEvidence",
          id: "cover-fallback-route",
          stage: "final",
          assessment: "value",
        },
      },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:44448/v1/chat/completions");
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe(
      "https://first.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-04-01-preview",
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure-openai",
        model: "gpt-4o-mini",
      }),
    );
    const completedAudit = vi
      .mocked(recordAuditLogSafe)
      .mock.calls.find((call) => call[0]?.eventType === "COVER_EVIDENCE_LLM_COMPLETED");
    expect(completedAudit).toBeDefined();
    expect(completedAudit?.[0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          providerOrder: ["local-llm", "azure-openai"],
          attemptedProviders: ["local-llm", "azure-openai"],
          selectedProvider: "azure-openai",
          fallbackUsed: true,
          providerErrorKinds: expect.objectContaining({
            "local-llm": expect.any(String),
          }),
          selectedProviderDetails: expect.objectContaining({
            azureDeployment: expect.objectContaining({
              label: "deployment1",
              host: "first.openai.azure.com",
              model: "gpt-4o-mini",
            }),
          }),
        }),
      }),
    );
  });

  test("runDistillationCompletion falls back when a provider-local timeout aborts", async () => {
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.azureOpenAi.apiKey = "azure-key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://first.openai.azure.com";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.apiVersion = "2025-04-01-preview";
    groupedConfig.azureOpenAi.model = "gpt-4o-mini";
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "azure-key",
        apiBaseUrl: "https://first.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-4o-mini",
      },
    ];

    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [{ role: "user", content: "provider timeout fallback" }],
        maxTokens: 128,
      },
      {
        providerSetting: "local-llm",
        fallbackOrder: ["azure-openai"],
        enableTools: false,
      },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe(
      "https://first.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-04-01-preview",
    );
  });

  test("runDistillationCompletion uses configured Local LLM model for fallback", async () => {
    groupedConfig.openAi.apiKey = "openai-key";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.test/v1";
    groupedConfig.openAi.model = "gpt-5-4-mini";
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      },
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "openai failure",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gpt-5-4-mini",
        messages: [{ role: "user", content: "local fallback model" }],
        maxTokens: 128,
      },
      {
        providerSetting: "openai",
        fallbackOrder: ["local-llm"],
        localLlmModel: "qwen-3.6-14b-it",
        enableTools: false,
      },
    );

    expect(result.content).toBe('{"ok":true}');
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe("http://127.0.0.1:44449/v1/chat/completions");
    expect(JSON.parse(String(mockFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      model: "qwen-3.6-14b-it",
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-llm",
        model: "qwen-3.6-14b-it",
      }),
    );
  });

  test("runDistillationCompletion uses configured Local LLM model for primary local provider", async () => {
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-27b",
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [{ role: "user", content: "primary local model" }],
        maxTokens: 128,
      },
      {
        providerSetting: "local-llm",
        localLlmModel: "qwen-3.6-27b",
        enableTools: false,
      },
    );

    expect(result.content).toBe('{"ok":true}');
    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:44449/v1/chat/completions");
    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen-3.6-27b",
    });
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-llm",
        model: "qwen-3.6-27b",
      }),
    );
  });

  test("records provider route diagnostics on non-fallback provider failure", async () => {
    groupedConfig.openAi.apiKey = "openai-key";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.test/v1";
    groupedConfig.openAi.model = "gpt-5-4-mini";
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "openai failure",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      runDistillationCompletion(
        {
          model: "gpt-5-4-mini",
          messages: [{ role: "user", content: "failure route audit" }],
          maxTokens: 128,
        },
        {
          providerSetting: "openai",
          enableTools: false,
          auditContext: {
            domain: "coverEvidence",
            id: "cover-no-fallback",
            stage: "final",
            assessment: "value",
          },
        },
      ),
    ).rejects.toThrow();

    const failedAudit = vi
      .mocked(recordAuditLogSafe)
      .mock.calls.find((call) => call[0]?.eventType === "COVER_EVIDENCE_LLM_FAILED");
    expect(failedAudit).toBeDefined();
    expect(failedAudit?.[0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          providerOrder: ["openai"],
          attemptedProviders: ["openai"],
          selectedProvider: undefined,
          fallbackUsed: false,
          providerErrorKinds: expect.objectContaining({
            openai: expect.any(String),
          }),
        }),
      }),
    );
  });

  test("keeps fallbackUsed true with pinned fallback provider on later rounds", async () => {
    groupedConfig.localLlm.apiKey = "local-key";
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.azureOpenAi.apiKey = "azure-key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://first.openai.azure.com";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.apiVersion = "2025-04-01-preview";
    groupedConfig.azureOpenAi.model = "gpt-4o-mini";
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "azure-key",
        apiBaseUrl: "https://first.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-4o-mini",
      },
    ];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "local failure",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-search-1",
                    type: "function",
                    function: {
                      name: "search_web",
                      arguments: JSON.stringify({ query: "fallback check" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"candidates":[]}', tool_calls: [] } }],
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [{ role: "user", content: "pinned fallback audit" }],
        maxTokens: 128,
      },
      {
        providerSetting: "local-llm",
        fallbackOrder: ["azure-openai"],
        auditContext: {
          domain: "coverEvidence",
          id: "cover-pinned-fallback-route",
          stage: "final",
          assessment: "value",
        },
        toolExecutor: async (toolCall) => ({
          callId: toolCall.id,
          name: toolCall.function.name,
          ok: true,
          content: JSON.stringify({ ok: true }),
        }),
      },
    );

    expect(result.content).toBe('{"candidates":[]}');
    const completedAudits = vi
      .mocked(recordAuditLogSafe)
      .mock.calls.filter((call) => call[0]?.eventType === "COVER_EVIDENCE_LLM_COMPLETED");
    expect(completedAudits.length).toBe(2);
    const firstPayload = completedAudits[0]?.[0]?.payload as Record<string, unknown>;
    const secondPayload = completedAudits[1]?.[0]?.payload as Record<string, unknown>;
    expect(firstPayload.providerOrder).toEqual(["local-llm", "azure-openai"]);
    expect(firstPayload.attemptedProviders).toEqual(["local-llm", "azure-openai"]);
    expect(firstPayload.fallbackUsed).toBe(true);
    expect(secondPayload.providerOrder).toEqual(["local-llm", "azure-openai"]);
    expect(secondPayload.attemptedProviders).toEqual(["azure-openai"]);
    expect(secondPayload.selectedProvider).toBe("azure-openai");
    expect(secondPayload.fallbackUsed).toBe(true);
  });
  afterAll(() => {
    groupedConfig.distillation.provider = originalConfig.distillationProvider;
    groupedConfig.distillation.timeoutMs = originalConfig.distillationTimeoutMs;
    groupedConfig.distillation.llmContextWindowTokens = originalConfig.llmContextWindowTokens;
    groupedConfig.distillation.llmMaxInputTokens = originalConfig.llmMaxInputTokens;
    groupedConfig.distillation.llmInputSafetyMarginTokens =
      originalConfig.llmInputSafetyMarginTokens;
    groupedConfig.openAi.apiKey = originalConfig.openAiApiKey;
    groupedConfig.openAi.apiBaseUrl = originalConfig.openAiApiBaseUrl;
    groupedConfig.openAi.model = originalConfig.openAiModel;
    groupedConfig.localLlm.apiBaseUrl = originalConfig.localLlmApiBaseUrl;
    groupedConfig.localLlm.apiKey = originalConfig.localLlmApiKey;
    groupedConfig.localLlm.model = originalConfig.localLlmModel;
    groupedConfig.localLlm.models = [...originalConfig.localLlmModels];
    groupedConfig.azureOpenAi.apiKey = originalConfig.azureOpenAiApiKey;
    groupedConfig.azureOpenAi.apiBaseUrl = originalConfig.azureOpenAiApiBaseUrl;
    groupedConfig.azureOpenAi.apiPath = originalConfig.azureOpenAiApiPath;
    groupedConfig.azureOpenAi.apiVersion = originalConfig.azureOpenAiApiVersion;
    groupedConfig.azureOpenAi.model = originalConfig.azureOpenAiModel;
    groupedConfig.azureOpenAi.deployments = originalConfig.azureOpenAiDeployments;
    groupedConfig.bedrock.region = originalConfig.bedrockRegion;
    groupedConfig.bedrock.model = originalConfig.bedrockModel;
    vi.unstubAllGlobals();
  });
});
