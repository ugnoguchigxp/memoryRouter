import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupedConfig } from "../../../config.js";
import { checkCodexAuthStatus } from "../../codex/codex-auth.service.js";
import { renderSystemContext } from "../../system-context/system-context.service.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";

// Safe dynamic import to allow compilation when package is not fully installed
async function loadCodexSdk() {
  try {
    const { Codex } = await import("@openai/codex-sdk");
    return Codex;
  } catch (error) {
    throw new Error(
      "Codex SDK is not installed. Please run `bun add @openai/codex-sdk` to install it.",
    );
  }
}

export function createCodexProvider(
  options: { timeoutMs?: number; model?: string } = {},
): LlmProvider {
  const defaultTimeoutMs = options.timeoutMs ?? 60_000;
  const configuredModel = options.model || undefined;

  return {
    name: "codex",

    isConfigured(): boolean {
      const hasEnvToken = Boolean(groupedConfig.codex.accessToken.trim());
      if (hasEnvToken) return true;
      const authJsonPath = path.join(os.homedir(), ".codex", "auth.json");
      return fs.existsSync(authJsonPath);
    },

    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      const CodexClass = await loadCodexSdk();

      const sdkOptions: any = {
        config: {
          max_tokens: request.maxTokens,
        },
      };

      if (groupedConfig.codex.accessToken.trim()) {
        sdkOptions.env = {
          ...process.env,
          CODEX_ACCESS_TOKEN: groupedConfig.codex.accessToken.trim(),
        };
      }

      const codex = new CodexClass(sdkOptions);

      // Start the conversation thread with safety defaults
      const thread = codex.startThread({
        model: configuredModel,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });

      // P1: Reconstruct system prompt and conversation history into a single prompt context
      // to ensure Codex doesn't throw away system goals/output contracts.
      const formattedMessages = request.messages
        .map((msg) => {
          const roleLabel =
            msg.role === "system"
              ? "System Instructions"
              : msg.role === "user"
                ? "User"
                : "Assistant";
          return `[${roleLabel}]\n${msg.content ?? ""}`;
        })
        .join("\n\n");

      const finalResponseContext = renderSystemContext("provider.codex.finalResponse", {});
      const prompt = `${formattedMessages}\n\n${finalResponseContext.content.text}`;

      // P1: Wire timeout guard using AbortController
      const timeoutMs = defaultTimeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const turn = await thread.run(prompt, { signal: controller.signal });

        return {
          content: turn.finalResponse,
          finishReason: "stop",
          systemContexts: [finalResponseContext.manifest],
          usage: turn.usage
            ? {
                promptTokens: turn.usage.input_tokens,
                completionTokens: turn.usage.output_tokens,
                totalTokens: turn.usage.input_tokens + turn.usage.output_tokens,
              }
            : {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              },
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async healthCheck(): Promise<LlmHealthStatus> {
      const authStatus = await checkCodexAuthStatus();
      const configured = authStatus.recommendedAction === "ready";

      const statusResult: LlmHealthStatus = {
        provider: "codex",
        configured,
        reachable: false,
        model: configuredModel ?? "codex-sdk-agent",
        endpoint: "codex-api",
      };

      if (!configured) {
        return {
          ...statusResult,
          error: "Codex SDK is not logged in or configured.",
        };
      }

      try {
        await loadCodexSdk();
        return {
          ...statusResult,
          reachable: true,
        };
      } catch (error) {
        return {
          ...statusResult,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
