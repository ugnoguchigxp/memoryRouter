export type RuntimeProviderName = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex";

export type RuntimeProviderSetting = RuntimeProviderName | "auto";

export type RuntimeSearchProvider = "brave" | "exa" | "duckduckgo";

export type RuntimeSecretKey =
  | "openaiApiKey"
  | "azureOpenAiApiKey"
  | `azureOpenAiApiKey${number}`
  | "localLlmApiKey"
  | `localLlmApiKey${number}`
  | "braveApiKey"
  | "exaApiKey";

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

export type DistillationPriorityTargetKind =
  | "knowledge_candidate"
  | "web_ingest"
  | "wiki_file"
  | "vibe_memory";

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
      provider: RuntimeProviderName;
      model: string;
      localLlmModel?: string;
      fallback: RuntimeProviderName[];
      azureDeploymentSlots?: number[];
      timeoutMs: number;
      maxTokens: number;
    };
  };
  search: {
    providerOrder: RuntimeSearchProvider[];
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
    provider: "auto" | "daemon" | "openai" | "disabled";
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
  effectiveTargets: {
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

export type RuntimeSettingsSnapshotResponse = {
  settings: RuntimeSettingsView;
  effective: RuntimeSettingsView;
  sources: Record<string, string>;
  revision: number;
  loadedAt: string | null;
};

export type RuntimeSettingsUpdateRequest = {
  settings: RuntimeSettingsEditable;
  secrets?: Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>>;
  updatedBy?: string;
};

export type RuntimeSettingsUpdateResponse = RuntimeSettingsSnapshotResponse & {
  updatedAt: string;
  cacheInvalidated: boolean;
  reloadRequired: boolean;
};

export type RuntimeProviderHealth = {
  provider: RuntimeProviderName;
  configured: boolean;
  reachable: boolean;
  model: string;
  endpoint: string;
  error?: string;
};

export type RuntimeProviderHealthResponse = {
  provider: RuntimeProviderName;
  health: RuntimeProviderHealth;
};

export type RuntimeAzureOpenAiDeploymentHealthResponse = {
  provider: "azure-openai";
  deployment: number;
  health: RuntimeProviderHealth;
};

export type RuntimeLocalLlmModelHealthResponse = {
  provider: "local-llm";
  model: string;
  health: RuntimeProviderHealth;
};

export type RuntimeSettingsReloadResponse = {
  ok: true;
  reloadedAt: string;
};
