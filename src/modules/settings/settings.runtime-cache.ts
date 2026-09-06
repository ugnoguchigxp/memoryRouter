import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { projectEnvKey } from "../../project-identity.js";
import { bootstrap, cloneDefaultSettings, secretRowKeys } from "./settings.defaults.js";
import type { SettingsRow } from "./settings.repository.js";
import { isLarmAgentConnectionRoute } from "./settings.types.js";
import type {
  RuntimeEffectiveProviderTarget,
  RuntimeEffectiveRouteTargets,
  RuntimeProviderPoolTarget,
  RuntimeSecretKey,
  RuntimeSecretSource,
  RuntimeSecretStatus,
  RuntimeSettingsDiagnostic,
  RuntimeSettingsDiagnostics,
  RuntimeSettingsEditable,
  RuntimeSettingsEffectiveTargets,
  RuntimeSettingsRoute,
  RuntimeSettingsView,
  StaticRuntimeSettingsRoute,
} from "./settings.types.js";

export type SecretValueEntry = {
  value: string;
  source: RuntimeSecretSource;
  updatedAt: string | null;
};

export type RuntimeSettingsCache = {
  loadedAt: Date | null;
  revision: number;
  settings: RuntimeSettingsEditable;
  view: RuntimeSettingsView;
  sources: Record<string, string>;
};

