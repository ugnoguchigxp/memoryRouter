import { z } from "zod";

const doctorStatusSchema = z.enum(["ok", "degraded", "failed"]);
const compileRunDurationSampleSchema = z.object({
  runId: z.string().uuid(),
  label: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  status: doctorStatusSchema,
  createdAt: z.string().datetime(),
});

const launchAgentSchema = z.object({
  label: z.string(),
  plistPath: z.string(),
  installed: z.boolean(),
  loaded: z.boolean(),
  state: z.string().nullable(),
});

const skippedRunReasonSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative(),
});

const distillationQueueBlockersSchema = z.object({
  pendingKnowledgeCandidates: z.number().int().nonnegative(),
  runningKnowledgeCandidates: z.number().int().nonnegative(),
  staleRunningKnowledgeCandidates: z.number().int().nonnegative(),
  retryableKnowledgeCandidates: z.number().int().nonnegative(),
  manualPausedKnowledgeCandidates: z.number().int().nonnegative(),
  pendingWiki: z.number().int().nonnegative(),
  runningWiki: z.number().int().nonnegative(),
  staleRunningWiki: z.number().int().nonnegative(),
  retryableWiki: z.number().int().nonnegative(),
  manualPausedWiki: z.number().int().nonnegative(),
});

const distillationQueueHealthSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  retryablePaused: z.number().int().nonnegative(),
  staleRunning: z.number().int().nonnegative(),
  blockedByHigherPriority: z.boolean(),
  blockers: distillationQueueBlockersSchema.optional(),
  oldestQueuedAt: z.string().datetime().nullable(),
  oldestQueuedAgeMinutes: z.number().nonnegative().nullable(),
  oldestRunningAt: z.string().datetime().nullable(),
  oldestRunningAgeMinutes: z.number().nonnegative().nullable(),
  lock: z.object({
    path: z.string(),
    exists: z.boolean(),
    pid: z.number().int().positive().nullable(),
    createdAt: z.string().datetime().nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
    staleByCreatedAge: z.boolean(),
  }),
});

const doctorReasonSeveritySchema = z.enum(["critical", "warning", "info"]);
const doctorReasonAreaSchema = z.enum([
  "Knowledge",
  "Distillation",
  "Sync",
  "Runtime",
  "MCP",
  "Other",
]);
const doctorReasonImpactLevelSchema = z.enum(["blocking", "degraded", "maintenance", "skipped"]);
const doctorReasonEnvironmentScopeSchema = z.enum([
  "all",
  "configured_only",
  "non_empty_db",
  "strict_only",
]);
const doctorReasonCommandsSchema = z.object({
  inspect: z.string().nullable(),
  repairDryRun: z.string().nullable(),
  repairApply: z.string().nullable(),
});
const doctorReasonDetailSchema = z.object({
  code: z.string(),
  label: z.string(),
  severity: doctorReasonSeveritySchema,
  area: doctorReasonAreaSchema,
  description: z.string(),
  impact: z.string(),
  action: z.string(),
  impactLevel: doctorReasonImpactLevelSchema.optional(),
  environmentScope: doctorReasonEnvironmentScopeSchema.optional(),
  commands: doctorReasonCommandsSchema.optional(),
  evidence: z.record(z.unknown()).nullable().optional(),
});

const doctorReasonSummarySchema = z.object({
  blocking: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  maintenance: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const desktopReadinessStateSchema = z.enum([
  "Ready",
  "Needs setup",
  "Optional improvement",
  "Advanced server backend only",
]);
const desktopReadinessItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: desktopReadinessStateSchema,
  scope: z.enum(["default", "optional", "advanced"]),
  action: z.string().min(1),
});
const desktopReadinessSchema = z.object({
  backendCategory: z.enum(["sqlite-local", "postgres-server", "compat-legacy"]),
  modeLabel: z.string().min(1),
  status: desktopReadinessStateSchema,
  defaultBackendReady: z.boolean(),
  items: z.array(desktopReadinessItemSchema),
});

