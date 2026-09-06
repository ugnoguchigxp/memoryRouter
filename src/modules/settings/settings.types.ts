import { z } from "zod";
import type { DistillationSearchProvider, EmbeddingProvider } from "../../config.types.js";

export const runtimeProviderNames = [
  "openai",
  "azure-openai",
  "bedrock",
  "local-llm",
  "codex",
] as const;
export type RuntimeProviderName = (typeof runtimeProviderNames)[number];

export const runtimeAgenticProviderNames = [...runtimeProviderNames] as const;
export type RuntimeAgenticProviderName = (typeof runtimeAgenticProviderNames)[number];

export const runtimeProviderSettingNames = [...runtimeProviderNames, "auto"] as const;
export type RuntimeProviderSetting = (typeof runtimeProviderSettingNames)[number];

export type RuntimeSecretKey =
  | "openaiApiKey"
  | "azureOpenAiApiKey"
  | `azureOpenAiApiKey${number}`
  | "localLlmApiKey"
  | `localLlmApiKey${number}`
  | "braveApiKey"
  | "exaApiKey";

export const runtimeSecretKeys = [
  "openaiApiKey",
  "azureOpenAiApiKey",
  "azureOpenAiApiKey2",
  "azureOpenAiApiKey3",
  "localLlmApiKey",
  "braveApiKey",
  "exaApiKey",
] as const;

export type RuntimeSecretSource = "db" | "env" | "none" | "env-or-profile";

export type RuntimeSecretStatus = {
  configured: boolean;
  source: RuntimeSecretSource;
  maskedValue: string | null;
  updatedAt: string | null;
};

export type StaticRuntimeSettingsRoute = {
  kind?: "static";
  provider: RuntimeProviderSetting;
  model?: string;
  localLlmModel?: string;
  providerPoolId?: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
};

export type LarmAgentConnectionRoute = {
  kind: "larm-agent-connection";
  connectionId: string;
  provider?: never;
  model?: never;
  localLlmModel?: never;
  providerPoolId?: never;
  fallback?: never;
  azureDeploymentSlots?: never;
};

export type RuntimeSettingsRoute = StaticRuntimeSettingsRoute | LarmAgentConnectionRoute;

export function isLarmAgentConnectionRoute(
  route: RuntimeSettingsRoute,
): route is LarmAgentConnectionRoute {
  return route.kind === "larm-agent-connection";
}

export function requireStaticRuntimeSettingsRoute(
  route: RuntimeSettingsRoute,
): StaticRuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) {
    throw new Error(`dynamic_provider_requires_rust_resident: ${route.connectionId}`);
  }
  return route;
}

export type FindCandidateThrottlingSettings = {
  backgroundEnabled: boolean;
  interactiveWindowSeconds: number;
  recentBlockSeconds: number;
  minIntervalSeconds: number;
  mediumIntervalSeconds: number;
  busyIntervalSeconds: number;
  maxIntervalSeconds: number;
  rateLimitCooldownSeconds: number;
  jitterSeconds: number;
};

export type AzureOpenAiDeploymentSettings = {
  name: string;
  apiBaseUrl: string;
  apiPath: string;
  apiVersion: string;
  model: string;
};

export type LocalLlmModelSettings = {
  id?: string;
  name: string;
  apiBaseUrl: string;
  apiPath: string;
  model: string;
};

export type LarmAgentConnectionSettings = {
  id: string;
  controlBaseUrl: string;
  agentProfile: string;
  audience: string;
  availabilityPollMs: number;
  availabilityTimeoutMs: number;
  controlTimeoutMs: number;
  readyTimeoutMs: number;
  ttlSeconds: number;
  requestTimeoutMs: number;
};

export type RuntimeProviderPoolTarget =
  | {
      provider: "local-llm";
      localLlmModelId: string;
    }
  | {
      provider: "azure-openai";
      deploymentSlot: number;
    }
  | {
      provider: "openai" | "bedrock" | "codex";
      targetId: string;
    }
  | {
      provider: "larm-agent-connection";
      connectionId: string;
    };

