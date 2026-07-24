import { groupedConfig } from "../../config.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { getRuntimeSettingsSnapshot } from "../settings/settings.service.ts";
import type { LlmHealthStatus, LlmProvider, LlmProviderName } from "./llm-provider.js";
import { recordLlmUsage } from "./llm-usage-logger.js";
import { configuredAzureOpenAiDeploymentSlots } from "./providers/azure-openai-config.js";
import { createAzureOpenAiProvider } from "./providers/azure-openai.provider.js";
import { createBedrockProvider } from "./providers/bedrock.provider.js";
import { createCodexProvider } from "./providers/codex.provider.ts";
import { createLocalLlmProvider } from "./providers/local-llm.provider.js";
import { createOpenAiProvider } from "./providers/openai.provider.js";
import {
  englishPromptBinding,
  renderPrompt,
  promptMessage,
} from "../system-context/system-context.service.js";

export type AgenticCompileProvider =
  | "openai"
  | "azure-openai"
  | "bedrock"
  | "local-llm"
  | "codex"
  | "auto";

export type AgenticLlmHealthStatus = LlmHealthStatus & {
  providerSetting: AgenticCompileProvider;
  selectedProvider?: LlmProviderName;
  fallbackOrder: LlmProviderName[];
  providerHealth?: LlmProviderHealthStatus[];
};

export type LlmProviderHealthStatus = LlmHealthStatus & {
  id: string;
  label: string;
  deploymentIndex?: number;
  selected: boolean;
  routeOrder: number | null;
  generationChecked?: boolean;
  generationReachable?: boolean;
  generationError?: string;
  localLlmSmokes?: LocalLlmSmokeStatus[];
};

export type LocalLlmSmokeName = "simple_chat" | "json_only" | "tool_result_history";

export type LocalLlmSmokeStatus = {
  name: LocalLlmSmokeName;
  ok: boolean;
  error?: string;
  preview?: string;
};

type LlmProviderHealthEntry = {
  id: string;
  label: string;
  providerName: LlmProviderName;
  provider: LlmProvider;
  deploymentIndex?: number;
  model?: string;
};

const singleInstanceProviderNames: LlmProviderName[] = ["openai", "bedrock", "codex"];
const jsonOnlySystemContext = renderPrompt("shared.jsonOnly", {}, englishPromptBinding);

function dedupeOrder(values: LlmProviderName[]): LlmProviderName[] {
  const seen = new Set<LlmProviderName>();
  const result: LlmProviderName[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveProviderOrder(
  providerSetting: AgenticCompileProvider,
  fallbackOrder: LlmProviderName[] = [],
): LlmProviderName[] {
  if (providerSetting === "auto") {
    return dedupeOrder(["openai", "azure-openai", "bedrock", "local-llm"]);
  }
  return dedupeOrder([providerSetting, ...fallbackOrder]);
}

function resolveDistillationProviderOrder(
  providerSetting: AgenticCompileProvider,
  fallbackOrder: LlmProviderName[] = [],
): LlmProviderName[] {
  if (providerSetting === "auto") {
    return dedupeOrder(["local-llm", "openai", "azure-openai", "bedrock"]);
  }
  return dedupeOrder([providerSetting, ...fallbackOrder]);
}

function buildProvider(
  provider: LlmProviderName,
  timeoutMs: number,
  azureDeploymentSlots?: number[],
): LlmProvider {
  switch (provider) {
    case "openai":
      return createOpenAiProvider({ timeoutMs });
    case "azure-openai":
      return azureDeploymentSlots && azureDeploymentSlots.length > 0
        ? createAzureOpenAiProvider({ timeoutMs, deploymentSlots: azureDeploymentSlots })
        : createAzureOpenAiProvider({ timeoutMs });
    case "bedrock":
      return createBedrockProvider({ timeoutMs });
    case "local-llm":
      return createLocalLlmProvider({ timeoutMs });
    case "codex": {
      let model: string | undefined;
      try {
        const settings = getRuntimeSettingsSnapshot();
        model = settings.providers.codex.model;
      } catch {
        model = undefined;
      }
      return createCodexProvider({ timeoutMs, model });
    }
    default:
      return createAzureOpenAiProvider({ timeoutMs });
  }
}

function defaultModelForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.model;
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    case "local-llm":
      return groupedConfig.localLlm.model;
    case "codex": {
      try {
        const settings = getRuntimeSettingsSnapshot();
        return settings.providers.codex.model || "codex-sdk-agent";
      } catch {
        return "codex-sdk-agent";
      }
    }
  }
}

function defaultEndpointForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.apiBaseUrl;
    case "azure-openai":
      return groupedConfig.azureOpenAi.apiBaseUrl;
    case "bedrock":
      return groupedConfig.bedrock.region;
    case "local-llm":
      return groupedConfig.localLlm.apiBaseUrl;
    case "codex":
      return "codex-api";
  }
}

function defaultLabelForProvider(provider: LlmProviderName): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "azure-openai":
      return "Azure OpenAI";
    case "bedrock":
      return "Bedrock";
    case "local-llm":
      return "Local LLM";
    case "codex":
      return "Codex Auth";
  }
}

function withUsageLogging(provider: LlmProvider, source: string): LlmProvider {
  return {
    ...provider,
    async chat(request) {
      const response = await provider.chat(request);
      recordLlmUsage({
        provider: provider.name,
        model: request.model ?? defaultModelForProvider(provider.name),
        usage: response.usage,
        promptMessages: request.messages,
        completionText: response.content,
        source,
      });
      const submittedSystemContexts = [
        ...(request.systemContexts ?? []),
        ...(response.systemContexts ?? []),
      ];
      if (submittedSystemContexts.length > 0) {
        await recordAuditLogSafe({
          eventType: auditEventTypes.systemContextSubmitted,
          actor: "system",
          payload: {
            source,
            provider: provider.name,
            model: request.model ?? defaultModelForProvider(provider.name),
            manifests: submittedSystemContexts,
          },
        });
      }
      return response;
    },
  };
}

