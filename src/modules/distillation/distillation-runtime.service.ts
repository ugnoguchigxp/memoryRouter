import { randomUUID } from "node:crypto";
import { groupedConfig } from "../../config.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { recordLlmUsage } from "../llm/llm-usage-logger.js";
import { createCodexProvider } from "../llm/providers/codex.provider.js";
import { resolveLocalLlmModelConfig } from "../llm/providers/local-llm-config.js";
import { estimateTextTokens } from "../llm/token-estimator.js";
import { ensureRuntimeSettingsLoaded } from "../settings/settings.service.js";
import {
  type DistillationToolCall,
  type DistillationToolResult,
  distillationEvidenceToolNames,
  distillationToolDefinitions,
  executeDistillationToolCall,
} from "./distillation-tools.service.js";
import {
  type DistillationProviderName,
  type DistillationProviderSetting,
  defaultModelForProvider,
  isProviderConfigured,
  resolveDistillationModel,
  resolveDistillationProviderOrder,
} from "./llm-resolver.js";
import { createAzureOpenAiChatClient } from "./providers/azure-openai.js";
import { callBedrockChat } from "./providers/bedrock.js";
import { callLocalLlmChat } from "./providers/local-llm.js";
import { callOpenAiChat } from "./providers/openai.js";

// Re-export types from types.ts to preserve public schema
export type {
  DistillationRuntimeToolDefinition,
  DistillationMessage,
  DistillationModelRequest,
  DistillationChatClient,
  DistillationToolExecutor,
  DistillationCompletionResult,
  DistillationRuntimeOptions,
} from "./types.js";

import type {
  DistillationChatClient,
  DistillationChatRequest,
  DistillationChatResponse,
  DistillationCompletionResult,
  DistillationMessage,
  DistillationModelRequest,
  DistillationRuntimeOptions,
  DistillationRuntimeToolDefinition,
} from "./types.js";

// Re-export resolveDistillationModel and ProviderSetting
export { resolveDistillationModel, type DistillationProviderSetting } from "./llm-resolver.js";

// Re-export internal utilities used by external libraries/tests
export { parseToolCalls, parseOpenAiStyleResponse } from "./providers/helpers.js";
export {
  buildBedrockToolConfig,
  buildBedrockConversation,
  parseBedrockResponse,
} from "./providers/bedrock.js";

type DistillationErrorWithToolEvents = Error & {
  distillationToolEvents?: DistillationToolResult[];
};

type DistillationErrorWithProviderRoute = Error & {
  providerRoute?: DistillationChatResponse["providerRoute"];
};

type MessageSizeSummary = {
  messageCount: number;
  inputChars: number;
  systemChars: number;
  userChars: number;
  assistantChars: number;
  toolChars: number;
  maxMessageChars: number;
};

type InputBudgetSummary = {
  estimatedInputTokens: number;
  effectiveMaxInputTokens: number;
  inputTruncated: boolean;
  droppedOrTruncatedMessageCount: number;
  llmContextWindowTokens: number;
  llmMaxInputTokens: number;
  llmInputSafetyMarginTokens: number;
};

type InputBudgetApplication = InputBudgetSummary & {
  messages: DistillationMessage[];
};

export function resolveRouteModelForProvider(params: {
  provider: DistillationProviderSetting;
  routeModel?: string | null;
  localLlmModel?: string | null;
}): string {
  const routeModel = params.routeModel?.trim() ?? "";
  const localLlmModel = params.localLlmModel?.trim() ?? "";
  if (params.provider === "local-llm") {
    return localLlmModel || routeModel || resolveDistillationModel(params.provider);
  }
  return routeModel || resolveDistillationModel(params.provider);
}

export function distillationToolEventsFromError(error: unknown): DistillationToolResult[] {
  if (!error || typeof error !== "object") return [];
  const events = (error as { distillationToolEvents?: unknown }).distillationToolEvents;
  return Array.isArray(events) ? (events as DistillationToolResult[]) : [];
}

