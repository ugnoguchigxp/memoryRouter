import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import type {
  AgenticCompileProvider,
  DistillationProvider,
  DistillationSearchProvider,
  EmbeddingProvider,
  GroupedConfig,
} from "./config.types.js";
import { APP_CONSTANTS } from "./constants.js";
import { projectIdentity, readProjectEnv, readProjectEnvWithFallback } from "./project-identity.js";
import { resolveAdminApiKey } from "./shared/admin-api-key.js";

loadEnv({ quiet: true, path: process.env.DOTENV_CONFIG_PATH || ".env" });

const distillationSearchProviderValues = new Set<DistillationSearchProvider>([
  "brave",
  "exa",
  "duckduckgo",
]);

const parseDistillationSearchProviders = (
  value: string | undefined,
  fallback: readonly DistillationSearchProvider[],
): DistillationSearchProvider[] => {
  if (value === undefined || value.trim() === "") return [...fallback];
  const parsed = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is DistillationSearchProvider =>
      distillationSearchProviderValues.has(part as DistillationSearchProvider),
    );
  if (parsed.length === 0) return [...fallback];
  return [...new Set(parsed)];
};

const parseDistillationProvider = (
  value: string | undefined,
  fallback: DistillationProvider,
): DistillationProvider => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "local-llm" ||
    normalized === "azure-openai" ||
    normalized === "bedrock" ||
    normalized === "auto"
  ) {
    return normalized;
  }
  return fallback;
};

const parseEmbeddingProvider = (value: string | undefined): EmbeddingProvider => {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "daemon" ||
    normalized === "openai" ||
    normalized === "disabled"
  ) {
    return normalized;
  }
  return "auto";
};

const parseCsvValues = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const resolvePositiveInt = (
  value: string | undefined,
  fallback: number,
  options?: { min?: number; max?: number },
): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (options?.min !== undefined && floored < options.min) return fallback;
  if (options?.max !== undefined && floored > options.max) return options.max;
  return Math.max(1, floored);
};

const resolveNonNegativeInt = (
  value: string | undefined,
  fallback: number,
  options?: { max?: number },
): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 0) return fallback;
  if (options?.max !== undefined && floored > options.max) return options.max;
  return floored;
};

const resolveBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on")
    return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
    return false;
  return fallback;
};

const parseAgenticCompileProvider = (
  value: string | undefined,
  fallback: AgenticCompileProvider,
): AgenticCompileProvider => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "local-llm" ||
    normalized === "azure-openai" ||
    normalized === "bedrock" ||
    normalized === "auto"
  ) {
    return normalized as AgenticCompileProvider;
  }
  return fallback;
};

const distillationProvider = parseDistillationProvider(
  readProjectEnv("DISTILLATION_PROVIDER"),
  "local-llm",
);
const findCandidateProvider = parseDistillationProvider(
  readProjectEnv("DISTILLATION_FIND_CANDIDATE_PROVIDER") ||
    readProjectEnv("FIND_CANDIDATE_PROVIDER"),
  "openai",
);

const sourceContentRoot = path.resolve(
  readProjectEnv("SOURCE_CONTENT_ROOT")?.trim() || path.resolve(process.cwd(), "wiki"),
);
const readFileRoot = path.resolve(sourceContentRoot, "pages");

