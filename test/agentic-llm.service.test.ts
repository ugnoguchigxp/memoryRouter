import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  checkAgenticLlmHealth,
  checkDistillationLlmHealth,
  checkLlmProviderHealthMatrix,
  getAgenticLlmProviders,
} from "../src/modules/llm/agentic-llm.service.js";
import { recordLlmUsage } from "../src/modules/llm/llm-usage-logger.js";
import { createAzureOpenAiProvider } from "../src/modules/llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../src/modules/llm/providers/bedrock.provider.js";
import { createCodexProvider } from "../src/modules/llm/providers/codex.provider.js";
import { createLocalLlmProvider } from "../src/modules/llm/providers/local-llm.provider.js";
import { createOpenAiProvider } from "../src/modules/llm/providers/openai.provider.js";
import { renderSystemContext } from "../src/modules/system-context/system-context.service.js";

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    systemContextSubmitted: "SYSTEM_CONTEXT_SUBMITTED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/modules/llm/llm-usage-logger.js", () => ({
  recordLlmUsage: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/openai.provider.js", () => ({
  createOpenAiProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/azure-openai.provider.js", () => ({
  createAzureOpenAiProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/bedrock.provider.js", () => ({
  createBedrockProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/local-llm.provider.ts", () => ({
  createLocalLlmProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/codex.provider.ts", () => ({
  createCodexProvider: vi.fn(),
}));

