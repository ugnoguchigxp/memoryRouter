import { z } from "zod";
import { groupedConfig } from "../../../src/config.js";
import { createAzureOpenAiProvider } from "../../../src/modules/llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../../../src/modules/llm/providers/bedrock.provider.js";
import { createLocalLlmProvider } from "../../../src/modules/llm/providers/local-llm.provider.js";
import { createOpenAiProvider } from "../../../src/modules/llm/providers/openai.provider.js";
import { stableLocalLlmModelId } from "../../../src/modules/settings/settings.defaults.js";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  getRuntimeSettingsSnapshot,
  getRuntimeSettingsViewSnapshot,
  reloadRuntimeSettingsCache,
  saveRuntimeSettings,
} from "../../../src/modules/settings/settings.service.js";
import {
  type RuntimeSettingsUpdateRequest,
  settingsUpdateRequestSchema,
} from "../../../src/modules/settings/settings.types.js";

import {
  checkCodexAuthStatus,
  getCodexLoginCommand,
} from "../../../src/modules/codex/codex-auth.service.js";
import { createCodexProvider } from "../../../src/modules/llm/providers/codex.provider.js";

const providerNameSchema = z.enum([
  "openai",
  "azure-openai",
  "bedrock",
  "local-llm",
  "codex",
] as const);
const azureOpenAiDeploymentSchema = z.coerce.number().int().min(1);
const localLlmModelTestSchema = z.object({
  model: z.string().trim().min(1),
});

export async function getSettingsForApi() {
  await ensureRuntimeSettingsLoaded();
  return getRuntimeSettingsViewSnapshot();
}

export async function updateSettingsForApi(input: RuntimeSettingsUpdateRequest) {
  const validated = settingsUpdateRequestSchema.parse(input);
  const saved = await saveRuntimeSettings(validated);
  const snapshot = getRuntimeSettingsViewSnapshot();
  return {
    ...snapshot,
    revision: saved.revision,
    updatedAt: saved.updatedAt,
    cacheInvalidated: true,
    reloadRequired: true,
  };
}

export async function reloadRuntimeCacheForApi() {
  await reloadRuntimeSettingsCache();
  return {
    ok: true as const,
    reloadedAt: new Date().toISOString(),
  };
}

export async function testProviderForApi(providerRaw: string) {
  await ensureRuntimeSettingsLoaded();
  const provider = providerNameSchema.parse(providerRaw);
  switch (provider) {
    case "openai":
      return createOpenAiProvider({ timeoutMs: 10_000 }).healthCheck();
    case "azure-openai":
      return createAzureOpenAiProvider({ timeoutMs: 10_000 }).healthCheck();
    case "bedrock":
      return createBedrockProvider({ timeoutMs: 10_000 }).healthCheck();
    case "local-llm":
      return testLocalLlmProviderPoolForApi();
    case "codex":
      return createCodexProvider({ timeoutMs: 10_000 }).healthCheck();
  }
}

async function testLocalLlmProviderPoolForApi() {
  const settings = getRuntimeSettingsSnapshot();
  const configuredModels = settings.providers["local-llm"].models;
  const activeModelIds = new Set(
    settings.providerPools
      .filter((pool) => pool.enabled)
      .flatMap((pool) => pool.targets)
      .filter((target) => target.provider === "local-llm")
      .map((target) => target.localLlmModelId),
  );
  const configuredById = new Map(
    configuredModels.map((model, index) => [
      model.id ?? stableLocalLlmModelId(model),
      {
        model,
        runtime: groupedConfig.localLlm.models[index],
      },
    ]),
  );

  if (activeModelIds.size === 0) {
    return createLocalLlmProvider({ timeoutMs: 10_000 }).healthCheck();
  }

  const targets = await Promise.all(
    [...activeModelIds].map(async (id) => {
      const configured = configuredById.get(id);
      if (!configured) {
        return {
          id,
          name: id,
          provider: "local-llm" as const,
          configured: false,
          reachable: false,
          model: "",
          endpoint: "",
          error: `provider pool target ${id} is not configured`,
        };
      }
      const { model, runtime } = configured;
      return {
        id,
        name: model.name,
        ...(await createLocalLlmProvider({
          timeoutMs: 10_000,
          modelConfig: {
            apiBaseUrl: model.apiBaseUrl,
            apiPath: model.apiPath,
            model: model.model,
            apiKey: runtime?.apiKey ?? "",
          },
        }).healthCheck()),
      };
    }),
  );
  const reachable = targets.find((target) => target.reachable);
  const primary = reachable ?? targets[0];
  return {
    provider: "local-llm" as const,
    configured: targets.some((target) => target.configured),
    reachable: Boolean(reachable),
    model: primary?.model,
    endpoint: primary?.endpoint,
    ...(!reachable
      ? {
          error: targets
            .map((target) => `${target.name}: ${target.error ?? "unreachable"}`)
            .join("; "),
        }
      : {}),
    targets,
  };
}

export async function testAzureOpenAiDeploymentForApi(deploymentRaw: string | number) {
  await ensureRuntimeSettingsLoaded();
  const deployment = azureOpenAiDeploymentSchema.parse(deploymentRaw);
  return createAzureOpenAiProvider({
    timeoutMs: 10_000,
    deploymentIndex: deployment - 1,
  }).healthCheck();
}

export async function testLocalLlmModelForApi(input: unknown) {
  await ensureRuntimeSettingsLoaded();
  const { model } = localLlmModelTestSchema.parse(input);
  return createLocalLlmProvider({ timeoutMs: 10_000 }).healthCheck({ model });
}

export async function getCodexAuthStatusForApi() {
  return checkCodexAuthStatus();
}

export function getCodexLoginCommandForApi() {
  return {
    command: getCodexLoginCommand(),
  };
}
