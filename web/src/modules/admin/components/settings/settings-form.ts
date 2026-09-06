import type {
  RuntimeProviderPool,
  RuntimeProviderPoolTarget,
  RuntimeSecretKey,
  RuntimeSettingsEditable,
  RuntimeSettingsView,
} from "../../repositories/admin.repository";
import { type SecretDraftState, localLlmDefaultProviderPoolId } from "./settings-primitives";
import { cloneRuntimeSettingsRoute, localLlmRouteOptionLabel } from "./settings-routing";

export function createEmptySecretDraftState(): SecretDraftState {
  return {
    openaiApiKey: { value: "", clear: false },
    azureOpenAiApiKey: { value: "", clear: false },
    azureOpenAiApiKey2: { value: "", clear: false },
    azureOpenAiApiKey3: { value: "", clear: false },
    localLlmApiKey: { value: "", clear: false },
    braveApiKey: { value: "", clear: false },
    exaApiKey: { value: "", clear: false },
  };
}

export function normalizeAzureDeploymentsForForm(
  provider: RuntimeSettingsView["providers"]["azure-openai"],
): RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"] {
  const deployments = provider.deployments.length
    ? provider.deployments
    : [
        {
          name: "Primary",
          apiBaseUrl: provider.apiBaseUrl,
          apiPath: provider.apiPath,
          apiVersion: provider.apiVersion,
          model: provider.model,
        },
      ];
  return deployments.map((deployment, index) => ({
    name: deployment?.name || (index === 0 ? "Primary" : `Deployment ${index + 1}`),
    apiBaseUrl: deployment?.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
    apiPath: deployment?.apiPath || provider.apiPath || "/openai/deployments",
    apiVersion: deployment?.apiVersion || provider.apiVersion || "2025-04-01-preview",
    model: deployment?.model ?? (index === 0 ? provider.model : ""),
  }));
}

export function syncAzureOpenAiProviderForDraft(
  provider: RuntimeSettingsEditable["providers"]["azure-openai"],
  deployments: RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"],
): RuntimeSettingsEditable["providers"]["azure-openai"] {
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

export function normalizeLocalLlmModelsForForm(
  provider: RuntimeSettingsView["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"] {
  const models = provider.models?.length
    ? provider.models
    : [
        {
          name: "Primary",
          apiBaseUrl: provider.apiBaseUrl,
          apiPath: provider.apiPath || "/v1/chat/completions",
          model: provider.model,
        },
      ];
  return models.map((model, index) => {
    const normalized = {
      name: model.name || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
      apiBaseUrl: model.apiBaseUrl ?? (index === 0 ? provider.apiBaseUrl : ""),
      apiPath: model.apiPath || provider.apiPath || "/v1/chat/completions",
      model: model.model ?? (index === 0 ? provider.model : ""),
    };
    return {
      id: model.id?.trim() || stableLocalLlmModelIdForDraft(normalized),
      ...normalized,
    };
  });
}

export function syncLocalLlmProviderForDraft(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
  models: RuntimeSettingsEditable["providers"]["local-llm"]["models"],
): RuntimeSettingsEditable["providers"]["local-llm"] {
  const nextModels = models;
  const primary = nextModels[0];
  return {
    ...provider,
    apiBaseUrl: primary?.apiBaseUrl ?? provider.apiBaseUrl,
    apiPath: primary?.apiPath ?? provider.apiPath,
    model: primary?.model ?? provider.model,
    models: nextModels,
  };
}

export function normalizeLocalLlmModelsForSave(
  provider: RuntimeSettingsEditable["providers"]["local-llm"],
): RuntimeSettingsEditable["providers"]["local-llm"]["models"] {
  return provider.models
    .map((model, index) => {
      const normalized = {
        name: model.name.trim() || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
        apiBaseUrl: model.apiBaseUrl.trim(),
        apiPath: model.apiPath.trim() || "/v1/chat/completions",
        model: model.model.trim(),
      };
      return {
        id: model.id?.trim() || stableLocalLlmModelIdForDraft(normalized),
        ...normalized,
      };
    })
    .filter((model) => model.apiBaseUrl && model.model);
}

export function stableLocalLlmModelIdForDraft(input: {
  apiBaseUrl: string;
  apiPath?: string;
  model: string;
}): string {
  const normalized = JSON.stringify({
    apiBaseUrl: input.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: input.apiPath?.trim() || "/v1/chat/completions",
    model: input.model.trim(),
  });
  return `local-llm-${sha256Hex(normalized).slice(0, 12)}`;
}

export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  }
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] |= 0x80 << (24 - (bitLength % 32));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const schedule = new Array<number>(64);

  for (let offset = 0; offset < words.length; offset += 16) {
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) {
        schedule[index] = words[offset + index] | 0;
      } else {
        const s0 =
          rotateRight(schedule[index - 15], 7) ^
          rotateRight(schedule[index - 15], 18) ^
          (schedule[index - 15] >>> 3);
        const s1 =
          rotateRight(schedule[index - 2], 17) ^
          rotateRight(schedule[index - 2], 19) ^
          (schedule[index - 2] >>> 10);
        schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) | 0;
      }
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + schedule[index]) | 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0;
    state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0;
    state[7] = (state[7] + h) | 0;
  }
  return state.map((item) => (item >>> 0).toString(16).padStart(8, "0")).join("");
}