export const doctorDistillationHealthSchema = z.object({
  inputSources: z
    .object({
      sources: z.number().int().nonnegative(),
      fragments: z.number().int().nonnegative(),
    })
    .default({ sources: 0, fragments: 0 }),
  launchAgent: launchAgentSchema,
  runs: z.object({
    totalRuns: z.number().int().nonnegative(),
    okRuns: z.number().int().nonnegative(),
    skippedRuns: z.number().int().nonnegative(),
    outcomeKindCounts: z.array(skippedRunReasonSchema),
    skippedRunReasons: z.array(skippedRunReasonSchema),
    failedRuns: z.number().int().nonnegative(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunAgeMinutes: z.number().nonnegative().nullable(),
    lastOkRunAt: z.string().datetime().nullable(),
    lastOkRunAgeMinutes: z.number().nonnegative().nullable(),
  }),
  jobs: z.object({
    total: z.number().int().nonnegative().optional(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failedLast24h: z.number().int().nonnegative().optional(),
    failedLast7d: z.number().int().nonnegative().optional(),
    lastPausedAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
  }),
  queueHealth: distillationQueueHealthSchema,
  nextActions: z.array(z.string()),
});

const llmProviderHealthSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.enum(["openai", "azure-openai", "bedrock", "local-llm", "codex"]),
  configured: z.boolean(),
  reachable: z.boolean(),
  model: z.string(),
  endpoint: z.string(),
  error: z.string().optional(),
  deploymentIndex: z.number().int().positive().optional(),
  selected: z.boolean().default(false),
  routeOrder: z.number().int().nonnegative().nullable().default(null),
  generationChecked: z.boolean().optional(),
  generationReachable: z.boolean().optional(),
  generationError: z.string().optional(),
  localLlmSmokes: z
    .array(
      z.object({
        name: z.enum(["simple_chat", "json_only", "tool_result_history"]),
        ok: z.boolean(),
        error: z.string().optional(),
        preview: z.string().optional(),
      }),
    )
    .optional(),
});

export const doctorReportSchema = z.object({
  status: doctorStatusSchema,
  checkedAt: z.string().datetime(),
  totalDurationMs: z.number().int().nonnegative(),
  summary: doctorReasonSummarySchema,
  reasons: z.array(z.string()),
  reasonDetails: z.array(doctorReasonDetailSchema),
  skippedChecks: z.array(doctorReasonDetailSchema),
  db: z.object({
    reachable: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    responseMs: z.number().nonnegative(),
    queryMs: z.number().nonnegative(),
    totalInspectionMs: z.number().nonnegative(),
    error: z.string().optional(),
  }),
  vector: z.object({
    installed: z.boolean(),
    healthMs: z.number().nonnegative().nullable(),
    source: z.enum(["rust", "bun", "postgres", "unavailable"]),
  }),
  desktopReadiness: desktopReadinessSchema.optional(),
  embedding: z.object({
    configured: z.boolean(),
    provider: z.string(),
    effectiveMode: z.enum(["daemon", "openai", "disabled", "unavailable"]).optional(),
    daemon: z.object({
      url: z.string(),
      reachable: z.boolean(),
      status: z.enum(["external_ready", "offline", "not_required"]).optional(),
      managedBy: z.enum(["external", "none"]).optional(),
      error: z.string().optional(),
    }),
    openai: z
      .object({
        configured: z.boolean(),
        model: z.string(),
        error: z.string().optional(),
      })
      .optional(),
  }),
  agenticLlm: z.object({
    providerSetting: z.string(),
    selectedProvider: z.string().optional(),
    fallbackOrder: z.array(z.string()),
    provider: z.string(),
    configured: z.boolean(),
    reachable: z.boolean(),
    model: z.string(),
    endpoint: z.string(),
    error: z.string().optional(),
    providerHealth: z.array(llmProviderHealthSchema).default([]),
  }),
  tables: z.object({
    expected: z.array(z.string()),
    existing: z.array(z.string()),
    missing: z.array(z.string()),
  }),
  runs: z.object({
    windowSize: z.number().int().positive(),
    totalRuns: z.number().int().nonnegative(),
    degradedRuns: z.number().int().nonnegative(),
    degradedRate: z.number().min(0).max(1),
    blockingRuns: z.number().int().nonnegative().optional(),
    blockingRate: z.number().min(0).max(1).optional(),
    usableRuns: z.number().int().nonnegative().optional(),
    usableRate: z.number().min(0).max(1).optional(),
    warningOnlyRuns: z.number().int().nonnegative().optional(),
    warningOnlyRate: z.number().min(0).max(1).optional(),
    noContentRuns: z.number().int().nonnegative().optional(),
    noContentRate: z.number().min(0).max(1).optional(),
    durationMsP50: z.number().nonnegative().nullable(),
    durationMsP95: z.number().nonnegative().nullable(),
    durationMsAvg: z.number().nonnegative().nullable(),
    durationSamples: z.array(compileRunDurationSampleSchema).default([]),
    lastRunAt: z.string().datetime().nullable(),
    lastRunAgeMinutes: z.number().nonnegative().nullable(),
    freshnessThresholdMinutes: z.number().int().positive(),
    degradedRateThreshold: z.number().min(0).max(1),
  }),
  hitl: z.object({
    draftCount: z.number().int().nonnegative(),
    oldestDraftAt: z.string().datetime().nullable(),
    oldestDraftAgeMinutes: z.number().nonnegative().nullable(),
    backlogThresholdCount: z.number().int().positive(),
    backlogThresholdAgeMinutes: z.number().int().positive(),
  }),
  knowledgeLifecycle: z.object({
    activeCount: z.number().int().nonnegative(),
    zeroUseActiveCount: z.number().int().nonnegative(),
    staleByDecayCount: z.number().int().nonnegative(),
    staleProcedureCount: z.number().int().nonnegative(),
    dynamicScoreAvg: z.number().nonnegative().nullable(),
    dynamicScoreP95: z.number().nonnegative().nullable(),
    lastCompiledAt: z.string().datetime().nullable(),
    lastCompiledAgeMinutes: z.number().nonnegative().nullable(),
    thresholds: z.object({
      staleDecayFactor: z.number().min(0).max(1),
      zeroUseWarningMinActiveCount: z.number().int().positive(),
    }),
  }),
  mcp: z.object({
    exposedTools: z.array(z.string()),
    requiredPrimaryTools: z.array(z.string()),
    missingPrimaryTools: z.array(z.string()),
    staleKnowledgeCount: z.number().int().nonnegative(),
    staleSourceCount: z.number().int().nonnegative(),
    nextActions: z.array(z.string()),
  }),
  contextDecision: z.object({
    available: z.boolean(),
    totalDecisions: z.number().int().nonnegative(),
    decisionCounts: z.record(z.number().int().nonnegative()),
    escalateRate: z.number().min(0).max(1),
    escalateTargetRate: z.number().min(0).max(1),
    goodFeedbackCount: z.number().int().nonnegative(),
    badFeedbackCount: z.number().int().nonnegative(),
    prDiscardFeedbackCount: z.number().int().nonnegative(),
    autoAppliedEffectsCount: z.number().int().nonnegative(),
    queuedEffectsCount: z.number().int().nonnegative(),
    degradedDecisionsCount: z.number().int().nonnegative(),
    requiredZeroEvidenceCount: z.number().int().nonnegative(),
    lowRelevanceSelectedEvidenceCount: z.number().int().nonnegative(),
    ghAvailable: z.boolean(),
    nextActions: z.array(z.string()),
  }),
  agentLogSync: z.object({
    codex: z.object({
      sessionDir: z.string(),
      sessionDirExists: z.boolean(),
      archivedSessionDir: z.string(),
      archivedSessionDirExists: z.boolean(),
    }),
    antigravity: z.object({
      logDir: z.string(),
      configured: z.boolean(),
      exists: z.boolean(),
    }),
    states: z.array(
      z.object({
        id: z.string(),
        lastSyncedAt: z.string().datetime().nullable(),
        lastSyncedAgeMinutes: z.number().nonnegative().nullable(),
        lastCheckedAt: z.string().datetime().nullable().optional(),
        lastCheckedAgeMinutes: z.number().nonnegative().nullable().optional(),
        cursorFiles: z.number().int().nonnegative(),
        skipped: z.boolean(),
        warnings: z.array(z.string()),
      }),
    ),
    launchAgent: launchAgentSchema,
    nextActions: z.array(z.string()),
  }),
  vibeDistillation: doctorDistillationHealthSchema,
  sourceDistillation: doctorDistillationHealthSchema,
});

