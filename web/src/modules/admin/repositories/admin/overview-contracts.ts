import type { SkippedRunReason } from "./knowledge-contracts";

export type DoctorReasonSeverity = "critical" | "warning" | "info";

export type DoctorReasonArea = "Knowledge" | "Distillation" | "Sync" | "Runtime" | "MCP" | "Other";

export type DoctorReasonImpactLevel = "blocking" | "degraded" | "maintenance" | "skipped";

export type DoctorReasonEnvironmentScope =
  | "all"
  | "configured_only"
  | "non_empty_db"
  | "strict_only";

export type DoctorReasonDetail = {
  code: string;
  label: string;
  severity: DoctorReasonSeverity;
  area: DoctorReasonArea;
  description: string;
  impact: string;
  action: string;
  impactLevel?: DoctorReasonImpactLevel;
  environmentScope?: DoctorReasonEnvironmentScope;
  commands?: {
    inspect: string | null;
    repairDryRun: string | null;
    repairApply: string | null;
  };
  evidence?: Record<string, unknown> | null;
};

export type DoctorReport = {
  status: "ok" | "degraded" | "failed";
  checkedAt: string;
  totalDurationMs: number;
  summary: {
    blocking: number;
    degraded: number;
    maintenance: number;
    skipped: number;
  };
  reasons: string[];
  reasonDetails?: DoctorReasonDetail[];
  skippedChecks?: DoctorReasonDetail[];
  db: {
    reachable: boolean;
    durationMs: number;
    responseMs: number;
    queryMs: number;
    totalInspectionMs: number;
    error?: string;
  };
  vector: {
    installed: boolean;
    healthMs: number | null;
    source: "rust" | "bun" | "postgres" | "unavailable";
  };
  desktopReadiness?: {
    backendCategory: "sqlite-local" | "postgres-server" | "compat-legacy";
    modeLabel: string;
    status: "Ready" | "Needs setup" | "Optional improvement" | "Advanced server backend only";
    defaultBackendReady: boolean;
    items: Array<{
      id: string;
      label: string;
      state: "Ready" | "Needs setup" | "Optional improvement" | "Advanced server backend only";
      scope: "default" | "optional" | "advanced";
      action: string;
    }>;
  };
  embedding?: {
    configured: boolean;
    provider: string;
    effectiveMode?: "daemon" | "openai" | "disabled" | "unavailable";
    daemon: {
      url: string;
      reachable: boolean;
      status?: "external_ready" | "offline" | "not_required";
      managedBy?: "external" | "none";
      error?: string;
    };
  };
  agenticLlm?: {
    providerSetting: string;
    selectedProvider?: string;
    fallbackOrder: string[];
    provider: string;
    configured: boolean;
    reachable: boolean;
    model: string;
    endpoint: string;
    error?: string;
    providerHealth?: Array<{
      id: string;
      label: string;
      provider: string;
      configured: boolean;
      reachable: boolean;
      model: string;
      endpoint: string;
      error?: string;
      deploymentIndex?: number;
      selected?: boolean;
      routeOrder?: number | null;
      generationChecked?: boolean;
      generationReachable?: boolean;
      generationError?: string;
      localLlmSmokes?: Array<{
        name: "simple_chat" | "json_only" | "tool_result_history";
        ok: boolean;
        error?: string;
        preview?: string;
      }>;
    }>;
  };
  runs: {
    windowSize?: number;
    totalRuns: number;
    degradedRuns: number;
    degradedRate: number;
    blockingRuns?: number;
    blockingRate?: number;
    usableRuns?: number;
    usableRate?: number;
    warningOnlyRuns?: number;
    warningOnlyRate?: number;
    noContentRuns?: number;
    noContentRate?: number;
    durationMsP50: number | null;
    durationMsP95: number | null;
    durationMsAvg: number | null;
    durationSamples?: Array<{
      runId: string;
      label: string;
      durationMs: number;
      status: "ok" | "degraded" | "failed";
      createdAt: string;
    }>;
    lastRunAt: string | null;
    lastRunAgeMinutes?: number | null;
    freshnessThresholdMinutes?: number;
    degradedRateThreshold?: number;
  };
  tables?: {
    expected: string[];
    existing: string[];
    missing: string[];
  };
  hitl: {
    draftCount: number;
    oldestDraftAt: string | null;
    oldestDraftAgeMinutes: number | null;
    backlogThresholdCount: number;
    backlogThresholdAgeMinutes: number;
  };
  knowledgeLifecycle: {
    activeCount: number;
    zeroUseActiveCount: number;
    staleByDecayCount: number;
    staleProcedureCount: number;
    dynamicScoreAvg: number | null;
    dynamicScoreP95: number | null;
    lastCompiledAt: string | null;
    lastCompiledAgeMinutes: number | null;
    thresholds: {
      staleDecayFactor: number;
      zeroUseWarningMinActiveCount: number;
    };
  };
  mcp: {
    exposedTools: string[];
    requiredPrimaryTools: string[];
    missingPrimaryTools: string[];
    staleKnowledgeCount: number;
    staleSourceCount: number;
    nextActions: string[];
  };
  agentLogSync: {
    codex: {
      sessionDir: string;
      sessionDirExists: boolean;
      archivedSessionDir: string;
      archivedSessionDirExists: boolean;
    };
    antigravity: {
      logDir: string;
      configured: boolean;
      exists: boolean;
    };
    states: Array<{
      id: string;
      lastSyncedAt: string | null;
      lastSyncedAgeMinutes: number | null;
      lastCheckedAt?: string | null;
      lastCheckedAgeMinutes?: number | null;
      cursorFiles: number;
      skipped: boolean;
      warnings: string[];
    }>;
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    nextActions: string[];
  };
  vibeDistillation: {
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    runs: {
      totalRuns: number;
      okRuns: number;
      skippedRuns: number;
      outcomeKindCounts: SkippedRunReason[];
      skippedRunReasons: SkippedRunReason[];
      failedRuns: number;
      lastRunAt: string | null;
      lastRunAgeMinutes: number | null;
      lastOkRunAt?: string | null;
      lastOkRunAgeMinutes?: number | null;
    };
    jobs: {
      total?: number;
      queued: number;
      running: number;
      paused: number;
      failed: number;
      failedLast24h?: number;
      failedLast7d?: number;
      lastPausedAt: string | null;
      lastError: string | null;
    };
    queueHealth: {
      queued: number;
      running: number;
      retryablePaused: number;
      staleRunning: number;
      blockedByHigherPriority: boolean;
      blockers?: {
        pendingKnowledgeCandidates: number;
        runningKnowledgeCandidates: number;
        staleRunningKnowledgeCandidates: number;
        retryableKnowledgeCandidates: number;
        manualPausedKnowledgeCandidates: number;
        pendingWiki: number;
        runningWiki: number;
        staleRunningWiki: number;
        retryableWiki: number;
        manualPausedWiki: number;
      };
      oldestQueuedAt: string | null;
      oldestQueuedAgeMinutes: number | null;
      oldestRunningAt: string | null;
      oldestRunningAgeMinutes: number | null;
      lock: {
        path: string;
        exists: boolean;
        pid: number | null;
        createdAt: string | null;
        ageSeconds: number | null;
        staleByCreatedAge: boolean;
      };
    };
    nextActions: string[];
  };
  sourceDistillation: {
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    runs: {
      totalRuns: number;
      okRuns: number;
      skippedRuns: number;
      outcomeKindCounts: SkippedRunReason[];
      skippedRunReasons: SkippedRunReason[];
      failedRuns: number;
      lastRunAt: string | null;
      lastRunAgeMinutes: number | null;
      lastOkRunAt?: string | null;
      lastOkRunAgeMinutes?: number | null;
    };
    jobs: {
      queued: number;
      running: number;
      paused: number;
      failed: number;
      lastPausedAt: string | null;
      lastError: string | null;
    };
    queueHealth: {
      queued: number;
      running: number;
      retryablePaused: number;
      staleRunning: number;
      blockedByHigherPriority: boolean;
      blockers?: {
        pendingKnowledgeCandidates: number;
        runningKnowledgeCandidates: number;
        staleRunningKnowledgeCandidates: number;
        retryableKnowledgeCandidates: number;
        manualPausedKnowledgeCandidates: number;
        pendingWiki: number;
        runningWiki: number;
        staleRunningWiki: number;
        retryableWiki: number;
        manualPausedWiki: number;
      };
      oldestQueuedAt: string | null;
      oldestQueuedAgeMinutes: number | null;
      oldestRunningAt: string | null;
      oldestRunningAgeMinutes: number | null;
      lock: {
        path: string;
        exists: boolean;
        pid: number | null;
        createdAt: string | null;
        ageSeconds: number | null;
        staleByCreatedAge: boolean;
      };
    };
    nextActions: string[];
  };
};