function previewContent(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("response was not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function runLocalLlmSmoke(
  name: LocalLlmSmokeName,
  execute: () => Promise<string>,
  validate: (content: string) => void,
): Promise<LocalLlmSmokeStatus> {
  try {
    const content = await execute();
    validate(content);
    return { name, ok: true, preview: previewContent(content) };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runLocalLlmSmokeChecks(
  provider: LlmProvider,
  model: string,
): Promise<LocalLlmSmokeStatus[]> {
  return [
    await runLocalLlmSmoke(
      "simple_chat",
      async () =>
        (
          await provider.chat({
            model,
            messages: [{ role: "user", content: "Reply with OK only." }],
            maxTokens: 8,
            temperature: 0,
          })
        ).content,
      (content) => {
        if (content.trim().toUpperCase() !== "OK") {
          throw new Error(`expected OK, got ${previewContent(content) ?? "empty content"}`);
        }
      },
    ),
    await runLocalLlmSmoke(
      "json_only",
      async () =>
        (
          await provider.chat({
            model,
            messages: [
              promptMessage(jsonOnlySystemContext),
              { role: "user", content: 'Return {"ok":true} exactly.' },
            ],
            maxTokens: 32,
            temperature: 0,
            responseFormat: "json",
            systemContexts: [jsonOnlySystemContext.manifest],
          })
        ).content,
      (content) => {
        const parsed = parseJsonObject(content);
        if (parsed.ok !== true) {
          throw new Error("JSON response did not contain ok=true");
        }
      },
    ),
    await runLocalLlmSmoke(
      "tool_result_history",
      async () =>
        (
          await provider.chat({
            model,
            messages: [
              promptMessage(jsonOnlySystemContext),
              { role: "user", content: "Use the tool result to answer." },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tool-call-smoke-1",
                    type: "function",
                    function: { name: "memory_reader", arguments: "{}" },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "tool-call-smoke-1",
                name: "memory_reader",
                content: '{"fact":"queue_events_checked"}',
              },
              { role: "user", content: 'Return {"fact":"queue_events_checked"} exactly.' },
            ],
            maxTokens: 64,
            temperature: 0,
            responseFormat: "json",
            systemContexts: [jsonOnlySystemContext.manifest],
          })
        ).content,
      (content) => {
        const parsed = parseJsonObject(content);
        if (parsed.fact !== "queue_events_checked") {
          throw new Error("JSON response did not preserve the tool result fact");
        }
      },
    ),
  ];
}

export function getAgenticLlmProviders(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = groupedConfig.agenticCompile.timeoutMs,
  usageSource?: string,
  fallbackOrder: LlmProviderName[] = [],
  azureDeploymentSlots?: number[],
): LlmProvider[] {
  const resolvedUsageSource = usageSource ?? "agentic-llm";
  return resolveProviderOrder(providerSetting, fallbackOrder).map((providerName) => {
    const provider = buildProvider(providerName, timeoutMs, azureDeploymentSlots);
    return withUsageLogging(provider, resolvedUsageSource);
  });
}

export async function checkLlmProviderHealthMatrix(
  timeoutMs = 5000,
  options: {
    selectedProvider?: LlmProviderName;
    routeOrder?: LlmProviderName[];
    selectedAzureDeploymentSlots?: number[];
    selectedLocalLlmModel?: string;
    verifyLocalLlmGeneration?: boolean;
  } = {},
): Promise<LlmProviderHealthStatus[]> {
  const routeOrder = options.routeOrder ?? [];
  const selectedAzureDeploymentSlots = new Set(
    options.selectedAzureDeploymentSlots?.filter(
      (slot) => Number.isInteger(slot) && slot >= 1 && slot <= 3,
    ) ?? [],
  );
  const entries: LlmProviderHealthEntry[] = [];

  for (const providerName of singleInstanceProviderNames) {
    const provider = buildProvider(providerName, timeoutMs);
    if (!provider.isConfigured()) continue;
    entries.push({
      id: providerName,
      label: defaultLabelForProvider(providerName),
      providerName,
      provider,
    });
  }

  const localLlmModels = (groupedConfig.localLlm.models ?? []).filter(
    (model) => model.apiBaseUrl.trim() && model.model.trim(),
  );
  if (localLlmModels.length > 0) {
    for (const [index, model] of localLlmModels.entries()) {
      entries.push({
        id: `local-llm:${index + 1}`,
        label: model.name.trim() || `Local LLM #${index + 1}`,
        providerName: "local-llm",
        provider: createLocalLlmProvider({
          timeoutMs,
          modelConfig: {
            apiBaseUrl: model.apiBaseUrl,
            apiPath: model.apiPath,
            ...(model.apiKey?.trim() ? { apiKey: model.apiKey } : {}),
            model: model.model,
          },
        }),
        model: model.model,
      });
    }
  } else {
    const provider = buildProvider("local-llm", timeoutMs);
    if (provider.isConfigured()) {
      entries.push({
        id: "local-llm",
        label: defaultLabelForProvider("local-llm"),
        providerName: "local-llm",
        provider,
        model: groupedConfig.localLlm.model,
      });
    }
  }

  for (const slot of configuredAzureOpenAiDeploymentSlots()) {
    entries.push({
      id: `azure-openai:${slot.index + 1}`,
      label: `Azure OpenAI #${slot.index + 1}`,
      providerName: "azure-openai",
      provider: createAzureOpenAiProvider({ timeoutMs, deploymentIndex: slot.index }),
      deploymentIndex: slot.index + 1,
    });
  }

  entries.sort((left, right) => {
    const leftRoute = routeOrder.indexOf(left.providerName);
    const rightRoute = routeOrder.indexOf(right.providerName);
    const leftRank = leftRoute >= 0 ? leftRoute : Number.MAX_SAFE_INTEGER;
    const rightRank = rightRoute >= 0 ? rightRoute : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.id.localeCompare(right.id);
  });

  return Promise.all(
    entries.map(async (entry) => {
      let status: LlmHealthStatus;
      try {
        status = await entry.provider.healthCheck();
      } catch (error) {
        status = {
          provider: entry.providerName,
          configured: entry.provider.isConfigured(),
          reachable: false,
          model: defaultModelForProvider(entry.providerName),
          endpoint: defaultEndpointForProvider(entry.providerName),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      status = {
        ...status,
        model: status.model ?? defaultModelForProvider(entry.providerName),
        endpoint: status.endpoint ?? defaultEndpointForProvider(entry.providerName),
      };
      const routeIndex = routeOrder.indexOf(entry.providerName);
      const selected =
        options.selectedProvider === entry.providerName &&
        (entry.providerName !== "azure-openai" ||
          selectedAzureDeploymentSlots.size === 0 ||
          (typeof entry.deploymentIndex === "number" &&
            selectedAzureDeploymentSlots.has(entry.deploymentIndex))) &&
        (entry.providerName !== "local-llm" ||
          !options.selectedLocalLlmModel ||
          entry.model === options.selectedLocalLlmModel);
      const generationStatus: Pick<
        LlmProviderHealthStatus,
        "generationChecked" | "generationReachable" | "generationError" | "localLlmSmokes"
      > = {};
      const reachable = status.reachable;
      const error = status.error;
      if (options.verifyLocalLlmGeneration && entry.providerName === "local-llm" && reachable) {
        generationStatus.generationChecked = true;
        const smokes = await runLocalLlmSmokeChecks(entry.provider, entry.model ?? status.model);
        const failedSmokes = smokes.filter((smoke) => !smoke.ok);
        generationStatus.localLlmSmokes = smokes;
        generationStatus.generationReachable = failedSmokes.length === 0;
        if (failedSmokes.length > 0) {
          generationStatus.generationError = failedSmokes
            .map((smoke) => `${smoke.name}: ${smoke.error ?? "failed"}`)
            .join("; ");
        }
      }
      return {
        ...status,
        reachable,
        ...(error ? { error } : {}),
        id: entry.id,
        label: entry.label,
        deploymentIndex: entry.deploymentIndex,
        selected,
        routeOrder: routeIndex >= 0 ? routeIndex : null,
        ...generationStatus,
      };
    }),
  );
}

export async function checkAgenticLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.agenticCompile.provider,
  timeoutMs = 5000,
  fallbackOrder: LlmProviderName[] = [],
  azureDeploymentSlots?: number[],
): Promise<AgenticLlmHealthStatus> {
  const resolvedFallbackOrder = resolveProviderOrder(providerSetting, fallbackOrder);
  const providers = getAgenticLlmProviders(
    providerSetting,
    timeoutMs,
    "health-check:agentic-llm",
    fallbackOrder,
    azureDeploymentSlots,
  );
  let firstConfiguredStatus: LlmHealthStatus | null = null;

  for (const provider of providers) {
    const status = await provider.healthCheck();
    if (!status.configured) {
      continue;
    }

    if (!firstConfiguredStatus) {
      firstConfiguredStatus = status;
    }

    if (status.reachable) {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder: resolvedFallbackOrder,
      };
    }
  }

  if (firstConfiguredStatus) {
    return {
      ...firstConfiguredStatus,
      providerSetting,
      selectedProvider: firstConfiguredStatus.provider,
      fallbackOrder: resolvedFallbackOrder,
    };
  }

  const firstProvider = providers[0] ?? createAzureOpenAiProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder: resolvedFallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in fallback chain"
        : `${providerSetting} is not configured`),
  };
}

