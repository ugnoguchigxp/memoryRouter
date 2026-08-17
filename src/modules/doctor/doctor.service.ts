import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import {
  type DoctorAiServiceToolsDomain,
  type DoctorCoreInfrastructureDomain,
  type DoctorDomainName,
  type DoctorDomainReport,
  type DoctorPipelineAutomationDomain,
  type DoctorReport,
  doctorAiServiceToolsDomainSchema,
  doctorCoreInfrastructureDomainSchema,
  doctorPipelineAutomationDomainSchema,
  doctorReportSchema,
} from "../../shared/schemas/doctor.schema.js";
import { cleanupExpiredAuditLogsSafe } from "../audit/audit-log.service.js";
import {
  type AgenticLlmHealthStatus,
  checkAgenticLlmHealth,
  checkLlmProviderHealthMatrix,
} from "../llm/agentic-llm.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";
import {
  appendAutomationReasons,
  createEmptyRuns,
  createReasonResolutionContext,
  resolveReasonDetails,
} from "./doctor-reason-resolution.js";
import type { DoctorOptions, ResolvedDoctorOptions } from "./doctor.types.js";
import { nowIso } from "./doctor.utils.js";
import { inspectAgentLogSync } from "./inspectors/agent-log-sync.inspector.js";
import { inspectCompileRuns } from "./inspectors/compile.inspector.js";
import { inspectContextDecision } from "./inspectors/context-decision.inspector.js";
import { type DatabaseInspection, inspectDatabase } from "./inspectors/database.inspector.js";
import { inspectEmbedding } from "./inspectors/embedding.inspector.js";
import { inspectMcpSurface } from "./inspectors/mcp.inspector.js";
import { inspectSourceDistillation } from "./inspectors/source-distillation.inspector.js";
import { inspectVibeDistillation } from "./inspectors/vibe-distillation.inspector.js";

function resolveDoctorOptions(rawOptions?: DoctorOptions): ResolvedDoctorOptions {
  return {
    windowSize: Math.max(1, rawOptions?.windowSize ?? 20),
    freshnessThresholdMinutes:
      rawOptions?.freshnessThresholdMinutes ?? groupedConfig.doctor.freshnessThresholdMinutes,
    degradedRateThreshold:
      rawOptions?.degradedRateThreshold ?? groupedConfig.doctor.degradedRateThreshold,
    strict: rawOptions?.strict ?? false,
  };
}

async function inspectDoctorDatabase(options: ResolvedDoctorOptions): Promise<DatabaseInspection> {
  return inspectDatabase({
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    staleDecayFactor: groupedConfig.doctor.knowledgeStaleDecayFactor,
    zeroUseWarningMinActiveCount: groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
  });
}

async function inspectAgenticLlmWithProviderHealth(
  timeoutMs = 5000,
): Promise<AgenticLlmHealthStatus> {
  const agenticRouting = resolveAgenticCompileRouting();
  const agenticLlm = await checkAgenticLlmHealth(
    agenticRouting.provider,
    timeoutMs,
    agenticRouting.fallback,
    agenticRouting.azureDeploymentSlots,
  );
  const providerHealth = await checkLlmProviderHealthMatrix(timeoutMs, {
    selectedProvider: agenticLlm.selectedProvider,
    routeOrder: agenticLlm.fallbackOrder,
    selectedAzureDeploymentSlots: agenticRouting.azureDeploymentSlots,
    selectedLocalLlmModel:
      agenticLlm.provider === "local-llm"
        ? (agenticRouting.localLlmModel ?? agenticLlm.model)
        : undefined,
  });
  return {
    ...agenticLlm,
    providerHealth,
  };
}