export function errorWithDistillationToolEvents(
  error: unknown,
  toolEvents: DistillationToolResult[],
): Error {
  const normalized: DistillationErrorWithToolEvents =
    error instanceof Error ? error : new Error(String(error));
  if (toolEvents.length > 0) {
    normalized.distillationToolEvents = [...toolEvents];
  }
  return normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("distillation request aborted");
    error.name = "AbortError";
    throw error;
  }
}

function messageContentChars(content: DistillationMessage["content"]): number {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return content.length;
  return JSON.stringify(content).length;
}

function summarizeMessages(messages: DistillationMessage[]): MessageSizeSummary {
  const summary: MessageSizeSummary = {
    messageCount: messages.length,
    inputChars: 0,
    systemChars: 0,
    userChars: 0,
    assistantChars: 0,
    toolChars: 0,
    maxMessageChars: 0,
  };
  for (const message of messages) {
    const chars = messageContentChars(message.content);
    summary.inputChars += chars;
    summary.maxMessageChars = Math.max(summary.maxMessageChars, chars);
    if (message.role === "system") summary.systemChars += chars;
    if (message.role === "user") summary.userChars += chars;
    if (message.role === "assistant") summary.assistantChars += chars;
    if (message.role === "tool") summary.toolChars += chars;
  }
  return summary;
}

function messageContentTokens(content: DistillationMessage["content"]): number {
  if (content === null || content === undefined) return 0;
  return estimateTextTokens(content);
}

function estimateMessageTokens(message: DistillationMessage): number {
  return (
    4 +
    estimateTextTokens(message.role) +
    estimateTextTokens(message.name) +
    messageContentTokens(message.content) +
    estimateTextTokens(message.tool_calls)
  );
}

