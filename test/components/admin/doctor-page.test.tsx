import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorPage } from "../../../web/src/modules/admin/components/doctor.page";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

const queryClient = new QueryClient();

const baseReport = {
  status: "degraded",
  checkedAt: "2026-05-21T13:26:44.509Z",
  totalDurationMs: 120,
  summary: {
    blocking: 2,
    degraded: 2,
    maintenance: 1,
    skipped: 0,
  },
  reasons: [
    "KNOWLEDGE_ZERO_USE_HIGH",
    "VIBE_DISTILLATION_NEVER_RAN",
    "VIBE_DISTILLATION_PIPELINE_LOCK_STALE",
    "SOURCE_DISTILLATION_PIPELINE_LOCK_STALE",
    "ANTIGRAVITY_LOGS_SYNC_STALE",
  ],
  skippedChecks: [],
  db: { reachable: true, durationMs: 1, responseMs: 0.8, queryMs: 26, totalInspectionMs: 80 },
  vector: { installed: true, healthMs: 53, source: "rust" },
  embedding: {
    configured: true,
    provider: "daemon",
    effectiveMode: "daemon",
    daemon: {
      url: "http://127.0.0.1:44512",
      reachable: true,
      status: "external_ready",
      managedBy: "external",
    },
  },
  agenticLlm: {
    providerSetting: "azure-openai",
    selectedProvider: "azure-openai",
    fallbackOrder: ["azure-openai"],
    provider: "azure-openai",
    configured: true,
    reachable: true,
    model: "gpt-5-4-mini",
    endpoint: "https://example.openai.azure.com",
    providerHealth: [
      {
        id: "azure-openai:1",
        label: "Azure OpenAI #1",
        provider: "azure-openai",
        configured: true,
        reachable: true,
        model: "gpt-5-4-mini",
        endpoint: "https://example.openai.azure.com",
        deploymentIndex: 1,
        selected: true,
        routeOrder: 0,
      },
      {
        id: "azure-openai:2",
        label: "Azure OpenAI #2",
        provider: "azure-openai",
        configured: true,
        reachable: false,
        model: "gpt-5-4-mini",
        endpoint: "https://second.openai.azure.com",
        deploymentIndex: 2,
        error: "DeploymentNotFound",
        selected: true,
        routeOrder: 0,
      },
      {
        id: "local-llm",
        label: "Local LLM",
        provider: "local-llm",
        configured: true,
        reachable: true,
        model: "gemma4",
        endpoint: "http://127.0.0.1:11434",
        selected: false,
        routeOrder: 1,
        localLlmSmokes: [
          { name: "simple_chat", ok: true, preview: "OK" },
          { name: "json_only", ok: true, preview: '{"ok":true}' },
          { name: "tool_result_history", ok: true, preview: '{"fact":"queue_events_checked"}' },
        ],
      },
      {
        id: "local-llm:2",
        label: "Local LLM: Gemma",
        provider: "local-llm",
        configured: true,
        reachable: false,
        model: "gemma4",
        endpoint: "http://127.0.0.1:11435",
        error: "unreachable",
        selected: false,
        routeOrder: 1,
      },
    ],
  },
  tables: {
    expected: ["knowledge_items", "sources"],
    existing: ["knowledge_items", "sources"],
    missing: [],
  },
  runs: {
    windowSize: 20,
    totalRuns: 20,
    degradedRuns: 15,
    degradedRate: 0.75,
    blockingRuns: 4,
    blockingRate: 0.2,
    usableRuns: 16,
    usableRate: 0.8,
    warningOnlyRuns: 15,
    warningOnlyRate: 0.75,
    noContentRuns: 3,
    noContentRate: 0.15,
    durationMsP50: 1982,
    durationMsP95: 6871.1,
    durationMsAvg: 3094.9,
    durationSamples: [
      {
        runId: "550e8400-e29b-41d4-a716-446655440011",
        label: "#1",
        durationMs: 1982,
        status: "ok",
        createdAt: "2026-05-21T13:20:54.789Z",
      },
      {
        runId: "550e8400-e29b-41d4-a716-446655440012",
        label: "#2",
        durationMs: 6871,
        status: "degraded",
        createdAt: "2026-05-21T13:25:54.789Z",
      },
    ],
    lastRunAt: "2026-05-21T13:25:54.789Z",
    lastRunAgeMinutes: 1,
    freshnessThresholdMinutes: 720,
    degradedRateThreshold: 0.5,
  },
  hitl: {
    draftCount: 39,
    oldestDraftAt: "2026-05-20T23:17:04.355Z",
    oldestDraftAgeMinutes: 850,
    backlogThresholdCount: 50,
    backlogThresholdAgeMinutes: 4320,
  },
  knowledgeLifecycle: {
    activeCount: 671,
    zeroUseActiveCount: 658,
    staleByDecayCount: 7,
    staleProcedureCount: 0,
    dynamicScoreAvg: 0.4,
    dynamicScoreP95: 0,
    lastCompiledAt: "2026-05-20T17:26:48.523Z",
    lastCompiledAgeMinutes: 1200,
    thresholds: {
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    },
  },
  mcp: {
    exposedTools: ["doctor"],
    requiredPrimaryTools: ["context_compile", "compile_eval"],
    missingPrimaryTools: [],
    staleKnowledgeCount: 4,
    staleSourceCount: 40,
    nextActions: ["stale source を再importまたは更新する（count: 40）"],
  },
  agentLogSync: {
    codex: {
      sessionDir: "/Users/y.noguchi/.codex/sessions",
      sessionDirExists: true,
      archivedSessionDir: "/Users/y.noguchi/.codex/archived_sessions",
      archivedSessionDirExists: true,
    },
    antigravity: {
      logDir: "/Users/y.noguchi/.gemini/antigravity/brain",
      configured: true,
      exists: true,
    },
    states: [
      {
        id: "codex_logs",
        lastSyncedAt: "2026-05-21T08:31:04.936Z",
        lastSyncedAgeMinutes: 295,
        cursorFiles: 385,
        skipped: false,
        warnings: [],
      },
      {
        id: "antigravity_logs",
        lastSyncedAt: "2026-05-19T09:44:11.413Z",
        lastSyncedAgeMinutes: 3102,
        cursorFiles: 121,
        skipped: false,
        warnings: [],
      },
    ],
    launchAgent: {
      label: "com.memory-router.agent-log-sync",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.agent-log-sync.plist",
      installed: true,
      loaded: true,
      state: "not running",
    },
    nextActions: [],
  },
  vibeDistillation: {
    launchAgent: {
      label: "com.memory-router.queue-supervisor",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.queue-supervisor.plist",
      installed: true,
      loaded: true,
      state: "running",
    },
    runs: {
      totalRuns: 0,
      okRuns: 0,
      skippedRuns: 0,
      outcomeKindCounts: [],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
      lastOkRunAt: null,
      lastOkRunAgeMinutes: null,
    },
    jobs: {
      queued: 1150,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 1150,
      running: 0,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: true,
      oldestQueuedAt: "2026-05-21T07:49:40.165Z",
      oldestQueuedAgeMinutes: 337,
      oldestRunningAt: null,
      oldestRunningAgeMinutes: null,
      lock: {
        path: "/tmp/vibe.lock",
        exists: true,
        pid: 123,
        createdAt: "2026-05-21T13:04:36.225Z",
        ageSeconds: 1328,
        staleByCreatedAge: true,
      },
    },
    nextActions: ["vibe lock を確認する"],
  },
  sourceDistillation: {
    launchAgent: {
      label: "com.memory-router.queue-supervisor",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.queue-supervisor.plist",
      installed: true,
      loaded: true,
      state: "running",
    },
    runs: {
      totalRuns: 5,
      okRuns: 5,
      skippedRuns: 0,
      outcomeKindCounts: [{ reason: "knowledge_created", count: 5 }],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: "2026-05-21T02:48:15.457Z",
      lastRunAgeMinutes: 638,
      lastOkRunAt: "2026-05-21T02:48:15.457Z",
      lastOkRunAgeMinutes: 638,
    },
    jobs: {
      queued: 36,
      running: 1,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 36,
      running: 1,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: false,
      oldestQueuedAt: "2026-05-21T07:49:40.146Z",
      oldestQueuedAgeMinutes: 337,
      oldestRunningAt: "2026-05-21T13:26:00.057Z",
      oldestRunningAgeMinutes: 1,
      lock: {
        path: "/tmp/source.lock",
        exists: true,
        pid: 456,
        createdAt: "2026-05-21T13:04:36.225Z",
        ageSeconds: 1328,
        staleByCreatedAge: true,
      },
    },
    nextActions: ["source queue を確認する"],
  },
};