function buildMcpReport(
  mcp: DoctorReport["mcp"],
  database: DatabaseInspection,
): DoctorReport["mcp"] {
  return {
    ...mcp,
    staleKnowledgeCount: database.staleKnowledgeCount,
    staleSourceCount: database.staleSourceCount,
    nextActions: [
      ...mcp.nextActions,
      ...(database.staleKnowledgeCount > 0
        ? [`deprecated knowledge を整理する（count: ${database.staleKnowledgeCount}）`]
        : []),
      ...(database.staleSourceCount > 0
        ? [`stale source を再importまたは更新する（count: ${database.staleSourceCount}）`]
        : []),
      ...(database.hitl.draftCount > database.hitl.backlogThresholdCount
        ? [
            `draft backlog が閾値超過（${database.hitl.draftCount}/${database.hitl.backlogThresholdCount}）。Knowledge UI で一括レビューする`,
          ]
        : []),
      ...(database.knowledgeLifecycle.zeroUseActiveCount > 0
        ? [
            `unused active knowledge を確認する（${database.knowledgeLifecycle.zeroUseActiveCount}/${database.knowledgeLifecycle.activeCount}）`,
          ]
        : []),
      ...(database.knowledgeLifecycle.staleByDecayCount > 0
        ? [
            `decay が低い knowledge を再検証する（stale=${database.knowledgeLifecycle.staleByDecayCount}, threshold=${database.knowledgeLifecycle.thresholds.staleDecayFactor}）`,
          ]
        : []),
    ],
  };
}

function createUnavailableContextDecisionReport(): DoctorReport["contextDecision"] {
  return {
    available: false,
    totalDecisions: 0,
    decisionCounts: {},
    escalateRate: 0,
    escalateTargetRate: 0.1,
    goodFeedbackCount: 0,
    badFeedbackCount: 0,
    prDiscardFeedbackCount: 0,
    autoAppliedEffectsCount: 0,
    queuedEffectsCount: 0,
    degradedDecisionsCount: 0,
    requiredZeroEvidenceCount: 0,
    lowRelevanceSelectedEvidenceCount: 0,
    ghAvailable: false,
    nextActions: ["Restore database connectivity before inspecting context_decision."],
  };
}

function hasTable(database: DatabaseInspection, tableName: string): boolean {
  return database.existingTables.includes(tableName);
}

function canQueryOperationalTables(): boolean {
  const backend = resolveDatabaseBackendConfig().kind;
  return backend === "postgres" || backend === "sqlite";
}

function canQueryAgentLogSyncTables(): boolean {
  const backend = resolveDatabaseBackendConfig().kind;
  return backend === "postgres" || backend === "sqlite";
}

function isEmbeddingReady(embedding: DoctorReport["embedding"]): boolean {
  if (embedding.effectiveMode) {
    if (embedding.effectiveMode === "unavailable") return false;
    if (embedding.effectiveMode === "openai") return embedding.openai?.configured === true;
    return true;
  }
  return !embedding.configured || embedding.daemon.reachable || embedding.cli.usable;
}

