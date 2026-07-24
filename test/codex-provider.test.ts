import { beforeEach, describe, expect, it, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { createCodexProvider } from "../src/modules/llm/providers/codex.provider.js";

const codexSdkMocks = vi.hoisted(() => ({
  Codex: vi.fn(),
  run: vi.fn(),
  startThread: vi.fn(),
}));
const codexAuthMocks = vi.hoisted(() => ({
  checkCodexAuthStatus: vi.fn(),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: codexSdkMocks.Codex,
}));
vi.mock("../src/modules/codex/codex-auth.service.js", () => ({
  checkCodexAuthStatus: codexAuthMocks.checkCodexAuthStatus,
}));

describe("codex provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexSdkMocks.run.mockResolvedValue({
      finalResponse: '{"ok":true}',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
      },
    });
    codexSdkMocks.startThread.mockReturnValue({ run: codexSdkMocks.run });
    codexSdkMocks.Codex.mockImplementation(
      class {
        startThread = codexSdkMocks.startThread;
      } as never,
    );
    codexAuthMocks.checkCodexAuthStatus.mockResolvedValue({
      codexHome: "/tmp/.codex",
      cliAvailable: true,
      authJsonExists: true,
      accessTokenConfigured: false,
      tokenInfo: null,
      recommendedAction: "ready",
    });
  });

  it("uses Codex SDK as a generic chat provider without a fixed output schema", async () => {
    const originalCodex = { ...groupedConfig.codex };
    try {
      groupedConfig.codex.accessToken = " token ";
      const provider = createCodexProvider({ timeoutMs: 1000, model: "gpt-5.4-mini" });

      const response = await provider.chat({
        messages: [
          { role: "system", content: "Return JSON for this task." },
          { role: "user", content: "ping" },
        ],
        maxTokens: 123,
        responseFormat: "json",
      });

      expect(response).toMatchObject({
        content: '{"ok":true}',
        finishReason: "stop",
        systemContexts: [
          expect.objectContaining({
            key: "provider.codex.finalResponse",
            resolvedLocale: "ja-JP",
            renderedHash: expect.stringMatching(/^sha256:/),
          }),
        ],
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      });
      expect(codexSdkMocks.Codex).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { max_tokens: 123 },
          env: expect.objectContaining({ CODEX_ACCESS_TOKEN: "token" }),
        }),
      );
      expect(codexSdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.4-mini",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
        }),
      );

      const [prompt, runOptions] = codexSdkMocks.run.mock.calls[0] ?? [];
      expect(prompt).toContain("[System Instructions]\nReturn JSON for this task.");
      expect(prompt).toContain("[User]\nping");
      expect(prompt).toContain(
        "[Instructions]\nBased on the instructions and history above, generate the final response.",
      );
      expect(runOptions).toEqual({ signal: expect.any(AbortSignal) });
      expect(runOptions).not.toHaveProperty("outputSchema");
    } finally {
      groupedConfig.codex = originalCodex;
    }
  });

  it("healthCheck validates auth and SDK availability without running a Codex turn", async () => {
    const provider = createCodexProvider({ timeoutMs: 1000, model: "gpt-5.4-mini" });

    const status = await provider.healthCheck();

    expect(status).toMatchObject({
      provider: "codex",
      configured: true,
      reachable: true,
      model: "gpt-5.4-mini",
      endpoint: "codex-api",
    });
    expect(codexAuthMocks.checkCodexAuthStatus).toHaveBeenCalled();
    expect(codexSdkMocks.Codex).not.toHaveBeenCalled();
    expect(codexSdkMocks.startThread).not.toHaveBeenCalled();
    expect(codexSdkMocks.run).not.toHaveBeenCalled();
  });
});