export function maskSecret(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.max(4, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

function emptyRuntimeSecretStatus(): RuntimeSecretStatus {
  return { configured: false, source: "none", maskedValue: null, updatedAt: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getSecretStringFromRow(row: SettingsRow | undefined): string | undefined {
  if (!row) return undefined;
  const record = asRecord(row.value);
  const direct = asString(record.value);
  return direct?.trim() ? direct.trim() : undefined;
}

function azureOpenAiSecretKey(index: number): RuntimeSecretKey {
  if (index === 1) return "azureOpenAiApiKey2";
  if (index === 2) return "azureOpenAiApiKey3";
  if (index > 2) return `azureOpenAiApiKey${index + 1}`;
  return "azureOpenAiApiKey";
}

function localLlmSecretKey(index: number): RuntimeSecretKey {
  if (index === 0) return "localLlmApiKey";
  return `localLlmApiKey${index + 1}`;
}

function localLlmTargetId(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
): string {
  return model.id?.trim() || model.name.trim() || model.model.trim();
}

function findLocalLlmModel(
  settings: RuntimeSettingsEditable,
  value: string | undefined,
): RuntimeSettingsEditable["providers"]["local-llm"]["models"][number] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return settings.providers["local-llm"].models.find(
    (model) =>
      model.id?.trim() === trimmed ||
      model.name.trim() === trimmed ||
      model.model.trim() === trimmed,
  );
}

function localLlmRouteTargetValue(route: StaticRuntimeSettingsRoute): string | undefined {
  const raw = route.localLlmModel?.trim() || route.model?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["localLlmModelId", "id", "name", "model"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  } catch {
    // Plain model names are the common case.
  }
  return raw;
}

function targetLabelForProviderPoolTarget(
  settings: RuntimeSettingsEditable,
  target: RuntimeProviderPoolTarget,
): string {
  if (target.provider === "larm-agent-connection") {
    const connection = settings.providers["larm-agent-connection"].connections.find(
      (item) => item.id === target.connectionId,
    );
    return connection?.agentProfile ?? target.connectionId;
  }
  if (target.provider === "local-llm") {
    const model = findLocalLlmModel(settings, target.localLlmModelId);
    return model?.name.trim() || model?.model.trim() || target.localLlmModelId;
  }
  if (target.provider === "azure-openai") {
    const deployment = settings.providers["azure-openai"].deployments[target.deploymentSlot - 1];
    return (
      deployment?.name.trim() ||
      deployment?.model.trim() ||
      `Azure deployment ${target.deploymentSlot}`
    );
  }
  return target.targetId;
}

function resolveProviderPoolTarget(
  settings: RuntimeSettingsEditable,
  target: RuntimeProviderPoolTarget,
  providerPoolId: string,
): RuntimeEffectiveProviderTarget {
  if (target.provider === "larm-agent-connection") {
    const connection = settings.providers["larm-agent-connection"].connections.find(
      (item) => item.id === target.connectionId,
    );
    return {
      provider: "larm-agent-connection",
      id: `provider-pool:${providerPoolId}:larm-agent-connection:${target.connectionId}`,
      label: targetLabelForProviderPoolTarget(settings, target),
      source: "provider_pool",
      model: connection?.agentProfile ?? null,
      endpoint: connection?.controlBaseUrl ?? null,
      providerPoolId,
      connectionId: target.connectionId,
    };
  }
  if (target.provider === "local-llm") {
    const model = findLocalLlmModel(settings, target.localLlmModelId);
    return {
      provider: "local-llm",
      id: `provider-pool:${providerPoolId}:local-llm:${target.localLlmModelId}`,
      label: targetLabelForProviderPoolTarget(settings, target),
      source: "provider_pool",
      model: model?.model.trim() || null,
      endpoint: model?.apiBaseUrl.trim() || null,
      providerPoolId,
      localLlmModelId: target.localLlmModelId,
    };
  }
  if (target.provider === "azure-openai") {
    const deployment = settings.providers["azure-openai"].deployments[target.deploymentSlot - 1];
    return {
      provider: "azure-openai",
      id: `provider-pool:${providerPoolId}:azure-openai:${target.deploymentSlot}`,
      label: targetLabelForProviderPoolTarget(settings, target),
      source: "provider_pool",
      model: deployment?.model.trim() || null,
      endpoint: deployment?.apiBaseUrl.trim() || null,
      providerPoolId,
      deploymentSlot: target.deploymentSlot,
    };
  }
  return {
    provider: target.provider,
    id: `provider-pool:${providerPoolId}:${target.provider}:${target.targetId}`,
    label: target.targetId,
    source: "provider_pool",
    model: target.targetId,
    endpoint: null,
    providerPoolId,
  };
}

function resolveDirectRouteTarget(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeEffectiveProviderTarget[] {
  if (isLarmAgentConnectionRoute(route)) {
    const connection = settings.providers["larm-agent-connection"].connections.find(
      (item) => item.id === route.connectionId,
    );
    return [
      {
        provider: "larm-agent-connection",
        id: `route:larm-agent-connection:${route.connectionId}`,
        label: connection?.agentProfile ?? route.connectionId,
        source: "route",
        model: connection?.agentProfile ?? null,
        endpoint: connection?.controlBaseUrl ?? null,
        connectionId: route.connectionId,
      },
    ];
  }
  if (route.provider === "auto") return [];
  if (route.provider === "local-llm") {
    const value = localLlmRouteTargetValue(route);
    const model = findLocalLlmModel(settings, value) ?? settings.providers["local-llm"].models[0];
    return [
      {
        provider: "local-llm",
        id: `route:local-llm:${localLlmTargetId(model) || value || "default"}`,
        label: model?.name.trim() || model?.model.trim() || value || "Local LLM",
        source: "route",
        model: model?.model.trim() || value || null,
        endpoint:
          model?.apiBaseUrl.trim() || settings.providers["local-llm"].apiBaseUrl.trim() || null,
        ...(model?.id?.trim() ? { localLlmModelId: model.id.trim() } : {}),
      },
    ];
  }
  if (route.provider === "azure-openai") {
    const slots =
      route.azureDeploymentSlots?.filter((slot) => Number.isInteger(slot) && slot >= 1) ?? [];
    const slotList = slots.length > 0 ? slots : [1];
    return slotList.map((slot) => {
      const deployment = settings.providers["azure-openai"].deployments[slot - 1];
      return {
        provider: "azure-openai" as const,
        id: `route:azure-openai:${slot}`,
        label: deployment?.name.trim() || deployment?.model.trim() || `Azure deployment ${slot}`,
        source: "route" as const,
        model: deployment?.model.trim() || settings.providers["azure-openai"].model.trim() || null,
        endpoint:
          deployment?.apiBaseUrl.trim() ||
          settings.providers["azure-openai"].apiBaseUrl.trim() ||
          null,
        deploymentSlot: slot,
      };
    });
  }
  const provider = settings.providers[route.provider];
  const model = "model" in provider ? provider.model.trim() : route.model?.trim();
  const endpoint = "apiBaseUrl" in provider ? provider.apiBaseUrl.trim() : null;
  return [
    {
      provider: route.provider,
      id: `route:${route.provider}:${model || route.provider}`,
      label: model || route.provider,
      source: "route",
      model: model || null,
      endpoint: endpoint || null,
    },
  ];
}

function resolveEffectiveRouteTargets(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeEffectiveRouteTargets {
  if (isLarmAgentConnectionRoute(route)) {
    return { source: "route", targets: resolveDirectRouteTarget(settings, route) };
  }
  if (route.providerPoolId?.trim()) {
    const providerPoolId = route.providerPoolId.trim();
    const pool = settings.providerPools.find((item) => item.id === providerPoolId);
    return {
      source: "provider_pool",
      providerPoolId,
      targets:
        pool?.targets.map((target) =>
          resolveProviderPoolTarget(settings, target, providerPoolId),
        ) ?? [],
    };
  }
  const targets = resolveDirectRouteTarget(settings, route);
  return {
    source: targets.length > 0 ? "route" : "none",
    targets,
  };
}

function buildRuntimeEffectiveTargets(
  settings: RuntimeSettingsEditable,
): RuntimeSettingsEffectiveTargets {
  const providerPools: Record<string, RuntimeEffectiveProviderTarget[]> = {};
  for (const pool of settings.providerPools) {
    providerPools[pool.id] = pool.targets.map((target) =>
      resolveProviderPoolTarget(settings, target, pool.id),
    );
  }
  return {
    providerPools,
    taskRouting: {
      findCandidate: {
        source: resolveEffectiveRouteTargets(settings, settings.taskRouting.findCandidate.source),
        vibe: resolveEffectiveRouteTargets(settings, settings.taskRouting.findCandidate.vibe),
      },
      webSourceResearch: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.webSourceResearch,
      ),
      episodeDistiller: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.episodeDistiller,
      ),
      coverEvidence: {
        sourceSupport: resolveEffectiveRouteTargets(
          settings,
          settings.taskRouting.coverEvidence.sourceSupport,
        ),
        externalEvidence: resolveEffectiveRouteTargets(
          settings,
          settings.taskRouting.coverEvidence.externalEvidence,
        ),
        mcpEvidence: resolveEffectiveRouteTargets(
          settings,
          settings.taskRouting.coverEvidence.mcpEvidence,
        ),
      },
      deadZoneMergeReview: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.deadZoneMergeReview,
      ),
      landscapeCuration: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.landscapeCuration,
      ),
      finalizeDistille: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.finalizeDistille,
      ),
      mergeActivationFinalize: resolveEffectiveRouteTargets(
        settings,
        settings.taskRouting.mergeActivationFinalize,
      ),
      agenticCompile: resolveEffectiveRouteTargets(settings, {
        provider: settings.taskRouting.agenticCompile.provider,
        model: settings.taskRouting.agenticCompile.model,
        localLlmModel: settings.taskRouting.agenticCompile.localLlmModel,
        fallback: settings.taskRouting.agenticCompile.fallback,
        azureDeploymentSlots: settings.taskRouting.agenticCompile.azureDeploymentSlots,
      }),
    },
  };
}