function buildDesktopReadiness(input: {
  database: DatabaseInspection;
  embedding: DoctorReport["embedding"];
  mcp?: DoctorReport["mcp"];
  agenticLlm?: { reachable: boolean };
  includeIntegrationChecks?: boolean;
}): DoctorReport["desktopReadiness"] {
  const backend = resolveDatabaseBackendConfig().kind;
  const isSqlite = backend === "sqlite";
  const isPostgres = backend === "postgres";
  const defaultBackendReady =
    isSqlite && input.database.reachable && input.database.missingTables.length === 0;
  const embeddingReady = isEmbeddingReady(input.embedding);
  const mcpReady = Boolean(input.mcp && input.mcp.missingPrimaryTools.length === 0);
  const llmReady =
    !input.agenticLlm || !groupedConfig.agenticCompile.enabled || input.agenticLlm.reachable;

  const items: NonNullable<DoctorReport["desktopReadiness"]>["items"] = [
    {
      id: "sqlite-local-db",
      label: "SQLite local database",
      state: isSqlite
        ? defaultBackendReady
          ? "Ready"
          : "Needs setup"
        : "Advanced server backend only",
      scope: isSqlite ? "default" : "advanced",
      action: defaultBackendReady
        ? "SQLite backend is selected and required local tables are present."
        : isSqlite
          ? "Set CONTEXT_STILL_DB_BACKEND=sqlite and run the SQLite migration/bootstrap path."
          : "SQLite local database checks are skipped because the advanced server backend is selected.",
    },
    {
      id: "desktop-safe-defaults",
      label: "Desktop-safe defaults",
      state: isSqlite ? "Ready" : "Advanced server backend only",
      scope: isSqlite ? "default" : "advanced",
      action: isSqlite
        ? "Default runtime path does not require Docker or PostgreSQL."
        : "The selected backend is the opt-in server path, not the desktop default.",
    },
    {
      id: "embedding",
      label: "Embedding assistance",
      state: embeddingReady ? "Ready" : "Optional improvement",
      scope: "optional",
      action: embeddingReady
        ? "Embedding is available or intentionally not required for minimal desktop usage."
        : "Start the embedding daemon or configure the CLI embedding fallback when semantic search quality matters.",
    },
    {
      id: "postgres-server-backend",
      label: "PostgreSQL / pgvector backend",
      state: isPostgres
        ? input.database.reachable
          ? "Ready"
          : "Needs setup"
        : "Advanced server backend only",
      scope: "advanced",
      action: isPostgres
        ? "Server backend is selected; PostgreSQL and pgvector diagnostics apply to this advanced path."
        : "No PostgreSQL or pgvector remediation is required for the default desktop path.",
    },
  ];

  if (input.includeIntegrationChecks) {
    items.splice(
      3,
      0,
      {
        id: "mcp-tool-surface",
        label: "MCP tool surface",
        state: mcpReady ? "Ready" : "Optional improvement",
        scope: "optional",
        action: mcpReady
          ? "MCP tools are exposed; client registration remains an explicit user action."
          : "Expose the missing MCP tools before registering the server in an agent client.",
      },
      {
        id: "llm-assist",
        label: "LLM-assisted review",
        state: llmReady ? "Ready" : "Optional improvement",
        scope: "optional",
        action: llmReady
          ? "Minimal desktop usage is not blocked by cloud or local LLM setup."
          : "Configure a local or cloud LLM route before using assisted distillation/review modes.",
      },
    );
  }

  const hasDefaultSetupGap = items.some(
    (item) => item.scope === "default" && item.state === "Needs setup",
  );
  const hasOptionalGap = items.some((item) => item.state === "Optional improvement");
  const hasAdvancedSetupGap = items.some(
    (item) => item.scope === "advanced" && item.state === "Needs setup",
  );

  return {
    backendCategory: isSqlite ? "sqlite-local" : "postgres-server",
    modeLabel: isSqlite ? "Desktop local" : "Advanced server backend",
    status: isPostgres
      ? hasAdvancedSetupGap
        ? "Needs setup"
        : "Advanced server backend only"
      : hasDefaultSetupGap
        ? "Needs setup"
        : hasOptionalGap
          ? "Optional improvement"
          : "Ready",
    defaultBackendReady,
    items,
  };
}