export async function checkDistillationLlmHealth(
  providerSetting: AgenticCompileProvider = groupedConfig.distillation.provider,
  timeoutMs = groupedConfig.distillation.circuitBreakerHealthTimeoutMs,
  fallbackOrder: LlmProviderName[] = [],
): Promise<AgenticLlmHealthStatus> {
  const resolvedFallbackOrder = resolveDistillationProviderOrder(providerSetting, fallbackOrder);
  const providers = resolvedFallbackOrder.map((providerName) =>
    withUsageLogging(buildProvider(providerName, timeoutMs), "health-check:distillation-llm"),
  );
  let firstConfiguredStatus: LlmHealthStatus | null = null;

  for (const provider of providers) {
    const status = await provider.healthCheck();
    if (!status.configured) {
      continue;
    }
    firstConfiguredStatus ??= status;
    if (status.reachable) {
      return {
        ...status,
        providerSetting,
        selectedProvider: provider.name,
        fallbackOrder: resolvedFallbackOrder,
      };
    }
  }

  if (firstConfiguredStatus) {
    return {
      ...firstConfiguredStatus,
      providerSetting,
      selectedProvider: firstConfiguredStatus.provider,
      fallbackOrder: resolvedFallbackOrder,
    };
  }

  const firstProvider = providers[0] ?? createLocalLlmProvider({ timeoutMs });
  const firstStatus = await firstProvider.healthCheck();
  return {
    ...firstStatus,
    providerSetting,
    fallbackOrder: resolvedFallbackOrder,
    error:
      firstStatus.error ??
      (providerSetting === "auto"
        ? "No configured provider in distillation fallback chain"
        : `${providerSetting} is not configured`),
  };
}