export const groupedConfig: GroupedConfig = {
  database: {
    url:
      process.env.DATABASE_URL ||
      `postgres://postgres:postgres@localhost:7889/${projectIdentity.databaseName}`,
    poolMax: resolvePositiveInt(readProjectEnv("DB_POOL_MAX"), 3, { min: 1, max: 20 }),
    idleTimeoutMillis: resolvePositiveInt(readProjectEnv("DB_POOL_IDLE_TIMEOUT_MS"), 10_000, {
      min: 1_000,
      max: 300_000,
    }),
    connectionTimeoutMillis: resolvePositiveInt(
      readProjectEnv("DB_POOL_CONNECTION_TIMEOUT_MS"),
      5_000,
      { min: 500, max: 60_000 },
    ),
  },
  embedding: {
    dimension: APP_CONSTANTS.embeddingDimension,
    provider: parseEmbeddingProvider(readProjectEnv("EMBEDDING_PROVIDER")),
    daemonUrl: (readProjectEnv("EMBEDDING_DAEMON_URL") || "http://127.0.0.1:44512").replace(
      /\/+$/,
      "",
    ),
    accessToken:
      readProjectEnv("EMBEDDING_ACCESS_TOKEN") || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    timeoutMs: APP_CONSTANTS.embeddingTimeoutMs,
    openaiModel: readProjectEnv("EMBEDDING_OPENAI_MODEL") || "text-embedding-3-small",
  },
  localLlm: {
    apiBaseUrl: (readProjectEnv("LOCAL_LLM_API_BASE_URL") || "http://127.0.0.1:44448").replace(
      /\/+$/,
      "",
    ),
    apiPath: readProjectEnv("LOCAL_LLM_API_PATH") || "/v1/chat/completions",
    apiKey: readProjectEnv("LOCAL_LLM_API_KEY") || process.env.LOCAL_LLM_ACCESS_TOKEN || "",
    model: readProjectEnv("LOCAL_LLM_MODEL") || "gemma-4-e4b-it",
    models: [
      {
        name: "Primary",
        apiBaseUrl: (readProjectEnv("LOCAL_LLM_API_BASE_URL") || "http://127.0.0.1:44448").replace(
          /\/+$/,
          "",
        ),
        apiPath: readProjectEnv("LOCAL_LLM_API_PATH") || "/v1/chat/completions",
        model: readProjectEnv("LOCAL_LLM_MODEL") || "gemma-4-e4b-it",
      },
    ],
  },
  sourceContent: {
    root: sourceContentRoot,
  },
  readFile: {
    root: readFileRoot,
    defaultTokens: APP_CONSTANTS.readFileDefaultTokens,
    maxTokens: APP_CONSTANTS.readFileMaxTokens,
  },
  codex: {
    sessionDir:
      readProjectEnv("CODEX_SESSION_DIR") || path.join(os.homedir(), ".codex", "sessions"),
    archivedSessionDir:
      readProjectEnv("CODEX_ARCHIVED_SESSION_DIR") ||
      path.join(os.homedir(), ".codex", "archived_sessions"),
    accessToken: process.env.CODEX_ACCESS_TOKEN || "",
  },
  antigravity: {
    logDir:
      readProjectEnv("ANTIGRAVITY_LOG_DIR") ||
      path.join(os.homedir(), ".gemini", "antigravity", "brain"),
    initialLookbackHours: APP_CONSTANTS.antigravityLogInitialLookbackHours,
  },
  agentLogSync: {
    intervalSeconds: APP_CONSTANTS.agentLogSyncIntervalSeconds,
    initialLookbackHours: APP_CONSTANTS.agentLogInitialLookbackHours,
    maxMessagesPerChunk: APP_CONSTANTS.agentLogMaxMessagesPerChunk,
    maxCharsPerChunk: APP_CONSTANTS.agentLogMaxCharsPerChunk,
    lockTtlSeconds: APP_CONSTANTS.agentLogSyncLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "agent-log-sync.lock"),
    excludedProjectNames: parseCsvValues(readProjectEnv("AGENT_LOG_EXCLUDED_PROJECT_NAMES")),
    excludedSessionIds: parseCsvValues(readProjectEnv("AGENT_LOG_EXCLUDED_SESSION_IDS")),
    excludedSessionTitleContains: parseCsvValues(
      readProjectEnv("AGENT_LOG_EXCLUDED_SESSION_TITLE_CONTAINS"),
    ),
    minDistillableChars: resolveNonNegativeInt(
      readProjectEnv("AGENT_LOG_MIN_DISTILLABLE_CHARS"),
      2000,
    ),
  },
  vibeDistillation: {
    promptVersion: APP_CONSTANTS.vibeDistillationPromptVersion,
    batchSize: APP_CONSTANTS.vibeDistillationBatchSize,
    maxInputChars: APP_CONSTANTS.vibeDistillationMaxInputChars,
    maxOutputTokens: APP_CONSTANTS.vibeDistillationMaxOutputTokens,
    lockTtlSeconds: APP_CONSTANTS.vibeDistillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "vibe-distillation.lock"),
  },
  sourceDistillation: {
    promptVersion: APP_CONSTANTS.sourceDistillationPromptVersion,
    batchSize: APP_CONSTANTS.sourceDistillationBatchSize,
    maxInputChars: APP_CONSTANTS.sourceDistillationMaxInputChars,
    maxOutputTokens: APP_CONSTANTS.sourceDistillationMaxOutputTokens,
    lockTtlSeconds: APP_CONSTANTS.sourceDistillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "source-distillation.lock"),
  },
  distillationTools: {
    maxRounds: APP_CONSTANTS.distillationToolMaxRounds,
    findCandidateMaxToolCalls: APP_CONSTANTS.distillationFindCandidateToolMaxCalls,
    coverEvidenceSearchMaxCalls: APP_CONSTANTS.distillationCoverEvidenceSearchMaxCalls,
    coverEvidenceFetchMaxCalls: APP_CONSTANTS.distillationCoverEvidenceFetchMaxCalls,
    coverEvidenceFetchMaxTokensPerSite:
      APP_CONSTANTS.distillationCoverEvidenceFetchMaxTokensPerSite,
    timeoutMs: APP_CONSTANTS.distillationToolTimeoutMs,
    resultMaxChars: APP_CONSTANTS.distillationToolResultMaxChars,
    fetchMaxResponseBytes: resolvePositiveInt(
      readProjectEnv("FETCH_MAX_RESPONSE_BYTES"),
      APP_CONSTANTS.distillationFetchMaxResponseBytes,
      { min: 1024, max: 16 * 1024 * 1024 },
    ),
    searchResultCount: APP_CONSTANTS.distillationSearchResultCount,
    searchProviders: parseDistillationSearchProviders(
      readProjectEnv("DISTILLATION_SEARCH_PROVIDERS"),
      APP_CONSTANTS.distillationSearchProviders,
    ),
    searchMaxProviderAttempts: APP_CONSTANTS.distillationSearchMaxProviderAttempts,
    searchRateLimitCooldownSeconds: APP_CONSTANTS.distillationSearchRateLimitCooldownSeconds,
    failureRetryDelaySeconds: APP_CONSTANTS.distillationFailureRetryDelaySeconds,
    evidenceCacheTtlSeconds: APP_CONSTANTS.distillationEvidenceCacheTtlSeconds,
    readerMaxReads: APP_CONSTANTS.distillationReaderMaxReads,
    readerMaxCharsPerRead: APP_CONSTANTS.distillationReaderMaxCharsPerRead,
  },
  compile: {
    defaultTokenBudget: APP_CONSTANTS.defaultTokenBudget,
    candidateTraceLimit: resolvePositiveInt(
      readProjectEnv("CONTEXT_COMPILE_TRACE_LIMIT") ?? process.env.CONTEXT_COMPILE_TRACE_LIMIT,
      APP_CONSTANTS.defaultCandidateTraceLimit,
      { min: 1, max: APP_CONSTANTS.compileCandidateTraceLimitMax },
    ),
    candidateTraceLimitMax: APP_CONSTANTS.compileCandidateTraceLimitMax,
    enableVectorSearch: APP_CONSTANTS.enableVectorSearch,
  },
  openAi: {
    apiKey: readProjectEnvWithFallback("OPENAI_API_KEY", ["OPENAI_API_KEY"]) || "",
    apiBaseUrl: (readProjectEnv("OPENAI_API_BASE_URL") || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    ),
    model: readProjectEnv("OPENAI_MODEL") || "gpt-5.4-mini",
  },
  azureOpenAi: {
    apiKey: readProjectEnvWithFallback("AZURE_OPENAI_API_KEY", ["AZURE_OPENAI_API_KEY"]) || "",
    apiBaseUrl: (
      readProjectEnvWithFallback("AZURE_OPENAI_API_BASE_URL", ["AZURE_OPENAI_API_BASE_URL"]) ||
      process.env.AZURE_OPENAI_ENDPOINT ||
      process.env.GNOSIS_REVIEW_LLM_API_BASE_URL ||
      ""
    ).replace(/\/+$/, ""),
    apiPath: "/openai/deployments",
    apiVersion:
      readProjectEnvWithFallback("AZURE_OPENAI_API_VERSION", ["AZURE_OPENAI_API_VERSION"]) ||
      "2025-04-01-preview",
    model:
      readProjectEnvWithFallback("AZURE_OPENAI_MODEL", ["AZURE_OPENAI_MODEL"]) || "gpt-5-4-mini",
    deployments: [],
  },
  bedrock: {
    model: readProjectEnv("BEDROCK_MODEL") || "",
    region: readProjectEnv("BEDROCK_REGION") || process.env.AWS_REGION || "us-east-1",
    profile: readProjectEnv("BEDROCK_PROFILE") || process.env.AWS_PROFILE || "",
  },
  agenticCompile: {
    provider: parseAgenticCompileProvider(readProjectEnv("AGENTIC_COMPILE_PROVIDER"), "openai"),
    enabled: APP_CONSTANTS.agenticCompileEnabled,
    timeoutMs: APP_CONSTANTS.agenticCompileTimeoutMs,
    maxTokens: APP_CONSTANTS.agenticCompileMaxTokens,
  },
  distillation: {
    provider: distillationProvider,
    findCandidateProvider,
    timeoutMs: APP_CONSTANTS.distillationTimeoutMs,
    findCandidateTimeoutMs: APP_CONSTANTS.distillationFindCandidateTimeoutMs,
    coverEvidenceTimeoutMs: APP_CONSTANTS.distillationCoverEvidenceTimeoutMs,
    coverEvidenceConcurrency: resolvePositiveInt(
      readProjectEnv("COVER_EVIDENCE_CONCURRENCY"),
      APP_CONSTANTS.distillationCoverEvidenceConcurrency,
      { min: 1, max: 8 },
    ),
    lockTtlSeconds: APP_CONSTANTS.distillationLockTtlSeconds,
    lockFile: path.resolve(process.cwd(), "logs", "distillation.lock"),
    pipelineLockFile: path.resolve(process.cwd(), "logs", "distillation-pipeline.lock"),
    candidateTimeoutMs: APP_CONSTANTS.distillationCandidateTimeoutMs,
    pipelineLockStaleSeconds: APP_CONSTANTS.distillationPipelineLockStaleSeconds,
    pipelineClaimLimit: resolvePositiveInt(
      readProjectEnv("DISTILL_PIPELINE_LIMIT"),
      APP_CONSTANTS.distillationPipelineClaimLimit,
      { min: 1, max: 1000 },
    ),
    continuousIdleSleepMs: APP_CONSTANTS.distillationContinuousIdleSleepMs,
    continuousErrorSleepMs: APP_CONSTANTS.distillationContinuousErrorSleepMs,
    inventoryRefreshIntervalMs: APP_CONSTANTS.distillationInventoryRefreshIntervalMs,
    findCandidateBackgroundEnabled: APP_CONSTANTS.findCandidateBackgroundEnabled,
    findCandidateNoWait: resolveBoolean(
      readProjectEnv("FIND_CANDIDATE_NO_WAIT"),
      APP_CONSTANTS.findCandidateNoWait,
    ),
    findCandidateInteractiveWindowSeconds: APP_CONSTANTS.findCandidateInteractiveWindowSeconds,
    findCandidateRecentBlockSeconds: APP_CONSTANTS.findCandidateRecentBlockSeconds,
    findCandidateMinIntervalSeconds: APP_CONSTANTS.findCandidateMinIntervalSeconds,
    findCandidateMediumIntervalSeconds: APP_CONSTANTS.findCandidateMediumIntervalSeconds,
    findCandidateBusyIntervalSeconds: APP_CONSTANTS.findCandidateBusyIntervalSeconds,
    findCandidateMaxIntervalSeconds: APP_CONSTANTS.findCandidateMaxIntervalSeconds,
    findCandidateRateLimitCooldownSeconds: APP_CONSTANTS.findCandidateRateLimitCooldownSeconds,
    findCandidateJitterSeconds: APP_CONSTANTS.findCandidateJitterSeconds,
    findingQueueTaskIntervalSeconds: resolveNonNegativeInt(
      readProjectEnv("FINDING_QUEUE_TASK_INTERVAL_SECONDS"),
      APP_CONSTANTS.findingQueueTaskIntervalSeconds,
      { max: 3600 },
    ),
    coveringQueueTaskIntervalSeconds: resolveNonNegativeInt(
      readProjectEnv("COVERING_QUEUE_TASK_INTERVAL_SECONDS"),
      APP_CONSTANTS.coveringQueueTaskIntervalSeconds,
      { max: 3600 },
    ),
    promotionBacklogThresholdCount: APP_CONSTANTS.distillationPromotionBacklogThresholdCount,
    lowImportanceRejectThreshold: APP_CONSTANTS.distillationLowImportanceRejectThreshold,
    llmContextWindowTokens: APP_CONSTANTS.distillationLlmContextWindowTokens,
    llmMaxInputTokens: APP_CONSTANTS.distillationLlmMaxInputTokens,
    llmInputSafetyMarginTokens: APP_CONSTANTS.distillationLlmInputSafetyMarginTokens,
    circuitBreakerEnabled: APP_CONSTANTS.distillationCircuitBreakerEnabled,
    circuitBreakerHealthTimeoutMs: APP_CONSTANTS.distillationCircuitBreakerHealthTimeoutMs,
    circuitBreakerPauseSeconds: APP_CONSTANTS.distillationCircuitBreakerPauseSeconds,
    backpressurePauseSeconds: APP_CONSTANTS.distillationBackpressurePauseSeconds,
    sourceAgenticReaderManualEnabled: APP_CONSTANTS.sourceDistillationAgenticReaderManualEnabled,
    sourceAgenticReaderAutoEnabled: APP_CONSTANTS.sourceDistillationAgenticReaderAutoEnabled,
    vibeAgenticReaderManualEnabled: APP_CONSTANTS.vibeDistillationAgenticReaderManualEnabled,
    internalChunkedDistillationEnabled: resolveBoolean(
      readProjectEnv("INTERNAL_CHUNKED_DISTILLATION"),
      false,
    ),
  },
  admin: {
    apiKey: resolveAdminApiKey(readProjectEnv("ADMIN_API_KEY")),
    allowedOrigins: parseCsvValues(readProjectEnv("ALLOWED_ORIGINS")),
  },
  doctor: {
    freshnessThresholdMinutes: APP_CONSTANTS.doctorFreshnessThresholdMinutes,
    degradedRateThreshold: APP_CONSTANTS.doctorDegradedRateThreshold,
    knowledgeStaleDecayFactor: APP_CONSTANTS.doctorKnowledgeStaleDecayFactor,
    knowledgeZeroUseWarningMinActiveCount:
      APP_CONSTANTS.doctorKnowledgeZeroUseWarningMinActiveCount,
  },
};

export type {
  GroupedConfig,
  EmbeddingProvider,
  AgenticCompileProvider,
  DistillationProvider,
  DistillationSearchProvider,
};
