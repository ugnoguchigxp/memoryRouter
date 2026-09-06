import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendKind: "sqlite" as "sqlite" | "postgres",
  settings: {
    providerPools: [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm" as const, localLlmModelId: "local-a" },
          { provider: "local-llm" as const, localLlmModelId: "local-b" },
        ],
      },
    ],
    providers: {
      "local-llm": {
        models: [
          {
            id: "local-a",
            name: "Local A",
            apiBaseUrl: "http://localhost:50041/v1",
            apiPath: "/v1/chat/completions",
            model: "local-a-model",
          },
          {
            id: "local-b",
            name: "Local B",
            apiBaseUrl: "http://localhost:50042/v1",
            apiPath: "/v1/chat/completions",
            model: "local-b-model",
          },
          {
            id: "local-c",
            name: "Local C",
            apiBaseUrl: "http://localhost:50043/v1",
            apiPath: "/v1/chat/completions",
            model: "local-c-model",
          },
        ],
      },
    },
    taskRouting: {
      findCandidate: {
        source: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          model: "local-a-model",
          fallback: [],
        },
        vibe: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          model: "local-b-model",
          fallback: [],
        },
      },
      webSourceResearch: { provider: "local-llm", model: "local-a-model", fallback: [] },
      episodeDistiller: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        model: "local-b-model",
        fallback: [],
      },
      coverEvidence: {
        sourceSupport: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          model: "local-a-model",
          fallback: [],
        },
        externalEvidence: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          model: "local-b-model",
          fallback: [],
        },
        mcpEvidence: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          model: "local-b-model",
          fallback: [],
        },
      },
      deadZoneMergeReview: { provider: "local-llm", model: "local-a-model", fallback: [] },
      finalizeDistille: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        model: "local-b-model",
        fallback: [],
      },
      mergeActivationFinalize: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        model: "local-b-model",
        fallback: [],
      },
    },
  },
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  getRuntimeSettingsSnapshot: () => mocks.settings,
  resolveProviderPools: () => mocks.settings.providerPools,
}));

describe("provider pool scheduler", () => {
  beforeEach(() => {
    mocks.backendKind = "sqlite";
    mocks.settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      providerPoolId: "local-llm-default",
      model: "local-b-model",
      fallback: [],
    };
  });

  test("uses enabled provider pools on SQLite", async () => {
    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["findingCandidate"])).toHaveLength(1);
    expect(unpooledQueues(["findingCandidate", "deadZoneMergeReview"])).toEqual([]);
  });

  test("keeps explicit provider pools as the source of truth even when route model differs", async () => {
    mocks.settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      providerPoolId: "local-llm-default",
      model: "local-c-model",
      fallback: [],
    };

    const { enabledProviderPoolsForQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["episodeDistiller"])[0]).toMatchObject({
      id: "local-llm-default",
      targets: [
        { provider: "local-llm", localLlmModelId: "local-a" },
        { provider: "local-llm", localLlmModelId: "local-b" },
      ],
    });
  });

  test("synthesizes direct provider routes only when no provider pool is configured", async () => {
    mocks.settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      providerPoolId: "local-llm-default",
      model: "local-c-model",
      fallback: [],
    };
    (mocks.settings.taskRouting.episodeDistiller as { providerPoolId?: string }).providerPoolId =
      undefined;

    const { enabledProviderPoolsForQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["episodeDistiller"])[0]).toMatchObject({
      id: "task-routing:local-llm",
      targets: [{ provider: "local-llm", localLlmModelId: "local-c" }],
    });
  });

  test("keeps finalizeDistille in the shared local pool after coveringEvidence", async () => {
    const { priorityQueuesForProviderPool } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(
      priorityQueuesForProviderPool({
        poolId: "local-llm-default",
        allowedQueues: ["coveringEvidence", "finalizeDistille"],
      }),
    ).toEqual(["coveringEvidence", "finalizeDistille"]);
  });

  test("falls back to legacy unpooled queue execution outside SQLite", async () => {
    mocks.backendKind = "postgres";
    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["findingCandidate"])).toEqual([]);
    expect(unpooledQueues(["findingCandidate", "coveringEvidence"])).toEqual([
      "findingCandidate",
      "coveringEvidence",
    ]);
  });

  test("does not hand a dynamic LARM route to the TypeScript worker", async () => {
    mocks.settings.taskRouting.episodeDistiller = {
      kind: "larm-agent-connection",
      connectionId: "contextstill-background",
    } as unknown as typeof mocks.settings.taskRouting.episodeDistiller;

    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["episodeDistiller"])).toEqual([]);
    expect(unpooledQueues(["episodeDistiller"])).toEqual([]);
  });

  test("fails closed for a mixed static and LARM provider pool", async () => {
    mocks.settings.providerPools[0].targets = [
      { provider: "local-llm", localLlmModelId: "local-a" },
      {
        provider: "larm-agent-connection",
        connectionId: "contextstill-background",
      },
    ] as (typeof mocks.settings.providerPools)[0]["targets"];

    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["episodeDistiller"])).toEqual([]);
    expect(unpooledQueues(["episodeDistiller"])).toEqual([]);
  });

  test("does not claim a dynamic vibe row through the static source pool", async () => {
    mocks.settings.taskRouting.findCandidate.vibe = {
      kind: "larm-agent-connection",
      connectionId: "contextstill-background",
    } as unknown as typeof mocks.settings.taskRouting.findCandidate.vibe;
    const { candidateUsesLarmRoute } = await import("../src/modules/queue/core/provider-lease.js");

    expect(
      candidateUsesLarmRoute({
        settings: mocks.settings as never,
        queueName: "findingCandidate",
        row: { source_kind: "vibe_memory" },
      }),
    ).toBe(true);
    expect(
      candidateUsesLarmRoute({
        settings: mocks.settings as never,
        queueName: "findingCandidate",
        row: { source_kind: "wiki_file" },
      }),
    ).toBe(false);
  });
});