function estimateInputTokens(messages: DistillationMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function truncateToEstimatedTokens(value: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  if (estimateTextTokens(value) <= tokenBudget) return value;
  const suffix = "\n...[truncated to LLM input budget]";
  const suffixTokens = estimateTextTokens(suffix);
  const contentBudget = Math.max(0, tokenBudget - suffixTokens);
  if (contentBudget <= 0) return suffix.trim();

  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, mid)}${suffix}`;
    if (estimateTextTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || suffix.trim();
}

function lastUserMessageIndex(messages: DistillationMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function truncationPriority(
  message: DistillationMessage,
  index: number,
  lastUserIndex: number,
): number {
  if (message.role === "tool") return 0;
  if (message.role === "assistant") return 1;
  if (message.role === "user" && index === lastUserIndex) return 3;
  if (message.role === "user") return 2;
  return 4;
}

function effectiveMaxInputTokens(completionMaxTokens: number): InputBudgetSummary {
  const llmContextWindowTokens = Math.max(1, groupedConfig.distillation.llmContextWindowTokens);
  const llmMaxInputTokens = Math.max(1, groupedConfig.distillation.llmMaxInputTokens);
  const llmInputSafetyMarginTokens = Math.max(
    0,
    groupedConfig.distillation.llmInputSafetyMarginTokens,
  );
  const maxByWindow =
    llmContextWindowTokens - Math.max(0, completionMaxTokens) - llmInputSafetyMarginTokens;
  return {
    estimatedInputTokens: 0,
    effectiveMaxInputTokens: Math.max(1, Math.min(llmMaxInputTokens, maxByWindow)),
    inputTruncated: false,
    droppedOrTruncatedMessageCount: 0,
    llmContextWindowTokens,
    llmMaxInputTokens,
    llmInputSafetyMarginTokens,
  };
}

function applyInputTokenBudget(params: {
  messages: DistillationMessage[];
  completionMaxTokens: number;
}): InputBudgetApplication {
  const budget = effectiveMaxInputTokens(params.completionMaxTokens);
  const messages = params.messages.map((message) => ({ ...message }));
  let estimatedInputTokens = estimateInputTokens(messages);
  if (estimatedInputTokens <= budget.effectiveMaxInputTokens) {
    return { ...budget, messages, estimatedInputTokens };
  }

  const lastUserIndex = lastUserMessageIndex(messages);
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => {
      if (message.role === "system") return false;
      return typeof message.content === "string" && message.content.length > 0;
    })
    .sort((left, right) => {
      const priorityDiff =
        truncationPriority(left.message, left.index, lastUserIndex) -
        truncationPriority(right.message, right.index, lastUserIndex);
      if (priorityDiff !== 0) return priorityDiff;
      return left.index - right.index;
    });

  let droppedOrTruncatedMessageCount = 0;
  for (const { index } of candidates) {
    if (estimatedInputTokens <= budget.effectiveMaxInputTokens) break;
    const message = messages[index];
    if (!message || typeof message.content !== "string" || !message.content) continue;
    const contentTokens = estimateTextTokens(message.content);
    const overage = estimatedInputTokens - budget.effectiveMaxInputTokens;
    const nextBudget = Math.max(0, contentTokens - overage);
    const nextContent = truncateToEstimatedTokens(message.content, nextBudget);
    if (nextContent === message.content) continue;
    messages[index] = { ...message, content: nextContent };
    droppedOrTruncatedMessageCount += 1;
    estimatedInputTokens = estimateInputTokens(messages);
  }

  if (estimatedInputTokens > budget.effectiveMaxInputTokens) {
    throw new Error(
      `distillation input exceeds configured LLM max input tokens: estimated=${estimatedInputTokens}, limit=${budget.effectiveMaxInputTokens}`,
    );
  }

  return {
    ...budget,
    messages,
    estimatedInputTokens,
    inputTruncated: droppedOrTruncatedMessageCount > 0,
    droppedOrTruncatedMessageCount,
  };
}

function shouldRecordCoverEvidenceLlmAudit(auditContext: Record<string, unknown> | undefined) {
  return auditContext?.domain === "coverEvidence";
}

function stringContextValue(
  auditContext: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = auditContext?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coverEvidenceLlmStage(auditContext: Record<string, unknown> | undefined): string {
  return (
    stringContextValue(auditContext, "stage") ??
    stringContextValue(auditContext, "assessment") ??
    stringContextValue(auditContext, "optionalEvidence") ??
    "unknown"
  );
}

function coverEvidenceLlmBasePayload(params: {
  auditContext: Record<string, unknown>;
  request: DistillationModelRequest;
  messages: DistillationMessage[];
  round: number;
  toolRounds: number;
  providerSetting?: DistillationProviderSetting;
  fallbackOrder?: DistillationProviderName[];
  timeoutMs?: number;
  enableTools: boolean;
  allowTools: boolean;
  toolChoice: "auto" | "none" | "required";
  toolDefinitions: DistillationRuntimeToolDefinition[];
  requestAuditId: string;
  inputBudget: InputBudgetSummary;
}): Record<string, unknown> {
  const providerSetting = params.providerSetting ?? groupedConfig.distillation.provider;
  const providerOrder = resolveDistillationProviderOrder(
    providerSetting,
    params.fallbackOrder ?? [],
  );
  const messageSummary = summarizeMessages(params.messages);
  return {
    ...params.auditContext,
    requestAuditId: params.requestAuditId,
    stage: coverEvidenceLlmStage(params.auditContext),
    round: params.round,
    toolRounds: params.toolRounds,
    providerSetting,
    fallbackOrder: params.fallbackOrder,
    providerOrder,
    model: params.request.model,
    maxTokens: params.request.maxTokens,
    timeoutMs: params.timeoutMs,
    estimatedInputTokens: params.inputBudget.estimatedInputTokens,
    effectiveMaxInputTokens: params.inputBudget.effectiveMaxInputTokens,
    inputTruncated: params.inputBudget.inputTruncated,
    droppedOrTruncatedMessageCount: params.inputBudget.droppedOrTruncatedMessageCount,
    llmContextWindowTokens: params.inputBudget.llmContextWindowTokens,
    llmMaxInputTokens: params.inputBudget.llmMaxInputTokens,
    llmInputSafetyMarginTokens: params.inputBudget.llmInputSafetyMarginTokens,
    enableTools: params.enableTools,
    allowTools: params.allowTools,
    toolChoice: params.toolChoice,
    toolDefinitionCount: params.toolDefinitions.length,
    ...messageSummary,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyLlmError(error: unknown): string {
  const name = errorName(error);
  const message = errorMessage(error).toLowerCase();
  if (name === "AbortError" || message.includes("aborted")) return "aborted";
  if (message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("unable to connect") || message.includes("connection"))
    return "connectivity";
  if (message.includes("prompt_too_large") || message.includes("context_length_exceeded")) {
    return "input_too_large";
  }
  if (message.includes("http 503")) return "daemon_unavailable";
  if (message.includes("http 500")) return "daemon_error";
  return "provider_error";
}

function fallbackUsedFromRoute(
  route: DistillationChatResponse["providerRoute"] | undefined,
): boolean {
  if (!route) return false;
  if (route.fallbackUsed) return true;
  const selected = route.selectedProvider;
  const primary = route.providerOrder[0];
  return Boolean(selected && primary && selected !== primary);
}

function providerRouteFromError(
  error: unknown,
): DistillationChatResponse["providerRoute"] | undefined {
  if (!error || typeof error !== "object") return undefined;
  const route = (error as { providerRoute?: DistillationChatResponse["providerRoute"] })
    .providerRoute;
  return route;
}

function normalizeToolCallLimits(limits: Record<string, number> | undefined): Map<string, number> {
  const normalized = new Map<string, number>();
  if (!limits) return normalized;
  for (const [name, value] of Object.entries(limits)) {
    const limit = Math.max(0, Math.floor(value));
    normalized.set(name, limit);
  }
  return normalized;
}

function availableToolDefinitions(
  toolDefinitions: DistillationRuntimeToolDefinition[],
  limits: Map<string, number>,
  counts: Map<string, number>,
): DistillationRuntimeToolDefinition[] {
  if (limits.size === 0) return toolDefinitions;
  return toolDefinitions.filter((tool) => {
    const limit = limits.get(tool.function.name);
    return limit === undefined || (counts.get(tool.function.name) ?? 0) < limit;
  });
}

function toolLimitExceededResult(
  toolCall: DistillationToolCall,
  limit: number,
): DistillationToolResult {
  const message = `distillation tool call limit exceeded for ${toolCall.function.name} (${limit})`;
  return {
    callId: toolCall.id,
    name: toolCall.function.name,
    ok: false,
    content: JSON.stringify({
      error: message,
      instruction: "Stop calling this tool and return the best supported final JSON.",
    }),
    error: message,
    metadata: {
      limit,
      limitExceeded: true,
    },
  };
}

type ToolCallArgumentFallback = {
  content: string;
  toolCallName: string;
  argumentKey?: string;
  rawArgumentsPreview: string;
};

function parseToolCallArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch {
    return null;
  }
}

function preferredToolArgumentKeys(toolName: string): string[] {
  if (toolName === "search_web") return ["query", "q", "keywords"];
  if (toolName === "fetch_content") return ["url", "selection"];
  return ["query", "url", "selection", "content", "text"];
}

function stringFromToolArgument(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toolCallArgumentFallbackFromResponse(
  toolCalls: DistillationToolCall[],
): ToolCallArgumentFallback | null {
  for (const toolCall of toolCalls) {
    const rawArguments = toolCall.function.arguments;
    const parsedArguments = parseToolCallArguments(rawArguments);
    if (parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)) {
      const args = parsedArguments as Record<string, unknown>;
      for (const key of preferredToolArgumentKeys(toolCall.function.name)) {
        const value = stringFromToolArgument(args[key]);
        if (value) {
          return {
            content: value,
            toolCallName: toolCall.function.name,
            argumentKey: key,
            rawArgumentsPreview: rawArguments.slice(0, 700),
          };
        }
      }
    }

    const rawValue = stringFromToolArgument(rawArguments);
    if (rawValue && rawValue !== "{}") {
      return {
        content: rawValue,
        toolCallName: toolCall.function.name,
        rawArgumentsPreview: rawArguments.slice(0, 700),
      };
    }
  }

  return null;
}

const callCodexChat = async (
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> => {
  const provider = createCodexProvider({
    timeoutMs: request.timeoutMs,
    model: request.model,
  });

  const llmMessages = request.messages.map((msg) => {
    const role =
      msg.role === "system" || msg.role === "user" || msg.role === "assistant" ? msg.role : "user";
    const baseContent =
      typeof msg.content === "string"
        ? msg.content
        : msg.content === null || msg.content === undefined
          ? ""
          : JSON.stringify(msg.content);
    const toolCalls =
      msg.tool_calls && msg.tool_calls.length > 0
        ? `\n\n[Tool Calls]\n${JSON.stringify(msg.tool_calls)}`
        : "";
    const content =
      msg.role === "tool"
        ? `[Tool Result: ${msg.name ?? "tool"}]\n${baseContent}`
        : `${baseContent}${toolCalls}`;
    return { role, content };
  });

  const response = await provider.chat({
    messages: llmMessages,
    maxTokens: request.maxTokens,
  });

  return {
    content: response.content || null,
    finishReason: response.finishReason,
    usage: response.usage,
    toolCalls: [],
  };
};

export function createDefaultChatClient(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
  usageSource = "distillation",
  fallbackOrder: DistillationProviderName[] = [],
  azureDeploymentSlots?: number[],
  localLlmModel?: string,
): DistillationChatClient {
  const order = resolveDistillationProviderOrder(providerSetting, fallbackOrder);
  let pinnedProvider: DistillationProviderName | null = null;
  const azureOpenAiChatClient = createAzureOpenAiChatClient(azureDeploymentSlots);
  const requestModelOwner =
    providerSetting === "auto"
      ? (order.find((provider) => isProviderConfigured(provider)) ?? order[0] ?? "local-llm")
      : providerSetting;

  const callByProvider: Record<DistillationProviderName, DistillationChatClient> = {
    "local-llm": callLocalLlmChat,
    openai: callOpenAiChat,
    "azure-openai": azureOpenAiChatClient,
    bedrock: callBedrockChat,
    codex: callCodexChat,
  };

  return async (request: DistillationChatRequest): Promise<DistillationChatResponse> => {
    const providersToTry = pinnedProvider
      ? [pinnedProvider, ...order.filter((provider) => provider !== pinnedProvider)]
      : order;
    const providerOrder = [...order];
    const primaryProvider = providerOrder[0];
    const allowFallback = providerSetting === "auto" || order.length > 1;
    const errors: string[] = [];
    const attemptedProviders: DistillationProviderName[] = [];
    const providerErrorKinds: Partial<Record<DistillationProviderName, string>> = {};

    for (const provider of providersToTry) {
      if (!isProviderConfigured(provider)) {
        errors.push(`${provider}: not configured`);
        continue;
      }
      attemptedProviders.push(provider);

      const requestModel = request.model.trim();
      const model =
        provider === "local-llm" && localLlmModel?.trim()
          ? localLlmModel.trim()
          : requestModel && provider === requestModelOwner
            ? requestModel
            : defaultModelForProvider(provider);
      const recordedModel =
        provider === "local-llm" ? resolveLocalLlmModelConfig(model).model : model;

      try {
        const response = await callByProvider[provider]({ ...request, model });
        recordLlmUsage({
          provider,
          model: recordedModel,
          usage: response.usage,
          promptMessages: request.messages,
          promptMetadata: {
            tools: request.tools,
            toolChoice: request.toolChoice,
          },
          completionText: response.content ?? "",
          completionMetadata: response.toolCalls,
          source: usageSource,
        });
        if (request.systemContexts && request.systemContexts.length > 0) {
          await recordAuditLogSafe({
            eventType: auditEventTypes.systemContextSubmitted,
            actor: "system",
            payload: {
              source: usageSource,
              provider,
              model: recordedModel,
              manifests: request.systemContexts,
            },
          });
        }
        pinnedProvider = provider;
        return {
          ...response,
          provider,
          model,
          providerRoute: {
            providerOrder,
            attemptedProviders,
            selectedProvider: provider,
            selectedProviderDetails:
              provider === "local-llm"
                ? { model: recordedModel, routeTarget: model }
                : provider === "azure-openai"
                  ? response.providerMetadata
                  : undefined,
            fallbackUsed:
              attemptedProviders.length > 1 ||
              (primaryProvider !== undefined && provider !== primaryProvider),
            providerErrorKinds,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider}: ${message}`);
        providerErrorKinds[provider] = classifyLlmError(error);
        if (error instanceof Error && error.name === "AbortError" && request.signal?.aborted) {
          throw error;
        }
        if (!allowFallback) {
          const wrapped: DistillationErrorWithProviderRoute =
            error instanceof Error ? error : new Error(String(error));
          wrapped.providerRoute = {
            providerOrder,
            attemptedProviders,
            selectedProvider: undefined,
            fallbackUsed: attemptedProviders.some(
              (candidateProvider) => candidateProvider !== primaryProvider,
            ),
            providerErrorKinds,
          };
          throw wrapped;
        }
        pinnedProvider = null;
      }
    }

    const error: DistillationErrorWithProviderRoute = new Error(
      errors.join(" | ") || "no distillation provider available",
    );
    error.providerRoute = {
      providerOrder,
      attemptedProviders,
      selectedProvider: undefined,
      fallbackUsed: attemptedProviders.some(
        (candidateProvider) => candidateProvider !== primaryProvider,
      ),
      providerErrorKinds,
    };
    throw error;
  };
}