const baseDomainMeta = {
  status: baseReport.status,
  checkedAt: baseReport.checkedAt,
  totalDurationMs: baseReport.totalDurationMs,
  summary: baseReport.summary,
  reasonDetails: [],
  skippedChecks: baseReport.skippedChecks,
};

const coreInfrastructureDomain = {
  ...baseDomainMeta,
  reasons: ["KNOWLEDGE_ZERO_USE_HIGH"],
  db: baseReport.db,
  vector: baseReport.vector,
  desktopReadiness: {
    backendCategory: "sqlite-local",
    modeLabel: "Desktop local",
    status: "Ready",
    defaultBackendReady: true,
    items: [
      {
        id: "sqlite-local-db",
        label: "SQLite local database",
        state: "Ready",
        scope: "default",
        action: "SQLite backend is selected and required local tables are present.",
      },
      {
        id: "desktop-safe-defaults",
        label: "Desktop-safe defaults",
        state: "Ready",
        scope: "default",
        action: "Default runtime path does not require Docker or PostgreSQL.",
      },
    ],
  },
  embedding: baseReport.embedding,
  tables: baseReport.tables,
  hitl: baseReport.hitl,
  knowledgeLifecycle: baseReport.knowledgeLifecycle,
};

const aiServiceToolsDomain = {
  ...baseDomainMeta,
  reasons: ["AGENTIC_LLM_UNREACHABLE", "MCP_PRIMARY_TOOLS_MISSING"],
  agenticLlm: baseReport.agenticLlm,
  mcp: {
    ...baseReport.mcp,
    missingPrimaryTools: ["context_compile", "compile_eval"],
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions: ["不足 MCP primary tools を追加する: context_compile, compile_eval"],
  },
};