export type DoctorDomainBase = Pick<
  DoctorReport,
  | "status"
  | "checkedAt"
  | "totalDurationMs"
  | "summary"
  | "reasons"
  | "reasonDetails"
  | "skippedChecks"
>;

export type DoctorCoreInfrastructureDomain = DoctorDomainBase &
  Pick<
    DoctorReport,
    "db" | "vector" | "desktopReadiness" | "embedding" | "tables" | "hitl" | "knowledgeLifecycle"
  >;

export type DoctorAiServiceToolsDomain = DoctorDomainBase &
  Pick<DoctorReport, "agenticLlm" | "mcp">;

export type DoctorPipelineAutomationDomain = DoctorDomainBase &
  Pick<DoctorReport, "runs" | "agentLogSync" | "vibeDistillation" | "sourceDistillation">;

export type OverviewDashboard = {
  checkedAt: string;
  kpis: {
    knowledgeTotal: number;
    activeKnowledge: number;
    draftKnowledge: number;
    deprecatedKnowledge: number;
    rules: number;
    procedures: number;
    embeddedKnowledge: number;
    zeroUseActiveKnowledge: number;
    wikiPages: number;
    indexedSources: number;
    sourceFragments: number;
    sourceLinks: number;
    linkedKnowledge: number;
    unlinkedKnowledge: number;
    sourceEvidenceLinkedKnowledge: number;
    sourceEvidenceUnlinkedKnowledge: number;
    originLinkedKnowledge: number;
    originUnlinkedKnowledge: number;
    provenanceTraceableKnowledge: number;
    provenanceUntraceableKnowledge: number;
    originLinksByKind: Record<string, number>;
    sourceCommunities: number;
    sourceCoveredCommunities: number;
    sourceThinCommunities: number;
    sourceMissingCommunities: number;
    vibeRecords: number;
    vibeSessions: number;
    vibeRecordsWithDiffs: number;
    agentDiffEntries: number;
    compileRuns: number;
    compileOkRuns: number;
    compileDegradedRuns: number;
    compileFailedRuns: number;
    graphNodes?: number;
    graphEdges?: number;
    graphEmbedded?: number;
    graphSessionEdges?: number;
    graphProjectEdges?: number;
    graphSourceEdges?: number;
  };
  charts: {
    knowledgeByStatusType: Array<{
      status: "active" | "draft" | "deprecated";
      rule: number;
      procedure: number;
    }>;
    dynamicScoreBuckets: Array<{
      bucket:
        | "0"
        | "0-1"
        | "1-5"
        | "5-10"
        | "10-15"
        | "15-20"
        | "20-25"
        | "25-30"
        | "30-35"
        | "35+";
      count: number;
    }>;
    compileRunsByDay: Array<{
      day: string;
      ok: number;
      degraded: number;
      failed: number;
      avgDurationMs: number | null;
    }>;
    vibeRecordsByDay: Array<{
      day: string;
      records: number;
    }>;
    sourceCoverage: Array<{
      label: "linked" | "unlinked";
      count: number;
    }>;
    communitySourceCoverage: Array<{
      label: "covered" | "thin" | "no-source";
      count: number;
    }>;
  };
  llmUsage: {
    kpis: {
      totalCalls30d: number;
      measuredCalls30d: number;
      estimatedCalls30d: number;
      localTokensTotal30d: number;
      localPromptTokens30d: number;
      localCompletionTokens30d: number;
      cloudTokensTotal30d: number;
      cloudPromptTokens30d: number;
      cloudCompletionTokens30d: number;
      measuredTokensTotal30d: number;
      estimatedTokensTotal30d: number;
      measuredCoveragePercent30d: number;
      reasoningTokensTotal30d: number;
      cloudCostJpyTotal30d: number;
      cloudModel: string;
      cloudInputCostJpyPerMTokens: number;
      cloudOutputCostJpyPerMTokens: number;
    };
    daily: Array<{
      day: string;
      localPromptTokens: number;
      localCompletionTokens: number;
      localReasoningTokens: number;
      cloudPromptTokens: number;
      cloudCompletionTokens: number;
      cloudReasoningTokens: number;
      totalTokens: number;
      measuredTokens: number;
      estimatedTokens: number;
      measuredCalls: number;
      estimatedCalls: number;
      costJpy: number;
    }>;
    bySource: Array<{
      source: string;
      calls: number;
      measuredCalls: number;
      estimatedCalls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>;
  };
  searchApiStatus: {
    brave: {
      status: "ok" | "cooldown";
      cooldownUntil: string | null;
      lastError: string | null;
    };
    exa: {
      status: "ok" | "cooldown";
      cooldownUntil: string | null;
      lastError: string | null;
    };
  };
  compileEvalStats: {
    windowLabel: string;
    evaluatedRunCount: number;
    evaluationCount: number;
    averageAvg: number | null;
    metrics: Array<{
      metric: "relevance" | "actionability" | "coverage" | "clarity" | "specificity";
      label: string;
      average: number | null;
    }>;
  };
  productValueStats: {
    windowLabel: string;
    metrics: Array<{
      metric:
        | "compile_adoption_rate"
        | "compile_reuse_rate"
        | "decision_success_rate"
        | "bad_feedback_rate"
        | "prevented_rework_signals";
      label: string;
      rate: number | null;
      count: number;
      denominator: number;
      evidenceLabel: string;
    }>;
    evidence: {
      compileRunCount: number;
      evaluatedCompileRunCount: number;
      compileEvaluationCount: number;
      acceptedCompileEvaluationCount: number;
      reusedCompileRunCount: number;
      decisionRunCount: number;
      decisionFeedbackCount: number;
      knownDecisionFeedbackCount: number;
      successfulDecisionFeedbackCount: number;
      badDecisionFeedbackCount: number;
      preventedReworkSignalCount: number;
      appliedFeedbackEffectCount: number;
    };
  };
  landscape:
    | {
        status: "ok";
        windowDays: number;
        generatedAt: string;
        snapshot: {
          totalCommunities: number;
          strongAttractorCount: number;
          usefulAttractorCount: number;
          negativeCandidateCount: number;
          overSelectedNotUsedCount: number;
          deadZoneReachabilityCount: number;
          deadZoneStaleCount: number;
          feedbackInsufficientCount: number;
          topRiskCount: number;
        };
        replay: {
          comparedRunCount: number;
          averageOverlapRate: number;
          retainedItemCount: number;
          missingFromCurrentItemCount: number;
          newlyRetrievedItemCount: number;
          usedBaselineLostItemCount: number;
          highChurnRunCount: number;
          currentNoMatchRunCount: number;
          promotionGateMode: "normal" | "review_required";
        };
      }
    | {
        status: "unavailable";
        windowDays: number;
        error: string;
      };
};

export type OverviewKnowledgeAssetsDomain = {
  checkedAt: string;
  kpis: Pick<
    OverviewDashboard["kpis"],
    | "knowledgeTotal"
    | "activeKnowledge"
    | "draftKnowledge"
    | "deprecatedKnowledge"
    | "rules"
    | "procedures"
    | "embeddedKnowledge"
    | "zeroUseActiveKnowledge"
    | "wikiPages"
    | "indexedSources"
    | "sourceFragments"
    | "sourceLinks"
    | "linkedKnowledge"
    | "unlinkedKnowledge"
    | "sourceEvidenceLinkedKnowledge"
    | "sourceEvidenceUnlinkedKnowledge"
    | "originLinkedKnowledge"
    | "originUnlinkedKnowledge"
    | "provenanceTraceableKnowledge"
    | "provenanceUntraceableKnowledge"
    | "originLinksByKind"
    | "sourceCommunities"
    | "sourceCoveredCommunities"
    | "sourceThinCommunities"
    | "sourceMissingCommunities"
    | "vibeRecords"
    | "vibeSessions"
    | "vibeRecordsWithDiffs"
    | "agentDiffEntries"
    | "graphNodes"
    | "graphEdges"
    | "graphEmbedded"
    | "graphSessionEdges"
    | "graphProjectEdges"
    | "graphSourceEdges"
  >;
  charts: Pick<
    OverviewDashboard["charts"],
    | "knowledgeByStatusType"
    | "dynamicScoreBuckets"
    | "vibeRecordsByDay"
    | "sourceCoverage"
    | "communitySourceCoverage"
  >;
};

export type OverviewSystemQualityDomain = {
  checkedAt: string;
  kpis: Pick<
    OverviewDashboard["kpis"],
    "compileRuns" | "compileOkRuns" | "compileDegradedRuns" | "compileFailedRuns"
  >;
  compileRunHealth: DoctorReport["runs"];
  compileEvalStats: OverviewDashboard["compileEvalStats"];
  productValueStats: OverviewDashboard["productValueStats"];
  charts: Pick<OverviewDashboard["charts"], "compileRunsByDay">;
  searchApiStatus: OverviewDashboard["searchApiStatus"];
};

export type OverviewLlmResourcesDomain = {
  checkedAt: string;
  llmUsage: OverviewDashboard["llmUsage"];
};

export type OverviewLandscapeHealthDomain = {
  checkedAt: string;
  landscape: OverviewDashboard["landscape"];
};

export type OverviewDomainName =
  | "knowledge-assets"
  | "landscape-health"
  | "system-quality"
  | "llm-resources";

export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source";
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
  communityKey?: string;
  communityLabel?: string;
  sourceId?: string;
  sourceKind?: string;
  sourceUri?: string;
  sourceTitle?: string | null;
  linkedKnowledgeCount?: number;
};