type RuntimeRouteDiagnosticEntry = {
  path: string;
  route: RuntimeSettingsRoute;
};

function routeDiagnosticEntries(settings: RuntimeSettingsEditable): RuntimeRouteDiagnosticEntry[] {
  return [
    { path: "taskRouting.findCandidate.source", route: settings.taskRouting.findCandidate.source },
    { path: "taskRouting.findCandidate.vibe", route: settings.taskRouting.findCandidate.vibe },
    { path: "taskRouting.webSourceResearch", route: settings.taskRouting.webSourceResearch },
    { path: "taskRouting.episodeDistiller", route: settings.taskRouting.episodeDistiller },
    {
      path: "taskRouting.coverEvidence.sourceSupport",
      route: settings.taskRouting.coverEvidence.sourceSupport,
    },
    {
      path: "taskRouting.coverEvidence.externalEvidence",
      route: settings.taskRouting.coverEvidence.externalEvidence,
    },
    {
      path: "taskRouting.coverEvidence.mcpEvidence",
      route: settings.taskRouting.coverEvidence.mcpEvidence,
    },
    { path: "taskRouting.deadZoneMergeReview", route: settings.taskRouting.deadZoneMergeReview },
    { path: "taskRouting.landscapeCuration", route: settings.taskRouting.landscapeCuration },
    { path: "taskRouting.finalizeDistille", route: settings.taskRouting.finalizeDistille },
    {
      path: "taskRouting.mergeActivationFinalize",
      route: settings.taskRouting.mergeActivationFinalize,
    },
  ];
}

function isProviderEnabled(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderPoolTarget["provider"],
): boolean {
  return settings.providers[provider].enabled;
}

function unresolvedProviderPoolTarget(
  settings: RuntimeSettingsEditable,
  target: RuntimeProviderPoolTarget,
): string | null {
  if (target.provider === "larm-agent-connection") {
    const connection = settings.providers["larm-agent-connection"].connections.find(
      (item) => item.id === target.connectionId,
    );
    if (!connection) return `LARM connection ${target.connectionId} is not configured`;
    if (!connection.controlBaseUrl.trim() || !connection.agentProfile.trim()) {
      return `LARM connection ${target.connectionId} is missing control endpoint or profile`;
    }
    return null;
  }
  if (target.provider === "local-llm") {
    const model = findLocalLlmModel(settings, target.localLlmModelId);
    if (!model) return `Local LLM model ${target.localLlmModelId} is not configured`;
    if (!model.apiBaseUrl.trim() || !model.model.trim()) {
      return `Local LLM model ${target.localLlmModelId} is missing endpoint or model`;
    }
    return null;
  }
  if (target.provider === "azure-openai") {
    const deployment = settings.providers["azure-openai"].deployments[target.deploymentSlot - 1];
    if (!deployment)
      return `Azure OpenAI deployment slot ${target.deploymentSlot} is not configured`;
    if (!deployment.apiBaseUrl.trim() || !deployment.model.trim()) {
      return `Azure OpenAI deployment slot ${target.deploymentSlot} is missing endpoint or model`;
    }
    return null;
  }
  return target.targetId.trim() ? null : `${target.provider} target id is empty`;
}