const pipelineAutomationDomain = {
  ...baseDomainMeta,
  reasons: [
    "VIBE_DISTILLATION_NEVER_RAN",
    "VIBE_DISTILLATION_PIPELINE_LOCK_STALE",
    "SOURCE_DISTILLATION_PIPELINE_LOCK_STALE",
    "ANTIGRAVITY_LOGS_SYNC_STALE",
  ],
  runs: baseReport.runs,
  agentLogSync: baseReport.agentLogSync,
  vibeDistillation: baseReport.vibeDistillation,
  sourceDistillation: baseReport.sourceDistillation,
};

function mockDoctorDomainQueries({
  core = { data: coreInfrastructureDomain },
  ai = { data: aiServiceToolsDomain },
  pipeline = { data: pipelineAutomationDomain },
}: {
  core?: { data?: unknown; isError?: boolean; isFetching?: boolean };
  ai?: { data?: unknown; isError?: boolean; isFetching?: boolean };
  pipeline?: { data?: unknown; isError?: boolean; isFetching?: boolean };
} = {}) {
  vi.mocked(useQuery).mockImplementation((options: any) => {
    const domain = options.queryKey?.[2];
    const state =
      domain === "core-infrastructure" ? core : domain === "ai-service-tools" ? ai : pipeline;
    return {
      data: state.data,
      isError: state.isError ?? false,
      isFetching: state.isFetching ?? false,
      refetch: vi.fn(),
    } as any;
  });
}