export type RuntimeProviderPool = {
  id: string;
  label: string;
  targets: RuntimeProviderPoolTarget[];
  maxConcurrent: number;
  staleLeaseSeconds: number;
  enabled: boolean;
  lowPriorityAgingSeconds: number;
};

export type RuntimeEffectiveProviderTarget = {
  provider: RuntimeProviderName | "larm-agent-connection";
  id: string;
  label: string;
  source: "route" | "provider_pool";
  model: string | null;
  endpoint: string | null;
  providerPoolId?: string;
  localLlmModelId?: string;
  deploymentSlot?: number;
  connectionId?: string;
};

export type RuntimeEffectiveRouteTargets = {
  source: "none" | "route" | "provider_pool";
  providerPoolId?: string;
  targets: RuntimeEffectiveProviderTarget[];
};

export type RuntimeSettingsEffectiveTargets = {
  providerPools: Record<string, RuntimeEffectiveProviderTarget[]>;
  taskRouting: {
    findCandidate: {
      source: RuntimeEffectiveRouteTargets;
      vibe: RuntimeEffectiveRouteTargets;
    };
    webSourceResearch: RuntimeEffectiveRouteTargets;
    episodeDistiller: RuntimeEffectiveRouteTargets;
    coverEvidence: {
      sourceSupport: RuntimeEffectiveRouteTargets;
      externalEvidence: RuntimeEffectiveRouteTargets;
      mcpEvidence: RuntimeEffectiveRouteTargets;
    };
    deadZoneMergeReview: RuntimeEffectiveRouteTargets;
    landscapeCuration: RuntimeEffectiveRouteTargets;
    finalizeDistille: RuntimeEffectiveRouteTargets;
    mergeActivationFinalize: RuntimeEffectiveRouteTargets;
    agenticCompile: RuntimeEffectiveRouteTargets;
  };
};

export type RuntimeSettingsDiagnostic = {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
};

export type RuntimeSettingsDiagnostics = {
  providerPools: RuntimeSettingsDiagnostic[];
};

export const distillationPriorityTargetKindValues = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
] as const;

export type DistillationPriorityTargetKind = (typeof distillationPriorityTargetKindValues)[number];

export type RuntimeSettingsEditable = {
  general: {
    distillationPriority: {
      targetPriorityOrder: DistillationPriorityTargetKind[];
    };
  };
  providerPools: RuntimeProviderPool[];
  providers: {
    openai: {
      enabled: boolean;
      apiBaseUrl: string;
      model: string;
    };
    "azure-openai": {
      enabled: boolean;
      apiBaseUrl: string;
      apiPath: string;
      apiVersion: string;
      model: string;
      deployments: AzureOpenAiDeploymentSettings[];
    };
    bedrock: {
      enabled: boolean;
      region: string;
      profile: string;
      model: string;
    };
    "local-llm": {
      enabled: boolean;
      apiBaseUrl: string;
      apiPath: string;
      model: string;
      models: LocalLlmModelSettings[];
    };
    "larm-agent-connection": {
      enabled: boolean;
      connections: LarmAgentConnectionSettings[];
    };
    codex: {
      enabled: boolean;
      model: string;
    };
  };
  taskRouting: {
    findCandidate: {
      source: RuntimeSettingsRoute;
      vibe: RuntimeSettingsRoute;
      throttling: FindCandidateThrottlingSettings;
    };
    webSourceResearch: RuntimeSettingsRoute;
    episodeDistiller: RuntimeSettingsRoute;
    coverEvidence: {
      sourceSupport: RuntimeSettingsRoute;
      externalEvidence: RuntimeSettingsRoute;
      mcpEvidence: RuntimeSettingsRoute;
    };
    deadZoneMergeReview: RuntimeSettingsRoute;
    landscapeCuration: RuntimeSettingsRoute;
    finalizeDistille: RuntimeSettingsRoute;
    mergeActivationFinalize: RuntimeSettingsRoute;
    agenticCompile: {
      enabled: boolean;
      provider: RuntimeAgenticProviderName;
      model: string;
      localLlmModel?: string;
      fallback: RuntimeProviderName[];
      azureDeploymentSlots?: number[];
      timeoutMs: number;
      maxTokens: number;
    };
  };
  search: {
    providerOrder: DistillationSearchProvider[];
    maxProviderAttempts: number;
    resultCount: number;
    timeoutMs: number;
    rateLimitCooldownSeconds: number;
    providers: {
      brave: { enabled: boolean };
      exa: { enabled: boolean };
      duckduckgo: { enabled: boolean };
    };
  };
  embedding: {
    provider: EmbeddingProvider;
    daemonUrl: string;
    openaiModel: string;
    timeoutMs: number;
  };
  distillationRuntime: {
    timeoutMs: number;
    candidateTimeoutMs: number;
    maxToolRounds: number;
    findCandidateTimeoutMs: number;
    findCandidateMaxToolCalls: number;
    coverEvidenceTimeoutMs: number;
    coverEvidenceSearchMaxCalls: number;
    coverEvidenceFetchMaxCalls: number;
    coverEvidenceFetchMaxTokensPerSite: number;
    toolTimeoutMs: number;
    toolResultMaxChars: number;
    failureRetryDelaySeconds: number;
    readerMaxReads: number;
    readerMaxCharsPerRead: number;
    llmContextWindowTokens: number;
    llmMaxInputTokens: number;
    llmInputSafetyMarginTokens: number;
    lowImportanceRejectThreshold: number;
  };
  advanced: {
    pipelineLockStaleSeconds: number;
    lockTtlSeconds: number;
    pipelineClaimLimit: number;
    findingQueueTaskIntervalSeconds: number;
    coveringQueueTaskIntervalSeconds: number;
    continuousIdleSleepMs: number;
    continuousErrorSleepMs: number;
    inventoryRefreshIntervalMs: number;
    doctorFreshnessThresholdMinutes: number;
    doctorDegradedRateThreshold: number;
    doctorKnowledgeZeroUseWarningMinActiveCount: number;
    codexLogSyncEnabled: boolean;
    antigravityLogSyncEnabled: boolean;
    claudeLogSyncEnabled: boolean;
  };
};