function buildRuntimeDiagnostics(settings: RuntimeSettingsEditable): RuntimeSettingsDiagnostics {
  const diagnostics: RuntimeSettingsDiagnostic[] = [];
  const poolsById = new Map(settings.providerPools.map((pool) => [pool.id, pool]));
  const emittedPoolTargetWarnings = new Set<string>();

  for (const entry of routeDiagnosticEntries(settings)) {
    if (isLarmAgentConnectionRoute(entry.route)) {
      const connectionId = entry.route.connectionId;
      const connection = settings.providers["larm-agent-connection"].connections.find(
        (item) => item.id === connectionId,
      );
      if (!settings.providers["larm-agent-connection"].enabled || !connection) {
        diagnostics.push({
          severity: "error",
          code: connection ? "larm_provider_disabled" : "larm_connection_missing",
          path: `${entry.path}.connectionId`,
          message: connection
            ? `${entry.path} uses LARM Agent Connection while the provider is disabled.`
            : `${entry.path} references missing LARM connection "${connectionId}".`,
          details: { connectionId },
        });
      }
      continue;
    }
    const providerPoolId = entry.route.providerPoolId?.trim();
    if (!providerPoolId) continue;
    const pool = poolsById.get(providerPoolId);
    if (!pool) {
      diagnostics.push({
        severity: "error",
        code: "provider_pool_missing",
        path: `${entry.path}.providerPoolId`,
        message: `${entry.path} references provider pool "${providerPoolId}", but the pool is not configured.`,
        details: { providerPoolId },
      });
      continue;
    }
    if (!pool.enabled) {
      diagnostics.push({
        severity: "error",
        code: "provider_pool_disabled",
        path: `${entry.path}.providerPoolId`,
        message: `${entry.path} references provider pool "${providerPoolId}", but the pool is disabled.`,
        details: { providerPoolId },
      });
    }
    if (pool.targets.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "provider_pool_empty",
        path: `providerPools.${providerPoolId}.targets`,
        message: `Provider pool "${providerPoolId}" has no targets for ${entry.path}.`,
        details: { providerPoolId },
      });
    }
    if (pool.targets.some((target) => target.provider === "larm-agent-connection")) {
      diagnostics.push({
        severity: "error",
        code: "larm_provider_pool_unsupported",
        path: `${entry.path}.providerPoolId`,
        message: `${entry.path} references a LARM provider pool. Dynamic execution is supported only through a direct LARM route, so the entire mixed pool remains fail-closed.`,
        details: { providerPoolId },
      });
    }
  }

  for (const pool of settings.providerPools) {
    for (const [index, target] of pool.targets.entries()) {
      const warningKey = `${pool.id}:${index}`;
      const unresolved = unresolvedProviderPoolTarget(settings, target);
      if (unresolved && !emittedPoolTargetWarnings.has(warningKey)) {
        diagnostics.push({
          severity: "error",
          code: "provider_pool_target_unresolved",
          path: `providerPools.${pool.id}.targets.${index}`,
          message: `Provider pool "${pool.id}" target cannot be resolved: ${unresolved}.`,
          details: { providerPoolId: pool.id, target },
        });
        emittedPoolTargetWarnings.add(warningKey);
      }
      if (!isProviderEnabled(settings, target.provider)) {
        diagnostics.push({
          severity: "warning",
          code: "provider_pool_target_provider_disabled",
          path: `providerPools.${pool.id}.targets.${index}`,
          message: `Provider pool "${pool.id}" targets ${target.provider}, but that provider is disabled.`,
          details: { providerPoolId: pool.id, target },
        });
      }
    }
  }

  return { providerPools: diagnostics };
}

export function buildSecretMap(
  rows: SettingsRow[],
): Partial<Record<RuntimeSecretKey, SettingsRow | undefined>> {
  const result = Object.create(null) as Partial<Record<RuntimeSecretKey, SettingsRow | undefined>>;
  for (const key of secretRowKeys) {
    result[key] = rows.find((row) => row.key === key);
  }
  for (const row of rows) {
    if (/^azureOpenAiApiKey[1-9]\d*$/.test(row.key)) {
      result[row.key as RuntimeSecretKey] = row;
    }
    if (/^localLlmApiKey[1-9]\d*$/.test(row.key)) {
      result[row.key as RuntimeSecretKey] = row;
    }
  }
  return result;
}