export function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function isLocalLlmPoolTarget(
  target: RuntimeProviderPoolTarget,
): target is Extract<RuntimeProviderPoolTarget, { provider: "local-llm" }> {
  return target.provider === "local-llm";
}

export function localLlmPoolTargetId(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
): string | null {
  const id = model.id?.trim();
  return id || null;
}

export function localLlmPoolTargetLabel(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
  index: number,
): string {
  return localLlmRouteOptionLabel(
    {
      ...model,
      name: model.name.trim() || (index === 0 ? "Primary" : `Local LLM ${index + 1}`),
      apiBaseUrl: model.apiBaseUrl.trim(),
      apiPath: model.apiPath.trim() || "/v1/chat/completions",
      model: model.model.trim(),
    },
    true,
  );
}

export function localLlmProviderPool(settings: RuntimeSettingsEditable): RuntimeProviderPool {
  const existing = settings.providerPools.find((pool) => pool.id === localLlmDefaultProviderPoolId);
  if (existing) return existing;
  const targets = settings.providers["local-llm"].models
    .map(localLlmPoolTargetId)
    .filter((id): id is string => Boolean(id))
    .map((localLlmModelId) => ({ provider: "local-llm" as const, localLlmModelId }));
  return {
    id: localLlmDefaultProviderPoolId,
    label: "Local LLM Pool",
    targets,
    maxConcurrent: Math.max(1, targets.length),
    staleLeaseSeconds: 660,
    enabled: true,
    lowPriorityAgingSeconds: 1800,
  };
}

export function withLocalLlmProviderPool(
  settings: RuntimeSettingsEditable,
  nextPool: RuntimeProviderPool,
): RuntimeSettingsEditable {
  const providerPools = settings.providerPools.some((pool) => pool.id === nextPool.id)
    ? settings.providerPools.map((pool) => (pool.id === nextPool.id ? nextPool : pool))
    : [...settings.providerPools, nextPool];
  return { ...settings, providerPools };
}

export function prepareSettingsForSave(settings: RuntimeSettingsEditable): RuntimeSettingsEditable {
  const localLlmModels = normalizeLocalLlmModelsForSave(settings.providers["local-llm"]);
  return {
    ...settings,
    providers: {
      ...settings.providers,
      "local-llm": syncLocalLlmProviderForDraft(settings.providers["local-llm"], localLlmModels),
    },
  };
}

