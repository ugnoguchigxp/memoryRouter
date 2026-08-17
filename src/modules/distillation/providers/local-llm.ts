import { groupedConfig } from "../../../config.js";
import {
  buildLocalLlmChatCompletionsUrl,
  resolveLocalLlmModelConfig,
} from "../../llm/providers/local-llm-config.js";
import type { DistillationChatRequest, DistillationChatResponse } from "../types.js";
import { parseOpenAiStyleResponse, withRequestTimeout } from "./helpers.js";

function localLlmHeaders(apiKey?: string): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  const trimmed = apiKey?.trim();
  if (trimmed) {
    headers.Authorization = `Bearer ${trimmed}`;
  }
  return headers;
}

export function assertLocalLlmMessageCompatibility(
  messages: DistillationChatRequest["messages"],
): void {
  const systemIndexes = messages.flatMap((message, index) =>
    message.role === "system" ? [index] : [],
  );
  if (systemIndexes.length > 1 || (systemIndexes.length === 1 && systemIndexes[0] !== 0)) {
    throw new Error(
      "local-llm incompatible message sequence: expected at most one leading system message",
    );
  }
}

export async function callLocalLlmChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  assertLocalLlmMessageCompatibility(request.messages);
  return withRequestTimeout(
    request.timeoutMs ?? groupedConfig.distillation.timeoutMs,
    async (signal) => {
      const config = resolveLocalLlmModelConfig(request.model);
      const response = await fetch(
        buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, config.apiPath),
        {
          method: "POST",
          headers: localLlmHeaders(config.apiKey),
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            stream: false,
            temperature: 0,
            max_tokens: request.maxTokens,
            priority: "low",
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools,
                  tool_choice: request.toolChoice ?? "auto",
                }
              : {
                  tool_choice: request.toolChoice ?? "none",
                }),
          }),
          signal,
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`local-llm HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      return parseOpenAiStyleResponse(await response.json());
    },
    request.signal,
  );
}