export async function runDoctor(rawOptions?: DoctorOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  await ensureRuntimeSettingsLoaded();
  const options = resolveDoctorOptions(rawOptions);
  await cleanupExpiredAuditLogsSafe({ trigger: "doctor" });
  const reasons: string[] = [];
  const mcp = await inspectMcpSurface();
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }

  const embedding = await inspectEmbedding();
  const agenticLlm = await inspectAgenticLlmWithProviderHealth(5000);
  const database = await inspectDoctorDatabase(options);

  if (!database.reachable) {
    const [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
      inspectAgentLogSync({
        canQueryDb: false,
        syncStatesTableAvailable: false,
      }),
      inspectVibeDistillation({
        canQueryDb: false,
      }),
      inspectSourceDistillation({
        canQueryDb: false,
      }),
    ]);

    const mergedReasons = [...reasons, ...database.reasons];
    const emptyRuns = createEmptyRuns(options);
    const reasonResolution = resolveReasonDetails(mergedReasons, {
      options,
      runs: emptyRuns,
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    });
    return doctorReportSchema.parse({
      status: reasonResolution.status,
      checkedAt: nowIso(),
      totalDurationMs: Date.now() - startedAt,
      summary: reasonResolution.summary,
      reasons: reasonResolution.reasons,
      reasonDetails: reasonResolution.reasonDetails,
      skippedChecks: reasonResolution.skippedChecks,
      db: database.db,
      vector: database.vector,
      desktopReadiness: buildDesktopReadiness({
        database,
        embedding,
        mcp,
        agenticLlm,
        includeIntegrationChecks: true,
      }),
      embedding,
      agenticLlm,
      tables: {
        expected: database.expectedTables,
        existing: database.existingTables,
        missing: database.missingTables,
      },
      runs: emptyRuns,
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
      mcp,
      contextDecision: createUnavailableContextDecisionReport(),
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    });
  }

  reasons.push(...database.reasons);

  if (!isEmbeddingReady(embedding)) {
    reasons.push("EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  if (groupedConfig.agenticCompile.enabled && !agenticLlm.configured) {
    reasons.push("AGENTIC_LLM_NOT_CONFIGURED");
  } else if (groupedConfig.agenticCompile.enabled && !agenticLlm.reachable) {
    reasons.push("AGENTIC_LLM_UNREACHABLE");
  }

  const compile = await inspectCompileRuns({
    windowSize: options.windowSize,
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    degradedRateThreshold: options.degradedRateThreshold,
    compileRunsTableAvailable: hasTable(database, "context_compile_runs"),
  });
  reasons.push(...compile.reasons);
  const contextDecision = await inspectContextDecision({
    tableAvailable: hasTable(database, "context_decision_runs"),
  });
  reasons.push(...contextDecision.reasons);
  const canQueryOperationalDb = canQueryOperationalTables();
  const canQueryAgentLogSyncDb = canQueryAgentLogSyncTables();

  const [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
    inspectAgentLogSync({
      canQueryDb: canQueryAgentLogSyncDb,
      syncStatesTableAvailable: hasTable(database, "sync_states"),
    }),
    inspectVibeDistillation({
      canQueryDb: canQueryOperationalDb,
    }),
    inspectSourceDistillation({
      canQueryDb: canQueryOperationalDb,
    }),
  ]);

  appendAutomationReasons(reasons, options, agentLogSync, vibeDistillation, sourceDistillation);
  const reasonResolution = resolveReasonDetails(reasons, {
    options,
    runs: compile.runs,
    hitl: database.hitl,
    knowledgeLifecycle: database.knowledgeLifecycle,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });

  const mcpReport = buildMcpReport(mcp, database);
  const desktopReadiness = buildDesktopReadiness({
    database,
    embedding,
    mcp: mcpReport,
    agenticLlm,
    includeIntegrationChecks: true,
  });

  return doctorReportSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    totalDurationMs: Date.now() - startedAt,
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    db: database.db,
    vector: database.vector,
    desktopReadiness,
    embedding,
    agenticLlm,
    tables: {
      expected: database.expectedTables,
      existing: database.existingTables,
      missing: database.missingTables,
    },
    runs: compile.runs,
    hitl: database.hitl,
    knowledgeLifecycle: database.knowledgeLifecycle,
    mcp: mcpReport,
    contextDecision: contextDecision.report,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}

async function prepareDoctorDomainOptions(
  rawOptions?: DoctorOptions,
): Promise<ResolvedDoctorOptions> {
  await ensureRuntimeSettingsLoaded();
  return resolveDoctorOptions(rawOptions);
}

export async function runDoctorCoreInfrastructure(
  rawOptions?: DoctorOptions,
): Promise<DoctorCoreInfrastructureDomain> {
  const startedAt = Date.now();
  const options = await prepareDoctorDomainOptions(rawOptions);
  const [embedding, database] = await Promise.all([
    inspectEmbedding(),
    inspectDoctorDatabase(options),
  ]);

  const reasons = [...database.reasons];
  if (!isEmbeddingReady(embedding)) {
    reasons.push("EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
    }),
  );

  return doctorCoreInfrastructureDomainSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    totalDurationMs: Date.now() - startedAt,
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    db: database.db,
    vector: database.vector,
    desktopReadiness: buildDesktopReadiness({ database, embedding }),
    embedding,
    tables: {
      expected: database.expectedTables,
      existing: database.existingTables,
      missing: database.missingTables,
    },
    hitl: database.hitl,
    knowledgeLifecycle: database.knowledgeLifecycle,
  });
}