export function resolveSecretValue(
  key: RuntimeSecretKey,
  secretRow: SettingsRow | undefined,
): SecretValueEntry | null {
  const dbValue = getSecretStringFromRow(secretRow);
  if (dbValue) {
    return {
      value: dbValue,
      source: "db",
      updatedAt: secretRow?.updatedAt.toISOString() ?? null,
    };
  }
  const envValue = bootstrap.secrets[key];
  if (envValue?.trim()) {
    return {
      value: envValue.trim(),
      source: "env",
      updatedAt: null,
    };
  }
  return null;
}

export function resolveBedrockCredentialStatus(
  settings: RuntimeSettingsEditable,
): RuntimeSecretStatus {
  const configured =
    Boolean(settings.providers.bedrock.profile.trim()) ||
    Boolean(process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());
  return {
    configured,
    source: configured ? "env-or-profile" : "none",
    maskedValue: configured ? "***" : null,
    updatedAt: null,
  };
}

export function applyRuntimeSettingsToProcess(
  settings: RuntimeSettingsEditable,
  secrets: Partial<Record<RuntimeSecretKey, SecretValueEntry | null>>,
): void {
  const openAiEnabled = settings.providers.openai.enabled;
  const azureOpenAiEnabled = settings.providers["azure-openai"].enabled;
  const bedrockEnabled = settings.providers.bedrock.enabled;
  const localLlmEnabled = settings.providers["local-llm"].enabled;

  const azureDeployments = azureOpenAiEnabled
    ? settings.providers["azure-openai"].deployments.map((deployment, index) => ({
        apiKey: secrets[azureOpenAiSecretKey(index)]?.value ?? "",
        apiBaseUrl: deployment.apiBaseUrl.replace(/\/+$/, ""),
        apiPath: deployment.apiPath,
        apiVersion: deployment.apiVersion,
        model: deployment.model,
      }))
    : [];
  const configuredAzureDeployments = azureDeployments.filter(
    (deployment) =>
      deployment.apiKey.trim() && deployment.apiBaseUrl.trim() && deployment.model.trim(),
  );
  const primaryAzure = configuredAzureDeployments[0] ?? {
    apiKey: azureOpenAiEnabled ? (secrets.azureOpenAiApiKey?.value ?? "") : "",
    apiBaseUrl: settings.providers["azure-openai"].apiBaseUrl.replace(/\/+$/, ""),
    apiPath: settings.providers["azure-openai"].apiPath,
    apiVersion: settings.providers["azure-openai"].apiVersion,
    model: settings.providers["azure-openai"].model,
  };

  groupedConfig.openAi.apiBaseUrl = settings.providers.openai.apiBaseUrl.replace(/\/+$/, "");
  groupedConfig.openAi.model = settings.providers.openai.model;
  groupedConfig.openAi.apiKey = openAiEnabled ? (secrets.openaiApiKey?.value ?? "") : "";
  groupedConfig.azureOpenAi.apiBaseUrl = primaryAzure.apiBaseUrl;
  groupedConfig.azureOpenAi.apiPath = primaryAzure.apiPath;
  groupedConfig.azureOpenAi.apiVersion = primaryAzure.apiVersion;
  groupedConfig.azureOpenAi.model = primaryAzure.model;
  groupedConfig.azureOpenAi.apiKey = primaryAzure.apiKey;
  groupedConfig.azureOpenAi.deployments = azureDeployments;
  groupedConfig.bedrock.region = settings.providers.bedrock.region;
  groupedConfig.bedrock.profile = settings.providers.bedrock.profile;
  groupedConfig.bedrock.model = bedrockEnabled ? settings.providers.bedrock.model : "";
  const localLlmModels = localLlmEnabled
    ? settings.providers["local-llm"].models
        .map((model, index) => ({
          name: model.name,
          apiBaseUrl: model.apiBaseUrl.replace(/\/+$/, ""),
          apiPath: model.apiPath.trim() || "/v1/chat/completions",
          apiKey: secrets[localLlmSecretKey(index)]?.value ?? "",
          model: model.model,
        }))
        .filter((model) => model.apiBaseUrl.trim() && model.model.trim())
    : [];
  const primaryLocalLlm = localLlmModels[0] ?? {
    apiBaseUrl: settings.providers["local-llm"].apiBaseUrl.replace(/\/+$/, ""),
    apiPath: settings.providers["local-llm"].apiPath.trim() || "/v1/chat/completions",
    model: localLlmEnabled ? settings.providers["local-llm"].model : "",
    apiKey: localLlmEnabled ? (secrets.localLlmApiKey?.value ?? "") : "",
  };
  groupedConfig.localLlm.apiBaseUrl = primaryLocalLlm.apiBaseUrl;
  groupedConfig.localLlm.apiPath = primaryLocalLlm.apiPath;
  groupedConfig.localLlm.model = primaryLocalLlm.model;
  groupedConfig.localLlm.models = localLlmModels;
  groupedConfig.localLlm.apiKey = primaryLocalLlm.apiKey;
  groupedConfig.embedding.provider = settings.embedding.provider;
  groupedConfig.embedding.daemonUrl = settings.embedding.daemonUrl.replace(/\/+$/, "");
  groupedConfig.embedding.openaiModel = settings.embedding.openaiModel;
  groupedConfig.embedding.timeoutMs = settings.embedding.timeoutMs;
  groupedConfig.agenticCompile.enabled = settings.taskRouting.agenticCompile.enabled;
  groupedConfig.agenticCompile.provider = settings.taskRouting.agenticCompile.provider;
  groupedConfig.agenticCompile.timeoutMs = settings.taskRouting.agenticCompile.timeoutMs;
  groupedConfig.agenticCompile.maxTokens = settings.taskRouting.agenticCompile.maxTokens;
  if (!isLarmAgentConnectionRoute(settings.taskRouting.finalizeDistille)) {
    groupedConfig.distillation.provider = settings.taskRouting.finalizeDistille.provider;
  }
  if (!isLarmAgentConnectionRoute(settings.taskRouting.findCandidate.source)) {
    groupedConfig.distillation.findCandidateProvider =
      settings.taskRouting.findCandidate.source.provider;
  }
  groupedConfig.distillation.findCandidateBackgroundEnabled =
    settings.taskRouting.findCandidate.throttling.backgroundEnabled;
  groupedConfig.distillation.findCandidateInteractiveWindowSeconds =
    settings.taskRouting.findCandidate.throttling.interactiveWindowSeconds;
  groupedConfig.distillation.findCandidateRecentBlockSeconds =
    settings.taskRouting.findCandidate.throttling.recentBlockSeconds;
  groupedConfig.distillation.findCandidateMinIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.minIntervalSeconds;
  groupedConfig.distillation.findCandidateMediumIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.mediumIntervalSeconds;
  groupedConfig.distillation.findCandidateBusyIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.busyIntervalSeconds;
  groupedConfig.distillation.findCandidateMaxIntervalSeconds =
    settings.taskRouting.findCandidate.throttling.maxIntervalSeconds;
  groupedConfig.distillation.findCandidateRateLimitCooldownSeconds =
    settings.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds;
  groupedConfig.distillation.findCandidateJitterSeconds =
    settings.taskRouting.findCandidate.throttling.jitterSeconds;
  groupedConfig.distillation.timeoutMs = settings.distillationRuntime.timeoutMs;
  groupedConfig.distillation.findCandidateTimeoutMs =
    settings.distillationRuntime.findCandidateTimeoutMs;
  groupedConfig.distillation.coverEvidenceTimeoutMs =
    settings.distillationRuntime.coverEvidenceTimeoutMs;
  groupedConfig.distillation.candidateTimeoutMs = settings.distillationRuntime.candidateTimeoutMs;
  groupedConfig.distillation.llmContextWindowTokens =
    settings.distillationRuntime.llmContextWindowTokens;
  groupedConfig.distillation.llmMaxInputTokens = settings.distillationRuntime.llmMaxInputTokens;
  groupedConfig.distillation.llmInputSafetyMarginTokens =
    settings.distillationRuntime.llmInputSafetyMarginTokens;
  groupedConfig.distillation.lowImportanceRejectThreshold =
    settings.distillationRuntime.lowImportanceRejectThreshold;
  groupedConfig.distillation.lockTtlSeconds = settings.advanced.lockTtlSeconds;
  groupedConfig.distillation.pipelineLockStaleSeconds = settings.advanced.pipelineLockStaleSeconds;
  groupedConfig.distillation.pipelineClaimLimit = settings.advanced.pipelineClaimLimit;
  groupedConfig.distillation.findingQueueTaskIntervalSeconds =
    settings.advanced.findingQueueTaskIntervalSeconds;
  groupedConfig.distillation.coveringQueueTaskIntervalSeconds =
    settings.advanced.coveringQueueTaskIntervalSeconds;
  groupedConfig.distillation.continuousIdleSleepMs = settings.advanced.continuousIdleSleepMs;
  groupedConfig.distillation.continuousErrorSleepMs = settings.advanced.continuousErrorSleepMs;
  groupedConfig.distillation.inventoryRefreshIntervalMs =
    settings.advanced.inventoryRefreshIntervalMs;

  const providerOrder = settings.search.providerOrder.filter((provider) => {
    if (provider === "brave") return settings.search.providers.brave.enabled;
    if (provider === "exa") return settings.search.providers.exa.enabled;
    return settings.search.providers.duckduckgo.enabled;
  });
  groupedConfig.distillationTools.searchProviders =
    providerOrder.length > 0 ? providerOrder : (["duckduckgo"] as DistillationSearchProvider[]);
  groupedConfig.distillationTools.searchMaxProviderAttempts = settings.search.maxProviderAttempts;
  groupedConfig.distillationTools.searchResultCount = settings.search.resultCount;
  groupedConfig.distillationTools.timeoutMs = settings.search.timeoutMs;
  groupedConfig.distillationTools.searchRateLimitCooldownSeconds =
    settings.search.rateLimitCooldownSeconds;
  groupedConfig.distillationTools.maxRounds = settings.distillationRuntime.maxToolRounds;
  groupedConfig.distillationTools.findCandidateMaxToolCalls =
    settings.distillationRuntime.findCandidateMaxToolCalls;
  groupedConfig.distillationTools.coverEvidenceSearchMaxCalls =
    settings.distillationRuntime.coverEvidenceSearchMaxCalls;
  groupedConfig.distillationTools.coverEvidenceFetchMaxCalls =
    settings.distillationRuntime.coverEvidenceFetchMaxCalls;
  groupedConfig.distillationTools.coverEvidenceFetchMaxTokensPerSite =
    settings.distillationRuntime.coverEvidenceFetchMaxTokensPerSite;
  groupedConfig.distillationTools.resultMaxChars = settings.distillationRuntime.toolResultMaxChars;
  groupedConfig.distillationTools.failureRetryDelaySeconds =
    settings.distillationRuntime.failureRetryDelaySeconds;
  groupedConfig.distillationTools.readerMaxReads = settings.distillationRuntime.readerMaxReads;
  groupedConfig.distillationTools.readerMaxCharsPerRead =
    settings.distillationRuntime.readerMaxCharsPerRead;

  groupedConfig.doctor.freshnessThresholdMinutes =
    settings.advanced.doctorFreshnessThresholdMinutes;
  groupedConfig.doctor.degradedRateThreshold = settings.advanced.doctorDegradedRateThreshold;
  groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount =
    settings.advanced.doctorKnowledgeZeroUseWarningMinActiveCount;
  process.env.BRAVE_SEARCH_API_KEY = secrets.braveApiKey?.value ?? "";
  process.env[projectEnvKey("EXA_API_KEY")] = secrets.exaApiKey?.value ?? "";
}