describe("DoctorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dashboard sections and human-readable reason labels", () => {
    mockDoctorDomainQueries();

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Doctor")).toBeInTheDocument();
    expect(screen.getAllByText("degraded").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Core Infrastructure")).toBeInTheDocument();
    expect(screen.getByText("External / Ready")).toBeInTheDocument();
    expect(screen.getByText("Desktop Readiness")).toBeInTheDocument();
    expect(screen.getByText("SQLite local database")).toBeInTheDocument();
    expect(screen.queryByText("pgvector")).not.toBeInTheDocument();
    expect(screen.queryByText("Installed")).not.toBeInTheDocument();
    expect(screen.getByText("AI & Service Tools")).toBeInTheDocument();
    expect(screen.getByText("Pipeline & Automation")).toBeInTheDocument();
    expect(screen.getByText(/システム緊急警告/)).toBeInTheDocument();
    expect(screen.getByText("Provider Health")).toBeInTheDocument();
    expect(screen.getByText("Azure OpenAI #1")).toBeInTheDocument();
    expect(screen.getByText("Azure OpenAI #2")).toBeInTheDocument();
    expect(screen.getByText("Local LLM")).toBeInTheDocument();
    expect(screen.getByText("Local LLM: Gemma")).toBeInTheDocument();
    expect(screen.queryByText("tool history")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Bedrock")).not.toBeInTheDocument();
    expect(screen.getByText("Finished Targets")).toBeInTheDocument();
    expect(screen.getByText("Stale Running")).toBeInTheDocument();
    expect(screen.queryByText("Queue Pending")).not.toBeInTheDocument();
    expect(screen.queryByText("Queue Running")).not.toBeInTheDocument();

    expect(screen.getByText("未使用の active knowledge が多い")).toBeInTheDocument();
    expect(screen.getByText("Agentic LLM に到達できない")).toBeInTheDocument();
    expect(screen.getAllByText("会話ログ蒸留ロックが古い").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("AI 推奨アクション:")).toBeInTheDocument();
    expect(screen.getByText("パイプライン推奨アクション:")).toBeInTheDocument();
    expect(
      screen.getByText("不足 MCP primary tools を追加する: context_compile, compile_eval"),
    ).toBeInTheDocument();
    expect(screen.getByText("vibe lock を確認する")).toBeInTheDocument();
    expect(screen.getByText("source queue を確認する")).toBeInTheDocument();
  }, 15_000);

  it("renders fallback text for unknown reason codes", () => {
    const core = {
      ...coreInfrastructureDomain,
      reasons: ["UNMAPPED_CUSTOM_REASON"],
    };
    const ai = {
      ...aiServiceToolsDomain,
      mcp: { ...baseReport.mcp, nextActions: [] },
    };
    const pipeline = {
      ...pipelineAutomationDomain,
      reasons: [],
      vibeDistillation: { ...baseReport.vibeDistillation, nextActions: [] },
      sourceDistillation: { ...baseReport.sourceDistillation, nextActions: [] },
    };

    mockDoctorDomainQueries({
      core: { data: core },
      ai: { data: ai },
      pipeline: { data: pipeline },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Unmapped Custom Reason")).toBeInTheDocument();
    expect(screen.getByText("Doctor が未定義の診断コードを返しました。")).toBeInTheDocument();
    expect(screen.queryByText("AI 推奨アクション:")).not.toBeInTheDocument();
    expect(screen.queryByText("パイプライン推奨アクション:")).not.toBeInTheDocument();
  });

  it("colors core infrastructure metrics by health severity", () => {
    const core = {
      ...coreInfrastructureDomain,
      totalDurationMs: 6000,
      db: {
        reachable: true,
        durationMs: 100,
        responseMs: 100,
        queryMs: 800,
        totalInspectionMs: 1000,
      },
      vector: { installed: false, healthMs: 2500, source: "unavailable" },
      tables: {
        ...baseReport.tables,
        missing: ["knowledge_items"],
      },
    };

    mockDoctorDomainQueries({ core: { data: core } });

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("DB response: 100ms")).toHaveClass("text-amber-700");
    expect(screen.getByText("100ms")).toHaveClass("text-amber-600");
    expect(screen.getByText("800ms")).toHaveClass("text-red-600");
    expect(screen.getByText("2500ms")).toHaveClass("text-red-600");
    expect(screen.getByText("Missing 1")).toHaveClass("text-red-600");
    expect(screen.getByText("6000ms")).toHaveClass("text-amber-600");
  });

  it("shows Offline when the external embedding provider is down", () => {
    const core = {
      ...coreInfrastructureDomain,
      embedding: {
        ...baseReport.embedding,
        effectiveMode: "unavailable",
        daemon: {
          ...baseReport.embedding.daemon,
          reachable: false,
          status: "offline",
          managedBy: "none",
        },
      },
    };

    mockDoctorDomainQueries({ core: { data: core } });

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Embedding Provider").parentElement).toHaveTextContent("Offline");
  });

  it("renders error card when doctor query fails", () => {
    mockDoctorDomainQueries({
      core: { isError: true },
      ai: { data: aiServiceToolsDomain },
      pipeline: { data: pipelineAutomationDomain },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Doctor API Error")).toBeInTheDocument();
  });

  it("renders domain placeholders before data arrives", () => {
    mockDoctorDomainQueries({
      core: {},
      ai: {},
      pipeline: {},
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Core Infrastructure")).toBeInTheDocument();
    expect(screen.getByText("AI & Service Tools")).toBeInTheDocument();
    expect(screen.getByText("Pipeline & Automation")).toBeInTheDocument();
    expect(screen.getAllByText("Loading")).toHaveLength(3);
  });
});
