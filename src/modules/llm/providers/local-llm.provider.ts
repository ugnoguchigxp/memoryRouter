import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";
import { LlmProviderHttpError, parseRetryAfterSeconds } from "../provider-http-error.js";
import { normalizeLlmUsage } from "../usage-normalizer.js";
import {
  checkAgentSessionModel,
  isAgentSessionApiPath,
  runAgentSessionChat,
} from "./agent-session-client.js";
import { buildLocalLlmChatCompletionsUrl, resolveLocalLlmModelConfig } from "./local-llm-config.js";

type LocalLlmResponse = {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type LocalLlmHealthResponse = {
  status?: unknown;
  ready?: unknown;
  loaded?: unknown;
  modelId?: unknown;
  modelPath?: unknown;
  preloadError?: unknown;
};

type LocalLlmProviderOptions = {
  timeoutMs?: number;
  modelConfig?: {
    apiBaseUrl: string;
    apiPath?: string;
    apiKey?: string;
    model: string;
  };
};

function resolveProviderConfig(providerOptions: LocalLlmProviderOptions, model?: string) {
  if (!model?.trim() && providerOptions.modelConfig) {
    return {
      apiBaseUrl: providerOptions.modelConfig.apiBaseUrl.replace(/\/+$/, ""),
      apiPath: providerOptions.modelConfig.apiPath?.trim() || "/v1/chat/completions",
      apiKey: providerOptions.modelConfig.apiKey ?? "",
      model: providerOptions.modelConfig.model,
    };
  }
  return resolveLocalLlmModelConfig(model);
}

function isConfigured(providerOptions: LocalLlmProviderOptions, model?: string): boolean {
  const config = resolveProviderConfig(providerOptions, model);
  return Boolean(config.apiBaseUrl.trim() && config.model.trim());
}

function headers(apiKey?: string): HeadersInit {
  const result: HeadersInit = { "content-type": "application/json" };
  const trimmed = apiKey?.trim();
  if (trimmed) {
    result.Authorization = `Bearer ${trimmed}`;
  }
  return result;
}

function healthUrl(providerOptions: LocalLlmProviderOptions, model?: string): string {
  return `${resolveProviderConfig(providerOptions, model).apiBaseUrl}/health`;
}

async function parseResponse(response: Response): Promise<LlmChatResponse> {
  const payload = (await response.json()) as LocalLlmResponse;
  const choice = payload.choices?.[0];
  const rawContent = choice?.message?.content;
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    throw new Error("local-llm response did not include assistant content");
  }
  const usage = payload.usage
    ? normalizeLlmUsage({
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
      })
    : undefined;
  return {
    content: rawContent,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage,
  };
}

export function createLocalLlmProvider(options: LocalLlmProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);

  return {
    name: "local-llm",
    isConfigured: () => isConfigured(options),
    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      if (!isConfigured(options, request.model)) {
        throw new Error("local-llm is not configured");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const config = resolveProviderConfig(options, request.model);
        if (isAgentSessionApiPath(config.apiPath)) {
          return await runAgentSessionChat(config, request, controller.signal);
        }
        const response = await fetch(
          buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, config.apiPath),
          {
            method: "POST",
            headers: headers(config.apiKey),
            body: JSON.stringify({
              model: config.model,
              messages: request.messages,
              stream: false,
              temperature: request.temperature ?? 0,
              max_tokens: request.maxTokens,
              ...(request.responseFormat === "json"
                ? { response_format: { type: "json_object" as const } }
                : {}),
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new LlmProviderHttpError({
            provider: "local-llm",
            status: response.status,
            retryAfterSeconds: parseRetryAfterSeconds(response.headers),
            requestId: response.headers.get("x-request-id") || undefined,
            message: `local-llm HTTP ${response.status}: ${body.slice(0, 500)}`,
          });
        }

        return parseResponse(response);
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(healthOptions = {}): Promise<LlmHealthStatus> {
      const requestedModel = healthOptions.model?.trim();
      const config = resolveProviderConfig(options, requestedModel);
      const result: LlmHealthStatus = {
        provider: "local-llm",
        configured: isConfigured(options, requestedModel),
        reachable: false,
        model: config.model,
        endpoint: config.apiBaseUrl,
      };

      if (!result.configured) {
        return { ...result, error: "local-llm is not configured" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (isAgentSessionApiPath(config.apiPath)) {
          const health = await checkAgentSessionModel(config, controller.signal);
          return {
            ...result,
            reachable: health.reachable,
            ...(health.error ? { error: health.error } : {}),
          };
        }
        const health = await fetch(healthUrl(options, requestedModel), {
          method: "GET",
          headers: headers(config.apiKey),
          signal: controller.signal,
        });
        if (health.ok) {
          const payload = (await health.json()) as LocalLlmHealthResponse;
          const ready = payload.ready === true || payload.status === "ok";
          const loaded = payload.loaded !== false;
          const model =
            typeof payload.modelId === "string" && payload.modelId.trim()
              ? payload.modelId
              : result.model;
          if (ready && loaded) {
            return {
              ...result,
              reachable: true,
              model,
            };
          }
          const preloadError =
            typeof payload.preloadError === "string" && payload.preloadError.trim()
              ? `: ${payload.preloadError}`
              : "";
          return {
            ...result,
            model,
            error: `local-llm health endpoint is not ready${preloadError}`,
          };
        }
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") {
          return {
            ...result,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        clearTimeout(timer);
      }

      try {
        const ping = await this.chat({
          model: requestedModel,
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 8,
          temperature: 0,
        });
        return {
          ...result,
          reachable: Boolean(ping.content.trim()),
        };
      } catch (error) {
        return {
          ...result,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