export type RuntimeSettingsView = RuntimeSettingsEditable & {
  effectiveTargets: RuntimeSettingsEffectiveTargets;
  diagnostics: RuntimeSettingsDiagnostics;
  providers: RuntimeSettingsEditable["providers"] & {
    openai: RuntimeSettingsEditable["providers"]["openai"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
    "azure-openai": RuntimeSettingsEditable["providers"]["azure-openai"] & {
      apiKeySecret: RuntimeSecretStatus;
      apiKeySecrets: RuntimeSecretStatus[];
    };
    bedrock: RuntimeSettingsEditable["providers"]["bedrock"] & {
      credentialSecret: RuntimeSecretStatus;
    };
    "local-llm": RuntimeSettingsEditable["providers"]["local-llm"] & {
      apiKeySecret: RuntimeSecretStatus;
      apiKeySecrets: RuntimeSecretStatus[];
    };
    codex: RuntimeSettingsEditable["providers"]["codex"];
  };
  search: RuntimeSettingsEditable["search"] & {
    providers: RuntimeSettingsEditable["search"]["providers"] & {
      brave: RuntimeSettingsEditable["search"]["providers"]["brave"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
      exa: RuntimeSettingsEditable["search"]["providers"]["exa"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
    };
  };
};

export type RuntimeSettingsSecrets = Partial<Record<RuntimeSecretKey, string>>;

const runtimeProviderSchema = z.enum(runtimeProviderNames);
const runtimeProviderSettingSchema = z.enum(runtimeProviderSettingNames);
const searchProviderSchema = z.enum(["brave", "exa", "duckduckgo"] as const);

const azureOpenAiDeploymentSchema = z.object({
  name: z.string().trim().max(80).default(""),
  apiBaseUrl: z.string().trim().url().or(z.literal("")),
  apiPath: z.string().trim().min(1),
  apiVersion: z.string().trim().min(1),
  model: z.string().trim().min(1).or(z.literal("")),
});

const localLlmModelSchema = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().max(80).default(""),
  apiBaseUrl: z.string().trim().url().or(z.literal("")),
  apiPath: z.string().trim().min(1).default("/v1/chat/completions"),
  model: z.string().trim().min(1).or(z.literal("")),
});

const larmIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9._:-]+$/, "must be a valid LARM identifier");

function isAllowedLarmControlHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::1" || /^f[cd][0-9a-f:]+$/i.test(host) || /^fe[89ab][0-9a-f:]+$/i.test(host)) {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

const larmAgentConnectionSchema = z
  .object({
    id: larmIdentifierSchema,
    controlBaseUrl: z.string().trim().url(),
    agentProfile: larmIdentifierSchema,
    audience: larmIdentifierSchema,
    availabilityPollMs: z.number().int().min(1_000).max(300_000).default(5_000),
    availabilityTimeoutMs: z.number().int().min(250).max(30_000).default(2_000),
    controlTimeoutMs: z.number().int().min(250).max(120_000).default(5_000),
    readyTimeoutMs: z.number().int().min(1_000).max(900_000).default(180_000),
    ttlSeconds: z.number().int().min(60).max(86_400).default(900),
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  })
  .strict()
  .superRefine((connection, ctx) => {
    let url: URL;
    try {
      url = new URL(connection.controlBaseUrl);
    } catch {
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlBaseUrl"],
        message: "controlBaseUrl must be a canonical HTTP(S) origin without credentials or path",
      });
    }
    if (!isAllowedLarmControlHost(url.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controlBaseUrl"],
        message: "controlBaseUrl host must be loopback, private, link-local, localhost, or .local",
      });
    }
    if (connection.ttlSeconds * 1_000 < connection.requestTimeoutMs + 30_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ttlSeconds"],
        message: "ttlSeconds must cover requestTimeoutMs plus a 30 second cleanup margin",
      });
    }
  });

const runtimeRouteSchema = z.union([
  z
    .object({
      kind: z.literal("static").optional(),
      provider: runtimeProviderSettingSchema,
      model: z.string().trim().min(1).optional(),
      localLlmModel: z.string().trim().min(1).optional(),
      providerPoolId: z.string().trim().min(1).max(120).optional(),
      fallback: z.array(runtimeProviderSchema).max(8).default([]),
      azureDeploymentSlots: z.array(z.number().int().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("larm-agent-connection"),
      connectionId: larmIdentifierSchema,
    })
    .strict(),
]);

const runtimeProviderPoolTargetSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("local-llm"),
    localLlmModelId: z.string().trim().min(1).max(120),
  }),
  z.object({
    provider: z.literal("azure-openai"),
    deploymentSlot: z.number().int().min(1),
  }),
  z.object({
    provider: z.enum(["openai", "bedrock", "codex"] as const),
    targetId: z.string().trim().min(1).max(120),
  }),
  z.object({
    provider: z.literal("larm-agent-connection"),
    connectionId: larmIdentifierSchema,
  }),
]);

const runtimeProviderPoolSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  targets: z.array(runtimeProviderPoolTargetSchema).min(1).max(32),
  maxConcurrent: z.number().int().min(1).max(64),
  staleLeaseSeconds: z.number().int().min(30).max(604_800),
  enabled: z.boolean().default(true),
  lowPriorityAgingSeconds: z.number().int().min(60).max(604_800).default(1800),
});

