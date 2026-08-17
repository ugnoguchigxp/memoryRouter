export type KnowledgeType = "rule" | "procedure";

export type KnowledgeItem = {
  id: string;
  type: KnowledgeType | string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sourceRefs?: string[];
  sourceVibeMemoryIds?: string[];
  compileSelectCount: number;
  lastCompiledAt: string | null;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  decayFactor: number;
  lastVerifiedAt: string | null;
  updatedAt: string;
  polarity: "positive" | "negative";
  intentTags: string[];
};

export type KnowledgeListResponse = {
  items: KnowledgeItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type KnowledgeListRequest = {
  limit?: number;
  page?: number;
  status?: string;
  query?: string;
  displayFilter?:
    | "all"
    | "draft"
    | "active"
    | "deprecated"
    | "unused-active"
    | "stale"
    | "high-value";
  minQuality?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  polarities?: Array<"positive" | "negative">;
  intentTags?: string[];
};

export type KnowledgeFeedback = {
  id: string;
  direction: "up" | "down";
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  lastVerifiedAt: string | null;
};

export type KnowledgeBulkStatusResponse = {
  targetStatus: "active" | "deprecated";
  requestedIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
  notFoundIds: string[];
  invalidTransitionIds: Array<{ id: string; fromStatus: string }>;
  outcome: "ok" | "partial" | "none";
};

export type KnowledgeBulkStatusSelection = {
  status?: string;
  type?: string;
  query?: string;
};

export type KnowledgeBulkStatusRequest =
  | {
      ids: string[];
      status: "active" | "deprecated";
    }
  | {
      selection: KnowledgeBulkStatusSelection;
      status: "active" | "deprecated";
    };

export type VibeMemory = {
  id: string;
  sessionId: string;
  content: string;
  memoryType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type AgentDiffEntry = {
  id: string;
  vibeMemoryId: string;
  filePath: string;
  diffHunk: string;
  changeType: string | null;
  language: string | null;
  symbolName: string | null;
  symbolKind: string | null;
  signature: string | null;
  startLine: number | null;
  endLine: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type EpisodeCardStatus = "active" | "deprecated";
export type EpisodeOutcomeKind = "success" | "failure" | "mixed" | "unknown";
export type EpisodeSourceKind =
  | "vibe_memory"
  | "compile_run"
  | "decision_run"
  | "audit_log"
  | "manual";
export type EpisodeRefKind =
  | "vibe_memory"
  | "agent_diff"
  | "compile_run"
  | "decision_run"
  | "audit_log"
  | "file"
  | "commit";

export type EpisodeRefInput = {
  refKind: EpisodeRefKind;
  refValue: string;
  locator?: string | null;
  queryHint?: string | null;
  metadata?: Record<string, unknown>;
};

export type EpisodeRef = EpisodeRefInput & {
  id: string;
  episodeCardId: string;
  createdAt: string;
};

export type EpisodeCard = {
  id: string;
  title: string;
  situation: string;
  observations: string;
  action: string;
  outcome: string;
  lesson: string;
  applicability: Record<string, unknown>;
  antiApplicability: Record<string, unknown>;
  domains: string[];
  technologies: string[];
  changeTypes: string[];
  tools: string[];
  repoPath?: string | null;
  repoKey?: string | null;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  outcomeKind: EpisodeOutcomeKind;
  importance: number;
  confidence: number;
  compileUseCount: number;
  decisionUseCount: number;
  status: EpisodeCardStatus;
  staleAt?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  score?: number;
  refs: EpisodeRef[];
};

export type EpisodeCardCreateInput = {
  title: string;
  situation: string;
  observations?: string;
  action?: string;
  outcome?: string;
  lesson?: string;
  applicability?: Record<string, unknown>;
  antiApplicability?: Record<string, unknown>;
  domains?: string[];
  technologies?: string[];
  changeTypes?: string[];
  tools?: string[];
  repoPath?: string | null;
  repoKey?: string | null;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  outcomeKind?: EpisodeOutcomeKind;
  importance?: number;
  confidence?: number;
  compileUseCount?: number;
  decisionUseCount?: number;
  status?: EpisodeCardStatus;
  metadata?: Record<string, unknown>;
  refs?: EpisodeRefInput[];
};

export type EpisodeListRequest = {
  query?: string;
  status?: "active" | "deprecated";
  limit?: number;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  tools?: string[];
};

export type KnowledgeWriteInput = {
  type: KnowledgeType;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown> & {
    general?: boolean;
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
    repoPath?: string;
    repoKey?: string;
  };
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  metadata?: Record<string, unknown>;
  polarity?: "positive" | "negative";
  intentTags?: string[];
};

export type KnowledgeUpdateInput = Partial<KnowledgeWriteInput>;

export type KnowledgeTagDefinition = {
  id: string;
  kind: "technology" | "change_type" | "retrieval_mode" | "domain";
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: "active" | "draft" | "deprecated";
  sortOrder: number;
};

export type SkippedRunReason = {
  reason: string;
  count: number;
};

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
    daemon: { url: string; reachable: boolean; error?: string };
    cli: { python: string; root: string; modelDir: string; usable: boolean; error?: string };
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

export type GraphNodeDetail = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  detail: string;
  weight: number;
  status: string;
  confidence: number;
  importance: number;
  bodyPreview: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  edgeKind: "semantic" | "session" | "project" | "source" | "evidence";
  relationAxis: "semantic" | "session" | "project" | "source" | "evidence";
  derived: boolean;
  weight: number;
};

export type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

export type GraphViewMode = "relation" | "semantic" | "community" | "evidence";
export type GraphRelationAxis = "session" | "project" | "source";
export type GraphCommunityDisplayMode = "detail" | "supernode";

export type GraphCommunityHealth = {
  dead: boolean;
  stale: boolean;
  thinEvidence: boolean;
};

export type GraphCommunitySummary = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  embeddedCount: number;
  compileSelectCount: number;
  staleNodeCount: number;
  sourceRefCount: number;
  sourceRefDensity: number;
  health: GraphCommunityHealth;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSupernode = {
  id: string;
  label: string;
  communityKey: string;
  size: number;
  communityRank: number;
  health: GraphCommunityHealth;
};

export type GraphSuperedge = {
  id: string;
  source: string;
  target: string;
  weight: number;
};

export type GraphCommunityLabel = {
  communityKey: string;
  communityId: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunitySummary[];
  supernodes: GraphSupernode[];
  superedges: GraphSuperedge[];
  stats: {
    visibleKnowledgeCount: number;
    totalKnowledgeCount: number;
    embeddedKnowledgeCount: number;
    semanticEdgeCount: number;
    sessionEdgeCount: number;
    projectEdgeCount: number;
    sourceEdgeCount: number;
    sourceNodeCount: number;
    evidenceEdgeCount: number;
    evidenceLinkedKnowledgeCount: number;
    evidenceUnlinkedKnowledgeCount: number;
    truncatedSourceNodeCount: number;
    relationEdgeCount: number;
    sourceRefCount: number;
    communityCount: number;
    largestCommunitySize: number;
    orphanNodeCount: number;
    deadCommunityCount: number;
    staleCommunityCount: number;
    thinEvidenceCommunityCount: number;
  };
};

export type LandscapeFeedbackConfidence = "insufficient" | "low" | "medium" | "high";

export type LandscapeClassificationPrimary =
  | "strong_attractor"
  | "useful_attractor"
  | "negative_attractor_candidate"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale"
  | "feedback_insufficient"
  | "neutral";

export type LandscapeClassificationConfidence = "low" | "medium" | "high";

export type LandscapeThresholds = {
  minSelectedCount: number;
  minFeedbackCount: number;
  feedbackConfidence: {
    mediumMin: number;
    highMin: number;
  };
  feedbackFactor: Record<LandscapeFeedbackConfidence, number>;
  attractor: {
    strongUsedRateMin: number;
    usefulUsedRateMin: number;
    strongSourceRefDensityMin: number;
  };
  negative: {
    offTopicWeight: number;
    wrongWeight: number;
    candidateOffTopicRateMin: number;
  };
  notUsed: {
    overSelectedRateMin: number;
  };
  deadZone: {
    reachabilityRiskMin: number;
    staleSourceRefDensityMax: number;
    staleFactorMin: number;
  };
  evidenceFactor: {
    sourceRefDensityBaseline: number;
    min: number;
    max: number;
  };
};

export type LandscapeCommunity = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  memberCounts: {
    active: number;
    draft: number;
    deprecated: number;
    rule: number;
    procedure: number;
    embedded: number;
  };
  selection: {
    selectedItemCountWindow: number;
    selectedRunCountWindow: number;
    cumulativeCompileSelectCount: number;
    zeroUseActiveCount: number;
    zeroUseActiveRatio: number;
  };
  feedback: {
    usedCountWindow: number;
    notUsedCountWindow: number;
    offTopicCountWindow: number;
    wrongCountWindow: number;
    feedbackCountWindow: number;
    usedRate: number;
    notUsedRate: number;
    offTopicRate: number;
    wrongRate: number;
    feedbackConfidence: LandscapeFeedbackConfidence;
  };
  quality: {
    avgImportance: number;
    avgConfidence: number;
    avgDynamicScore: number;
    sourceRefCount: number;
    sourceRefDensity: number;
    avgFreshnessFactor: number;
    avgStalenessFactor: number;
  };
  scores: {
    activity: number;
    attractorScore: number;
    negativeScore: number;
    reachabilityRiskScore: number;
  };
  classification: {
    primary: LandscapeClassificationPrimary;
    flags: string[];
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };
  recommendedActions: string[];
  representativeKnowledgeIds: string[];
};

export type LandscapeSnapshot = {
  generatedAt: string;
  windowDays: number;
  basis: {
    unit: "community";
    relationAxes: GraphRelationAxis[];
    status: GraphStatusFilter;
  };
  thresholds: LandscapeThresholds;
  stats: {
    totalCommunities: number;
    activeCommunities: number;
    selectedCommunities: number;
    insufficientFeedbackCommunities: number;
    strongAttractorCount: number;
    usefulAttractorCount: number;
    negativeCandidateCount: number;
    overSelectedNotUsedCount: number;
    deadZoneReachabilityCount: number;
    deadZoneStaleCount: number;
  };
  communities: LandscapeCommunity[];
  risks: Array<{
    communityId: string;
    communityKey: string;
    communityLabel: string;
    communityRank: number;
    type:
      | "negative_attractor_candidate"
      | "wrong_review_required"
      | "over_selected_not_used"
      | "dead_zone_reachability_risk"
      | "dead_zone_stale";
    severity: LandscapeClassificationConfidence;
    reason: string;
  }>;
};

export type DeadZoneKnowledgeReviewBadge =
  | "Strong merge candidate"
  | "Canonical candidate"
  | "Likely duplicate"
  | "Scope differs"
  | "Evidence thin"
  | "Stale"
  | "Niche but valid"
  | "Needs embedding"
  | "Similarity unavailable";

export type DeadZoneKnowledgeReviewReason =
  | "all"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale";

export type DeadZoneKnowledgeReviewSortBy =
  | "deadZoneScore"
  | "compileSelectCount"
  | "title"
  | "similarity"
  | "evidence"
  | "usage";

export type DeadZoneKnowledgeMaintenanceAction =
  | "merge_deadzone_into_similar"
  | "merge_similar_into_deadzone"
  | "deprecate_deadzone"
  | "deprecate_similar";

export type DeadZoneRecommendationAction =
  | "merge_deadzone_into_canonical"
  | "deprecate_deadzone"
  | "keep_separate"
  | "promote_deadzone"
  | "needs_evidence";

export type DeadZoneReviewRecommendation = {
  action: DeadZoneRecommendationAction;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  blockers: string[];
};

export type DeadZoneMergeReviewResult = {
  decision: "merge_recommended" | "merge_blocked" | "keep_separate" | "needs_evidence";
  confidence: "low" | "medium" | "high";
  rationale: string[];
  blockers: string[];
  proposedCanonicalBody: string | null;
  proposedSummary: string | null;
  rawOutputExcerpt: string;
  parseStatus: "parsed" | "recovered" | "failed";
};

export type DeadZoneMergeReviewJob = {
  id: string;
  status: DistillationQueueStatus;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string | null;
  reviewItemId: string | null;
  provider: string;
  model: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  result: DeadZoneMergeReviewResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DeadZoneSimilarKnowledge = {
  id: string;
  title: string;
  status: "draft" | "active" | "deprecated";
  similarity: number;
  applicabilityMatch: "low" | "medium" | "high";
  evidenceStrength: "none" | "thin" | "moderate" | "strong";
  usageStrength: "none" | "low" | "moderate" | "strong";
  suggestedAction:
    | "merge_into_similar"
    | "deadzone_is_canonical"
    | "likely_duplicate"
    | "scope_differs"
    | "needs_evidence"
    | "keep_separate";
  reasons: string[];
};

export type DeadZoneKnowledgeReviewItem = {
  knowledge: {
    id: string;
    title: string;
    bodyPreview: string;
    type: "rule" | "procedure";
    status: "draft" | "active" | "deprecated";
    appliesTo: Record<string, unknown>;
    confidence: number;
    importance: number;
    compileSelectCount: number;
    lastCompiledAt: string | null;
    sourceRefCount: number;
    sourceRefDensity: number;
    communityKey: string | null;
    communityLabel: string | null;
  };
  classification: {
    primary: "dead_zone_reachability_risk" | "dead_zone_stale";
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };
  indicators: {
    deadZoneScore: number;
    evidenceStrength: "none" | "thin" | "moderate" | "strong";
    usageStrength: "none" | "low" | "moderate" | "strong";
    structureQuality: "weak" | "partial" | "strong";
    graphHealth: "orphan" | "thin" | "connected";
    badges: DeadZoneKnowledgeReviewBadge[];
  };
  bestCanonicalCandidate: DeadZoneSimilarKnowledge | null;
  alternativeCandidates: DeadZoneSimilarKnowledge[];
  recommendation: DeadZoneReviewRecommendation;
  allowedActions: DeadZoneRecommendationAction[];
  similarKnowledge: DeadZoneSimilarKnowledge[];
  reviewItemId: string | null;
  mergeReviewJob?: DeadZoneMergeReviewJob | null;
};

export type DeadZoneKnowledgeReviewResponse = {
  generatedAt: string;
  windowDays: number;
  minSimilarity: number;
  similarTopK: number;
  communityCount: number;
  itemCount: number;
  unavailableReason: string | null;
  items: DeadZoneKnowledgeReviewItem[];
};

export type DeadZoneKnowledgeMaintenanceResult = {
  action: DeadZoneKnowledgeMaintenanceAction;
  keptKnowledgeId: string | null;
  deprecatedKnowledgeId: string;
};

export type DeadZoneKnowledgeReviewActionResult = {
  action: DeadZoneRecommendationAction;
  status: "recorded" | "applied";
  message: string;
  keptKnowledgeId?: string;
  deprecatedKnowledgeId?: string;
  reviewItemId?: string;
};

export type LandscapeSnapshotCacheType =
  | "landscape_snapshot"
  | "landscape_replay_snapshot"
  | "landscape_replay_comparison";

export type LandscapeSnapshotCacheStatus = {
  generatedAt: string;
  enabled: boolean;
  ttlSeconds: number;
  disabledReason?: string | null;
  snapshots: Array<{
    snapshotType: LandscapeSnapshotCacheType;
    readyCount: number;
    staleCount: number;
    expiredReadyCount: number;
    oldestGeneratedAt: string | null;
    latestGeneratedAt: string | null;
    latestExpiresAt: string | null;
    estimatedPayloadBytes: number;
    lastPurge: {
      purgedAt: string;
      staleDeletedCount: number;
      expiredDeletedCount: number;
      deletedCount: number;
      snapshotTypes: LandscapeSnapshotCacheType[];
      error: string | null;
    } | null;
  }>;
};

export type LandscapeRunStatusFilter = "ok" | "degraded" | "failed" | "all";

export type LandscapeVerdictMix = {
  used: number;
  notUsed: number;
  offTopic: number;
  wrong: number;
};

export type LandscapeBasinExplanation =
  | "aligned_attractor"
  | "negative_explained"
  | "dead_zone_missed"
  | "over_selected"
  | "unexplained";

export type LandscapeFacetBasinSummary = {
  facetKind:
    | "retrievalMode"
    | "repoKey"
    | "technology"
    | "changeType"
    | "domain"
    | "source"
    | "runStatus"
    | "degradedReasonBucket";
  facetValue: string;
  replayRunCount: number;
  selectedItemCount: number;
  selectedCommunityCount: number;
  attractorHitCount: number;
  negativeCandidateHitCount: number;
  overSelectedHitCount: number;
  deadZoneMissCount: number;
  usedRate: number;
  offTopicRate: number;
  wrongRate: number;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeCommunityReplaySummary = {
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  replayRunCount: number;
  selectedItemCount: number;
  classificationAtAnalysis: LandscapeClassificationPrimary;
  verdictMix: LandscapeVerdictMix;
  explanationCounts: Record<LandscapeBasinExplanation, number>;
  feedbackCoverageRate: number;
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
};

export type LandscapeAcceptanceWindowSummary = {
  eventCountWindow: number;
  acceptedCountWindow: number;
  acceptedRunCountWindow: number;
  unknownAcceptanceCountWindow: number;
  agentActorEventCountWindow: number;
  acceptanceRateKnownWindow: number;
  acceptanceCoverageRate: number;
};

export type LandscapeCommunityComparison = {
  relationCommunityKey: string;
  relationCommunityLabel: string;
  relationCommunityRank: number;
  semanticCommunityKey?: string;
  comparison:
    | "aligned"
    | "semantic_split"
    | "semantic_merge"
    | "relation_orphan"
    | "semantic_reachable_dead_zone";
  jaccardOverlap: number;
  relationCommunitySize: number;
  semanticCommunitySize: number;
  selectedNeighborCountWindow: number;
  selectedNeighborKnowledgeIds: string[];
  deadZoneSemanticReachabilityScore: number;
};

export type LandscapeReplaySnapshot = {
  generatedAt: string;
  analysisAsOf: string;
  windowDays: number;
  corpusWindow: {
    startAt: string;
    endAt: string;
  };
  landscapeWindow: {
    days: number;
    analysisAsOf: string;
  };
  basis: {
    unit: "community-replay";
    relationAxes: GraphRelationAxis[];
    runStatus: LandscapeRunStatusFilter;
    landscapeStatus: GraphStatusFilter;
    minSimilarity: number;
    semanticTopK: number;
  };
  replayRunCount: number;
  selectedKnowledgeCount: number;
  missingKnowledgeCount: number;
  runs: unknown[];
  facetSummaries: LandscapeFacetBasinSummary[];
  communityReplaySummaries: LandscapeCommunityReplaySummary[];
  acceptanceWindow: LandscapeAcceptanceWindowSummary;
  communityComparison: {
    universeKnowledgeCount: number;
    comparedKnowledgeCount: number;
    missingRelationAssignmentCount: number;
    missingSemanticAssignmentCount: number;
    alignedCount: number;
    semanticSplitCount: number;
    semanticMergeCount: number;
    relationOrphanCount: number;
    semanticReachableDeadZoneCount: number;
    communities: LandscapeCommunityComparison[];
  };
};

export type LandscapeReplayComparisonKind =
  | "stable"
  | "drifted"
  | "lost_baseline"
  | "new_only"
  | "no_current_match"
  | "not_comparable";

export type LandscapeReplayComparisonRun = {
  runId: string;
  createdAt: string;
  goal: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  identityCompatibility: "comparable" | "legacy_identity_unknown";
  taskFacets: {
    repoKey?: string;
    repoPath?: string;
    retrievalMode: string;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
    source: string;
    runStatus: "ok" | "degraded" | "failed";
    degradedReasonBuckets: string[];
  };
  baselineSelectedKnowledgeIds: string[];
  currentRetrievedKnowledgeIds: string[];
  retainedKnowledgeIds: string[];
  missingFromCurrentKnowledgeIds: string[];
  newlyRetrievedKnowledgeIds: string[];
  baselineVerdicts: LandscapeVerdictMix;
  usedBaselineRetainedKnowledgeIds: string[];
  usedBaselineLostKnowledgeIds: string[];
  offTopicBaselineKnowledgeIds: string[];
  wrongBaselineKnowledgeIds: string[];
  overlapRate: number;
  replacementRate: number;
  comparison: LandscapeReplayComparisonKind;
  currentDegradedReasons: string[];
  currentRetrievalStats: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    textFailed: boolean;
    vectorFailed: boolean;
    embeddingStatus: "provided" | "generated" | "unavailable" | "disabled";
    repoScopeFallbackUsed: boolean;
  };
};

export type LandscapeAppliesToRefineCandidate = {
  runId: string;
  knowledgeId: string;
  reason:
    | "used_baseline_lost"
    | "baseline_off_topic"
    | "baseline_wrong"
    | "baseline_missing_after_recompile";
  confidence: "low" | "medium";
  suggestedAppliesTo: {
    repoKey?: string;
    repoPath?: string;
    retrievalMode: string;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
  };
  evidence: string[];
};

export type LandscapeReplayComparisonResponse = {
  generatedAt: string;
  analysisAsOf: string;
  windowDays: number;
  corpusWindow: {
    startAt: string;
    endAt: string;
  };
  basis: {
    unit: "replay-comparison";
    mode: "current_retrieval";
    runStatus: LandscapeRunStatusFilter;
    currentLimit: number;
  };
  replayRunCount: number;
  comparedRunCount: number;
  baselineSelectedItemCount: number;
  currentRetrievedItemCount: number;
  retainedItemCount: number;
  missingFromCurrentItemCount: number;
  newlyRetrievedItemCount: number;
  usedBaselineLostItemCount: number;
  averageOverlapRate: number;
  currentNoMatchRunCount: number;
  comparisonCounts: Record<LandscapeReplayComparisonKind, number>;
  recompilePlan: {
    mode: "current_retrieval_dry_run";
    writesCompileRuns: false;
    replayRunCount: number;
    comparedRunCount: number;
    blockers: string[];
  };
  rankingExperiments: Array<{
    experiment:
      | "current_retrieval"
      | "used_baseline_retention"
      | "negative_repulsion"
      | "diversity_exploration";
    productionEnabled: false;
    targetRunCount: number;
    estimatedRetainedItemCount: number;
    estimatedMissingFromCurrentItemCount: number;
    estimatedUsedBaselineLostItemCount: number;
    estimatedAverageOverlapRate: number;
    riskReductionSignal: number;
    recommendation: string;
  }>;
  appliesToRefineCandidates: LandscapeAppliesToRefineCandidate[];
  promotionGateSummary: {
    productionEnabled: false;
    gateMode: "normal" | "review_required";
    shouldTighten: boolean;
    affectedRunCount: number;
    riskyNewKnowledgeCount: number;
    reason: string;
  };
  scoreTuning: {
    productionEnabled: false;
    stableRunCount: number;
    driftedRunCount: number;
    lostBaselineRunCount: number;
    negativeFeedbackRunCount: number;
    highChurnRunCount: number;
    lostUsedBaselineRunCount: number;
    noCurrentMatchRunCount: number;
    averageReplacementRate: number;
    recommendations: string[];
  };
  compileInterventionPlan: {
    productionEnabled: false;
    strategy:
      | "observe_only"
      | "retain_used_baseline"
      | "repel_negative_candidates"
      | "diversity_exploration";
    candidateRunCount: number;
    reason: string;
  };
  runs: LandscapeReplayComparisonRun[];
};

export type LandscapeTrajectoryCandidate = {
  itemKind: "rule" | "procedure";
  itemId: string;
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
  evidence: {
    status: string | null;
    candidateEvidence: {
      textMatched: boolean;
      vectorMatched: boolean;
      vectorScore?: number | null;
      facetMatched: boolean;
    } | null;
  };
};

export type LandscapeTrajectoryResult = {
  run: {
    id: string;
    goal: string;
    retrievalMode: string;
    status: "ok" | "degraded" | "failed";
    source: string;
    createdAt: string;
  };
  traceAvailable: boolean;
  warnings: string[];
  stageCounts: {
    totalCandidates: number;
    textHit: number;
    vectorHit: number;
    merged: number;
    finalRanked: number;
    selected: number;
    suppressed: number;
  };
  selectedKnowledgeIds: string[];
  diagnostics: {
    candidateTraceSavedCount: number | null;
    candidateTraceTruncated: boolean | null;
    candidateTraceLimit: number | null;
    candidateTraceSkippedReason: string | null;
  };
  candidates: LandscapeTrajectoryCandidate[];
  communitySummary: Array<{
    communityKey: string;
    candidateCount: number;
    selectedCount: number;
    suppressedCount: number;
  }>;
  taskTrace: {
    runId: string;
    retrievalMode: string;
    repoPath: string | null;
    repoKey: string | null;
    technologies: string[];
    changeTypes: string[];
    domains: string[];
    embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
    embeddingProvider: string | null;
    embeddingModel: string | null;
    embeddingDimensions: number | null;
    goalHash: string;
    createdAt: string;
  } | null;
  taskSimilarity: Array<{
    runId: string;
    similarity: number;
    mode: "embedding" | "facets";
    retrievalMode: string;
    repoPath: string | null;
    repoKey: string | null;
    goalHash: string;
    embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
    createdAt: string;
  }>;
};

export type LandscapeReviewItemSource =
  | "replay_compare"
  | "landscape_snapshot"
  | "semantic_relation_comparison"
  | "promotion_gate"
  | "contradiction_detection";

export type LandscapeReviewItemReason =
  | "used_baseline_lost"
  | "baseline_off_topic"
  | "baseline_wrong"
  | "baseline_missing_after_recompile"
  | "negative_attractor_candidate"
  | "wrong_review_required"
  | "over_selected_not_used"
  | "dead_zone_reachability_risk"
  | "dead_zone_stale"
  | "semantic_reachable_dead_zone"
  | "semantic_split"
  | "semantic_merge"
  | "relation_orphan"
  | "promotion_gate_review"
  | "contradiction_review";

export type LandscapeReviewItemStatus = "pending" | "reviewing" | "resolved" | "dismissed";

export type LandscapeReviewItemProposedAction =
  | "review_only"
  | "refine_applies_to"
  | "repair_reachability"
  | "review_wrong"
  | "split_or_merge_review"
  | "promotion_gate_review"
  | "demote_to_draft_candidate"
  | "review_contradiction";

export type LandscapeReviewItemConfidence = "low" | "medium" | "high";

export type LandscapeReviewItem = {
  id: string;
  source: LandscapeReviewItemSource;
  reason: LandscapeReviewItemReason;
  status: LandscapeReviewItemStatus;
  proposedAction: LandscapeReviewItemProposedAction;
  priority: number;
  confidence: LandscapeReviewItemConfidence;
  knowledgeId: string | null;
  runId: string | null;
  triggerEventId: string | null;
  communityKey: string | null;
  communityLabel: string | null;
  suggestedAppliesTo: Record<string, unknown>;
  evidence: string[];
  payload: Record<string, unknown>;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type LandscapeReviewItemCandidate = {
  source: LandscapeReviewItemSource;
  reason: LandscapeReviewItemReason;
  proposedAction: LandscapeReviewItemProposedAction;
  priority: number;
  confidence: LandscapeReviewItemConfidence;
  idempotencyKey: string;
  knowledgeId: string | null;
  runId: string | null;
  triggerEventId: string | null;
  communityKey: string | null;
  communityLabel: string | null;
  suggestedAppliesTo: Record<string, unknown>;
  evidence: string[];
  payload: Record<string, unknown>;
  note?: string | null;
};

export type LandscapeReviewItemsMaterializeInput = {
  dryRun: boolean;
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  landscapeLimit: number;
  landscapeStatus: GraphStatusFilter;
  relationAxes: GraphRelationAxis[];
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  sources: LandscapeReviewItemSource[];
  materializeLimit: number;
};

export type LandscapeReviewItemsMaterializeResult = {
  dryRun: boolean;
  generatedAt: string;
  candidateCount: number;
  insertedCount: number;
  existingCount: number;
  skippedCount: number;
  items: LandscapeReviewItem[];
  candidates: LandscapeReviewItemCandidate[];
};

export type LandscapeReviewItemsListQuery = {
  status?: LandscapeReviewItemStatus | "all";
  source?: LandscapeReviewItemSource | "all";
  reason?: LandscapeReviewItemReason | "all";
  proposedAction?: LandscapeReviewItemProposedAction | "all";
  knowledgeId?: string;
  runId?: string;
  communityKey?: string;
  priorityMin?: number;
  limit?: number;
};

export type LandscapeReviewItemsListResponse = {
  items: LandscapeReviewItem[];
  count: number;
};

export type LandscapeContradictionOverlayItem = {
  reviewItemId: string;
  leftKnowledgeId: string;
  rightKnowledgeId: string;
  pairKey: string;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  status: LandscapeReviewItemStatus;
  evidence: string[];
  communityKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LandscapeContradictionOverlayList = {
  items: LandscapeContradictionOverlayItem[];
  count: number;
};

export type LandscapeReviewCandidateCreateInput = {
  ids?: string[];
  status?: "pending" | "reviewing";
  limit?: number;
  dryRun?: boolean;
};

export type LandscapeReviewCandidateCreateItem = {
  reviewItemId: string;
  reason: LandscapeReviewItemReason;
  proposedAction: LandscapeReviewItemProposedAction;
  candidateType: "rule" | "procedure";
  candidateKey: string;
  targetKey: string;
  targetStateId: string | null;
  findCandidateResultId: string | null;
  linkId: string | null;
  linkStatus: LandscapeReviewCandidateLinkStatus | null;
  draftLinked: boolean;
};

export type LandscapeReviewCandidateCreateResult = {
  dryRun: boolean;
  processedCount: number;
  createdCount: number;
  existingCount: number;
  missingIds: string[];
  items: LandscapeReviewCandidateCreateItem[];
};

export type LandscapeReviewCandidateLinkUpdateInput = {
  status: "approved" | "rejected";
  note?: string;
  actor?: string;
};

export type LandscapeReviewCandidateLinkUpdateResult = {
  link: {
    id: string;
    reviewItemId: string;
    targetStateId: string;
    findCandidateResultId: string;
    candidateKey: string;
    status: LandscapeReviewCandidateLinkStatus;
    approvalNote: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

export type SourceTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: string;
};

export type SourceFolderItem = {
  path: string;
};

export type SourceTreeResponse = {
  items: SourceTreeItem[];
  folders: SourceFolderItem[];
};

export type SourcePageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

export type SourceMutationResponse = {
  ok: true;
  slug?: string;
  path?: string;
  from?: string;
  commit: string | null;
  hash?: string;
  movedPages?: Array<{ from: string; to: string }>;
  deletedSlugs?: string[];
};

export type SourceHistoryItem = {
  commit: string;
  author: string;
  date: string;
  message: string;
};

export type SourceHealth = {
  app: string;
  version: string;
  git: {
    branch: string;
    commit: string;
  } | null;
};

export type SourceSearchItem = {
  slug: string;
  excerpt: string;
};

export type WebSourceQueueItem = {
  url: string;
  normalizedUrl: string;
  state: {
    id: string;
    status: string;
    priority: number;
    attemptCount: number;
    sourceKind: "web_ingest";
    sourceKey: string;
    sourceUri: string;
    distillationVersion: string;
    createdAt: string;
    updatedAt: string;
  };
  existing: boolean;
};

export type QueueWebSourceResult =
  | { ok: true; item: WebSourceQueueItem }
  | { ok: false; url: string; reason: string };

export type QueueWebSourcesBulkResponse = {
  ok: true;
  total: number;
  queued: number;
  invalid: number;
  duplicateInRequest: number;
  items: QueueWebSourceResult[];
};

export type QueueWebSourceUploadResponse = QueueWebSourcesBulkResponse & {
  file: {
    name: string;
    size: number;
    extractedUrls: number;
  };
};

export type AuditLogActor = "agent" | "user" | "system";

export type AuditLogItem = {
  id: string;
  eventType: string;
  actor: AuditLogActor | string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogsPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

export type AuditLogsResponse = {
  items: AuditLogItem[];
  availableEventTypes: string[];
  pagination: AuditLogsPagination;
};

export type SourceReindexResponse = {
  ok: true;
  indexed: number;
  removed: number;
};

export type CandidateOutcome =
  | "stored"
  | "ready_not_finalized"
  | "rejected"
  | "retryable"
  | "retained_failure"
  | "candidate_only"
  | "target_pending";

export type CandidateListSortBy =
  | "targetKey"
  | "candidateTitle"
  | "coverageStatus"
  | "knowledgeStatus"
  | "outcome"
  | "qualityScore"
  | "latestUpdatedAt";

export type CandidateListSortDir = "asc" | "desc";

export type CandidateDiffSummary = {
  titleChanged: boolean;
  bodyChanged: boolean;
  typeChanged: boolean;
  importanceDelta: number | null;
  confidenceDelta: number | null;
  bodySimilarity: number;
  summary: string[];
};

export type LandscapeReviewCandidateLinkStatus =
  | "draft_created"
  | "review_required"
  | "approved"
  | "rejected"
  | "finalized";

export type CandidateListItem = {
  id: string;
  targetStateId: string;
  candidateIndex: number;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  finalizeSourceUri: string;
  targetStatus: string;
  targetPhase: string;
  targetOutcomeKind: string | null;
  targetLastError: string | null;
  latestUpdatedAt: string;
  original: {
    title: string;
    body: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  cover: null | {
    status: string;
    stage: string;
    type: "rule" | "procedure" | null;
    title: string | null;
    body: string | null;
    importance: number | null;
    confidence: number | null;
    reason: string | null;
    referencesCount: number;
    duplicateRefsCount: number;
    toolEventsCount: number;
    updatedAt: string;
  };
  knowledge: null | {
    id: string;
    type: string;
    status: string;
    scope: string;
    title: string;
    body: string;
    importance: number | null;
    confidence: number | null;
    updatedAt: string;
  };
  outcome: CandidateOutcome;
  landscapeWarning: null | {
    source: "landscape_review_item";
    linkId: string | null;
    reviewItemId: string | null;
    reason: string | null;
    evidence: string[];
    linkStatus: LandscapeReviewCandidateLinkStatus | null;
    requiresManualApproval: boolean;
    warningReason: "promotion_gate_review" | "review_required";
  };
  diff: {
    originalToCover: CandidateDiffSummary | null;
    coverToKnowledge: CandidateDiffSummary | null;
    originalToKnowledge: CandidateDiffSummary | null;
  };
};

export type CandidateListStats = {
  total: number;
  stored: number;
  readyNotFinalized: number;
  rejected: number;
  retryable: number;
  retainedFailure: number;
  targetPending: number;
  candidateOnly: number;
};

export type CandidateListResponse = {
  items: CandidateListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  stats: CandidateListStats;
};

export type CandidateListRequest = {
  page?: number;
  limit?: number;
  query?: string;
  targetKind?: "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  outcome?: "all" | CandidateOutcome;
  hasKnowledge?: "all" | "yes" | "no";
  includeStored?: boolean;
  targetStateId?: string;
  sortBy?: CandidateListSortBy;
  sortDir?: CandidateListSortDir;
};

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

export type RuntimeSettingsRoute = {
  provider: RuntimeProviderSetting;
  model?: string;
  localLlmModel?: string;
  providerPoolId?: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
};

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
  provider: RuntimeProviderName;
  id: string;
  label: string;
  source: "route" | "provider_pool";
  model: string | null;
  endpoint: string | null;
  providerPoolId?: string;
  localLlmModelId?: string;
  deploymentSlot?: number;
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
    provider: "auto" | "daemon" | "cli" | "openai" | "disabled";
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

const ADMIN_API_KEY_STORAGE_KEY = "context_still_admin_api_key";
const LEGACY_ADMIN_API_KEY_STORAGE_KEY = "memory_router_admin_api_key";
const ADMIN_API_KEY_QUERY_PARAM_KEYS = ["admin_api_key", "adminApiKey", "x-admin-api-key"];
export const ADMIN_SESSION_INVALID_EVENT = "context-still:admin-session-invalid";
let adminSessionBootstrap: Promise<void> | null = null;

function normalizeAdminApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clearLegacyAdminCredentials(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ADMIN_API_KEY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_ADMIN_API_KEY_STORAGE_KEY);
  } catch {
    // Continue with URL cleanup even when browser storage is unavailable.
  }
  try {
    const currentUrl = new URL(window.location.href);
    let mutated = false;
    for (const key of ADMIN_API_KEY_QUERY_PARAM_KEYS) {
      if (!currentUrl.searchParams.has(key)) continue;
      currentUrl.searchParams.delete(key);
      mutated = true;
    }
    if (!mutated) return;
    const nextSearch = currentUrl.searchParams.toString();
    const nextRelativeUrl = `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ""}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, "", nextRelativeUrl);
  } catch {
    // Legacy credentials are never read even when URL cleanup is unavailable.
  }
}

function takeAdminApiKeyFromGlobal(): string | null {
  const runtime = globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: unknown };
  const globalKey = normalizeAdminApiKey(runtime.__MEMORY_ROUTER_ADMIN_API_KEY__);
  runtime.__MEMORY_ROUTER_ADMIN_API_KEY__ = undefined;
  return globalKey;
}

async function exchangeAdminApiKeyForSession(apiKey: string): Promise<void> {
  const response = await fetch("/api/admin-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) {
    throw new AdminApiError(`Admin session bootstrap failed: ${response.status}`, response.status);
  }
}

async function ensureAdminSession(): Promise<void> {
  clearLegacyAdminCredentials();
  const bootstrapKey = takeAdminApiKeyFromGlobal();
  if (bootstrapKey) {
    adminSessionBootstrap = exchangeAdminApiKeyForSession(bootstrapKey);
  }
  if (adminSessionBootstrap) {
    await adminSessionBootstrap;
  }
}

export type AdminSessionStatus = {
  configured: boolean;
  authenticated: boolean;
  configurationError: "admin_api_key_not_configured" | "admin_api_key_too_short" | null;
};

export async function createAdminSession(apiKey: string): Promise<void> {
  const normalized = normalizeAdminApiKey(apiKey);
  if (!normalized) throw new Error("Admin API key is required.");
  adminSessionBootstrap = exchangeAdminApiKeyForSession(normalized);
  await adminSessionBootstrap;
}

function buildRequestHeaders(options?: {
  includeJsonContentType?: boolean;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (options?.includeJsonContentType) {
    headers["content-type"] = "application/json";
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly payload: unknown = null,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

function parseErrorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseStringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

function parseResponseErrorPayload(payload: unknown): {
  message: string | null;
  code: string | null;
} {
  const record = parseErrorRecord(payload);
  if (!record) {
    return { message: null, code: null };
  }
  const nestedError = parseErrorRecord(record.error);
  const code = parseStringField(record, "code") ?? parseStringField(nestedError, "code");
  const message =
    typeof record.error === "string"
      ? record.error
      : (parseStringField(record, "message") ??
        parseStringField(record, "reason") ??
        parseStringField(nestedError, "message") ??
        parseStringField(nestedError, "reason"));
  return { message, code };
}

function notifyInvalidAdminSession(url: string, status: number): void {
  if (status !== 401 || url === "/api/admin-session" || typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(ADMIN_SESSION_INVALID_EVENT));
}

async function getJson<T>(url: string): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders();
  const response = headers ? await fetch(url, { headers }) : await fetch(url);
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const payload =
      typeof response.json === "function" ? await response.json().catch(() => null) : null;
    const parsed = parseResponseErrorPayload(payload);
    throw new AdminApiError(
      parsed.message ?? `${url} failed: ${response.status}`,
      response.status,
      parsed.code,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

function parseRequestErrorMessage(
  method: string,
  url: string,
  status: number,
  payload: unknown,
): string {
  if (typeof payload === "object" && payload !== null) {
    if ("outcome" in payload) return JSON.stringify(payload);
    if ("reason" in payload && typeof (payload as { reason?: unknown }).reason === "string") {
      return (payload as { reason: string }).reason;
    }
    if ("message" in payload && typeof (payload as { message?: unknown }).message === "string") {
      return (payload as { message: string }).message;
    }
    if ("error" in payload && typeof (payload as { error?: unknown }).error === "string") {
      return (payload as { error: string }).error;
    }
  }
  return `${method} ${url} failed: ${status}`;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders({ includeJsonContentType: body !== undefined });
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const message = await response
      .json()
      .then((payload) => parseRequestErrorMessage(method, url, response.status, payload))
      .catch(() => `${method} ${url} failed: ${response.status}`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function requestForm<T>(url: string, method: string, body: FormData): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders();
  const response = headers
    ? await fetch(url, {
        method,
        headers,
        body,
      })
    : await fetch(url, {
        method,
        body,
      });
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const message = await response
      .json()
      .then((payload) => parseRequestErrorMessage(method, url, response.status, payload))
      .catch(() => `${method} ${url} failed: ${response.status}`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchAdminSessionStatus(): Promise<AdminSessionStatus> {
  return getJson<AdminSessionStatus>("/api/admin-session");
}

export async function deleteAdminSession(): Promise<void> {
  await requestJson<{ ok: true }>("/api/admin-session", "DELETE");
  adminSessionBootstrap = null;
}

const encodeSlug = (slug: string): string =>
  slug
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export async function fetchKnowledgeItems(
  input: number | KnowledgeListRequest = 80,
): Promise<KnowledgeListResponse> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 80));
    params.set("page", String(input.page ?? 1));
    if (input.status) params.set("status", input.status);
    if (input.query) params.set("query", input.query);
    if (input.displayFilter) params.set("displayFilter", input.displayFilter);
    if (input.minQuality !== undefined) params.set("minQuality", String(input.minQuality));
    if (input.sortBy) params.set("sortBy", input.sortBy);
    if (input.sortDir) params.set("sortDir", input.sortDir);
    if (input.polarities && input.polarities.length > 0)
      params.set("polarities", input.polarities.join(","));
    if (input.intentTags && input.intentTags.length > 0)
      params.set("intentTags", input.intentTags.join(","));
  }
  const json = await getJson<KnowledgeListResponse>(`/api/knowledge?${params.toString()}`);
  return json;
}

export async function createKnowledgeItem(input: KnowledgeWriteInput): Promise<void> {
  await requestJson("/api/knowledge", "POST", input);
}

export async function updateKnowledgeItem(id: string, input: KnowledgeUpdateInput): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "PUT", input);
}

export async function deleteKnowledgeItem(id: string): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "DELETE");
}

export async function bulkUpdateKnowledgeStatus(
  input: KnowledgeBulkStatusRequest,
): Promise<KnowledgeBulkStatusResponse> {
  return requestJson<KnowledgeBulkStatusResponse>("/api/knowledge/bulk-status", "POST", input);
}

export async function sendKnowledgeFeedback(
  id: string,
  input: { direction: "up" | "down"; reason?: string },
): Promise<KnowledgeFeedback> {
  const json = await requestJson<{ feedback: KnowledgeFeedback }>(
    `/api/knowledge/${id}/feedback`,
    "POST",
    input,
  );
  return json.feedback;
}

export async function fetchVibeMemories(limit = 120): Promise<VibeMemory[]> {
  const json = await getJson<{ memories: VibeMemory[] }>(`/api/vibe-memory?limit=${limit}`);
  return json.memories;
}

export async function deleteVibeMemory(id: string): Promise<void> {
  await requestJson(`/api/vibe-memory/${id}`, "DELETE");
}

export async function fetchAgentDiffEntries(
  limit = 120,
  params?: { id?: string; vibeMemoryId?: string; vibeMemoryIds?: string[] },
): Promise<AgentDiffEntry[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (params?.id) query.set("id", params.id);
  if (params?.vibeMemoryId) query.set("vibeMemoryId", params.vibeMemoryId);
  if (params?.vibeMemoryIds?.length) query.set("vibeMemoryIds", params.vibeMemoryIds.join(","));
  const json = await getJson<{ entries: AgentDiffEntry[] }>(`/api/agent-diffs?${query}`);
  return json.entries;
}

export async function fetchEpisodes(input: EpisodeListRequest = {}): Promise<EpisodeCard[]> {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit ?? 50));
  if (input.query?.trim()) query.set("q", input.query.trim());
  if (input.status) query.set("status", input.status);
  if (input.technologies?.length) query.set("technologies", input.technologies.join(","));
  if (input.changeTypes?.length) query.set("changeTypes", input.changeTypes.join(","));
  if (input.domains?.length) query.set("domains", input.domains.join(","));
  if (input.tools?.length) query.set("tools", input.tools.join(","));
  const json = await getJson<{ items: EpisodeCard[] }>(`/api/episodes?${query}`);
  return json.items;
}

export async function fetchEpisode(id: string): Promise<EpisodeCard> {
  const json = await getJson<{ episode: EpisodeCard }>(`/api/episodes/${encodeURIComponent(id)}`);
  return json.episode;
}

export async function createEpisode(input: EpisodeCardCreateInput): Promise<EpisodeCard> {
  const json = await requestJson<{ episode: EpisodeCard }>("/api/episodes", "POST", input);
  return json.episode;
}

export async function fetchDoctorReport(): Promise<DoctorReport> {
  return getJson<DoctorReport>("/api/doctor");
}

export async function fetchDoctorCoreInfrastructureDomain(): Promise<DoctorCoreInfrastructureDomain> {
  return getJson<DoctorCoreInfrastructureDomain>("/api/doctor/domains/core-infrastructure");
}

export async function fetchDoctorAiServiceToolsDomain(): Promise<DoctorAiServiceToolsDomain> {
  return getJson<DoctorAiServiceToolsDomain>("/api/doctor/domains/ai-service-tools");
}

export async function fetchDoctorPipelineAutomationDomain(): Promise<DoctorPipelineAutomationDomain> {
  return getJson<DoctorPipelineAutomationDomain>("/api/doctor/domains/pipeline-automation");
}

function withTimezoneQuery(path: string, timezone?: string): string {
  if (!timezone) return path;
  const params = new URLSearchParams({ timezone });
  return `${path}?${params.toString()}`;
}

export async function fetchOverviewDashboard(timezone?: string): Promise<OverviewDashboard> {
  return getJson<OverviewDashboard>(withTimezoneQuery("/api/overview", timezone));
}

export async function fetchOverviewKnowledgeAssetsDomain(
  timezone?: string,
): Promise<OverviewKnowledgeAssetsDomain> {
  return getJson<OverviewKnowledgeAssetsDomain>(
    withTimezoneQuery("/api/overview/domains/knowledge-assets", timezone),
  );
}

export async function fetchOverviewLandscapeHealthDomain(
  timezone?: string,
): Promise<OverviewLandscapeHealthDomain> {
  return getJson<OverviewLandscapeHealthDomain>(
    withTimezoneQuery("/api/overview/domains/landscape-health", timezone),
  );
}

export async function fetchOverviewSystemQualityDomain(
  timezone?: string,
): Promise<OverviewSystemQualityDomain> {
  return getJson<OverviewSystemQualityDomain>(
    withTimezoneQuery("/api/overview/domains/system-quality", timezone),
  );
}

export async function fetchOverviewLlmResourcesDomain(
  timezone?: string,
): Promise<OverviewLlmResourcesDomain> {
  return getJson<OverviewLlmResourcesDomain>(
    withTimezoneQuery("/api/overview/domains/llm-resources", timezone),
  );
}

export async function fetchGraphSnapshot(
  input:
    | number
    | {
        limit?: number;
        status?: GraphStatusFilter;
        view?: GraphViewMode;
        communityDisplay?: GraphCommunityDisplayMode;
        relationAxes?: GraphRelationAxis[];
        minSimilarity?: number;
        semanticTopK?: number;
        maxContextEdgesPerNode?: number;
        sourceNodeLimit?: number;
      } = 1000,
): Promise<GraphSnapshot> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 1000));
    if (input.status) params.set("status", input.status);
    if (input.view) params.set("view", input.view);
    if (input.communityDisplay) params.set("communityDisplay", input.communityDisplay);
    if (input.relationAxes && input.relationAxes.length > 0) {
      params.set("relationAxes", input.relationAxes.join(","));
    }
    if (input.minSimilarity !== undefined) {
      params.set("minSimilarity", String(input.minSimilarity));
    }
    if (input.semanticTopK !== undefined) {
      params.set("semanticTopK", String(input.semanticTopK));
    }
    if (input.maxContextEdgesPerNode !== undefined) {
      params.set("maxContextEdgesPerNode", String(input.maxContextEdgesPerNode));
    }
    if (input.sourceNodeLimit !== undefined) {
      params.set("sourceNodeLimit", String(input.sourceNodeLimit));
    }
  }
  return getJson<GraphSnapshot>(`/api/graph?${params}`);
}

export async function fetchLandscapeSnapshot(input?: {
  windowDays?: number;
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
  minSelectedCount?: number;
  minFeedbackCount?: number;
}): Promise<LandscapeSnapshot> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 1000));
  params.set("status", input?.status ?? "active");
  params.set("format", "full");
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.minSelectedCount !== undefined) {
    params.set("minSelectedCount", String(input.minSelectedCount));
  }
  if (input?.minFeedbackCount !== undefined) {
    params.set("minFeedbackCount", String(input.minFeedbackCount));
  }
  return getJson<LandscapeSnapshot>(`/api/graph/landscape?${params.toString()}`);
}

export async function fetchLandscapeSnapshotCacheStatus(): Promise<LandscapeSnapshotCacheStatus> {
  return getJson<LandscapeSnapshotCacheStatus>("/api/graph/landscape/cache-status");
}

export async function fetchDeadZoneKnowledgeReview(input?: {
  windowDays?: number;
  limit?: number;
  page?: number;
  status?: GraphStatusFilter;
  reason?: DeadZoneKnowledgeReviewReason;
  minSimilarity?: number;
  similarTopK?: number;
  relationAxes?: GraphRelationAxis[];
  communityKey?: string;
  badge?: DeadZoneKnowledgeReviewBadge | "all";
  sortBy?: DeadZoneKnowledgeReviewSortBy;
  sortDir?: "asc" | "desc";
}): Promise<DeadZoneKnowledgeReviewResponse> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 50));
  params.set("page", String(input?.page ?? 1));
  params.set("status", input?.status ?? "active");
  params.set("reason", input?.reason ?? "all");
  params.set("minSimilarity", String(input?.minSimilarity ?? 0.9));
  params.set("similarTopK", String(input?.similarTopK ?? 5));
  params.set("badge", input?.badge ?? "all");
  params.set("sortBy", input?.sortBy ?? "deadZoneScore");
  params.set("sortDir", input?.sortDir ?? "desc");
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.communityKey) params.set("communityKey", input.communityKey);
  return getJson<DeadZoneKnowledgeReviewResponse>(
    `/api/graph/landscape/dead-zone-knowledge?${params.toString()}`,
  );
}

export async function maintainDeadZoneKnowledge(input: {
  action: DeadZoneKnowledgeMaintenanceAction;
  deadZoneKnowledgeId: string;
  similarKnowledgeId?: string;
}): Promise<DeadZoneKnowledgeMaintenanceResult> {
  return requestJson<DeadZoneKnowledgeMaintenanceResult>(
    "/api/graph/landscape/dead-zone-knowledge/maintenance",
    "POST",
    input,
  );
}

export async function applyDeadZoneKnowledgeReviewAction(input: {
  action: DeadZoneRecommendationAction;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId?: string;
  reviewItemId?: string;
  note?: string;
}): Promise<DeadZoneKnowledgeReviewActionResult> {
  return requestJson<DeadZoneKnowledgeReviewActionResult>(
    "/api/graph/landscape/dead-zone-knowledge/actions",
    "POST",
    input,
  );
}

export async function requestDeadZoneMergeReviewJob(input: {
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId?: string;
  note?: string;
}): Promise<DeadZoneMergeReviewJob> {
  return requestJson<DeadZoneMergeReviewJob>(
    "/api/graph/landscape/dead-zone-knowledge/merge-review-jobs",
    "POST",
    input,
  );
}

export async function applyDeadZoneMergeReviewJob(jobId: string): Promise<{
  status: "applied";
  jobId: string;
  keptKnowledgeId: string;
  deprecatedKnowledgeId: string;
  reviewItemId: string | null;
}> {
  return requestJson(
    `/api/graph/landscape/dead-zone-knowledge/merge-review-jobs/${jobId}/apply`,
    "POST",
  );
}

export async function sendDeadZoneMergeReviewToFinalize(jobId: string): Promise<{
  id: string;
  status: string;
  jobType: "merge_activation_finalize";
  mergeReviewJobId: string;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId: string | null;
}> {
  return requestJson(
    `/api/graph/landscape/dead-zone-knowledge/merge-review-jobs/${jobId}/finalize`,
    "POST",
  );
}

export async function fetchLandscapeReplaySnapshot(input?: {
  windowDays?: number;
  limit?: number;
  landscapeLimit?: number;
  runStatus?: LandscapeRunStatusFilter;
  landscapeStatus?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
  minSelectedCount?: number;
  minFeedbackCount?: number;
  minSimilarity?: number;
  semanticTopK?: number;
  includeRuns?: boolean;
}): Promise<LandscapeReplaySnapshot> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 500));
  params.set("landscapeLimit", String(input?.landscapeLimit ?? 1000));
  params.set("runStatus", input?.runStatus ?? "all");
  params.set("landscapeStatus", input?.landscapeStatus ?? "active");
  params.set("format", "full");
  params.set("includeRuns", String(input?.includeRuns ?? false));
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.minSelectedCount !== undefined) {
    params.set("minSelectedCount", String(input.minSelectedCount));
  }
  if (input?.minFeedbackCount !== undefined) {
    params.set("minFeedbackCount", String(input.minFeedbackCount));
  }
  if (input?.minSimilarity !== undefined) {
    params.set("minSimilarity", String(input.minSimilarity));
  }
  if (input?.semanticTopK !== undefined) {
    params.set("semanticTopK", String(input.semanticTopK));
  }
  return getJson<LandscapeReplaySnapshot>(`/api/graph/landscape/replay?${params.toString()}`);
}

export async function fetchLandscapeReplayComparison(input?: {
  windowDays?: number;
  limit?: number;
  runStatus?: LandscapeRunStatusFilter;
  currentLimit?: number;
  includeRuns?: boolean;
}): Promise<LandscapeReplayComparisonResponse> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 100));
  params.set("runStatus", input?.runStatus ?? "all");
  params.set("currentLimit", String(input?.currentLimit ?? 12));
  params.set("includeRuns", String(input?.includeRuns ?? true));
  params.set("format", "full");
  return getJson<LandscapeReplayComparisonResponse>(
    `/api/graph/landscape/replay/compare?${params.toString()}`,
  );
}

export async function fetchLandscapeTrajectory(input: {
  runId: string;
  includeCandidates?: boolean;
  limit?: number;
}): Promise<LandscapeTrajectoryResult | null> {
  const params = new URLSearchParams();
  params.set("includeCandidates", String(input.includeCandidates ?? true));
  params.set("limit", String(input.limit ?? 200));
  try {
    return await getJson<LandscapeTrajectoryResult>(
      `/api/graph/landscape/trajectory/${encodeURIComponent(input.runId)}?${params.toString()}`,
    );
  } catch {
    return null;
  }
}

export async function materializeLandscapeReviewItems(
  input: LandscapeReviewItemsMaterializeInput,
): Promise<LandscapeReviewItemsMaterializeResult> {
  const json = await requestJson<{ result: LandscapeReviewItemsMaterializeResult }>(
    "/api/graph/landscape/replay/queue",
    "POST",
    input,
  );
  return json.result;
}

export async function fetchLandscapeReviewItems(
  input?: LandscapeReviewItemsListQuery,
): Promise<LandscapeReviewItemsListResponse> {
  const params = new URLSearchParams();
  params.set("status", input?.status ?? "pending");
  params.set("source", input?.source ?? "all");
  params.set("reason", input?.reason ?? "all");
  params.set("proposedAction", input?.proposedAction ?? "all");
  params.set("priorityMin", String(input?.priorityMin ?? 0));
  params.set("limit", String(input?.limit ?? 50));
  if (input?.knowledgeId) params.set("knowledgeId", input.knowledgeId);
  if (input?.runId) params.set("runId", input.runId);
  if (input?.communityKey) params.set("communityKey", input.communityKey);
  return getJson<LandscapeReviewItemsListResponse>(
    `/api/graph/landscape/review-items?${params.toString()}`,
  );
}

export async function fetchLandscapeContradictionOverlay(input?: {
  status?: LandscapeReviewItemStatus | "all";
  confidenceMin?: number;
  limit?: number;
}): Promise<LandscapeContradictionOverlayList> {
  const params = new URLSearchParams();
  params.set("status", input?.status ?? "pending");
  params.set("confidenceMin", String(input?.confidenceMin ?? 0.62));
  params.set("limit", String(input?.limit ?? 80));
  return getJson<LandscapeContradictionOverlayList>(
    `/api/graph/landscape/contradictions?${params.toString()}`,
  );
}

export async function updateLandscapeReviewItemStatus(
  id: string,
  input: { status: LandscapeReviewItemStatus; note?: string },
): Promise<LandscapeReviewItem> {
  const json = await requestJson<{ item: LandscapeReviewItem }>(
    `/api/graph/landscape/review-items/${encodeURIComponent(id)}`,
    "PATCH",
    input,
  );
  return json.item;
}

export async function createLandscapeReviewCandidates(
  input: LandscapeReviewCandidateCreateInput,
): Promise<LandscapeReviewCandidateCreateResult> {
  const json = await requestJson<{ result: LandscapeReviewCandidateCreateResult }>(
    "/api/graph/landscape/review-items/candidates",
    "POST",
    input,
  );
  return json.result;
}

export async function updateLandscapeReviewCandidateLink(
  reviewItemId: string,
  linkId: string,
  input: LandscapeReviewCandidateLinkUpdateInput,
): Promise<LandscapeReviewCandidateLinkUpdateResult> {
  return requestJson<LandscapeReviewCandidateLinkUpdateResult>(
    `/api/graph/landscape/review-items/${encodeURIComponent(reviewItemId)}/candidate-links/${encodeURIComponent(linkId)}`,
    "PATCH",
    input,
  );
}

export async function fetchGraphCommunityLabels(input?: {
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
}): Promise<GraphCommunityLabel[]> {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  if (input?.status) params.set("status", input.status);
  if (input?.relationAxes?.length) params.set("relationAxes", input.relationAxes.join(","));
  const query = params.toString();
  const path = query ? `/api/graph/community-labels?${query}` : "/api/graph/community-labels";
  const json = await getJson<{ labels: GraphCommunityLabel[] }>(path);
  return json.labels;
}

export async function updateGraphCommunityLabel(input: {
  communityKey: string;
  label: string;
  note?: string;
}): Promise<{
  communityKey: string;
  label: string;
  note: string | null;
  updatedAt: string;
}> {
  const payload = {
    label: input.label,
    note: input.note ?? "",
  };
  const json = await requestJson<{
    label: {
      communityKey: string;
      label: string;
      note: string | null;
      updatedAt: string;
    };
  }>(`/api/graph/community-labels/${encodeURIComponent(input.communityKey)}`, "PUT", payload);
  return json.label;
}

export async function fetchGraphNodeDetail(rawId: string): Promise<GraphNodeDetail | null> {
  try {
    return await getJson<GraphNodeDetail>(`/api/graph/nodes/${encodeURIComponent(rawId)}`);
  } catch {
    return null;
  }
}

export async function fetchSourceTree(): Promise<SourceTreeResponse> {
  return getJson<SourceTreeResponse>("/api/sources/tree");
}

export async function fetchSourceHealth(): Promise<SourceHealth> {
  return getJson<SourceHealth>("/api/sources/health");
}

export async function fetchSourcePage(slug: string): Promise<SourcePageDocument> {
  return getJson<SourcePageDocument>(`/api/sources/pages/${encodeSlug(slug)}`);
}

export async function createSourcePage(input: {
  slug: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/pages", "POST", input);
}

export async function updateSourcePage(
  slug: string,
  input: {
    slug?: string;
    title?: string;
    body: string;
    meta?: Record<string, unknown>;
    commitMessage?: string;
  },
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(
    `/api/sources/pages/${encodeSlug(slug)}`,
    "PUT",
    input,
  );
}

export async function deleteSourcePage(slug: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/pages/${encodeSlug(slug)}`, "DELETE");
}

export async function createSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/folders", "POST", { path });
}

export async function renameSourceFolder(
  path: string,
  nextPath: string,
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "PUT", {
    path: nextPath,
  });
}

export async function deleteSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "DELETE");
}

export async function fetchSourceHistory(slug: string): Promise<SourceHistoryItem[]> {
  const json = await getJson<{ slug: string; items: SourceHistoryItem[] }>(
    `/api/sources/history/${encodeSlug(slug)}`,
  );
  return json.items;
}

export async function fetchSourceDiff(slug: string, from: string, to: string): Promise<string> {
  const json = await getJson<{ diff: string }>(
    `/api/sources/diff/${encodeSlug(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return json.diff;
}

export async function searchSourcePages(query: string): Promise<SourceSearchItem[]> {
  const encoded = encodeURIComponent(query.trim());
  const json = await getJson<{ items: SourceSearchItem[] }>(`/api/sources/search?q=${encoded}`);
  return json.items;
}

export async function runSourceReindex(): Promise<SourceReindexResponse> {
  return requestJson<SourceReindexResponse>("/api/sources/reindex", "POST");
}

export async function queueWebSourceUrl(input: {
  url: string;
  distillationVersion?: string;
}): Promise<{ ok: true; item: WebSourceQueueItem }> {
  return requestJson<{ ok: true; item: WebSourceQueueItem }>("/api/sources/web", "POST", input);
}

export async function queueWebSourceUrlsBulk(input: {
  urls: string[];
  distillationVersion?: string;
}): Promise<QueueWebSourcesBulkResponse> {
  return requestJson<QueueWebSourcesBulkResponse>("/api/sources/web/bulk", "POST", input);
}

export async function queueWebSourceUrlsUpload(input: {
  file: File;
  distillationVersion?: string;
}): Promise<QueueWebSourceUploadResponse> {
  const formData = new FormData();
  formData.set("file", input.file);
  if (input.distillationVersion?.trim()) {
    formData.set("distillationVersion", input.distillationVersion.trim());
  }
  return requestForm<QueueWebSourceUploadResponse>("/api/sources/web/upload", "POST", formData);
}

export async function fetchAuditLogs(input?: {
  page?: number;
  limit?: number;
  eventType?: string;
  actor?: AuditLogActor | "all";
}): Promise<AuditLogsResponse> {
  const query = new URLSearchParams();
  if (input?.page !== undefined) query.set("page", String(input.page));
  if (input?.limit !== undefined) query.set("limit", String(input.limit));
  if (input?.eventType) query.set("eventType", input.eventType);
  if (input?.actor && input.actor !== "all") query.set("actor", input.actor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson<AuditLogsResponse>(`/api/audit-logs${suffix}`);
}

export async function fetchCandidateItems(
  input: CandidateListRequest = {},
): Promise<CandidateListResponse> {
  const query = new URLSearchParams();
  query.set("page", String(input.page ?? 1));
  query.set("limit", String(input.limit ?? 50));
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.targetKind && input.targetKind !== "all") query.set("targetKind", input.targetKind);
  if (input.outcome && input.outcome !== "all") query.set("outcome", input.outcome);
  if (input.hasKnowledge && input.hasKnowledge !== "all") {
    query.set("hasKnowledge", input.hasKnowledge);
  }
  if (input.includeStored) query.set("includeStored", "true");
  if (input.targetStateId?.trim()) query.set("targetStateId", input.targetStateId.trim());
  if (input.sortBy) query.set("sortBy", input.sortBy);
  if (input.sortDir) query.set("sortDir", input.sortDir);
  return getJson<CandidateListResponse>(`/api/candidates?${query.toString()}`);
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettingsSnapshotResponse> {
  return getJson<RuntimeSettingsSnapshotResponse>("/api/settings");
}

export async function updateRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<RuntimeSettingsUpdateResponse> {
  return requestJson<RuntimeSettingsUpdateResponse>("/api/settings", "PUT", input);
}

export async function testRuntimeProvider(
  provider: RuntimeProviderName,
): Promise<RuntimeProviderHealthResponse> {
  return requestJson<RuntimeProviderHealthResponse>(
    `/api/settings/providers/${provider}/test`,
    "POST",
  );
}

export async function testAzureOpenAiDeployment(
  deploymentIndex: number,
): Promise<RuntimeAzureOpenAiDeploymentHealthResponse> {
  const deployment = deploymentIndex + 1;
  return requestJson<RuntimeAzureOpenAiDeploymentHealthResponse>(
    `/api/settings/providers/azure-openai/deployments/${deployment}/test`,
    "POST",
  );
}

export async function testLocalLlmModel(
  model: string,
): Promise<RuntimeLocalLlmModelHealthResponse> {
  return requestJson<RuntimeLocalLlmModelHealthResponse>(
    "/api/settings/providers/local-llm/models/test",
    "POST",
    { model },
  );
}

export async function reloadRuntimeSettingsCache(): Promise<RuntimeSettingsReloadResponse> {
  return requestJson<RuntimeSettingsReloadResponse>("/api/settings/reload-runtime-cache", "POST");
}

export type CodexAuthTokenInfo = {
  authMode: string;
  email: string | null;
  expiresAt: string | null;
  isExpired: boolean;
};

export type CodexAuthStatus = {
  codexHome: string;
  cliAvailable: boolean;
  authJsonExists: boolean;
  accessTokenConfigured: boolean;
  /** Detailed token information parsed from auth.json */
  tokenInfo: CodexAuthTokenInfo | null;
  recommendedAction: "ready" | "run-codex-login" | "set-codex-access-token" | "install-codex-cli";
};

export type CodexLoginCommandResponse = {
  command: string;
};

export async function fetchCodexAuthStatus(): Promise<CodexAuthStatus> {
  return getJson<CodexAuthStatus>("/api/settings/providers/codex/auth/status");
}

export async function fetchCodexLoginCommand(): Promise<CodexLoginCommandResponse> {
  return requestJson<CodexLoginCommandResponse>(
    "/api/settings/providers/codex/auth/login-command",
    "POST",
  );
}

export type DistillationTargetState = {
  id: string;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  distillationVersion: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed" | "paused";
  phase:
    | "selected"
    | "reading"
    | "researching_source"
    | "writing_source"
    | "finding_candidate"
    | "covering_evidence"
    | "finalizing"
    | "stored";
  priorityGroup: string;
  sortKey: string;
  attemptCount: number;
  lockedBy: string | null;
  activeModel?: string | null;
  activeProvider?: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  candidateCount: number;
  knowledgeIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DistillationQueueName =
  | "findingCandidate"
  | "episodeDistiller"
  | "coveringEvidence"
  | "deadZoneMergeReview"
  | "finalizeDistille"
  | "mergeActivationFinalize";
export type VisibleDistillationQueueName = Exclude<
  DistillationQueueName,
  "mergeActivationFinalize"
>;
export type DistillationQueueStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export type QueueDashboardStatsV2 = {
  queueControls: Record<
    VisibleDistillationQueueName,
    {
      paused: boolean;
      updatedAt: string | null;
      updatedBy: string | null;
      reason: string | null;
    }
  >;
  queues: Record<
    VisibleDistillationQueueName,
    {
      counters: Record<DistillationQueueStatus, number>;
      oldestPendingAt: string | null;
      running: number;
      failed: number;
      offline: number;
      nonRegistered: number;
    }
  >;
  totals: {
    counters: Record<DistillationQueueStatus, number>;
    oldestPendingAt: string | null;
    running: number;
    failed: number;
    offline: number;
    nonRegistered: number;
  };
};

export type QueueListItemV2 = {
  queueName: DistillationQueueName;
  visibleQueueName: DistillationQueueName;
  jobType?: "candidate_finalize" | "merge_activation_finalize";
  backendKind:
    | "finding_candidate_queue"
    | "episode_distiller_queue"
    | "covering_evidence_queue"
    | "dead_zone_merge_review_queue"
    | "finalize_distille_queue"
    | "merge_activation_finalize_queue";
  id: string;
  status: DistillationQueueStatus;
  priority: number;
  attemptCount: number;
  subjectTitle: string;
  subjectDetail: string;
  provider: string | null;
  model: string | null;
  activeProviderPoolId?: string | null;
  activeProviderTargetId?: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  nextRunAt: string | null;
  metadataSummary: string | null;
};

export type QueueListResponseV2 = {
  queue: DistillationQueueName;
  items: QueueListItemV2[];
  total: number;
  page: number;
  limit: number;
};

export async function fetchQueueDashboardStatsV2(): Promise<QueueDashboardStatsV2> {
  return getJson<QueueDashboardStatsV2>("/api/queue/stats");
}

export async function fetchActiveQueueTasksV2(): Promise<QueueListItemV2[]> {
  return getJson<QueueListItemV2[]>("/api/queue/active");
}

export async function fetchQueueItemsV2(input: {
  page: number;
  limit: number;
  queue: DistillationQueueName;
  query?: string;
  status?: DistillationQueueStatus | "all";
  sortBy?: string;
  sortDir?: "asc" | "desc";
}): Promise<QueueListResponseV2> {
  const query = new URLSearchParams();
  query.set("page", String(input.page));
  query.set("limit", String(input.limit));
  query.set("queue", input.queue);
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.status) query.set("status", input.status);
  if (input.sortBy) query.set("sortBy", input.sortBy);
  if (input.sortDir) query.set("sortDir", input.sortDir);
  return getJson<QueueListResponseV2>(`/api/queue?${query.toString()}`);
}

export async function pauseQueueJobV2(
  queue: DistillationQueueName,
  id: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/pause`,
    "POST",
    {
      reason,
    },
  );
}

export async function pauseQueueLaneV2(
  queue: DistillationQueueName,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/queue/${encodeURIComponent(queue)}/pause`, "POST", {
    reason,
  });
}

export async function resumeQueueLaneV2(
  queue: DistillationQueueName,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/queue/${encodeURIComponent(queue)}/resume`, "POST", {
    reason,
  });
}

export async function resumeQueueJobV2(
  queue: DistillationQueueName,
  id: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/resume`,
    "POST",
  );
}

export async function retryQueueJobV2(input: {
  queue: DistillationQueueName;
  id: string;
  mode?: "default" | "cloud_api";
  forceRefreshEvidence?: boolean;
  reason?: string;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(input.queue)}/${encodeURIComponent(input.id)}/retry`,
    "POST",
    {
      mode: input.mode ?? "default",
      forceRefreshEvidence: input.forceRefreshEvidence ?? true,
      reason: input.reason,
    },
  );
}