const doctorDomainBaseSchema = doctorReportSchema.pick({
  status: true,
  checkedAt: true,
  totalDurationMs: true,
  summary: true,
  reasons: true,
  reasonDetails: true,
  skippedChecks: true,
});

export const doctorCoreInfrastructureDomainSchema = doctorDomainBaseSchema.extend({
  db: doctorReportSchema.shape.db,
  vector: doctorReportSchema.shape.vector,
  desktopReadiness: doctorReportSchema.shape.desktopReadiness,
  embedding: doctorReportSchema.shape.embedding,
  tables: doctorReportSchema.shape.tables,
  hitl: doctorReportSchema.shape.hitl,
  knowledgeLifecycle: doctorReportSchema.shape.knowledgeLifecycle,
});

export const doctorAiServiceToolsDomainSchema = doctorDomainBaseSchema.extend({
  agenticLlm: doctorReportSchema.shape.agenticLlm,
  mcp: doctorReportSchema.shape.mcp,
});

export const doctorPipelineAutomationDomainSchema = doctorDomainBaseSchema.extend({
  runs: doctorReportSchema.shape.runs,
  agentLogSync: doctorReportSchema.shape.agentLogSync,
  vibeDistillation: doctorReportSchema.shape.vibeDistillation,
  sourceDistillation: doctorReportSchema.shape.sourceDistillation,
});

export const doctorDomainNameSchema = z.enum([
  "core-infrastructure",
  "ai-service-tools",
  "pipeline-automation",
]);

export type DoctorReport = z.infer<typeof doctorReportSchema>;
export type DoctorDistillationHealth = z.infer<typeof doctorDistillationHealthSchema>;
export type DoctorCoreInfrastructureDomain = z.infer<typeof doctorCoreInfrastructureDomainSchema>;
export type DoctorAiServiceToolsDomain = z.infer<typeof doctorAiServiceToolsDomainSchema>;
export type DoctorPipelineAutomationDomain = z.infer<typeof doctorPipelineAutomationDomainSchema>;
export type DoctorDomainName = z.infer<typeof doctorDomainNameSchema>;
export type DoctorDomainReport =
  | DoctorCoreInfrastructureDomain
  | DoctorAiServiceToolsDomain
  | DoctorPipelineAutomationDomain;