export async function runDistillationCompletion(
  request: DistillationModelRequest,
  options: DistillationRuntimeOptions = {},
): Promise<DistillationCompletionResult> {
  await ensureRuntimeSettingsLoaded();
  const chatClient =
    options.chatClient ??
    createDefaultChatClient(
      options.providerSetting ?? groupedConfig.distillation.provider,
      options.usageSource ?? "distillation",
      options.fallbackOrder,
      options.azureDeploymentSlots,
      options.localLlmModel,
    );
  const toolExecutor = options.toolExecutor ?? executeDistillationToolCall;
  const maxToolRounds = Math.max(
    0,
    options.maxToolRounds ?? groupedConfig.distillationTools.maxRounds,
  );
  const enableTools = options.enableTools ?? true;
  const defaultToolNames = new Set<string>(distillationEvidenceToolNames);
  const toolDefinitions =
    options.toolDefinitions && options.toolDefinitions.length > 0
      ? options.toolDefinitions
      : options.toolNames?.length
        ? distillationToolDefinitions.filter((tool) =>
            options.toolNames?.includes(tool.function.name),
          )
        : distillationToolDefinitions.filter((tool) => defaultToolNames.has(tool.function.name));
  const requireToolCall = Boolean(options.requireToolCall);
  const messages = request.messages.map((message) => ({ ...message }));
  const toolEvents: DistillationToolResult[] = [];
  const toolCallLimits = normalizeToolCallLimits(options.toolCallLimits);
  const toolCallCounts = new Map<string, number>();
  let toolRounds = 0;
  let chatRound = 0;
  let requiredToolReminderSent = false;
  let blankResponseReminderSent = false;

  try {
    while (true) {
      throwIfAborted(options.signal);
      const roundToolDefinitions =
        enableTools && toolRounds < maxToolRounds
          ? availableToolDefinitions(toolDefinitions, toolCallLimits, toolCallCounts)
          : [];
      const allowTools =
        enableTools && toolRounds < maxToolRounds && roundToolDefinitions.length > 0;
      const toolChoice = allowTools
        ? requireToolCall && toolRounds === 0
          ? "required"
          : "auto"
        : "none";
      chatRound += 1;
      const inputBudget = applyInputTokenBudget({
        messages,
        completionMaxTokens: request.maxTokens,
      });
      const requestAuditId = randomUUID();
      const auditContext = options.auditContext;
      const shouldAudit =
        auditContext !== undefined && shouldRecordCoverEvidenceLlmAudit(auditContext);
      const auditBase =
        shouldAudit && auditContext
          ? coverEvidenceLlmBasePayload({
              auditContext,
              request,
              messages: inputBudget.messages,
              round: chatRound,
              toolRounds,
              providerSetting: options.providerSetting,
              fallbackOrder: options.fallbackOrder,
              timeoutMs: options.timeoutMs,
              enableTools,
              allowTools,
              toolChoice,
              toolDefinitions: roundToolDefinitions,
              requestAuditId,
              inputBudget,
            })
          : undefined;
      if (auditBase) {
        await recordAuditLogSafe({
          eventType: auditEventTypes.coverEvidenceLlmStarted,
          actor: "system",
          payload: auditBase,
        });
      }
      const startedAt = Date.now();
      let response: DistillationChatResponse;
      try {
        response = await chatClient({
          ...request,
          messages: inputBudget.messages,
          tools: allowTools ? roundToolDefinitions : undefined,
          toolChoice,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
      } catch (error) {
        if (auditBase) {
          const providerRoute = providerRouteFromError(error);
          const baseProviderOrder = Array.isArray(auditBase.providerOrder)
            ? (auditBase.providerOrder as DistillationProviderName[])
            : undefined;
          const providerOrder = providerRoute?.providerOrder ?? baseProviderOrder;
          const attemptedProviders =
            providerRoute?.attemptedProviders ??
            (providerOrder?.[0] ? [providerOrder[0]] : undefined);
          const providerErrorKinds =
            providerRoute?.providerErrorKinds ??
            (providerOrder?.[0]
              ? {
                  [providerOrder[0]]: classifyLlmError(error),
                }
              : undefined);
          await recordAuditLogSafe({
            eventType: auditEventTypes.coverEvidenceLlmFailed,
            actor: "system",
            payload: {
              ...auditBase,
              durationMs: Date.now() - startedAt,
              errorName: errorName(error),
              error: errorMessage(error),
              errorKind: classifyLlmError(error),
              providerOrder,
              attemptedProviders,
              selectedProvider: providerRoute?.selectedProvider,
              fallbackUsed: fallbackUsedFromRoute(providerRoute),
              providerErrorKinds,
            },
          });
        }
        throw error;
      }
      const providerRoute = response.providerRoute;
      const noToolArgumentFallback =
        !allowTools && options.fallbackToolCallArguments && response.toolCalls.length > 0
          ? toolCallArgumentFallbackFromResponse(response.toolCalls)
          : null;
      const outputContent = noToolArgumentFallback?.content ?? response.content;
      if (auditBase) {
        await recordAuditLogSafe({
          eventType: auditEventTypes.coverEvidenceLlmCompleted,
          actor: "system",
          payload: {
            ...auditBase,
            durationMs: Date.now() - startedAt,
            provider: response.provider,
            resolvedModel: response.model,
            finishReason: response.finishReason,
            outputChars: outputContent?.length ?? 0,
            outputPreview: outputContent?.slice(0, 700) ?? undefined,
            responseToolCallCount: response.toolCalls.length,
            responseToolCallNames: response.toolCalls.map((call) => call.function.name),
            toolCallArgumentFallbackUsed: Boolean(noToolArgumentFallback),
            toolCallArgumentFallbackName: noToolArgumentFallback?.toolCallName,
            toolCallArgumentFallbackKey: noToolArgumentFallback?.argumentKey,
            toolCallArgumentFallbackRawArguments:
              noToolArgumentFallback?.rawArgumentsPreview ?? undefined,
            promptTokens: response.usage?.promptTokens,
            completionTokens: response.usage?.completionTokens,
            totalTokens: response.usage?.totalTokens,
            reasoningTokens: response.usage?.reasoningTokens,
            providerOrder: providerRoute?.providerOrder,
            attemptedProviders: providerRoute?.attemptedProviders,
            selectedProvider: providerRoute?.selectedProvider ?? response.provider,
            fallbackUsed: fallbackUsedFromRoute(providerRoute),
            providerErrorKinds: providerRoute?.providerErrorKinds,
            selectedProviderDetails: providerRoute?.selectedProviderDetails,
          },
        });
      }

      if (noToolArgumentFallback) {
        const finalMessage: DistillationMessage = {
          role: "assistant",
          content: noToolArgumentFallback.content,
        };
        return {
          content: noToolArgumentFallback.content,
          toolEvents,
          messages: [...messages, finalMessage],
        };
      }

      if (response.toolCalls.length > 0 && allowTools) {
        messages.push({
          role: "assistant",
          content: response.content ?? null,
          tool_calls: response.toolCalls,
        });

        const toolResultReminderLines: string[] = [];
        for (const toolCall of response.toolCalls) {
          throwIfAborted(options.signal);
          const limit = toolCallLimits.get(toolCall.function.name);
          const used = toolCallCounts.get(toolCall.function.name) ?? 0;
          if (limit !== undefined && used >= limit) {
            const limitResult = toolLimitExceededResult(toolCall, limit);
            toolEvents.push(limitResult);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: limitResult.name,
              content: limitResult.content,
            });
            continue;
          }
          const toolResult = await toolExecutor(toolCall, options.auditContext);
          toolCallCounts.set(toolCall.function.name, used + 1);
          throwIfAborted(options.signal);
          toolEvents.push(toolResult);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolResult.name,
            content: toolResult.content,
          });
          const reminderLines = options.toolResultReminder?.(toolResult) ?? [];
          if (reminderLines.length > 0) {
            toolResultReminderLines.push(...reminderLines);
          }
        }
        if (toolResultReminderLines.length > 0) {
          messages.push({
            role: "user",
            content: [...new Set(toolResultReminderLines)].join("\n"),
          });
        }
        toolRounds += 1;
        continue;
      }

      if (response.toolCalls.length > 0) {
        throw new Error(`distillation tool loop exceeded max rounds (${maxToolRounds})`);
      }

      if (
        typeof response.content === "string" &&
        allowTools &&
        requireToolCall &&
        toolRounds === 0 &&
        toolEvents.length === 0 &&
        !requiredToolReminderSent
      ) {
        requiredToolReminderSent = true;
        messages.push({
          role: "assistant",
          content: response.content,
        });
        const reminderLines =
          options.requireToolCallReminder && options.requireToolCallReminder.length > 0
            ? options.requireToolCallReminder
            : [
                "直前の応答はまだ採用できません。",
                "この検証 session は外部証拠の tool call が必須です。最終候補を返す前に search_web または fetch_content を少なくとも 1 回呼び出してください。",
                "search_web の結果は URL 発見用です。検索結果を受け取った後は、有望な一次ソース URL を fetch_content してから最終候補を返してください。",
                "search_web は最大 1 回、fetch_content は最大 3 回です。同義の search_web query を繰り返すより、検索結果 URL を fetch_content してください。",
                'ローカル tool-call parser 向けには {"name":"search_web","arguments":{"query":"..."}} または {"name":"fetch_content","arguments":{"url":"https://..."}} だけを返してください。',
                "この tool-call JSON は中間応答専用です。最終 candidates の title/body に tool 名だけを入れないでください。",
              ];
        messages.push({
          role: "user",
          content: reminderLines.join("\n"),
        });
        continue;
      }

      if (typeof response.content === "string" && response.content.trim()) {
        const finalMessage: DistillationMessage = {
          role: "assistant",
          content: response.content,
        };
        return {
          content: response.content,
          toolEvents,
          messages: [...messages, finalMessage],
        };
      }

      if (
        typeof response.content === "string" &&
        !response.content.trim() &&
        !blankResponseReminderSent
      ) {
        blankResponseReminderSent = true;
        messages.push({
          role: "assistant",
          content: response.content,
        });
        const reminderLines =
          options.blankResponseReminder && options.blankResponseReminder.length > 0
            ? options.blankResponseReminder
            : [
                "直前の応答は空でした。",
                '最終回答として {"candidates":[]}、または TYPE: rule、TITLE: ...、BODY: ...、CONFIDENCE: ...、IMPORTANCE: ... のラベル付きテキストを返してください。',
                "TYPE / TITLE / BODY のような見出し行だけを出さないでください。",
              ];
        messages.push({
          role: "user",
          content: reminderLines.join("\n"),
        });
        continue;
      }

      throw new Error("distillation response did not include assistant content");
    }
  } catch (error) {
    throw errorWithDistillationToolEvents(error, toolEvents);
  }
}

export async function callLocalLlmCompletionForDistillation(
  request: DistillationModelRequest,
): Promise<DistillationCompletionResult> {
  return runDistillationCompletion(request, {
    providerSetting: "local-llm",
    usageSource: "distillation",
  });
}