export function buildRuntimeSettingsView(
  settings: RuntimeSettingsEditable,
  secretStatuses: {
    openaiApiKey: RuntimeSecretStatus;
    azureOpenAiApiKey: RuntimeSecretStatus;
    azureOpenAiApiKeys?: RuntimeSecretStatus[];
    localLlmApiKey: RuntimeSecretStatus;
    localLlmApiKeys?: RuntimeSecretStatus[];
    braveApiKey: RuntimeSecretStatus;
    exaApiKey: RuntimeSecretStatus;
    bedrockCredential: RuntimeSecretStatus;
  },
): RuntimeSettingsView {
  return {
    ...settings,
    effectiveTargets: buildRuntimeEffectiveTargets(settings),
    diagnostics: buildRuntimeDiagnostics(settings),
    providers: {
      ...settings.providers,
      openai: { ...settings.providers.openai, apiKeySecret: secretStatuses.openaiApiKey },
      "azure-openai": {
        ...settings.providers["azure-openai"],
        apiKeySecret: secretStatuses.azureOpenAiApiKey,
        apiKeySecrets:
          secretStatuses.azureOpenAiApiKeys ??
          settings.providers["azure-openai"].deployments.map((_, index) =>
            index === 0 ? secretStatuses.azureOpenAiApiKey : emptyRuntimeSecretStatus(),
          ),
      },
      bedrock: {
        ...settings.providers.bedrock,
        credentialSecret: secretStatuses.bedrockCredential,
      },
      "local-llm": {
        ...settings.providers["local-llm"],
        apiKeySecret: secretStatuses.localLlmApiKey,
        apiKeySecrets:
          secretStatuses.localLlmApiKeys ??
          settings.providers["local-llm"].models.map((_, index) =>
            index === 0 ? secretStatuses.localLlmApiKey : emptyRuntimeSecretStatus(),
          ),
      },
    },
    search: {
      ...settings.search,
      providers: {
        ...settings.search.providers,
        brave: { ...settings.search.providers.brave, apiKeySecret: secretStatuses.braveApiKey },
        exa: { ...settings.search.providers.exa, apiKeySecret: secretStatuses.exaApiKey },
      },
    },
  };
}

