/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../../web/src/modules/admin/components/settings.page";
import type {
  RuntimeProviderName,
  RuntimeSettingsSnapshotResponse,
  RuntimeSettingsUpdateResponse,
  RuntimeSettingsView,
} from "../../../web/src/modules/admin/repositories/admin.repository";

const routerState = vi.hoisted(() => ({
  pathname: "/setting/llmprovider",
}));

const repositoryMocks = vi.hoisted(() => ({
  fetchRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  reloadRuntimeSettingsCache: vi.fn(),
  testAzureOpenAiDeployment: vi.fn(),
  testLocalLlmModel: vi.fn(),
  testRuntimeProvider: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, className, children }: any) => {
    let href = typeof to === "string" ? to : "/";
    if (href.includes("$section")) {
      href = href.replace("$section", params?.section ?? "");
    }
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
  useRouterState: vi
    .fn()
    .mockImplementation(({ select }: any) =>
      typeof select === "function"
        ? select({ location: { pathname: routerState.pathname } })
        : routerState.pathname,
    ),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual(
    "../../../web/src/modules/admin/repositories/admin.repository",
  );
  return {
    ...actual,
    fetchRuntimeSettings: repositoryMocks.fetchRuntimeSettings,
    updateRuntimeSettings: repositoryMocks.updateRuntimeSettings,
    reloadRuntimeSettingsCache: repositoryMocks.reloadRuntimeSettingsCache,
    testAzureOpenAiDeployment: repositoryMocks.testAzureOpenAiDeployment,
    testLocalLlmModel: repositoryMocks.testLocalLlmModel,
    testRuntimeProvider: repositoryMocks.testRuntimeProvider,
  };
});

function secretStatus(configured: boolean) {
  return {
    configured,
    source: configured ? ("env" as const) : ("none" as const),
    maskedValue: configured ? "sk****ey" : null,
    updatedAt: configured ? "2026-05-23T12:00:00.000Z" : null,
  };
}

function buildSettingsView(): RuntimeSettingsView {
  const openAiTarget = {
    source: "route" as const,
    targets: [
      {
        provider: "openai" as const,
        id: "route:openai:gpt-5-4-mini",
        label: "gpt-5-4-mini",
        source: "route" as const,
        model: "gpt-5-4-mini",
        endpoint: "https://api.openai.com/v1",
      },
    ],
  };
  const localPoolTarget = {
    source: "provider_pool" as const,
    providerPoolId: "local-llm-default",
    targets: [
      {
        provider: "local-llm" as const,
        id: "provider-pool:local-llm-default:local-llm:local-primary",
        label: "Primary",
        source: "provider_pool" as const,
        model: "gemma-4-e4b-it",
        endpoint: "http://127.0.0.1:44448",
        providerPoolId: "local-llm-default",
        localLlmModelId: "local-primary",
      },
    ],
  };

  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: ["knowledge_candidate", "web_ingest", "wiki_file", "vibe_memory"],
      },
    },
    providerPools: [
      {
        id: "local-llm-default",
        label: "Local LLM pool",
        targets: [{ provider: "local-llm", localLlmModelId: "local-primary" }],
        maxConcurrent: 1,
        staleLeaseSeconds: 600,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ],
    effectiveTargets: {
      providerPools: {
        "local-llm-default": localPoolTarget.targets,
      },
      taskRouting: {
        findCandidate: {
          source: openAiTarget,
          vibe: openAiTarget,
        },
        webSourceResearch: localPoolTarget,
        episodeDistiller: localPoolTarget,
        coverEvidence: {
          sourceSupport: localPoolTarget,
          externalEvidence: localPoolTarget,
          mcpEvidence: localPoolTarget,
        },
        finalizeDistille: localPoolTarget,
        mergeActivationFinalize: localPoolTarget,
        deadZoneMergeReview: localPoolTarget,
        landscapeCuration: localPoolTarget,
        agenticCompile: openAiTarget,
      },
    },
    diagnostics: {
      providerPools: [],
    },
    providers: {
      openai: {
        enabled: true,
        apiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
      },
      "azure-openai": {
        enabled: true,
        apiBaseUrl: "https://example.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
        apiKeySecrets: [secretStatus(true), secretStatus(false), secretStatus(false)],
        deployments: [
          {
            name: "Primary",
            apiBaseUrl: "https://example.openai.azure.com",
            apiPath: "/openai/deployments",
            apiVersion: "2025-04-01-preview",
            model: "gpt-5-4-mini",
          },
        ],
      },
      bedrock: {
        enabled: false,
        region: "us-east-1",
        profile: "",
        model: "anthropic.claude-3-5-haiku-20241022-v1:0",
        credentialSecret: {
          configured: false,
          source: "none",
          maskedValue: null,
          updatedAt: null,
        },
      },
      "local-llm": {
        enabled: true,
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
        models: [
          {
            id: "local-primary",
            name: "Primary",
            apiBaseUrl: "http://127.0.0.1:44448",
            apiPath: "/v1/chat/completions",
            model: "gemma-4-e4b-it",
          },
          {
            id: "local-qwen",
            name: "Qwen",
            apiBaseUrl: "http://127.0.0.1:44449",
            apiPath: "/v1/chat/completions",
            model: "qwen-3.6-14b-it",
          },
        ],
        apiKeySecret: secretStatus(false),
        apiKeySecrets: [secretStatus(false), secretStatus(true)],
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
        source: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        vibe: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        throttling: {
          backgroundEnabled: true,
          interactiveWindowSeconds: 180,
          recentBlockSeconds: 30,
          minIntervalSeconds: 30,
          mediumIntervalSeconds: 90,
          busyIntervalSeconds: 180,
          maxIntervalSeconds: 300,
          rateLimitCooldownSeconds: 600,
          jitterSeconds: 10,
        },
      },
      webSourceResearch: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      episodeDistiller: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      coverEvidence: {
        sourceSupport: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
        externalEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
        mcpEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
      },
      finalizeDistille: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      mergeActivationFinalize: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      deadZoneMergeReview: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      landscapeCuration: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      agenticCompile: {
        enabled: true,
        provider: "openai",
        model: "gpt-5-4-mini",
        fallback: ["local-llm"],
        timeoutMs: 15000,
        maxTokens: 4000,
      },
    },
    search: {
      providerOrder: ["brave", "exa", "duckduckgo"],
      maxProviderAttempts: 2,
      resultCount: 8,
      timeoutMs: 10000,
      rateLimitCooldownSeconds: 3600,
      providers: {
        brave: { enabled: true, apiKeySecret: secretStatus(true) },
        exa: { enabled: true, apiKeySecret: secretStatus(false) },
        duckduckgo: { enabled: true },
      },
    },
    embedding: {
      provider: "daemon",
      daemonUrl: "http://127.0.0.1:44512",
      openaiModel: "text-embedding-3-small",
      timeoutMs: 30000,
    },
    distillationRuntime: {
      timeoutMs: 30000,
      candidateTimeoutMs: 15000,
      maxToolRounds: 4,
      findCandidateTimeoutMs: 600000,
      findCandidateMaxToolCalls: 8,
      coverEvidenceTimeoutMs: 600000,
      coverEvidenceSearchMaxCalls: 3,
      coverEvidenceFetchMaxCalls: 5,
      coverEvidenceFetchMaxTokensPerSite: 3000,
      toolTimeoutMs: 10000,
      toolResultMaxChars: 12000,
      failureRetryDelaySeconds: 90,
      readerMaxReads: 12,
      readerMaxCharsPerRead: 12000,
      llmContextWindowTokens: 128000,
      llmMaxInputTokens: 80000,
      llmInputSafetyMarginTokens: 4096,
      lowImportanceRejectThreshold: 40,
    },
    advanced: {
      pipelineLockStaleSeconds: 1200,
      lockTtlSeconds: 1800,
      pipelineClaimLimit: 1,
      findingQueueTaskIntervalSeconds: 30,
      coveringQueueTaskIntervalSeconds: 10,
      continuousIdleSleepMs: 5000,
      continuousErrorSleepMs: 12000,
      inventoryRefreshIntervalMs: 30000,
      doctorFreshnessThresholdMinutes: 720,
      doctorDegradedRateThreshold: 0.5,
      doctorKnowledgeZeroUseWarningMinActiveCount: 10,
      codexLogSyncEnabled: true,
      antigravityLogSyncEnabled: true,
      claudeLogSyncEnabled: true,
    },
  };
}