export const runtimeSettingsEditableSchema = z
  .object({
    general: z.object({
      distillationPriority: z.object({
        targetPriorityOrder: z.array(z.enum(distillationPriorityTargetKindValues)).min(1).max(4),
      }),
    }),
    providerPools: z.array(runtimeProviderPoolSchema).default([]),
    providers: z.object({
      openai: z.object({
        enabled: z.boolean().default(true),
        apiBaseUrl: z.string().trim().url(),
        model: z.string().trim().min(1),
      }),
      "azure-openai": z.object({
        enabled: z.boolean().default(false),
        apiBaseUrl: z.string().trim().url().or(z.literal("")),
        apiPath: z.string().trim().min(1),
        apiVersion: z.string().trim().min(1),
        model: z.string().trim().min(1).or(z.literal("")),
        deployments: z.array(azureOpenAiDeploymentSchema).default([]),
      }),
      bedrock: z.object({
        enabled: z.boolean().default(false),
        region: z.string().trim().min(1),
        profile: z.string().trim(),
        model: z.string().trim().min(1).or(z.literal("")),
      }),
      "local-llm": z.object({
        enabled: z.boolean().default(true),
        apiBaseUrl: z.string().trim().url().or(z.literal("")),
        apiPath: z.string().trim().min(1).default("/v1/chat/completions"),
        model: z.string().trim().min(1).or(z.literal("")),
        models: z.array(localLlmModelSchema).default([]),
      }),
      "larm-agent-connection": z
        .object({
          enabled: z.boolean().default(false),
          connections: z.array(larmAgentConnectionSchema).max(16).default([]),
        })
        .default({ enabled: false, connections: [] }),
      codex: z.object({
        enabled: z.boolean().default(false),
        model: z.string().trim().min(1).default("codex-sdk-agent"),
      }),
    }),
    taskRouting: z.object({
      findCandidate: z.object({
        source: runtimeRouteSchema,
        vibe: runtimeRouteSchema,
        throttling: z.object({
          backgroundEnabled: z.boolean().default(true),
          interactiveWindowSeconds: z.number().int().min(30).max(3_600).default(180),
          recentBlockSeconds: z.number().int().min(0).max(600).default(30),
          minIntervalSeconds: z.number().int().min(1).max(3_600).default(30),
          mediumIntervalSeconds: z.number().int().min(1).max(7_200).default(90),
          busyIntervalSeconds: z.number().int().min(1).max(21_600).default(180),
          maxIntervalSeconds: z.number().int().min(1).max(86_400).default(300),
          rateLimitCooldownSeconds: z.number().int().min(30).max(172_800).default(600),
          jitterSeconds: z.number().int().min(0).max(600).default(10),
        }),
      }),
      webSourceResearch: runtimeRouteSchema,
      episodeDistiller: runtimeRouteSchema,
      coverEvidence: z.object({
        sourceSupport: runtimeRouteSchema,
        externalEvidence: runtimeRouteSchema,
        mcpEvidence: runtimeRouteSchema,
      }),
      deadZoneMergeReview: runtimeRouteSchema,
      landscapeCuration: runtimeRouteSchema,
      finalizeDistille: runtimeRouteSchema,
      mergeActivationFinalize: runtimeRouteSchema,
      agenticCompile: z.object({
        enabled: z.boolean().default(true),
        provider: z.enum(runtimeAgenticProviderNames),
        model: z.string().trim().min(1),
        localLlmModel: z.string().trim().min(1).optional(),
        fallback: z.array(runtimeProviderSchema).max(8).default([]),
        azureDeploymentSlots: z.array(z.number().int().min(1)).optional(),
        timeoutMs: z.number().int().min(1000).max(3_600_000),
        maxTokens: z.number().int().min(128).max(16_384),
      }),
    }),
    search: z.object({
      providerOrder: z.array(searchProviderSchema).min(1).max(3),
      maxProviderAttempts: z.number().int().min(1).max(3),
      resultCount: z.number().int().min(1).max(10),
      timeoutMs: z.number().int().min(1000).max(120_000),
      rateLimitCooldownSeconds: z.number().int().min(30).max(172_800),
      providers: z.object({
        brave: z.object({ enabled: z.boolean().default(true) }),
        exa: z.object({ enabled: z.boolean().default(true) }),
        duckduckgo: z.object({ enabled: z.boolean().default(true) }),
      }),
    }),
    embedding: z.object({
      provider: z.enum(["auto", "daemon", "openai", "disabled"] as const),
      daemonUrl: z.string().trim().url(),
      openaiModel: z.string().trim().min(1),
      timeoutMs: z.number().int().min(1000).max(120_000),
    }),
    distillationRuntime: z.object({
      timeoutMs: z.number().int().min(1000).max(3_600_000),
      candidateTimeoutMs: z.number().int().min(1000).max(3_600_000),
      maxToolRounds: z.number().int().min(0).max(64),
      findCandidateTimeoutMs: z.number().int().min(1000).max(3_600_000),
      findCandidateMaxToolCalls: z.number().int().min(1).max(64),
      coverEvidenceTimeoutMs: z.number().int().min(1000).max(3_600_000),
      coverEvidenceSearchMaxCalls: z.number().int().min(0).max(16),
      coverEvidenceFetchMaxCalls: z.number().int().min(0).max(16),
      coverEvidenceFetchMaxTokensPerSite: z.number().int().min(128).max(50_000),
      toolTimeoutMs: z.number().int().min(1000).max(120_000),
      toolResultMaxChars: z.number().int().min(512).max(200_000),
      failureRetryDelaySeconds: z.number().int().min(1).max(604_800),
      readerMaxReads: z.number().int().min(1).max(64),
      readerMaxCharsPerRead: z.number().int().min(128).max(200_000),
      llmContextWindowTokens: z.number().int().min(4096).max(1_000_000),
      llmMaxInputTokens: z.number().int().min(1024).max(1_000_000),
      llmInputSafetyMarginTokens: z.number().int().min(0).max(200_000),
      lowImportanceRejectThreshold: z.number().min(0).max(100),
    }),
    advanced: z.object({
      pipelineLockStaleSeconds: z.number().int().min(30).max(604_800),
      lockTtlSeconds: z.number().int().min(30).max(604_800),
      pipelineClaimLimit: z.number().int().min(1).max(1000),
      findingQueueTaskIntervalSeconds: z.number().int().min(0).max(3_600),
      coveringQueueTaskIntervalSeconds: z.number().int().min(0).max(3_600),
      continuousIdleSleepMs: z.number().int().min(100).max(3_600_000),
      continuousErrorSleepMs: z.number().int().min(100).max(3_600_000),
      inventoryRefreshIntervalMs: z.number().int().min(100).max(3_600_000),
      doctorFreshnessThresholdMinutes: z.number().int().min(1).max(43_200),
      doctorDegradedRateThreshold: z.number().min(0).max(1),
      doctorKnowledgeZeroUseWarningMinActiveCount: z.number().int().min(1).max(100_000),
      codexLogSyncEnabled: z.boolean().default(true),
      antigravityLogSyncEnabled: z.boolean().default(true),
      claudeLogSyncEnabled: z.boolean().default(true),
    }),
  })
  .superRefine((settings, ctx) => {
    const { llmContextWindowTokens, llmInputSafetyMarginTokens, llmMaxInputTokens } =
      settings.distillationRuntime;
    if (llmMaxInputTokens + llmInputSafetyMarginTokens > llmContextWindowTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distillationRuntime", "llmMaxInputTokens"],
        message:
          "llmMaxInputTokens と llmInputSafetyMarginTokens の合計は llmContextWindowTokens 以下にしてください",
      });
    }
    const connectionIds = new Set<string>();
    for (const [index, connection] of settings.providers[
      "larm-agent-connection"
    ].connections.entries()) {
      if (connectionIds.has(connection.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providers", "larm-agent-connection", "connections", index, "id"],
          message: `duplicate LARM connection id: ${connection.id}`,
        });
      }
      connectionIds.add(connection.id);
    }
    const staticLeaseTargetIds = new Set<string>([
      "openai",
      "bedrock",
      "codex",
      ...settings.providers["local-llm"].models.flatMap((model) =>
        model.id?.trim() ? [model.id.trim()] : [],
      ),
      ...settings.providers["azure-openai"].deployments.map((_deployment, index) =>
        String(index + 1),
      ),
      ...settings.providerPools.flatMap((pool) =>
        pool.targets.flatMap((target) => {
          if (target.provider === "larm-agent-connection") return [];
          if (target.provider === "local-llm") return [target.localLlmModelId];
          if (target.provider === "azure-openai") return [String(target.deploymentSlot)];
          return [target.targetId];
        }),
      ),
    ]);
    for (const [poolIndex, pool] of settings.providerPools.entries()) {
      for (const [targetIndex, target] of pool.targets.entries()) {
        if (target.provider !== "larm-agent-connection") continue;
        const path = ["providerPools", poolIndex, "targets", targetIndex];
        if (!settings.providers["larm-agent-connection"].enabled) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: "LARM Agent Connection provider must be enabled for a pool target",
          });
        } else if (!connectionIds.has(target.connectionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "connectionId"],
            message: `unknown LARM connection id: ${target.connectionId}`,
          });
        } else if (staticLeaseTargetIds.has(target.connectionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "connectionId"],
            message: `LARM connection id collides with a static provider lease target: ${target.connectionId}`,
          });
        }
      }
    }
    const routes: Array<[string, RuntimeSettingsRoute]> = [
      ["findCandidate.source", settings.taskRouting.findCandidate.source],
      ["findCandidate.vibe", settings.taskRouting.findCandidate.vibe],
      ["webSourceResearch", settings.taskRouting.webSourceResearch],
      ["episodeDistiller", settings.taskRouting.episodeDistiller],
      ["coverEvidence.sourceSupport", settings.taskRouting.coverEvidence.sourceSupport],
      ["coverEvidence.externalEvidence", settings.taskRouting.coverEvidence.externalEvidence],
      ["coverEvidence.mcpEvidence", settings.taskRouting.coverEvidence.mcpEvidence],
      ["deadZoneMergeReview", settings.taskRouting.deadZoneMergeReview],
      ["landscapeCuration", settings.taskRouting.landscapeCuration],
      ["finalizeDistille", settings.taskRouting.finalizeDistille],
      ["mergeActivationFinalize", settings.taskRouting.mergeActivationFinalize],
    ];
    for (const [path, route] of routes) {
      if (route.kind !== "larm-agent-connection") continue;
      if (!settings.providers["larm-agent-connection"].enabled) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskRouting", ...path.split(".")],
          message: "LARM Agent Connection provider must be enabled for a dynamic route",
        });
      } else if (!connectionIds.has(route.connectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskRouting", ...path.split("."), "connectionId"],
          message: `unknown LARM connection id: ${route.connectionId}`,
        });
      } else if (staticLeaseTargetIds.has(route.connectionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["taskRouting", ...path.split("."), "connectionId"],
          message: `LARM connection id collides with a static provider lease target: ${route.connectionId}`,
        });
      }
    }
  });