export function buildSourceMap(view: RuntimeSettingsView): Record<string, string> {
  return {
    "distillationPriority.targetPriorityOrder": "db",
    "findCandidate.source.provider": "db",
    "findCandidate.vibe.provider": "db",
    "findCandidate.throttling": "db",
    "webSourceResearch.provider": "db",
    "coverEvidence.sourceSupport.provider": "db",
    "coverEvidence.externalEvidence.provider": "db",
    "coverEvidence.mcpEvidence.provider": "db",
    "findCandidate.timeoutMs": "db",
    "findCandidate.maxToolCalls": "db",
    "distillation.pipelineClaimLimit": "db",
    "findingQueue.taskIntervalSeconds": "db",
    "coveringQueue.taskIntervalSeconds": "db",
    "coverEvidence.timeoutMs": "db",
    "coverEvidence.searchMaxCalls": "db",
    "coverEvidence.fetchMaxCalls": "db",
    "agenticCompile.provider": "db",
    "openai.apiKey": view.providers.openai.apiKeySecret.source,
    "azure-openai.apiKey": view.providers["azure-openai"].apiKeySecret.source,
    "azure-openai.apiKey2": view.providers["azure-openai"].apiKeySecrets[1]?.source ?? "none",
    "azure-openai.apiKey3": view.providers["azure-openai"].apiKeySecrets[2]?.source ?? "none",
    "local-llm.apiKey": view.providers["local-llm"].apiKeySecret.source,
    "local-llm.apiKey2": view.providers["local-llm"].apiKeySecrets[1]?.source ?? "none",
    "local-llm.apiKey3": view.providers["local-llm"].apiKeySecrets[2]?.source ?? "none",
    "search.brave.apiKey": view.search.providers.brave.apiKeySecret.source,
    "search.exa.apiKey": view.search.providers.exa.apiKeySecret.source,
    "bedrock.credential": view.providers.bedrock.credentialSecret.source,
  };
}