describe("agentic-llm service tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.azureOpenAi.deployments = [];
    groupedConfig.localLlm.models = [];
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", false, false) as any);
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", false, false) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", false, false) as any);
    vi.mocked(createLocalLlmProvider).mockReturnValue(
      mockProvider("local-llm", false, false) as any,
    );
    vi.mocked(createCodexProvider).mockReturnValue(mockProvider("codex", false, false) as any);
  });

  const mockProvider = (name: string, configured: boolean, reachable: boolean, error?: string) => {
    return {
      name,
      isConfigured: vi.fn(() => configured),
      chat: vi.fn().mockResolvedValue({ content: "ok" }),
      healthCheck: vi.fn().mockResolvedValue({
        provider: name,
        configured,
        reachable,
        error: error || (configured && !reachable ? "unreachable" : null),
      }),
    };
  };

  test("getAgenticLlmProviders resolves fallback providers list", () => {
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", true, true) as any);
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", true, true) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", true, true) as any);
    vi.mocked(createLocalLlmProvider).mockReturnValue(mockProvider("local-llm", true, true) as any);
    vi.mocked(createCodexProvider).mockReturnValue(mockProvider("codex", true, true) as any);

    const providers = getAgenticLlmProviders("auto", 2000);
    expect(providers).toHaveLength(4);
    expect(providers[0]?.name).toBe("openai");
    expect(providers[1]?.name).toBe("azure-openai");
    expect(providers[2]?.name).toBe("bedrock");
    expect(providers[3]?.name).toBe("local-llm");

    // timeout parameter should be passed down
    expect(createOpenAiProvider).toHaveBeenCalledWith({ timeoutMs: 2000 });
    expect(createAzureOpenAiProvider).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });

  test("getAgenticLlmProviders can wrap chat calls with usage logging", async () => {
    const usage = {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
    };
    const azure = mockProvider("azure-openai", true, true);
    azure.chat.mockResolvedValue({ content: "ok", usage });
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

    const [provider] = getAgenticLlmProviders("azure-openai", 2000, "context-compiler");
    await provider?.chat({
      model: "deployment-override",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });

    expect(azure.chat).toHaveBeenCalledTimes(1);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure-openai",
        model: "deployment-override",
        usage,
        promptMessages: [{ role: "user", content: "hi" }],
        completionText: "ok",
        source: "context-compiler",
      }),
    );
  });

  test("awaits audit persistence and combines request and provider SystemContext manifests", async () => {
    const requestContext = renderSystemContext("shared.jsonOnly", {});
    const providerContext = renderSystemContext("provider.codex.finalResponse", {});
    const codex = mockProvider("codex", true, true);
    codex.chat.mockResolvedValue({
      content: "ok",
      systemContexts: [providerContext.manifest],
    });
    vi.mocked(createCodexProvider).mockReturnValue(codex as any);

    let releaseAudit: (() => void) | undefined;
    vi.mocked(recordAuditLogSafe).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAudit = resolve;
        }),
    );

    const [provider] = getAgenticLlmProviders("codex", 2000, "context-compiler");
    let completed = false;
    const completion = provider
      ?.chat({
        messages: [{ role: "system", content: requestContext.content.text }],
        maxTokens: 10,
        systemContexts: [requestContext.manifest],
      })
      .then((result) => {
        completed = true;
        return result;
      });

    await vi.waitFor(() => expect(releaseAudit).toBeTypeOf("function"));
    expect(completed).toBe(false);
    releaseAudit?.();
    await expect(completion).resolves.toEqual(expect.objectContaining({ content: "ok" }));
    expect(recordAuditLogSafe).toHaveBeenCalledWith({
      eventType: "SYSTEM_CONTEXT_SUBMITTED",
      actor: "system",
      payload: expect.objectContaining({
        provider: "codex",
        manifests: [
          expect.objectContaining({ key: "shared.jsonOnly" }),
          expect.objectContaining({ key: "provider.codex.finalResponse" }),
        ],
      }),
    });
  });

  test("passes Azure deployment slot routing when configured", () => {
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", true, true) as any,
    );

    const providers = getAgenticLlmProviders("azure-openai", 2000, "context-compiler", [], [2]);
    expect(providers).toHaveLength(1);
    expect(createAzureOpenAiProvider).toHaveBeenCalledWith({
      timeoutMs: 2000,
      deploymentSlots: [2],
    });
  });

  test("wrapped chat does not wait for usage persistence", async () => {
    const azure = mockProvider("azure-openai", true, true);
    azure.chat.mockResolvedValue({ content: "ok" });
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

    vi.mocked(recordLlmUsage).mockReturnValueOnce(new Promise<void>(() => undefined) as never);

    const [provider] = getAgenticLlmProviders("azure-openai", 2000, "context-compiler");
    const result = await provider?.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });

    expect(result?.content).toBe("ok");
    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
  });

  test("checkLlmProviderHealthMatrix reports configured providers and Azure deployments", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "first-key",
        apiBaseUrl: "https://first.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-5-mini",
        apiVersion: "2025-04-01-preview",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-5-mini",
        apiVersion: "2025-04-01-preview",
      },
    ];
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
    ];
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", false, false) as any);
    vi.mocked(createAzureOpenAiProvider).mockImplementation(
      (options?: { deploymentIndex?: number }) =>
        mockProvider(
          "azure-openai",
          true,
          options?.deploymentIndex !== 1,
          options?.deploymentIndex === 1 ? "DeploymentNotFound" : undefined,
        ) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(
      mockProvider("bedrock", false, false, "bedrock unavailable") as any,
    );
    vi.mocked(createLocalLlmProvider).mockReturnValue(mockProvider("local-llm", true, true) as any);

    const health = await checkLlmProviderHealthMatrix(2000, {
      selectedProvider: "azure-openai",
      routeOrder: ["azure-openai", "local-llm"],
    });

    expect(health).toHaveLength(3);
    expect(health.map((item) => item.id)).toEqual([
      "azure-openai:1",
      "azure-openai:2",
      "local-llm:1",
    ]);
    expect(health[0]).toMatchObject({
      label: "Azure OpenAI #1",
      configured: true,
      reachable: true,
      selected: true,
      routeOrder: 0,
      deploymentIndex: 1,
    });
    expect(health[1]).toMatchObject({
      label: "Azure OpenAI #2",
      configured: true,
      reachable: false,
      error: "DeploymentNotFound",
      selected: true,
      routeOrder: 0,
      deploymentIndex: 2,
    });
    expect(health[2]).toMatchObject({
      id: "local-llm:1",
      label: "Primary",
      provider: "local-llm",
      configured: true,
      reachable: true,
      selected: false,
      routeOrder: 1,
    });
    expect(createLocalLlmProvider).toHaveBeenCalledWith({
      timeoutMs: 2000,
      modelConfig: {
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
    });
  });

  test("checkLlmProviderHealthMatrix marks only selected Azure slots when constrained", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "first-key",
        apiBaseUrl: "https://first.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-5-mini",
        apiVersion: "2025-04-01-preview",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-5-mini",
        apiVersion: "2025-04-01-preview",
      },
    ];
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", false, false) as any);
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", true, true) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", false, false) as any);
    vi.mocked(createLocalLlmProvider).mockReturnValue(
      mockProvider("local-llm", false, false) as any,
    );

    const health = await checkLlmProviderHealthMatrix(2000, {
      selectedProvider: "azure-openai",
      routeOrder: ["azure-openai"],
      selectedAzureDeploymentSlots: [2],
    });

    expect(health.find((item) => item.id === "azure-openai:1")?.selected).toBe(false);
    expect(health.find((item) => item.id === "azure-openai:2")?.selected).toBe(true);
  });

  test("checkLlmProviderHealthMatrix reports each configured local LLM model", async () => {
    groupedConfig.localLlm.models = [
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:11434",
        apiPath: "/v1/chat/completions",
        apiKey: "qwen-key",
        model: "qwen3",
      },
      {
        name: "Gemma",
        apiBaseUrl: "http://127.0.0.1:11435",
        apiPath: "/v1/chat/completions",
        apiKey: "gemma-key",
        model: "gemma4",
      },
    ];
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", false, false) as any);
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", false, false) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", false, false) as any);
    vi.mocked(createLocalLlmProvider).mockImplementation(
      (options?: { modelConfig?: { apiBaseUrl: string; model: string } }) =>
        mockProvider("local-llm", Boolean(options?.modelConfig), true) as any,
    );

    const health = await checkLlmProviderHealthMatrix(2000, {
      selectedProvider: "local-llm",
      routeOrder: ["local-llm"],
      selectedLocalLlmModel: "gemma4",
    });

    expect(health.map((item) => item.id)).toEqual(["local-llm:1", "local-llm:2"]);
    expect(health.map((item) => item.label)).toEqual(["Qwen", "Gemma"]);
    expect(health.map((item) => item.routeOrder)).toEqual([0, 0]);
    expect(health.find((item) => item.id === "local-llm:1")?.selected).toBe(false);
    expect(health.find((item) => item.id === "local-llm:2")?.selected).toBe(true);
    expect(createLocalLlmProvider).toHaveBeenCalledWith({
      timeoutMs: 2000,
      modelConfig: {
        apiBaseUrl: "http://127.0.0.1:11434",
        apiPath: "/v1/chat/completions",
        apiKey: "qwen-key",
        model: "qwen3",
      },
    });
    expect(createLocalLlmProvider).toHaveBeenCalledWith({
      timeoutMs: 2000,
      modelConfig: {
        apiBaseUrl: "http://127.0.0.1:11435",
        apiPath: "/v1/chat/completions",
        apiKey: "gemma-key",
        model: "gemma4",
      },
    });
  });

  test("checkLlmProviderHealthMatrix reports Local LLM generation failure without marking endpoint offline", async () => {
    groupedConfig.localLlm.models = [
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:11434",
        apiPath: "/v1/chat/completions",
        apiKey: "qwen-key",
        model: "qwen3",
      },
    ];
    const local = mockProvider("local-llm", true, true);
    local.chat.mockRejectedValue(new Error("The operation was aborted."));
    vi.mocked(createOpenAiProvider).mockReturnValue(mockProvider("openai", false, false) as any);
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", false, false) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", false, false) as any);
    vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

    const health = await checkLlmProviderHealthMatrix(2000, {
      selectedProvider: "local-llm",
      routeOrder: ["local-llm"],
      verifyLocalLlmGeneration: true,
    });

    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      id: "local-llm:1",
      configured: true,
      reachable: true,
      generationChecked: true,
      generationReachable: false,
      localLlmSmokes: [
        { name: "simple_chat", ok: false, error: "The operation was aborted." },
        { name: "json_only", ok: false, error: "The operation was aborted." },
        { name: "tool_result_history", ok: false, error: "The operation was aborted." },
      ],
    });
    expect(health[0]?.generationError).toContain("simple_chat: The operation was aborted.");
    expect(local.chat).toHaveBeenCalledTimes(3);
    expect(local.chat).toHaveBeenNthCalledWith(1, {
      model: "qwen3",
      messages: [{ role: "user", content: "Reply with OK only." }],
      maxTokens: 8,
      temperature: 0,
    });
    expect(local.chat).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        model: "qwen3",
        responseFormat: "json",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant", tool_calls: expect.any(Array) }),
          expect.objectContaining({ role: "tool", tool_call_id: "tool-call-smoke-1" }),
        ]),
      }),
    );
  });

  test("checkLlmProviderHealthMatrix verifies Local LLM chat, JSON, and tool-history smokes", async () => {
    groupedConfig.localLlm.models = [
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:11434",
        apiPath: "/v1/chat/completions",
        apiKey: "qwen-key",
        model: "qwen3",
      },
    ];
    const local = mockProvider("local-llm", true, true);
    local.chat
      .mockResolvedValueOnce({ content: "OK" })
      .mockResolvedValueOnce({ content: '{"ok":true}' })
      .mockResolvedValueOnce({ content: '{"fact":"queue_events_checked"}' });
    vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

    const health = await checkLlmProviderHealthMatrix(2000, {
      selectedProvider: "local-llm",
      routeOrder: ["local-llm"],
      verifyLocalLlmGeneration: true,
    });

    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({
      id: "local-llm:1",
      configured: true,
      reachable: true,
      generationChecked: true,
      generationReachable: true,
      localLlmSmokes: [
        { name: "simple_chat", ok: true, preview: "OK" },
        { name: "json_only", ok: true, preview: '{"ok":true}' },
        { name: "tool_result_history", ok: true, preview: '{"fact":"queue_events_checked"}' },
      ],
    });
    expect(health[0]?.generationError).toBeUndefined();
    expect(local.chat).toHaveBeenCalledTimes(3);
  });

  describe("checkAgenticLlmHealth fallback logic", () => {
    test("returns first configured and reachable provider", async () => {
      // OpenAI and Azure are unconfigured; bedrock is configured & reachable, local is unreachable.
      const openai = mockProvider("openai", false, false);
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", true, true);
      const third = mockProvider("local-llm", true, false);

      vi.mocked(createOpenAiProvider).mockReturnValue(openai as any);
      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.reachable).toBe(true);
      expect(health.selectedProvider).toBe("bedrock");
      expect(health.providerSetting).toBe("auto");
      expect(openai.healthCheck).toHaveBeenCalled();
      expect(first.healthCheck).toHaveBeenCalled();
      expect(second.healthCheck).toHaveBeenCalled();
      expect(third.healthCheck).not.toHaveBeenCalled(); // short-circuited
    });

    test("uses configured fallback when non-auto setting provider is unreachable", async () => {
      const azure = mockProvider("azure-openai", true, false); // configured but unreachable
      const local = mockProvider("local-llm", true, true);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

      const health = await checkAgenticLlmHealth("azure-openai", 5000, ["local-llm"]);

      expect(health.reachable).toBe(true);
      expect(health.selectedProvider).toBe("local-llm");
      expect(health.providerSetting).toBe("azure-openai");
      expect(azure.healthCheck).toHaveBeenCalled();
      expect(local.healthCheck).toHaveBeenCalled();
      expect(health.fallbackOrder).toEqual(["azure-openai", "local-llm"]);
    });

    test("returns selected non-auto provider when no fallback is reachable", async () => {
      const azure = mockProvider("azure-openai", true, false); // configured but unreachable

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

      const health = await checkAgenticLlmHealth("azure-openai");

      expect(health.reachable).toBe(false);
      expect(health.selectedProvider).toBe("azure-openai");
      expect(health.providerSetting).toBe("azure-openai");
      expect(azure.healthCheck).toHaveBeenCalled();
    });

    test("returns first configured but unreachable provider if all configured are unreachable in auto mode", async () => {
      // OpenAI and Azure are unconfigured; bedrock and local are configured but unreachable.
      const openai = mockProvider("openai", false, false);
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", true, false);
      const third = mockProvider("local-llm", true, false);

      vi.mocked(createOpenAiProvider).mockReturnValue(openai as any);
      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.reachable).toBe(false);
      expect(health.selectedProvider).toBe("bedrock"); // first configured
      expect(second.healthCheck).toHaveBeenCalled();
      expect(third.healthCheck).toHaveBeenCalled(); // checks all to find a reachable one
    });

    test("returns error if no providers are configured in auto mode", async () => {
      const openai = mockProvider("openai", false, false);
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", false, false);
      const third = mockProvider("local-llm", false, false);

      vi.mocked(createOpenAiProvider).mockReturnValue(openai as any);
      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.configured).toBe(false);
      expect(health.reachable).toBe(false);
      expect(health.error).toBe("No configured provider in fallback chain");
      expect(openai.healthCheck).toHaveBeenCalledTimes(2); // one in loop, one for fallback first status
    });
  });

  describe("checkDistillationLlmHealth tests", () => {
    test("uses distillation fallback order (local-llm first)", async () => {
      const azure = mockProvider("azure-openai", true, true);
      const bedrock = mockProvider("bedrock", true, true);
      const local = mockProvider("local-llm", true, true);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);
      vi.mocked(createBedrockProvider).mockReturnValue(bedrock as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

      const health = await checkDistillationLlmHealth("auto");

      expect(health.selectedProvider).toBe("local-llm"); // Local LLM is first for distillation fallback
      expect(local.healthCheck).toHaveBeenCalled();
      expect(azure.healthCheck).not.toHaveBeenCalled();
    });

    test("returns error if distillation fallback has no configured providers", async () => {
      const openai = mockProvider("openai", false, false);
      const azure = mockProvider("azure-openai", false, false);
      const bedrock = mockProvider("bedrock", false, false);
      const local = mockProvider("local-llm", false, false);

      vi.mocked(createOpenAiProvider).mockReturnValue(openai as any);
      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);
      vi.mocked(createBedrockProvider).mockReturnValue(bedrock as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

      const health = await checkDistillationLlmHealth("auto");

      expect(health.configured).toBe(false);
      expect(health.error).toBe("No configured provider in distillation fallback chain");
    });

    test("uses configured distillation fallback when primary provider is unreachable", async () => {
      const local = mockProvider("local-llm", true, false);
      const azure = mockProvider("azure-openai", true, true);

      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);
      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

      const health = await checkDistillationLlmHealth("local-llm", 5000, ["azure-openai"]);

      expect(health.reachable).toBe(true);
      expect(health.selectedProvider).toBe("azure-openai");
      expect(local.healthCheck).toHaveBeenCalled();
      expect(azure.healthCheck).toHaveBeenCalled();
      expect(health.fallbackOrder).toEqual(["local-llm", "azure-openai"]);
    });

    test("allows codex as an explicit distillation provider", async () => {
      const codex = mockProvider("codex", true, true);

      vi.mocked(createCodexProvider).mockReturnValue(codex as any);

      const health = await checkDistillationLlmHealth("codex");

      expect(health.reachable).toBe(true);
      expect(health.selectedProvider).toBe("codex");
      expect(codex.healthCheck).toHaveBeenCalled();
      expect(health.fallbackOrder).toEqual(["codex"]);
    });
  });
});