export async function runDoctorAiServiceTools(
  rawOptions?: DoctorOptions,
): Promise<DoctorAiServiceToolsDomain> {
  const startedAt = Date.now();
  const options = await prepareDoctorDomainOptions(rawOptions);
  const mcp = await inspectMcpSurface();
  const agenticLlm = await inspectAgenticLlmWithProviderHealth(5000);

  const reasons: string[] = [];
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }
  if (groupedConfig.agenticCompile.enabled && !agenticLlm.configured) {
    reasons.push("AGENTIC_LLM_NOT_CONFIGURED");
  } else if (groupedConfig.agenticCompile.enabled && !agenticLlm.reachable) {
    reasons.push("AGENTIC_LLM_UNREACHABLE");
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {}),
  );

  return doctorAiServiceToolsDomainSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    totalDurationMs: Date.now() - startedAt,
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    agenticLlm,
    mcp,
  });
}

export async function runDoctorPipelineAutomation(
  rawOptions?: DoctorOptions,
): Promise<DoctorPipelineAutomationDomain> {
  const startedAt = Date.now();
  const options = await prepareDoctorDomainOptions(rawOptions);
  const database = await inspectDoctorDatabase(options);
  const reasons: string[] = [];
  let runs: DoctorReport["runs"] = createEmptyRuns(options);
  let agentLogSync: DoctorReport["agentLogSync"];
  let vibeDistillation: DoctorReport["vibeDistillation"];
  let sourceDistillation: DoctorReport["sourceDistillation"];

  if (!database.reachable) {
    reasons.push(...database.reasons);
    [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
      inspectAgentLogSync({
        canQueryDb: false,
        syncStatesTableAvailable: false,
      }),
      inspectVibeDistillation({
        canQueryDb: false,
      }),
      inspectSourceDistillation({
        canQueryDb: false,
      }),
    ]);
  } else {
    const canQueryOperationalDb = canQueryOperationalTables();
    const canQueryAgentLogSyncDb = canQueryAgentLogSyncTables();
    const [compile, inspectedAgentLogSync, inspectedVibeDistillation, inspectedSourceDistillation] =
      await Promise.all([
        inspectCompileRuns({
          windowSize: options.windowSize,
          freshnessThresholdMinutes: options.freshnessThresholdMinutes,
          degradedRateThreshold: options.degradedRateThreshold,
          compileRunsTableAvailable: hasTable(database, "context_compile_runs"),
        }),
        inspectAgentLogSync({
          canQueryDb: canQueryAgentLogSyncDb,
          syncStatesTableAvailable: hasTable(database, "sync_states"),
        }),
        inspectVibeDistillation({
          canQueryDb: canQueryOperationalDb,
        }),
        inspectSourceDistillation({
          canQueryDb: canQueryOperationalDb,
        }),
      ]);
    runs = compile.runs;
    agentLogSync = inspectedAgentLogSync;
    vibeDistillation = inspectedVibeDistillation;
    sourceDistillation = inspectedSourceDistillation;
    reasons.push(...compile.reasons);
    appendAutomationReasons(reasons, options, agentLogSync, vibeDistillation, sourceDistillation);
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {
      runs,
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    }),
  );

  return doctorPipelineAutomationDomainSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    totalDurationMs: Date.now() - startedAt,
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    runs,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}

export async function runDoctorDomain(
  domain: DoctorDomainName,
  rawOptions?: DoctorOptions,
): Promise<DoctorDomainReport> {
  if (domain === "core-infrastructure") return runDoctorCoreInfrastructure(rawOptions);
  if (domain === "ai-service-tools") return runDoctorAiServiceTools(rawOptions);
  return runDoctorPipelineAutomation(rawOptions);
}