function buildSnapshot(revision = 1): RuntimeSettingsSnapshotResponse {
  const settings = buildSettingsView();
  return {
    settings,
    effective: settings,
    sources: {},
    revision,
    loadedAt: "2026-05-23T12:00:00.000Z",
  };
}

function buildUpdateResponse(): RuntimeSettingsUpdateResponse {
  return {
    ...buildSnapshot(2),
    updatedAt: "2026-05-23T12:10:00.000Z",
    cacheInvalidated: true,
    reloadRequired: true,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

function getRouteRow(label: string): HTMLElement {
  const row = screen
    .getAllByText(label)
    .map((element) => element.closest(".settings-route-row"))
    .find((element): element is HTMLElement => element instanceof HTMLElement);
  if (!row) throw new Error(`Route row not found: ${label}`);
  return row;
}

function getLocalLlmEditRow(label: string): HTMLElement {
  const row = screen
    .getAllByText(label)
    .map((element) => element.closest(".settings-local-llm-model"))
    .find((element): element is HTMLElement => element instanceof HTMLElement);
  if (!row) throw new Error(`Local LLM edit row not found: ${label}`);
  return row;
}

function getEndpointCardByValue(value: string): HTMLElement {
  const row = screen
    .getAllByDisplayValue(value)
    .map((element) => element.closest(".settings-provider-endpoint-card"))
    .find((element): element is HTMLElement => element instanceof HTMLElement);
  if (!row) throw new Error(`Provider endpoint card not found: ${value}`);
  return row;
}

function queryEndpointCardByTitle(value: string): HTMLElement | null {
  return (
    screen
      .queryAllByText(value)
      .filter((element) => element.closest(".settings-provider-endpoint-title"))
      .map((element) => element.closest(".settings-provider-endpoint-card"))
      .find((element): element is HTMLElement => element instanceof HTMLElement) ?? null
  );
}

function getEndpointCardByText(value: string): HTMLElement {
  const row = queryEndpointCardByTitle(value);
  if (!row) throw new Error(`Provider endpoint card not found: ${value}`);
  return row;
}

function getEndpointField(card: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const field = within(card).getByText(label).closest("label");
  const control = field?.querySelector("input, select");
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`Provider endpoint field not found: ${label}`);
  }
  return control;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    routerState.pathname = "/setting/llmprovider";
    repositoryMocks.fetchRuntimeSettings.mockReset();
    repositoryMocks.updateRuntimeSettings.mockReset();
    repositoryMocks.reloadRuntimeSettingsCache.mockReset();
    repositoryMocks.testAzureOpenAiDeployment.mockReset();
    repositoryMocks.testLocalLlmModel.mockReset();
    repositoryMocks.testRuntimeProvider.mockReset();

    repositoryMocks.fetchRuntimeSettings.mockResolvedValue(buildSnapshot());
    repositoryMocks.updateRuntimeSettings.mockResolvedValue(buildUpdateResponse());
    repositoryMocks.reloadRuntimeSettingsCache.mockResolvedValue({
      ok: true,
      reloadedAt: "2026-05-23T12:20:00.000Z",
    });
    repositoryMocks.testRuntimeProvider.mockImplementation(
      async (provider: RuntimeProviderName) => ({
        provider,
        health: {
          provider,
          configured: true,
          reachable: true,
          model: "gpt-5-4-mini",
          endpoint: "https://example.invalid",
        },
      }),
    );
    repositoryMocks.testAzureOpenAiDeployment.mockImplementation(
      async (deploymentIndex: number) => ({
        provider: "azure-openai",
        deployment: deploymentIndex + 1,
        health: {
          provider: "azure-openai",
          configured: true,
          reachable: true,
          model: `azure-deployment-${deploymentIndex + 1}`,
          endpoint: "https://example.invalid",
        },
      }),
    );
    repositoryMocks.testLocalLlmModel.mockImplementation(async (model: string) => ({
      provider: "local-llm",
      model,
      health: {
        provider: "local-llm",
        configured: true,
        reachable: true,
        model,
        endpoint: "http://127.0.0.1:44449",
      },
    }));
  });

  it("renders task-routing tab from URL and keeps tab links canonical", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByText("Route Matrix")).toBeInTheDocument();
    expect(getRouteRow("findCandidate")).toBeInTheDocument();
    expect(getRouteRow("coverEvidence")).toBeInTheDocument();
    expect(getRouteRow("landscapeCuration")).toBeInTheDocument();
    expect(screen.getByText("Shared Distillation Runtime")).toBeInTheDocument();
    expect(screen.getByLabelText("Find Candidate LLM Timeout (seconds)")).toHaveValue(600);
    expect(screen.getByLabelText("Find Candidate Tool Calls")).toBeInTheDocument();
    expect(screen.getByLabelText("Finding Queue Task Interval (seconds)")).toHaveValue(30);
    expect(screen.getByLabelText("Covering Queue Task Interval (seconds)")).toHaveValue(10);
    expect(screen.getByLabelText("Cover Evidence Search Calls")).toBeInTheDocument();
    expect(screen.getByLabelText("LLM Context Window Tokens")).toHaveValue(128000);
    expect(screen.getByLabelText("LLM Max Input Tokens")).toHaveValue(80000);
    expect(screen.getByLabelText("LLM Input Safety Margin Tokens")).toHaveValue(4096);
    expect(screen.getByText("Agentic Compile")).toBeInTheDocument();
    expect(screen.queryByText("Local LLM Pools")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Distillation Runtime" })).not.toBeInTheDocument();

    const tabLink = screen.getByRole("link", { name: "LLM Providers" });
    expect(tabLink).toHaveAttribute("href", "/setting/llmprovider");
    expect(screen.getByRole("link", { name: "LLM Pool" })).toHaveAttribute(
      "href",
      "/setting/llmpool",
    );

    const primaryEndpointSelects = screen.getAllByLabelText("Routing Target");
    const firstPrimaryEndpointSelect = primaryEndpointSelects[0];
    expect(
      within(firstPrimaryEndpointSelect).getByRole("option", {
        name: "Pool / Local LLM pool",
      }),
    ).toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).getByRole("option", {
        name: /OpenAI \/ gpt-5-4-mini/,
      }),
    ).toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).getByRole("option", { name: /Primary \/ gpt-5-4-mini/ }),
    ).toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).queryByRole("option", {
        name: /Primary \/ gemma-4-e4b-it/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).getByRole("option", { name: /Qwen \/ qwen-3\.6-14b-it/ }),
    ).toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).queryByRole("option", { name: /AWS Bedrock/ }),
    ).not.toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).queryByRole("option", { name: /Codex/ }),
    ).not.toBeInTheDocument();
    expect(
      within(firstPrimaryEndpointSelect).queryByRole("option", { name: "auto" }),
    ).not.toBeInTheDocument();
  });

  it("preserves an enabled LARM connection and dynamic route in the settings form", async () => {
    const settings = buildSettingsView();
    settings.providers["larm-agent-connection"] = {
      enabled: true,
      connections: [
        {
          id: "contextstill-background",
          controlBaseUrl: "http://gnosis.local:9810",
          agentProfile: "contextstill-background",
          audience: "saaa-desktop",
          availabilityPollMs: 5_000,
          availabilityTimeoutMs: 2_000,
          controlTimeoutMs: 5_000,
          readyTimeoutMs: 180_000,
          ttlSeconds: 900,
          requestTimeoutMs: 300_000,
        },
      ],
    };
    const dynamicRoute = {
      kind: "larm-agent-connection" as const,
      connectionId: "contextstill-background",
    };
    settings.taskRouting.findCandidate.source = dynamicRoute;
    settings.taskRouting.findCandidate.vibe = dynamicRoute;
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/taskrouting";

    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    const rowScope = within(getRouteRow("findCandidate"));
    expect(rowScope.getByLabelText("Routing Target")).toHaveValue(
      "larm-agent-connection:contextstill-background",
    );
    expect(rowScope.getByLabelText("Fallback 1 Endpoint")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Find Candidate Tool Calls"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["larm-agent-connection"]).toEqual(
      settings.providers["larm-agent-connection"],
    );
    expect(payload.settings.taskRouting.findCandidate.source).toEqual(dynamicRoute);
    expect(payload.settings.taskRouting.findCandidate.vibe).toEqual(dynamicRoute);
  });

  it("keeps LARM route and pool references consistent when a connection id changes", async () => {
    const settings = buildSettingsView();
    settings.providers["larm-agent-connection"] = {
      enabled: true,
      connections: [
        {
          id: "contextstill-background",
          controlBaseUrl: "http://gnosis.local:9810",
          agentProfile: "contextstill-background",
          audience: "saaa-desktop",
          availabilityPollMs: 5_000,
          availabilityTimeoutMs: 2_000,
          controlTimeoutMs: 5_000,
          readyTimeoutMs: 180_000,
          ttlSeconds: 900,
          requestTimeoutMs: 300_000,
        },
      ],
    };
    settings.taskRouting.episodeDistiller = {
      kind: "larm-agent-connection",
      connectionId: "contextstill-background",
    };
    settings.providerPools = [
      {
        id: "dynamic-background",
        label: "Dynamic background",
        targets: [
          {
            provider: "larm-agent-connection",
            connectionId: "contextstill-background",
          },
        ],
        maxConcurrent: 1,
        staleLeaseSeconds: 600,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });

    renderPage();

    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();
    const card = getEndpointCardByValue("contextstill-background");
    expect(within(card).getByRole("button", { name: "Delete" })).toBeDisabled();
    fireEvent.change(getEndpointField(card, "Connection ID"), {
      target: { value: "contextstill-renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["larm-agent-connection"].connections[0].id).toBe(
      "contextstill-renamed",
    );
    expect(payload.settings.taskRouting.episodeDistiller).toEqual({
      kind: "larm-agent-connection",
      connectionId: "contextstill-renamed",
    });
    expect(payload.settings.providerPools[0].targets).toEqual([
      { provider: "larm-agent-connection", connectionId: "contextstill-renamed" },
    ]);
  });

  it("supports legacy settings URL and resolves active tab", async () => {
    routerState.pathname = "/settings/taskrouting";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Task Routing" })).toHaveClass("active");
    expect(screen.getByRole("link", { name: "LLM Providers" })).toHaveAttribute(
      "href",
      "/setting/llmprovider",
    );
  });

  it("renders the task-routing screen for the legacy distillation-runtime settings URL", async () => {
    routerState.pathname = "/setting/distillation-runtime";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Task Routing" })).toHaveClass("active");
    expect(screen.getByLabelText("Cover Evidence Fetch Calls")).toBeInTheDocument();
  });

  it("saves task-routing changes with endpoint sync and fallback routing", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save Settings" });
    expect(saveButton).toBeDisabled();

    expect(screen.queryByText("findCandidate.source")).not.toBeInTheDocument();
    expect(screen.queryByText("findCandidate.vibe")).not.toBeInTheDocument();
    const rowScope = within(getRouteRow("findCandidate"));

    fireEvent.change(rowScope.getByLabelText("Routing Target"), {
      target: { value: "endpoint:azure-openai:1" },
    });
    fireEvent.change(rowScope.getByLabelText("Fallback 1 Endpoint"), {
      target: { value: "local-llm:qwen-3.6-14b-it" },
    });
    expect(
      within(rowScope.getByLabelText("Fallback 2 Endpoint")).queryByRole("option", {
        name: /qwen-3\.6-14b-it/,
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find Candidate Tool Calls"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("Find Candidate LLM Timeout (seconds)"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Rate Limit Cooldown (sec)"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByLabelText("Cover Evidence Fetch Calls"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("LLM Context Window Tokens"), {
      target: { value: "128000" },
    });
    fireEvent.change(screen.getByLabelText("LLM Max Input Tokens"), {
      target: { value: "80000" },
    });
    fireEvent.change(screen.getByLabelText("LLM Input Safety Margin Tokens"), {
      target: { value: "4096" },
    });
    fireEvent.change(screen.getByLabelText("Finding Queue Task Interval (seconds)"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Covering Queue Task Interval (seconds)"), {
      target: { value: "10" },
    });

    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.updatedBy).toBe("admin-ui");
    expect(payload.settings.taskRouting.findCandidate.source).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
      azureDeploymentSlots: [1],
    });
    expect(payload.settings.taskRouting.findCandidate.vibe).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
      azureDeploymentSlots: [1],
    });
    expect(payload.settings.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds).toBe(
      120,
    );
    expect(payload.settings.distillationRuntime.findCandidateTimeoutMs).toBe(45_000);
    expect(payload.settings.distillationRuntime.findCandidateMaxToolCalls).toBe(6);
    expect(payload.settings.distillationRuntime.coverEvidenceFetchMaxCalls).toBe(2);
    expect(payload.settings.distillationRuntime.llmContextWindowTokens).toBe(128000);
    expect(payload.settings.distillationRuntime.llmMaxInputTokens).toBe(80000);
    expect(payload.settings.distillationRuntime.llmInputSafetyMarginTokens).toBe(4096);
    expect(payload.settings.advanced.findingQueueTaskIntervalSeconds).toBe(45);
    expect(payload.settings.advanced.coveringQueueTaskIntervalSeconds).toBe(10);
    expect(payload.settings.taskRouting.landscapeCuration).toEqual({
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      providerPoolId: "local-llm-default",
      fallback: [],
    });
  });

  it("saves the Landscape Curation task route", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const rowScope = within(getRouteRow("landscapeCuration"));
    fireEvent.change(rowScope.getByLabelText("Routing Target"), {
      target: { value: "endpoint:azure-openai:1" },
    });
    fireEvent.change(rowScope.getByLabelText("Fallback 1 Endpoint"), {
      target: { value: "local-llm:qwen-3.6-14b-it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.landscapeCuration).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
      azureDeploymentSlots: [1],
    });
  });

  it("saves route LLM Pool target selection from Task Routing", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const rowScope = within(getRouteRow("findCandidate"));
    expect(
      within(rowScope.getByLabelText("Routing Target")).getByRole("option", {
        name: "Pool / Local LLM pool",
      }),
    ).toBeInTheDocument();
    fireEvent.change(rowScope.getByLabelText("Routing Target"), {
      target: { value: "pool:local-llm-default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.findCandidate.source.providerPoolId).toBe(
      "local-llm-default",
    );
    expect(payload.settings.taskRouting.findCandidate.vibe.providerPoolId).toBe(
      "local-llm-default",
    );
  });

  it("does not offer LARM provider pools to agenticCompile", async () => {
    const settings = buildSettingsView();
    settings.providers["larm-agent-connection"] = {
      enabled: true,
      connections: [
        {
          id: "contextstill-background",
          controlBaseUrl: "http://gnosis.local:9810",
          agentProfile: "contextstill-background",
          audience: "saaa-desktop",
          availabilityPollMs: 5_000,
          availabilityTimeoutMs: 2_000,
          controlTimeoutMs: 5_000,
          readyTimeoutMs: 180_000,
          ttlSeconds: 900,
          requestTimeoutMs: 300_000,
        },
      ],
    };
    settings.providerPools.push({
      id: "larm-background",
      label: "LARM Background",
      targets: [{ provider: "larm-agent-connection", connectionId: "contextstill-background" }],
      maxConcurrent: 1,
      staleLeaseSeconds: 600,
      enabled: true,
      lowPriorityAgingSeconds: 1800,
    });
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/taskrouting";

    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(
      within(getRouteRow("findCandidate")).getByRole("option", {
        name: "Pool / LARM Background",
      }),
    ).toBeInTheDocument();
    expect(
      within(getRouteRow("agenticCompile")).queryByRole("option", {
        name: "Pool / LARM Background",
      }),
    ).not.toBeInTheDocument();
  });

  it("clears the route pool when saving episodeDistiller as a direct endpoint", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const rowScope = within(getRouteRow("episodeDistiller"));
    fireEvent.change(rowScope.getByLabelText("Routing Target"), {
      target: { value: "endpoint:local-llm:qwen-3.6-14b-it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.episodeDistiller).toMatchObject({
      provider: "local-llm",
      model: "qwen-3.6-14b-it",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["azure-openai"],
    });
    expect(payload.settings.taskRouting.episodeDistiller.providerPoolId).toBeUndefined();
  });

  it("edits Cover Evidence as one queue processing route", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    expect(screen.getByText("coverEvidence")).toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.sourceSupport")).not.toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.externalEvidence")).not.toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.mcpEvidence")).not.toBeInTheDocument();

    const rowScope = within(getRouteRow("coverEvidence"));
    fireEvent.change(rowScope.getByLabelText("Routing Target"), {
      target: { value: "endpoint:azure-openai:1" },
    });
    fireEvent.change(rowScope.getByLabelText("Fallback 1 Endpoint"), {
      target: { value: "local-llm:qwen-3.6-14b-it" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    const route = {
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
      azureDeploymentSlots: [1],
    };
    expect(payload.settings.taskRouting.coverEvidence.sourceSupport).toEqual(route);
    expect(payload.settings.taskRouting.coverEvidence.externalEvidence).toEqual(route);
    expect(payload.settings.taskRouting.coverEvidence.mcpEvidence).toEqual(route);
  });

  it("saves the Local LLM endpoint selected for Agentic Compile fallback", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const rowScope = within(getRouteRow("agenticCompile"));
    fireEvent.change(rowScope.getByLabelText("Fallback 1 Endpoint"), {
      target: { value: "local-llm:qwen-3.6-14b-it" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.agenticCompile).toMatchObject({
      provider: "openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
    });
  });

  it("saves an endpoint-qualified Local LLM fallback target when model names repeat", async () => {
    const settings = buildSettingsView();
    settings.providers["local-llm"].models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "shared-local-model",
      },
      {
        name: "Fallback API",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "shared-local-model",
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const rowScope = within(getRouteRow("findCandidate"));

    const endpointTarget = JSON.stringify({
      apiBaseUrl: "http://127.0.0.1:44449",
      apiPath: "/v1/chat/completions",
      model: "shared-local-model",
    });
    fireEvent.change(rowScope.getByLabelText("Fallback 1 Endpoint"), {
      target: { value: `local-llm:${endpointTarget}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.findCandidate.source.localLlmModel).toBe(endpointTarget);
  });

  it("calls provider health test for selected provider card", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(
      within(getEndpointCardByValue("OpenAI")).getByRole("button", { name: "Health" }),
    );

    await waitFor(() => expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledWith("openai");
  });

  it("renders OpenAI and Bedrock with the same editable endpoint kind selector", async () => {
    const settings = buildSettingsView();
    settings.providers.bedrock.enabled = true;
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    const openAiKind = getEndpointField(getEndpointCardByText("OpenAI"), "Kind");
    const bedrockKind = getEndpointField(getEndpointCardByText("AWS Bedrock"), "Kind");
    expect(openAiKind).not.toBeDisabled();
    expect(bedrockKind).not.toBeDisabled();
    expect(
      within(getEndpointCardByText("OpenAI")).getByRole("option", { name: "Local LLM" }),
    ).toBeInTheDocument();
    expect(
      within(getEndpointCardByText("AWS Bedrock")).getByRole("option", { name: "Azure OpenAI" }),
    ).toBeInTheDocument();
  });

  it("saves OpenAI endpoint deletion as a disabled provider", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(
      within(getEndpointCardByText("OpenAI")).getByRole("button", { name: "Delete" }),
    );
    expect(queryEndpointCardByTitle("OpenAI")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers.openai.enabled).toBe(false);
  });

  it("re-adds an OpenAI endpoint through the shared endpoint editor", async () => {
    const settings = buildSettingsView();
    settings.providers.openai.enabled = false;
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();
    expect(queryEndpointCardByTitle("OpenAI")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    const localRow = getLocalLlmEditRow("Local LLM 3");
    fireEvent.change(getEndpointField(localRow, "Kind"), { target: { value: "openai" } });
    const openAiRow = getEndpointCardByText("OpenAI");
    fireEvent.change(getEndpointField(openAiRow, "Endpoint"), {
      target: { value: "https://api.openai.example/v1" },
    });
    fireEvent.change(getEndpointField(openAiRow, "Models"), {
      target: { value: "gpt-openai-shared" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers.openai).toMatchObject({
      enabled: true,
      apiBaseUrl: "https://api.openai.example/v1",
      model: "gpt-openai-shared",
    });
    expect(payload.settings.providers["local-llm"].models).toHaveLength(2);
  });

  it("deletes and re-adds Bedrock through the shared endpoint editor", async () => {
    const settings = buildSettingsView();
    settings.providers.bedrock.enabled = true;
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(
      within(getEndpointCardByText("AWS Bedrock")).getByRole("button", { name: "Delete" }),
    );
    expect(queryEndpointCardByTitle("AWS Bedrock")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    const localRow = getLocalLlmEditRow("Local LLM 3");
    fireEvent.change(getEndpointField(localRow, "Kind"), { target: { value: "bedrock" } });
    const bedrockRow = getEndpointCardByText("AWS Bedrock");
    fireEvent.change(getEndpointField(bedrockRow, "Region"), {
      target: { value: "ap-northeast-1" },
    });
    fireEvent.change(getEndpointField(bedrockRow, "Models"), {
      target: { value: "anthropic.claude-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers.bedrock).toMatchObject({
      enabled: true,
      region: "ap-northeast-1",
      model: "anthropic.claude-test",
    });
    expect(payload.settings.providers["local-llm"].models).toHaveLength(2);
  });

  it("calls Azure OpenAI deployment health test for selected deployment", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    fireEvent.change(within(getEndpointCardByValue("Local LLM 3")).getByLabelText("Kind"), {
      target: { value: "azure-openai" },
    });
    fireEvent.click(
      within(getEndpointCardByValue("Local LLM 3")).getByRole("button", { name: "Health" }),
    );

    await waitFor(() => expect(repositoryMocks.testAzureOpenAiDeployment).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testAzureOpenAiDeployment).toHaveBeenCalledWith(1);
  });

  it("calls Local LLM model health test for an added model", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    await waitFor(() => expect(screen.getAllByText("Qwen").length).toBeGreaterThan(0));

    fireEvent.click(within(getLocalLlmEditRow("Qwen")).getByRole("button", { name: "Health" }));

    await waitFor(() => expect(repositoryMocks.testLocalLlmModel).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testLocalLlmModel).toHaveBeenCalledWith(
      JSON.stringify({
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      }),
    );
  });

  it("saves only complete added Local LLM model rows", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    const addedRows = screen.getAllByText("Local LLM 3");
    expect(addedRows.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["local-llm"].models).toEqual([
      expect.objectContaining({
        id: "local-primary",
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      }),
      expect.objectContaining({
        id: "local-qwen",
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      }),
    ]);
  });

  it("includes a filled added Local LLM model row in the save payload", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    const row = getLocalLlmEditRow("Local LLM 3");
    fireEvent.change(getEndpointField(row, "Name"), { target: { value: "Reasoner" } });
    fireEvent.change(getEndpointField(row, "Endpoint"), {
      target: { value: "http://127.0.0.1:44450" },
    });
    fireEvent.change(getEndpointField(row, "API Path"), {
      target: { value: "/openai/v1/chat/completions" },
    });
    fireEvent.change(getEndpointField(row, "Models"), {
      target: { value: "local-reasoner" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["local-llm"].models).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^local-llm-[a-f0-9]{12}$/),
        name: "Reasoner",
        apiBaseUrl: "http://127.0.0.1:44450",
        apiPath: "/openai/v1/chat/completions",
        model: "local-reasoner",
      }),
    );
  });

  it("deletes Local LLM and Azure OpenAI endpoints from the save payload", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(within(getLocalLlmEditRow("Qwen")).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(getEndpointCardByValue("Primary")).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["local-llm"].models).toEqual([
      expect.objectContaining({
        id: "local-primary",
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      }),
    ]);
    expect(payload.settings.providers["azure-openai"].deployments).toEqual([]);
  });

  it("shows added Local LLM models in Task Routing and Agentic Compile model choices", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    expect(
      within(getRouteRow("webSourceResearch")).getByRole("option", {
        name: /qwen-3\.6-14b-it/,
      }),
    ).toBeInTheDocument();

    const agenticRow = getRouteRow("agenticCompile");
    fireEvent.change(within(agenticRow).getByLabelText("Routing Target"), {
      target: { value: "endpoint:local-llm:qwen-3.6-14b-it" },
    });

    expect(
      within(agenticRow).getByRole("option", {
        name: /qwen-3\.6-14b-it/,
      }),
    ).toBeInTheDocument();
  });

  it("saves Local LLM queue pool targets and concurrency from LLM Pool", async () => {
    const settings = buildSettingsView();
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM pool",
        targets: [{ provider: "local-llm", localLlmModelId: "local-primary" }],
        maxConcurrent: 1,
        staleLeaseSeconds: 600,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ];
    settings.providers["local-llm"].models = [
      {
        id: "local-primary",
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        id: "local-qwen",
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      },
      {
        id: "local-reasoner",
        name: "Reasoner",
        apiBaseUrl: "http://127.0.0.1:44450",
        apiPath: "/v1/chat/completions",
        model: "reasoner-32b",
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmpool";
    renderPage();
    expect(await screen.findByRole("heading", { name: "LLM Pool" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "LLM Pool" })).toHaveClass("active");

    fireEvent.click(screen.getByLabelText(/Use Qwen .* for Local LLM pool/));
    fireEvent.click(screen.getByLabelText(/Use Reasoner .* for Local LLM pool/));
    fireEvent.change(screen.getByLabelText("Queue Pool Concurrent Jobs"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providerPools[0]).toMatchObject({
      id: "local-llm-default",
      maxConcurrent: 3,
      targets: [
        { provider: "local-llm", localLlmModelId: "local-primary" },
        { provider: "local-llm", localLlmModelId: "local-qwen" },
        { provider: "local-llm", localLlmModelId: "local-reasoner" },
      ],
    });
    expect(
      payload.settings.providers["local-llm"].models.map((model: { id?: string }) => model.id),
    ).toEqual(["local-primary", "local-qwen", "local-reasoner"]);
  });

  it("preserves a LARM pool target when the last Local LLM target is removed", async () => {
    const settings = buildSettingsView();
    settings.providers["larm-agent-connection"] = {
      enabled: true,
      connections: [
        {
          id: "contextstill-background",
          controlBaseUrl: "http://gnosis.local:9810",
          agentProfile: "contextstill-background",
          audience: "saaa-desktop",
          availabilityPollMs: 5_000,
          availabilityTimeoutMs: 2_000,
          controlTimeoutMs: 5_000,
          readyTimeoutMs: 180_000,
          ttlSeconds: 900,
          requestTimeoutMs: 300_000,
        },
      ],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Mixed pool",
        targets: [
          { provider: "larm-agent-connection", connectionId: "contextstill-background" },
          { provider: "local-llm", localLlmModelId: "local-primary" },
        ],
        maxConcurrent: 2,
        staleLeaseSeconds: 600,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmpool";

    renderPage();

    expect(await screen.findByRole("heading", { name: "LLM Pool" })).toBeInTheDocument();
    expect(screen.getByLabelText("Queue Pool Concurrent Jobs")).toHaveValue(2);
    const localTarget = screen.getByLabelText(/Use Primary .* for Mixed pool/);
    expect(localTarget).not.toBeDisabled();
    fireEvent.click(localTarget);
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providerPools[0]).toMatchObject({
      maxConcurrent: 1,
      targets: [{ provider: "larm-agent-connection", connectionId: "contextstill-background" }],
    });
  });

  it("shows provider pool diagnostics as non-blocking warnings", async () => {
    const settings = buildSettingsView();
    settings.diagnostics.providerPools = [
      {
        severity: "error",
        code: "provider_pool_missing",
        path: "taskRouting.episodeDistiller.providerPoolId",
        message:
          'taskRouting.episodeDistiller references provider pool "missing-pool", but the pool is not configured.',
        details: { providerPoolId: "missing-pool" },
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmpool";
    renderPage();

    expect(await screen.findByLabelText("provider pool diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Provider Pool Diagnostics")).toBeInTheDocument();
    expect(screen.getByText(/missing-pool/)).toBeInTheDocument();
  });

  it("keeps LLM Pool rendering when runtime diagnostics are absent", async () => {
    const settings = buildSettingsView() as Omit<
      RuntimeSettingsView,
      "diagnostics" | "effectiveTargets"
    > &
      Partial<Pick<RuntimeSettingsView, "diagnostics" | "effectiveTargets">>;
    settings.diagnostics = undefined;
    settings.effectiveTargets = undefined;
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings: settings as RuntimeSettingsView,
      effective: settings as RuntimeSettingsView,
    });
    routerState.pathname = "/setting/llmpool";
    renderPage();

    expect(await screen.findByRole("heading", { name: "LLM Pool" })).toBeInTheDocument();
    expect(screen.queryByLabelText("provider pool diagnostics")).not.toBeInTheDocument();
  });

  it("shows an empty state on LLM Pool when no complete Local LLM endpoint exists", async () => {
    const settings = buildSettingsView();
    settings.providerPools = [];
    settings.providers["local-llm"].models = [];
    settings.providers["local-llm"].apiBaseUrl = "";
    settings.providers["local-llm"].model = "";
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmpool";
    renderPage();

    expect(await screen.findByRole("heading", { name: "LLM Pool" })).toBeInTheDocument();
    expect(screen.getByText("No Local LLM endpoints")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Pool" })).toBeDisabled();
  });

  it("preserves Provider Pool targets when Local LLM models initially have no ids", async () => {
    const settings = buildSettingsView();
    settings.providerPools = [];
    settings.providers["local-llm"].models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      },
    ];
    repositoryMocks.fetchRuntimeSettings.mockResolvedValue({
      ...buildSnapshot(),
      settings,
      effective: settings,
    });
    routerState.pathname = "/setting/llmpool";
    renderPage();
    expect(await screen.findByRole("heading", { name: "LLM Pool" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Pool Name"), {
      target: { value: "Persisted Local LLM Pool" },
    });
    fireEvent.change(screen.getByLabelText("Queue Pool Concurrent Jobs"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    const modelIds = payload.settings.providers["local-llm"].models.map(
      (model: { id?: string }) => model.id,
    );
    expect(modelIds).toHaveLength(2);
    expect(
      modelIds.every((id: string | undefined) => /^local-llm-[a-f0-9]{12}$/.test(id ?? "")),
    ).toBe(true);
    expect(payload.settings.providerPools[0]).toMatchObject({
      id: "local-llm-default",
      label: "Persisted Local LLM Pool",
      maxConcurrent: 2,
      targets: [
        { provider: "local-llm", localLlmModelId: modelIds[0] },
        { provider: "local-llm", localLlmModelId: modelIds[1] },
      ],
    });
  });

  it("saves added Azure OpenAI deployments and separate legacy API keys", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Endpoint" }));
    fireEvent.change(within(getEndpointCardByValue("Local LLM 3")).getByLabelText("Kind"), {
      target: { value: "azure-openai" },
    });
    const row = getEndpointCardByValue("Local LLM 3");
    fireEvent.change(getEndpointField(row, "Endpoint"), {
      target: { value: "https://second.openai.azure.com" },
    });
    fireEvent.change(getEndpointField(row, "Models"), {
      target: { value: "gpt-5-4-mini-secondary" },
    });
    fireEvent.change(within(row).getByLabelText("API Key 2 value"), {
      target: { value: "second-secret" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["azure-openai"].deployments).toHaveLength(2);
    expect(payload.settings.providers["azure-openai"].deployments[1]).toMatchObject({
      apiBaseUrl: "https://second.openai.azure.com",
      model: "gpt-5-4-mini-secondary",
    });
    expect(payload.secrets.azureOpenAiApiKey2).toEqual({ value: "second-secret" });
  });

  it("saves separate Local LLM endpoint API keys", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Provider Endpoints" })).toBeInTheDocument();

    const qwenRow = getLocalLlmEditRow("Qwen");
    fireEvent.change(within(qwenRow).getByLabelText("API Key 2 value"), {
      target: { value: "qwen-secret" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.secrets.localLlmApiKey2).toEqual({ value: "qwen-secret" });
  });

  it("renders Advanced sync settings and allows toggling them", async () => {
    routerState.pathname = "/setting/advanced";
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Advanced Runtime Controls" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Log Synchronization" })).toBeInTheDocument();
    expect(screen.getByLabelText("Continuous Idle Sleep (seconds)")).toHaveValue(5);
    expect(screen.getByLabelText("LLM Context Window Tokens")).toHaveValue(128000);
    expect(screen.getByLabelText("LLM Max Input Tokens")).toHaveValue(80000);
    expect(screen.getByLabelText("LLM Input Safety Margin Tokens")).toHaveValue(4096);
    expect(
      screen.queryByLabelText("Finding Queue Task Interval (seconds)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Covering Queue Task Interval (seconds)"),
    ).not.toBeInTheDocument();

    const codexCheckbox = screen.getByLabelText("Enable Codex (Cursor) Log Sync");
    const antigravityCheckbox = screen.getByLabelText("Enable Antigravity Log Sync");
    const claudeCheckbox = screen.getByLabelText("Enable Claude Code Log Sync");

    expect(codexCheckbox).toBeChecked();
    expect(antigravityCheckbox).toBeChecked();
    expect(claudeCheckbox).toBeChecked();

    fireEvent.click(claudeCheckbox);
    expect(claudeCheckbox).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Continuous Idle Sleep (seconds)"), {
      target: { value: "7.5" },
    });
    fireEvent.change(screen.getByLabelText("LLM Context Window Tokens"), {
      target: { value: "128000" },
    });
    fireEvent.change(screen.getByLabelText("LLM Max Input Tokens"), {
      target: { value: "80000" },
    });
    fireEvent.change(screen.getByLabelText("LLM Input Safety Margin Tokens"), {
      target: { value: "4096" },
    });
    const saveButton = screen.getByRole("button", { name: "Save Settings" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.advanced.claudeLogSyncEnabled).toBe(false);
    expect(payload.settings.advanced.continuousIdleSleepMs).toBe(7500);
    expect(payload.settings.distillationRuntime.llmContextWindowTokens).toBe(128000);
    expect(payload.settings.distillationRuntime.llmMaxInputTokens).toBe(80000);
    expect(payload.settings.distillationRuntime.llmInputSafetyMarginTokens).toBe(4096);
  });
});