export const runtimeSecretUpdateSchema = z
  .object({
    value: z.string().optional(),
    clear: z.boolean().optional(),
  })
  .refine((value) => value.clear === true || typeof value.value === "string", {
    message: "value または clear=true のどちらかが必要です",
  });

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneRouteInput(value: unknown): unknown {
  const route = objectRecord(value);
  if (!route) return value;
  if (route.kind === "larm-agent-connection") {
    return {
      kind: "larm-agent-connection",
      connectionId: route.connectionId,
    };
  }
  return {
    ...route,
    fallback: Array.isArray(route.fallback) ? [...route.fallback] : route.fallback,
    azureDeploymentSlots: Array.isArray(route.azureDeploymentSlots)
      ? [...route.azureDeploymentSlots]
      : route.azureDeploymentSlots,
  };
}

function backfillRuntimeSettingsUpdateInput(value: unknown): unknown {
  const input = objectRecord(value);
  const settings = objectRecord(input?.settings);
  const taskRouting = objectRecord(settings?.taskRouting);
  if (!input || !settings || !taskRouting) return value;

  const nextTaskRouting = { ...taskRouting };
  if (!objectRecord(nextTaskRouting.episodeDistiller)) {
    nextTaskRouting.episodeDistiller = cloneRouteInput(nextTaskRouting.webSourceResearch);
  }
  if (!objectRecord(nextTaskRouting.mergeActivationFinalize)) {
    nextTaskRouting.mergeActivationFinalize = cloneRouteInput(nextTaskRouting.finalizeDistille);
  }
  if (!objectRecord(nextTaskRouting.landscapeCuration)) {
    nextTaskRouting.landscapeCuration = cloneRouteInput(nextTaskRouting.deadZoneMergeReview);
  }

  return {
    ...input,
    settings: {
      ...settings,
      taskRouting: nextTaskRouting,
    },
  };
}

export const settingsUpdateRequestSchema = z.preprocess(
  backfillRuntimeSettingsUpdateInput,
  z.object({
    settings: runtimeSettingsEditableSchema,
    secrets: z.record(runtimeSecretUpdateSchema).optional(),
    updatedBy: z.string().trim().max(120).optional(),
  }),
);

export type RuntimeSettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;