export function defaultCache(): RuntimeSettingsCache {
  const defaults = cloneDefaultSettings();
  const secretStatuses = {
    openaiApiKey: {
      configured: Boolean(bootstrap.secrets.openaiApiKey),
      source: bootstrap.secrets.openaiApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.openaiApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey),
      source: bootstrap.secrets.azureOpenAiApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey2: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey2),
      source: bootstrap.secrets.azureOpenAiApiKey2 ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey2),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKey3: {
      configured: Boolean(bootstrap.secrets.azureOpenAiApiKey3),
      source: bootstrap.secrets.azureOpenAiApiKey3 ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.azureOpenAiApiKey3),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    azureOpenAiApiKeys: bootstrap.providers["azure-openai"].deployments.map(
      (_deployment, index) => {
        const value =
          index === 0
            ? bootstrap.secrets.azureOpenAiApiKey
            : bootstrap.secrets[`azureOpenAiApiKey${index + 1}` as RuntimeSecretKey];
        return {
          configured: Boolean(value),
          source: value ? "env" : "none",
          maskedValue: maskSecret(value),
          updatedAt: null,
        } satisfies RuntimeSecretStatus;
      },
    ),
    localLlmApiKey: {
      configured: Boolean(bootstrap.secrets.localLlmApiKey),
      source: bootstrap.secrets.localLlmApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.localLlmApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    localLlmApiKeys: bootstrap.providers["local-llm"].models.map((_model, index) => {
      const value = bootstrap.secrets[localLlmSecretKey(index)];
      return {
        configured: Boolean(value),
        source: value ? "env" : "none",
        maskedValue: maskSecret(value),
        updatedAt: null,
      } satisfies RuntimeSecretStatus;
    }),
    braveApiKey: {
      configured: Boolean(bootstrap.secrets.braveApiKey),
      source: bootstrap.secrets.braveApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.braveApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    exaApiKey: {
      configured: Boolean(bootstrap.secrets.exaApiKey),
      source: bootstrap.secrets.exaApiKey ? "env" : "none",
      maskedValue: maskSecret(bootstrap.secrets.exaApiKey),
      updatedAt: null,
    } satisfies RuntimeSecretStatus,
    bedrockCredential: resolveBedrockCredentialStatus(defaults),
  };
  const view = buildRuntimeSettingsView(defaults, secretStatuses);
  return {
    loadedAt: null,
    revision: 0,
    settings: defaults,
    view,
    sources: buildSourceMap(view),
  };
}
