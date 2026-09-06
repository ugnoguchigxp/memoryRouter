import { createHash } from "node:crypto";
import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { readProjectEnv } from "../../project-identity.js";
import type { SettingsRow } from "./settings.repository.js";
import {
  type DistillationPriorityTargetKind,
  type RuntimeAgenticProviderName,
  type RuntimeProviderName,
  type RuntimeProviderPool,
  type RuntimeProviderPoolTarget,
  type RuntimeProviderSetting,
  type RuntimeSecretKey,
  type RuntimeSettingsEditable,
  type RuntimeSettingsRoute,
  type RuntimeSettingsSecrets,
  distillationPriorityTargetKindValues,
  isLarmAgentConnectionRoute,
  runtimeProviderNames,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

export const secretRowKeys: RuntimeSecretKey[] = [
  "openaiApiKey",
  "azureOpenAiApiKey",
  "azureOpenAiApiKey2",
  "azureOpenAiApiKey3",
  "localLlmApiKey",
  "braveApiKey",
  "exaApiKey",
];

type BootstrapConfig = {
  general: RuntimeSettingsEditable["general"];
  providerPools: RuntimeSettingsEditable["providerPools"];
  providers: RuntimeSettingsEditable["providers"];
  taskRouting: RuntimeSettingsEditable["taskRouting"];
  search: RuntimeSettingsEditable["search"];
  embedding: RuntimeSettingsEditable["embedding"];
  distillationRuntime: RuntimeSettingsEditable["distillationRuntime"];
  advanced: RuntimeSettingsEditable["advanced"];
  secrets: RuntimeSettingsSecrets;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeProviderName(value: unknown): RuntimeProviderName | undefined {
  if (typeof value !== "string") return undefined;
  return runtimeProviderNames.includes(value as RuntimeProviderName)
    ? (value as RuntimeProviderName)
    : undefined;
}

function normalizeProviderList(values: unknown[]): RuntimeProviderName[] {
  const deduped = new Set<RuntimeProviderName>();
  for (const value of values) {
    const normalized = normalizeProviderName(value);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

function normalizeProviderPoolTarget(
  value: unknown,
  localLlmModelIds: Set<string>,
  larmConnectionIds: Set<string>,
): RuntimeProviderPoolTarget | null {
  const record = asRecord(value);
  if (record.provider === "larm-agent-connection") {
    const connectionId = typeof record.connectionId === "string" ? record.connectionId.trim() : "";
    return connectionId && larmConnectionIds.has(connectionId)
      ? { provider: "larm-agent-connection", connectionId }
      : null;
  }
  const provider = normalizeProviderName(record.provider);
  if (!provider) return null;
  if (provider === "local-llm") {
    const localLlmModelId =
      typeof record.localLlmModelId === "string" ? record.localLlmModelId.trim() : "";
    return localLlmModelId && localLlmModelIds.has(localLlmModelId)
      ? { provider, localLlmModelId }
      : null;
  }
  if (provider === "azure-openai") {
    const deploymentSlot = Number(record.deploymentSlot);
    return Number.isInteger(deploymentSlot) && deploymentSlot >= 1
      ? { provider, deploymentSlot }
      : null;
  }
  const targetId = typeof record.targetId === "string" ? record.targetId.trim() : "";
  return targetId ? { provider, targetId } : null;
}

function normalizeProviderPools(
  settings: RuntimeSettingsEditable,
  values: unknown,
): RuntimeProviderPool[] {
  const localLlmModelIds = new Set(
    settings.providers["local-llm"].models
      .map((model) => model.id)
      .filter((id): id is string => Boolean(id)),
  );
  const larmConnectionIds = new Set(
    settings.providers["larm-agent-connection"].connections.map((connection) => connection.id),
  );
  const rawPools = Array.isArray(values) ? values : [];
  const pools: RuntimeProviderPool[] = [];
  const seen = new Set<string>();

  for (const value of rawPools) {
    const record = asRecord(value);
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const targets = Array.isArray(record.targets)
      ? record.targets
          .map((target) => normalizeProviderPoolTarget(target, localLlmModelIds, larmConnectionIds))
          .filter((target): target is RuntimeProviderPoolTarget => Boolean(target))
      : [];
    if (targets.length === 0) continue;
    const maxConcurrent = Math.max(
      1,
      Math.min(targets.length, Math.floor(Number(record.maxConcurrent) || targets.length)),
    );
    pools.push({
      id,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
      targets,
      maxConcurrent,
      staleLeaseSeconds: Math.max(
        30,
        Math.floor(Number(record.staleLeaseSeconds) || groupedConfig.distillation.lockTtlSeconds),
      ),
      enabled: record.enabled !== false,
      lowPriorityAgingSeconds: Math.max(
        60,
        Math.floor(Number(record.lowPriorityAgingSeconds) || 30 * 60),
      ),
    });
    seen.add(id);
  }

  if (pools.length === 0) {
    const targets = settings.providers["local-llm"].models.map((model) => ({
      provider: "local-llm" as const,
      localLlmModelId:
        model.id ??
        stableLocalLlmModelId({
          apiBaseUrl: model.apiBaseUrl,
          apiPath: model.apiPath,
          model: model.model,
        }),
    }));
    if (targets.length > 0) {
      pools.push({
        id: "local-llm-default",
        label: targets.length === 1 ? "Local LLM" : "Local LLM Pool",
        targets,
        maxConcurrent: targets.length,
        staleLeaseSeconds: Math.max(30, groupedConfig.distillation.lockTtlSeconds),
        enabled: settings.providers["local-llm"].enabled,
        lowPriorityAgingSeconds: 30 * 60,
      });
    }
  }

  return pools;
}

const defaultDistillationTargetPriorityOrder: DistillationPriorityTargetKind[] = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
];
const localLlmAzureFallback: RuntimeProviderName[] = ["azure-openai"];

const distillationPriorityTargetKindSet = new Set<DistillationPriorityTargetKind>(
  distillationPriorityTargetKindValues,
);

function normalizeAzureDeploymentSlots(values: unknown): number[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const deduped = new Set<number>();
  for (const value of values) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(numeric)) continue;
    if (numeric < 1) continue;
    deduped.add(numeric);
  }
  const normalized = [...deduped];
  return normalized.length > 0 ? normalized : undefined;
}

function azureDeploymentName(index: number): string {
  return index === 0 ? "Primary" : `Deployment ${index + 1}`;
}

function normalizeAzureDeployment(
  value: Record<string, unknown>,
  index: number,
  fallback: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number] {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const apiBaseUrl =
    typeof value.apiBaseUrl === "string"
      ? value.apiBaseUrl.trim().replace(/\/+$/, "")
      : index === 0
        ? fallback.apiBaseUrl
        : "";
  const apiPath =
    typeof value.apiPath === "string" && value.apiPath.trim()
      ? value.apiPath.trim()
      : fallback.apiPath;
  const apiVersion =
    typeof value.apiVersion === "string" && value.apiVersion.trim()
      ? value.apiVersion.trim()
      : fallback.apiVersion;
  const model =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : index === 0
        ? fallback.model
        : "";
  return {
    name: name || azureDeploymentName(index),
    apiBaseUrl,
    apiPath,
    apiVersion,
    model,
  };
}

function normalizeAzureDeployments(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"] {
  const rawDeployments = Array.isArray(provider.deployments) ? provider.deployments : [];
  return rawDeployments
    .map((value, index) => normalizeAzureDeployment(asRecord(value), index, provider))
    .filter((item) => item.apiBaseUrl.trim() && item.model.trim());
}

function syncAzureOpenAiProvider(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"] {
  const deployments = normalizeAzureDeployments(provider);
  const primary = deployments[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    apiPath: primary?.apiPath ?? provider.apiPath,
    apiVersion: primary?.apiVersion ?? provider.apiVersion,
    model: primary?.model ?? provider.model,
    deployments,
  };
}

function localLlmModelName(index: number): string {
  return index === 0 ? "Primary" : `Local LLM ${index + 1}`;
}

export function stableLocalLlmModelId(input: {
  apiBaseUrl: string;
  apiPath?: string;
  model: string;
}): string {
  const normalized = JSON.stringify({
    apiBaseUrl: input.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: input.apiPath?.trim() || "/v1/chat/completions",
    model: input.model.trim(),
  });
  return `local-llm-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

function normalizeLocalLlmModel(
  value: Record<string, unknown>,
  index: number,
  fallback: RuntimeSettingsEditable["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"][number] {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const apiBaseUrl =
    typeof value.apiBaseUrl === "string" && value.apiBaseUrl.trim()
      ? value.apiBaseUrl.trim().replace(/\/+$/, "")
      : index === 0
        ? fallback.apiBaseUrl
        : "";
  const apiPath =
    typeof value.apiPath === "string" && value.apiPath.trim()
      ? value.apiPath.trim()
      : fallback.apiPath || "/v1/chat/completions";
  const model =
    typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : index === 0
        ? fallback.model
        : "";
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id.trim()
      : stableLocalLlmModelId({ apiBaseUrl, apiPath, model });
  return {
    id,
    name: name || localLlmModelName(index),
    apiBaseUrl,
    apiPath,
    model,
  };
}

function normalizeLocalLlmModels(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"] {
  const rawModels = Array.isArray(provider.models) ? provider.models : [];
  const models = rawModels
    .map((value, index) => normalizeLocalLlmModel(asRecord(value), index, provider))
    .filter((item) => item.apiBaseUrl.trim() && item.model.trim());
  return models;
}

function syncLocalLlmProvider(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"] {
  const models = normalizeLocalLlmModels(provider);
  const primary = models[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    apiPath: primary?.apiPath ?? provider.apiPath,
    model: primary?.model ?? provider.model,
    models,
  };
}

export function normalizeDistillationTargetPriorityOrder(
  values: unknown,
): DistillationPriorityTargetKind[] {
  const source = Array.isArray(values) ? values : [];
  const deduped: DistillationPriorityTargetKind[] = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    if (!distillationPriorityTargetKindSet.has(raw as DistillationPriorityTargetKind)) continue;
    const next = raw as DistillationPriorityTargetKind;
    if (!deduped.includes(next)) deduped.push(next);
  }
  for (const fallback of defaultDistillationTargetPriorityOrder) {
    if (!deduped.includes(fallback)) deduped.push(fallback);
  }
  return deduped;
}

export const bootstrap: BootstrapConfig = {
  general: {
    distillationPriority: {
      targetPriorityOrder: [...defaultDistillationTargetPriorityOrder],
    },
  },
  providerPools: [
    {
      id: "local-llm-default",
      label: "Local LLM",
      targets: [
        {
          provider: "local-llm",
          localLlmModelId: stableLocalLlmModelId({
            apiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
            apiPath: groupedConfig.localLlm.apiPath,
            model: groupedConfig.localLlm.model,
          }),
        },
      ],
      maxConcurrent: 1,
      staleLeaseSeconds: Math.max(30, groupedConfig.distillation.lockTtlSeconds),
      enabled: Boolean(
        groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim(),
      ),
      lowPriorityAgingSeconds: 30 * 60,
    },
  ],
  providers: {
    openai: {
      enabled: true,
      apiBaseUrl: groupedConfig.openAi.apiBaseUrl,
      model: groupedConfig.openAi.model,
    },
    "azure-openai": {
      enabled: Boolean(
        groupedConfig.azureOpenAi.apiBaseUrl.trim() &&
          groupedConfig.azureOpenAi.model.trim() &&
          groupedConfig.azureOpenAi.apiKey.trim(),
      ),
      apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
      apiPath: groupedConfig.azureOpenAi.apiPath,
      apiVersion: groupedConfig.azureOpenAi.apiVersion,
      model: groupedConfig.azureOpenAi.model,
      deployments: [
        {
          name: "Primary",
          apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
          apiPath: groupedConfig.azureOpenAi.apiPath,
          apiVersion: groupedConfig.azureOpenAi.apiVersion,
          model: groupedConfig.azureOpenAi.model,
        },
        ...[2, 3]
          .map((slot) => ({
            name: `Deployment ${slot}`,
            apiBaseUrl:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_BASE_URL`)?.trim() ??
              process.env[`AZURE_OPENAI_${slot}_API_BASE_URL`]?.trim() ??
              "",
            apiPath:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_PATH`)?.trim() || "/openai/deployments",
            apiVersion:
              readProjectEnv(`AZURE_OPENAI_${slot}_API_VERSION`)?.trim() ||
              groupedConfig.azureOpenAi.apiVersion,
            model:
              readProjectEnv(`AZURE_OPENAI_${slot}_MODEL`)?.trim() ??
              process.env[`AZURE_OPENAI_${slot}_MODEL`]?.trim() ??
              "",
          }))
          .filter((deployment) => deployment.apiBaseUrl || deployment.model),
      ],
    },
    bedrock: {
      enabled: Boolean(groupedConfig.bedrock.region.trim() && groupedConfig.bedrock.model.trim()),
      region: groupedConfig.bedrock.region,
      profile: groupedConfig.bedrock.profile,
      model: groupedConfig.bedrock.model,
    },
    "local-llm": {
      enabled: Boolean(
        groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim(),
      ),
      apiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
      apiPath: groupedConfig.localLlm.apiPath,
      model: groupedConfig.localLlm.model,
      models: [
        {
          id: stableLocalLlmModelId({
            apiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
            apiPath: groupedConfig.localLlm.apiPath,
            model: groupedConfig.localLlm.model,
          }),
          name: "Primary",
          apiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
          apiPath: groupedConfig.localLlm.apiPath,
          model: groupedConfig.localLlm.model,
        },
      ],
    },
    "larm-agent-connection": {
      enabled: false,
      connections: [],
    },
    codex: {
      enabled: false,
      model: "codex-sdk-agent",
    },
  },
  taskRouting: {
    findCandidate: {
      source: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
      vibe: { provider: "openai", model: groupedConfig.openAi.model, fallback: [] },
      throttling: {
        backgroundEnabled: groupedConfig.distillation.findCandidateBackgroundEnabled,
        interactiveWindowSeconds: groupedConfig.distillation.findCandidateInteractiveWindowSeconds,
        recentBlockSeconds: groupedConfig.distillation.findCandidateRecentBlockSeconds,
        minIntervalSeconds: groupedConfig.distillation.findCandidateMinIntervalSeconds,
        mediumIntervalSeconds: groupedConfig.distillation.findCandidateMediumIntervalSeconds,
        busyIntervalSeconds: groupedConfig.distillation.findCandidateBusyIntervalSeconds,
        maxIntervalSeconds: groupedConfig.distillation.findCandidateMaxIntervalSeconds,
        rateLimitCooldownSeconds: groupedConfig.distillation.findCandidateRateLimitCooldownSeconds,
        jitterSeconds: groupedConfig.distillation.findCandidateJitterSeconds,
      },
    },
    webSourceResearch: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    episodeDistiller: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    coverEvidence: {
      sourceSupport: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
      externalEvidence: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
      mcpEvidence: {
        provider: "local-llm",
        model: groupedConfig.localLlm.model,
        fallback: [...localLlmAzureFallback],
      },
    },
    deadZoneMergeReview: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [],
    },
    landscapeCuration: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [],
    },
    finalizeDistille: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    mergeActivationFinalize: {
      provider: "local-llm",
      model: groupedConfig.localLlm.model,
      fallback: [...localLlmAzureFallback],
    },
    agenticCompile: {
      enabled: groupedConfig.agenticCompile.enabled,
      provider: "openai",
      model: groupedConfig.openAi.model,
      fallback: ["local-llm"],
      timeoutMs: groupedConfig.agenticCompile.timeoutMs,
      maxTokens: groupedConfig.agenticCompile.maxTokens,
    },
  },
  search: {
    providerOrder: [...groupedConfig.distillationTools.searchProviders],
    maxProviderAttempts: groupedConfig.distillationTools.searchMaxProviderAttempts,
    resultCount: groupedConfig.distillationTools.searchResultCount,
    timeoutMs: groupedConfig.distillationTools.timeoutMs,
    rateLimitCooldownSeconds: groupedConfig.distillationTools.searchRateLimitCooldownSeconds,
    providers: {
      brave: { enabled: true },
      exa: { enabled: true },
      duckduckgo: { enabled: true },
    },
  },
  embedding: {
    provider: groupedConfig.embedding.provider,
    daemonUrl: groupedConfig.embedding.daemonUrl,
    openaiModel: groupedConfig.embedding.openaiModel,
    timeoutMs: groupedConfig.embedding.timeoutMs,
  },
  distillationRuntime: {
    timeoutMs: groupedConfig.distillation.timeoutMs,
    candidateTimeoutMs: groupedConfig.distillation.candidateTimeoutMs,
    maxToolRounds: groupedConfig.distillationTools.maxRounds,
    findCandidateTimeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
    findCandidateMaxToolCalls: groupedConfig.distillationTools.findCandidateMaxToolCalls,
    coverEvidenceTimeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
    coverEvidenceSearchMaxCalls: groupedConfig.distillationTools.coverEvidenceSearchMaxCalls,
    coverEvidenceFetchMaxCalls: groupedConfig.distillationTools.coverEvidenceFetchMaxCalls,
    coverEvidenceFetchMaxTokensPerSite:
      groupedConfig.distillationTools.coverEvidenceFetchMaxTokensPerSite,
    toolTimeoutMs: groupedConfig.distillationTools.timeoutMs,
    toolResultMaxChars: groupedConfig.distillationTools.resultMaxChars,
    failureRetryDelaySeconds: groupedConfig.distillationTools.failureRetryDelaySeconds,
    readerMaxReads: groupedConfig.distillationTools.readerMaxReads,
    readerMaxCharsPerRead: groupedConfig.distillationTools.readerMaxCharsPerRead,
    llmContextWindowTokens: groupedConfig.distillation.llmContextWindowTokens,
    llmMaxInputTokens: groupedConfig.distillation.llmMaxInputTokens,
    llmInputSafetyMarginTokens: groupedConfig.distillation.llmInputSafetyMarginTokens,
    lowImportanceRejectThreshold: groupedConfig.distillation.lowImportanceRejectThreshold,
  },
  advanced: {
    pipelineLockStaleSeconds: groupedConfig.distillation.pipelineLockStaleSeconds,
    lockTtlSeconds: groupedConfig.distillation.lockTtlSeconds,
    pipelineClaimLimit: groupedConfig.distillation.pipelineClaimLimit,
    findingQueueTaskIntervalSeconds: groupedConfig.distillation.findingQueueTaskIntervalSeconds,
    coveringQueueTaskIntervalSeconds: groupedConfig.distillation.coveringQueueTaskIntervalSeconds,
    continuousIdleSleepMs: groupedConfig.distillation.continuousIdleSleepMs,
    continuousErrorSleepMs: groupedConfig.distillation.continuousErrorSleepMs,
    inventoryRefreshIntervalMs: groupedConfig.distillation.inventoryRefreshIntervalMs,
    doctorFreshnessThresholdMinutes: groupedConfig.doctor.freshnessThresholdMinutes,
    doctorDegradedRateThreshold: groupedConfig.doctor.degradedRateThreshold,
    doctorKnowledgeZeroUseWarningMinActiveCount:
      groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
    codexLogSyncEnabled: true,
    antigravityLogSyncEnabled: true,
    claudeLogSyncEnabled: true,
  },
  secrets: {
    openaiApiKey: groupedConfig.openAi.apiKey.trim() || undefined,
    azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey.trim() || undefined,
    azureOpenAiApiKey2:
      readProjectEnv("AZURE_OPENAI_2_API_KEY")?.trim() ||
      process.env.AZURE_OPENAI_2_API_KEY?.trim() ||
      undefined,
    azureOpenAiApiKey3:
      readProjectEnv("AZURE_OPENAI_3_API_KEY")?.trim() ||
      process.env.AZURE_OPENAI_3_API_KEY?.trim() ||
      undefined,
    localLlmApiKey: groupedConfig.localLlm.apiKey.trim() || undefined,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
    exaApiKey:
      readProjectEnv("EXA_API_KEY")?.trim() || process.env.EXA_API_KEY?.trim() || undefined,
  },
};

export function cloneDefaultSettings(): RuntimeSettingsEditable {
  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: [...bootstrap.general.distillationPriority.targetPriorityOrder],
      },
    },
    providerPools: bootstrap.providerPools.map((pool) => ({
      ...pool,
      targets: pool.targets.map((target) => ({ ...target })),
    })),
    providers: {
      openai: { ...bootstrap.providers.openai },
      "azure-openai": {
        ...bootstrap.providers["azure-openai"],
        deployments: bootstrap.providers["azure-openai"].deployments.map((deployment) => ({
          ...deployment,
        })),
      },
      bedrock: { ...bootstrap.providers.bedrock },
      "local-llm": {
        ...bootstrap.providers["local-llm"],
        models: bootstrap.providers["local-llm"].models.map((model) => ({ ...model })),
      },
      "larm-agent-connection": {
        ...bootstrap.providers["larm-agent-connection"],
        connections: bootstrap.providers["larm-agent-connection"].connections.map((connection) => ({
          ...connection,
        })),
      },
      codex: { ...bootstrap.providers.codex },
    },
    taskRouting: {
      findCandidate: {
        source: cloneRoute(bootstrap.taskRouting.findCandidate.source),
        vibe: cloneRoute(bootstrap.taskRouting.findCandidate.vibe),
        throttling: { ...bootstrap.taskRouting.findCandidate.throttling },
      },
      webSourceResearch: cloneRoute(bootstrap.taskRouting.webSourceResearch),
      episodeDistiller: cloneRoute(bootstrap.taskRouting.episodeDistiller),
      coverEvidence: {
        sourceSupport: cloneRoute(bootstrap.taskRouting.coverEvidence.sourceSupport),
        externalEvidence: cloneRoute(bootstrap.taskRouting.coverEvidence.externalEvidence),
        mcpEvidence: cloneRoute(bootstrap.taskRouting.coverEvidence.mcpEvidence),
      },
      finalizeDistille: cloneRoute(bootstrap.taskRouting.finalizeDistille),
      mergeActivationFinalize: cloneRoute(bootstrap.taskRouting.mergeActivationFinalize),
      deadZoneMergeReview: cloneRoute(bootstrap.taskRouting.deadZoneMergeReview),
      landscapeCuration: cloneRoute(bootstrap.taskRouting.landscapeCuration),
      agenticCompile: {
        ...bootstrap.taskRouting.agenticCompile,
        fallback: [...bootstrap.taskRouting.agenticCompile.fallback],
        azureDeploymentSlots: bootstrap.taskRouting.agenticCompile.azureDeploymentSlots
          ? [...bootstrap.taskRouting.agenticCompile.azureDeploymentSlots]
          : undefined,
      },
    },
    search: {
      ...bootstrap.search,
      providerOrder: [...bootstrap.search.providerOrder],
      providers: {
        brave: { ...bootstrap.search.providers.brave },
        exa: { ...bootstrap.search.providers.exa },
        duckduckgo: { ...bootstrap.search.providers.duckduckgo },
      },
    },
    embedding: { ...bootstrap.embedding },
    distillationRuntime: { ...bootstrap.distillationRuntime },
    advanced: { ...bootstrap.advanced },
  };
}

function resolveConfiguredRouteModel(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting | RuntimeAgenticProviderName,
): string | undefined {
  if (provider === "auto") return undefined;
  switch (provider) {
    case "openai":
      return settings.providers.openai.model.trim() || undefined;
    case "azure-openai":
      return (
        settings.providers["azure-openai"].deployments
          .find((deployment) => deployment.model.trim())
          ?.model.trim() ||
        settings.providers["azure-openai"].model.trim() ||
        undefined
      );
    case "bedrock":
      return settings.providers.bedrock.model.trim() || undefined;
    case "local-llm":
      return (
        settings.providers["local-llm"].models.find((model) => model.model.trim())?.model.trim() ||
        settings.providers["local-llm"].model.trim() ||
        undefined
      );
    case "codex":
      return settings.providers.codex.model.trim() || undefined;
  }
}

function localLlmRouteTargetValue(model: {
  apiBaseUrl: string;
  apiPath?: string;
  model: string;
}): string {
  return JSON.stringify({
    apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: model.apiPath?.trim() || "/v1/chat/completions",
    model: model.model.trim(),
  });
}

function parseLocalLlmRouteTarget(
  value: string | undefined,
): { apiBaseUrl: string; apiPath?: string; model: string } | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<{
      apiBaseUrl: string;
      apiPath: string;
      model: string;
    }>;
    if (typeof parsed.apiBaseUrl === "string" && typeof parsed.model === "string") {
      const apiBaseUrl = parsed.apiBaseUrl.trim().replace(/\/+$/, "");
      const apiPath =
        typeof parsed.apiPath === "string" && parsed.apiPath.trim()
          ? parsed.apiPath.trim()
          : undefined;
      const model = parsed.model.trim();
      if (apiBaseUrl && model) return { apiBaseUrl, apiPath, model };
    }
  } catch {
    // Plain model names are the legacy route value.
  }
  return null;
}

function resolveConfiguredLocalLlmRouteTarget(
  settings: RuntimeSettingsEditable,
  value: string | undefined,
): { routeValue: string; model: string } | undefined {
  const configuredModels = settings.providers["local-llm"].models
    .map((model) => ({
      apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
      apiPath: model.apiPath.trim() || "/v1/chat/completions",
      model: model.model.trim(),
    }))
    .filter((model) => model.apiBaseUrl && model.model);
  if (configuredModels.length === 0) return undefined;

  const target = parseLocalLlmRouteTarget(value);
  const matched = target
    ? configuredModels.find(
        (model) =>
          model.apiBaseUrl === target.apiBaseUrl &&
          (!target.apiPath || model.apiPath === target.apiPath) &&
          model.model === target.model,
      )
    : configuredModels.find((model) => model.model === value?.trim());
  const selected = matched ?? configuredModels[0];
  const duplicateModelCount = configuredModels.filter(
    (model) => model.model === selected.model,
  ).length;
  return {
    routeValue: duplicateModelCount > 1 ? localLlmRouteTargetValue(selected) : selected.model,
    model: selected.model,
  };
}

function sanitizeRoute(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) {
    return {
      kind: "larm-agent-connection",
      connectionId: route.connectionId.trim(),
    };
  }
  const configuredLocalLlmTarget = resolveConfiguredLocalLlmRouteTarget(
    settings,
    route.localLlmModel,
  );
  const model =
    route.provider === "local-llm"
      ? (resolveConfiguredLocalLlmRouteTarget(settings, route.model)?.routeValue ??
        configuredLocalLlmTarget?.routeValue ??
        resolveConfiguredRouteModel(settings, route.provider))
      : resolveConfiguredRouteModel(settings, route.provider);
  const requestedProviderPoolId =
    typeof route.providerPoolId === "string" && route.providerPoolId.trim()
      ? route.providerPoolId.trim()
      : undefined;
  return {
    provider: route.provider,
    model,
    providerPoolId: requestedProviderPoolId,
    localLlmModel:
      route.provider === "local-llm" || route.fallback.includes("local-llm")
        ? (configuredLocalLlmTarget?.routeValue ??
          (route.provider === "local-llm"
            ? model
            : resolveConfiguredLocalLlmRouteTarget(settings, undefined)?.routeValue))
        : undefined,
    fallback: normalizeProviderList(route.fallback),
    azureDeploymentSlots: normalizeAzureDeploymentSlots(route.azureDeploymentSlots),
  };
}

function cloneRoute(route: RuntimeSettingsRoute): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) {
    return { kind: "larm-agent-connection", connectionId: route.connectionId };
  }
  return {
    ...route,
    providerPoolId: route.providerPoolId,
    fallback: [...route.fallback],
    azureDeploymentSlots: route.azureDeploymentSlots ? [...route.azureDeploymentSlots] : undefined,
  };
}

function hasRouteConfig(value: unknown): boolean {
  return Object.keys(asRecord(value)).length > 0;
}

function mergeRoute(fallback: RuntimeSettingsRoute, value: unknown): RuntimeSettingsRoute {
  const record = asRecord(value);
  if (record.kind === "larm-agent-connection") {
    return {
      kind: "larm-agent-connection",
      connectionId: typeof record.connectionId === "string" ? record.connectionId : "",
    };
  }
  return {
    ...fallback,
    ...record,
  } as RuntimeSettingsRoute;
}

function mergeRuntimeSettings(
  defaults: RuntimeSettingsEditable,
  input: Record<string, unknown>,
): RuntimeSettingsEditable {
  const rawTaskRouting = asRecord(input.taskRouting);
  const hasEpisodeDistillerRoute = hasRouteConfig(rawTaskRouting.episodeDistiller);
  const merged: RuntimeSettingsEditable = {
    ...defaults,
    general: {
      ...defaults.general,
      ...asRecord(input.general),
      distillationPriority: {
        ...defaults.general.distillationPriority,
        ...asRecord(asRecord(input.general).distillationPriority),
      },
    },
    providerPools: Array.isArray(input.providerPools)
      ? (input.providerPools as RuntimeProviderPool[])
      : defaults.providerPools,
    providers: {
      ...defaults.providers,
      ...asRecord(input.providers),
      openai: {
        ...defaults.providers.openai,
        ...asRecord(asRecord(input.providers).openai),
      },
      "azure-openai": {
        ...defaults.providers["azure-openai"],
        ...asRecord(asRecord(input.providers)["azure-openai"]),
      },
      bedrock: {
        ...defaults.providers.bedrock,
        ...asRecord(asRecord(input.providers).bedrock),
      },
      "local-llm": {
        ...defaults.providers["local-llm"],
        ...asRecord(asRecord(input.providers)["local-llm"]),
      },
      "larm-agent-connection": {
        ...defaults.providers["larm-agent-connection"],
        ...asRecord(asRecord(input.providers)["larm-agent-connection"]),
      },
      codex: {
        ...defaults.providers.codex,
        ...asRecord(asRecord(input.providers).codex),
      },
    },
    taskRouting: {
      ...defaults.taskRouting,
      ...asRecord(input.taskRouting),
      findCandidate: {
        ...defaults.taskRouting.findCandidate,
        ...asRecord(asRecord(input.taskRouting).findCandidate),
        source: mergeRoute(
          defaults.taskRouting.findCandidate.source,
          asRecord(asRecord(input.taskRouting).findCandidate).source,
        ),
        vibe: mergeRoute(
          defaults.taskRouting.findCandidate.vibe,
          asRecord(asRecord(input.taskRouting).findCandidate).vibe,
        ),
        throttling: {
          ...defaults.taskRouting.findCandidate.throttling,
          ...asRecord(asRecord(asRecord(input.taskRouting).findCandidate).throttling),
        },
      },
      webSourceResearch: mergeRoute(
        defaults.taskRouting.webSourceResearch,
        asRecord(input.taskRouting).webSourceResearch,
      ),
      episodeDistiller: mergeRoute(
        defaults.taskRouting.episodeDistiller,
        rawTaskRouting.episodeDistiller,
      ),
      coverEvidence: {
        ...defaults.taskRouting.coverEvidence,
        ...asRecord(asRecord(input.taskRouting).coverEvidence),
        sourceSupport: mergeRoute(
          defaults.taskRouting.coverEvidence.sourceSupport,
          asRecord(asRecord(input.taskRouting).coverEvidence).sourceSupport,
        ),
        externalEvidence: mergeRoute(
          defaults.taskRouting.coverEvidence.externalEvidence,
          asRecord(asRecord(input.taskRouting).coverEvidence).externalEvidence,
        ),
        mcpEvidence: mergeRoute(
          defaults.taskRouting.coverEvidence.mcpEvidence,
          asRecord(asRecord(input.taskRouting).coverEvidence).mcpEvidence,
        ),
      },
      finalizeDistille: mergeRoute(
        defaults.taskRouting.finalizeDistille,
        asRecord(input.taskRouting).finalizeDistille,
      ),
      mergeActivationFinalize: mergeRoute(
        defaults.taskRouting.mergeActivationFinalize,
        asRecord(input.taskRouting).mergeActivationFinalize,
      ),
      deadZoneMergeReview: mergeRoute(
        defaults.taskRouting.deadZoneMergeReview,
        asRecord(input.taskRouting).deadZoneMergeReview,
      ),
      landscapeCuration: mergeRoute(
        defaults.taskRouting.landscapeCuration,
        asRecord(input.taskRouting).landscapeCuration,
      ),
      agenticCompile: {
        ...defaults.taskRouting.agenticCompile,
        ...asRecord(asRecord(input.taskRouting).agenticCompile),
      },
    },
    search: {
      ...defaults.search,
      ...asRecord(input.search),
      providers: {
        ...defaults.search.providers,
        ...asRecord(asRecord(input.search).providers),
        brave: {
          ...defaults.search.providers.brave,
          ...asRecord(asRecord(asRecord(input.search).providers).brave),
        },
        exa: {
          ...defaults.search.providers.exa,
          ...asRecord(asRecord(asRecord(input.search).providers).exa),
        },
        duckduckgo: {
          ...defaults.search.providers.duckduckgo,
          ...asRecord(asRecord(asRecord(input.search).providers).duckduckgo),
        },
      },
    },
    embedding: {
      ...defaults.embedding,
      ...asRecord(input.embedding),
    },
    distillationRuntime: {
      ...defaults.distillationRuntime,
      ...asRecord(input.distillationRuntime),
    },
    advanced: {
      ...defaults.advanced,
      ...asRecord(input.advanced),
    },
  };

  merged.providers["azure-openai"] = syncAzureOpenAiProvider(merged.providers["azure-openai"]);
  merged.providers["local-llm"] = syncLocalLlmProvider(merged.providers["local-llm"]);
  merged.providerPools = normalizeProviderPools(merged, input.providerPools);

  if (!hasEpisodeDistillerRoute) {
    merged.taskRouting.episodeDistiller = cloneRoute(merged.taskRouting.webSourceResearch);
  }

  merged.taskRouting.findCandidate.source = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.source,
  );
  merged.taskRouting.findCandidate.vibe = sanitizeRoute(
    merged,
    merged.taskRouting.findCandidate.vibe,
  );
  merged.taskRouting.webSourceResearch = sanitizeRoute(
    merged,
    merged.taskRouting.webSourceResearch,
  );
  merged.taskRouting.episodeDistiller = sanitizeRoute(merged, merged.taskRouting.episodeDistiller);
  merged.taskRouting.coverEvidence.sourceSupport = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.sourceSupport,
  );
  merged.taskRouting.coverEvidence.externalEvidence = sanitizeRoute(
    merged,
    merged.taskRouting.coverEvidence.externalEvidence,
  );
  const coverEvidenceRoute = cloneRoute(merged.taskRouting.coverEvidence.externalEvidence);
  merged.taskRouting.coverEvidence.sourceSupport = cloneRoute(coverEvidenceRoute);
  merged.taskRouting.coverEvidence.mcpEvidence = cloneRoute(coverEvidenceRoute);
  merged.taskRouting.finalizeDistille = sanitizeRoute(merged, merged.taskRouting.finalizeDistille);
  merged.taskRouting.mergeActivationFinalize = sanitizeRoute(
    merged,
    merged.taskRouting.mergeActivationFinalize,
  );
  merged.taskRouting.deadZoneMergeReview = sanitizeRoute(
    merged,
    merged.taskRouting.deadZoneMergeReview,
  );
  merged.taskRouting.landscapeCuration = sanitizeRoute(
    merged,
    merged.taskRouting.landscapeCuration,
  );
  merged.taskRouting.agenticCompile.fallback = normalizeProviderList(
    merged.taskRouting.agenticCompile.fallback,
  );
  merged.taskRouting.agenticCompile.model =
    resolveConfiguredRouteModel(merged, merged.taskRouting.agenticCompile.provider) ??
    merged.taskRouting.agenticCompile.model;
  merged.taskRouting.agenticCompile.localLlmModel =
    merged.taskRouting.agenticCompile.provider === "local-llm" ||
    merged.taskRouting.agenticCompile.fallback.includes("local-llm")
      ? (resolveConfiguredLocalLlmRouteTarget(
          merged,
          merged.taskRouting.agenticCompile.localLlmModel,
        )?.routeValue ??
        (merged.taskRouting.agenticCompile.provider === "local-llm"
          ? resolveConfiguredLocalLlmRouteTarget(merged, merged.taskRouting.agenticCompile.model)
              ?.routeValue
          : resolveConfiguredLocalLlmRouteTarget(merged, undefined)?.routeValue))
      : undefined;
  merged.taskRouting.agenticCompile.azureDeploymentSlots = normalizeAzureDeploymentSlots(
    merged.taskRouting.agenticCompile.azureDeploymentSlots,
  );
  merged.general.distillationPriority.targetPriorityOrder =
    normalizeDistillationTargetPriorityOrder(
      merged.general.distillationPriority.targetPriorityOrder,
    );
  merged.search.providerOrder = [...new Set(merged.search.providerOrder)];
  groupedConfig.distillationTools.searchProviders = merged.search
    .providerOrder as DistillationSearchProvider[];
  return merged;
}

export function parseDocumentValue(row: SettingsRow | null): RuntimeSettingsEditable {
  if (!row) return cloneDefaultSettings();
  const root = asRecord(row.value);
  const raw = asRecord(root.settings ?? root);
  return normalizeRuntimeSettingsEditable(raw);
}

export function normalizeRuntimeSettingsEditable(
  input: RuntimeSettingsEditable | Record<string, unknown>,
): RuntimeSettingsEditable {
  const defaults = cloneDefaultSettings();
  const merged = mergeRuntimeSettings(defaults, input as Record<string, unknown>);
  const allowedEmbeddingProviders = new Set(["auto", "daemon", "openai", "disabled"]);
  if (!allowedEmbeddingProviders.has(String(merged.embedding.provider))) {
    merged.embedding.provider = defaults.embedding.provider;
  }
  const parsed = runtimeSettingsEditableSchema.safeParse(merged);
  if (!parsed.success) return defaults;
  return parsed.data;
}