export function buildSecretPayload(
  secretDrafts: SecretDraftState,
): Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> | undefined {
  const result: Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>> = {};
  for (const key of Object.keys(secretDrafts) as RuntimeSecretKey[]) {
    const item = secretDrafts[key];
    if (!item) continue;
    const value = item.value.trim();
    if (item.clear) {
      result[key] = { clear: true };
      continue;
    }
    if (value) {
      result[key] = { value };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function settingsViewToEditable(view: RuntimeSettingsView): RuntimeSettingsEditable {
  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: [...view.general.distillationPriority.targetPriorityOrder],
      },
    },
    providerPools: view.providerPools.map((pool) => ({
      ...pool,
      targets: pool.targets.map((target) => ({ ...target })),
    })),
    providers: {
      openai: {
        enabled: view.providers.openai.enabled,
        apiBaseUrl: view.providers.openai.apiBaseUrl,
        model: view.providers.openai.model,
      },
      "azure-openai": {
        enabled: view.providers["azure-openai"].enabled,
        apiBaseUrl: view.providers["azure-openai"].apiBaseUrl,
        apiPath: view.providers["azure-openai"].apiPath,
        apiVersion: view.providers["azure-openai"].apiVersion,
        model: view.providers["azure-openai"].model,
        deployments: normalizeAzureDeploymentsForForm(view.providers["azure-openai"]),
      },
      bedrock: {
        enabled: view.providers.bedrock.enabled,
        region: view.providers.bedrock.region,
        profile: view.providers.bedrock.profile,
        model: view.providers.bedrock.model,
      },
      "local-llm": {
        enabled: view.providers["local-llm"].enabled,
        apiBaseUrl: view.providers["local-llm"].apiBaseUrl,
        apiPath: view.providers["local-llm"].apiPath,
        model: view.providers["local-llm"].model,
        models: normalizeLocalLlmModelsForForm(view.providers["local-llm"]),
      },
      "larm-agent-connection": {
        enabled: view.providers["larm-agent-connection"].enabled,
        connections: view.providers["larm-agent-connection"].connections.map((connection) => ({
          ...connection,
        })),
      },
      codex: {
        enabled: view.providers.codex?.enabled ?? false,
        model: view.providers.codex?.model ?? "codex-sdk-agent",
      },
    },
    taskRouting: {
      findCandidate: {
        source: cloneRuntimeSettingsRoute(view.taskRouting.findCandidate.source),
        vibe: cloneRuntimeSettingsRoute(view.taskRouting.findCandidate.vibe),
        throttling: {
          backgroundEnabled: view.taskRouting.findCandidate.throttling.backgroundEnabled,
          interactiveWindowSeconds:
            view.taskRouting.findCandidate.throttling.interactiveWindowSeconds,
          recentBlockSeconds: view.taskRouting.findCandidate.throttling.recentBlockSeconds,
          minIntervalSeconds: view.taskRouting.findCandidate.throttling.minIntervalSeconds,
          mediumIntervalSeconds: view.taskRouting.findCandidate.throttling.mediumIntervalSeconds,
          busyIntervalSeconds: view.taskRouting.findCandidate.throttling.busyIntervalSeconds,
          maxIntervalSeconds: view.taskRouting.findCandidate.throttling.maxIntervalSeconds,
          rateLimitCooldownSeconds:
            view.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds,
          jitterSeconds: view.taskRouting.findCandidate.throttling.jitterSeconds,
        },
      },
      webSourceResearch: cloneRuntimeSettingsRoute(view.taskRouting.webSourceResearch),
      episodeDistiller: cloneRuntimeSettingsRoute(view.taskRouting.episodeDistiller),
      coverEvidence: {
        sourceSupport: cloneRuntimeSettingsRoute(view.taskRouting.coverEvidence.sourceSupport),
        externalEvidence: cloneRuntimeSettingsRoute(
          view.taskRouting.coverEvidence.externalEvidence,
        ),
        mcpEvidence: cloneRuntimeSettingsRoute(view.taskRouting.coverEvidence.mcpEvidence),
      },
      finalizeDistille: cloneRuntimeSettingsRoute(view.taskRouting.finalizeDistille),
      mergeActivationFinalize: cloneRuntimeSettingsRoute(view.taskRouting.mergeActivationFinalize),
      deadZoneMergeReview: cloneRuntimeSettingsRoute(view.taskRouting.deadZoneMergeReview),
      landscapeCuration: cloneRuntimeSettingsRoute(view.taskRouting.landscapeCuration),
      agenticCompile: {
        enabled: view.taskRouting.agenticCompile.enabled,
        provider: view.taskRouting.agenticCompile.provider,
        model: view.taskRouting.agenticCompile.model,
        localLlmModel: view.taskRouting.agenticCompile.localLlmModel,
        fallback: [...view.taskRouting.agenticCompile.fallback],
        azureDeploymentSlots: view.taskRouting.agenticCompile.azureDeploymentSlots
          ? [...view.taskRouting.agenticCompile.azureDeploymentSlots]
          : undefined,
        timeoutMs: view.taskRouting.agenticCompile.timeoutMs,
        maxTokens: view.taskRouting.agenticCompile.maxTokens,
      },
    },
    search: {
      providerOrder: [...view.search.providerOrder],
      maxProviderAttempts: view.search.maxProviderAttempts,
      resultCount: view.search.resultCount,
      timeoutMs: view.search.timeoutMs,
      rateLimitCooldownSeconds: view.search.rateLimitCooldownSeconds,
      providers: {
        brave: { enabled: view.search.providers.brave.enabled },
        exa: { enabled: view.search.providers.exa.enabled },
        duckduckgo: { enabled: view.search.providers.duckduckgo.enabled },
      },
    },
    embedding: {
      provider: view.embedding.provider,
      daemonUrl: view.embedding.daemonUrl,
      openaiModel: view.embedding.openaiModel,
      timeoutMs: view.embedding.timeoutMs,
    },
    distillationRuntime: {
      timeoutMs: view.distillationRuntime.timeoutMs,
      candidateTimeoutMs: view.distillationRuntime.candidateTimeoutMs,
      maxToolRounds: view.distillationRuntime.maxToolRounds,
      findCandidateTimeoutMs: view.distillationRuntime.findCandidateTimeoutMs,
      findCandidateMaxToolCalls: view.distillationRuntime.findCandidateMaxToolCalls,
      coverEvidenceTimeoutMs: view.distillationRuntime.coverEvidenceTimeoutMs,
      coverEvidenceSearchMaxCalls: view.distillationRuntime.coverEvidenceSearchMaxCalls,
      coverEvidenceFetchMaxCalls: view.distillationRuntime.coverEvidenceFetchMaxCalls,
      coverEvidenceFetchMaxTokensPerSite:
        view.distillationRuntime.coverEvidenceFetchMaxTokensPerSite,
      toolTimeoutMs: view.distillationRuntime.toolTimeoutMs,
      toolResultMaxChars: view.distillationRuntime.toolResultMaxChars,
      failureRetryDelaySeconds: view.distillationRuntime.failureRetryDelaySeconds,
      readerMaxReads: view.distillationRuntime.readerMaxReads,
      readerMaxCharsPerRead: view.distillationRuntime.readerMaxCharsPerRead,
      llmContextWindowTokens: view.distillationRuntime.llmContextWindowTokens,
      llmMaxInputTokens: view.distillationRuntime.llmMaxInputTokens,
      llmInputSafetyMarginTokens: view.distillationRuntime.llmInputSafetyMarginTokens,
      lowImportanceRejectThreshold: view.distillationRuntime.lowImportanceRejectThreshold,
    },
    advanced: {
      pipelineLockStaleSeconds: view.advanced.pipelineLockStaleSeconds,
      lockTtlSeconds: view.advanced.lockTtlSeconds,
      pipelineClaimLimit: view.advanced.pipelineClaimLimit,
      findingQueueTaskIntervalSeconds: view.advanced.findingQueueTaskIntervalSeconds,
      coveringQueueTaskIntervalSeconds: view.advanced.coveringQueueTaskIntervalSeconds,
      continuousIdleSleepMs: view.advanced.continuousIdleSleepMs,
      continuousErrorSleepMs: view.advanced.continuousErrorSleepMs,
      inventoryRefreshIntervalMs: view.advanced.inventoryRefreshIntervalMs,
      doctorFreshnessThresholdMinutes: view.advanced.doctorFreshnessThresholdMinutes,
      doctorDegradedRateThreshold: view.advanced.doctorDegradedRateThreshold,
      doctorKnowledgeZeroUseWarningMinActiveCount:
        view.advanced.doctorKnowledgeZeroUseWarningMinActiveCount,
      codexLogSyncEnabled: view.advanced.codexLogSyncEnabled,
      antigravityLogSyncEnabled: view.advanced.antigravityLogSyncEnabled,
      claudeLogSyncEnabled: view.advanced.claudeLogSyncEnabled,
    },
  };
}
