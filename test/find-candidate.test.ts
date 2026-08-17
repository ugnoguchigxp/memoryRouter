import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { runFindCandidate } from "../src/modules/findCandidate/domain.js";
import {
  parseStorageCandidatesFromLlmOutput,
  parseStorageCandidatesWithDiagnostics,
} from "../src/modules/findCandidate/parser.js";

type RuntimeProviderName = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex";
type RuntimeRouteMock = {
  provider: string;
  model: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
};

const mocks = vi.hoisted(() => ({
  getDistillationTargetStateById: vi.fn(),
  readFileDomain: vi.fn(),
  readFilteredVibeMemoryForCandidateWindow: vi.fn(),
  runDistillationCompletion: vi.fn(),
  resolveDistillationModel: vi.fn(() => "test-model"),
  resolveRouteModelForProvider: vi.fn(
    (params: { routeModel?: string; localLlmModel?: string }) =>
      params.localLlmModel ?? params.routeModel ?? "test-model",
  ),
  ensureRuntimeSettingsLoaded: vi.fn(async () => {}),
  resolveFindCandidateRoute: vi.fn(
    (): RuntimeRouteMock => ({
      provider: "local-llm",
      model: "test-model",
      fallback: [] as RuntimeProviderName[],
    }),
  ),
  insertFindCandidateResult: vi.fn(),
  createEpisodeCard: vi.fn(),
  getEpisodeCardBySource: vi.fn(),
  recordAuditLogSafe: vi.fn(),
}));

const validProcedureBody = [
  "Use when:",
  "- Finalizing implementation changes.",
  "",
  "Workflow:",
  "1. Run smoke tests.",
  "2. Inspect returned evidence.",
  "",
  "Verification:",
  "- The smoke command passes.",
  "",
  "Avoid:",
  "- Finalizing without verification.",
].join("\n");

vi.mock("../src/modules/distillationTarget/repository.js", () => ({
  getDistillationTargetStateById: mocks.getDistillationTargetStateById,
}));

vi.mock("../src/modules/readFile/domain.js", () => ({
  readFileDomain: mocks.readFileDomain,
}));

vi.mock("../src/modules/findCandidate/vibe-memory-filter.js", () => ({
  readFilteredVibeMemoryForCandidateWindow: mocks.readFilteredVibeMemoryForCandidateWindow,
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  runDistillationCompletion: mocks.runDistillationCompletion,
  resolveDistillationModel: mocks.resolveDistillationModel,
  resolveRouteModelForProvider: mocks.resolveRouteModelForProvider,
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  insertFindCandidateResult: mocks.insertFindCandidateResult,
}));

vi.mock("../src/modules/episodic-memory/episode-card.repository.js", () => ({
  createEpisodeCard: mocks.createEpisodeCard,
  getEpisodeCardBySource: mocks.getEpisodeCardBySource,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    findCandidateStarted: "FIND_CANDIDATE_STARTED",
    findCandidateReaderUsed: "FIND_CANDIDATE_READER_USED",
    findCandidateCompleted: "FIND_CANDIDATE_COMPLETED",
    findCandidateFailed: "FIND_CANDIDATE_FAILED",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: mocks.ensureRuntimeSettingsLoaded,
  resolveFindCandidateRoute: mocks.resolveFindCandidateRoute,
}));

describe("runFindCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.distillation.findCandidateProvider = "local-llm";
    groupedConfig.distillation.findCandidateTimeoutMs = 600_000;
    groupedConfig.distillation.internalChunkedDistillationEnabled = false;
    groupedConfig.distillationTools.findCandidateMaxToolCalls = 8;
    mocks.resolveFindCandidateRoute.mockImplementation(
      (): RuntimeRouteMock => ({
        provider: groupedConfig.distillation.findCandidateProvider,
        model: "test-model",
        fallback: [] as RuntimeProviderName[],
      }),
    );
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-1",
      targetKind: "wiki_file",
      targetKey: "rules/testing.md",
    });
    mocks.readFileDomain.mockResolvedValue({
      content: "- Run smoke tests before finalizing implementation changes.",
      totalTokens: 20,
      from: 0,
      toExclusive: 20,
      returnedTokens: 20,
    });
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor(
        {
          id: "tool-1",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ fromToken: 0, readTokens: 20 }),
          },
        },
        {},
      );
      return {
        content: JSON.stringify({
          candidates: [
            {
              type: "procedure",
              polarity: "positive",
              title: "Run smoke tests before finalizing changes",
              content: validProcedureBody,
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      };
    });
    mocks.insertFindCandidateResult.mockResolvedValue({ id: "candidate-1" });
    mocks.getEpisodeCardBySource.mockResolvedValue(null);
    mocks.createEpisodeCard.mockResolvedValue({ id: "episode-1" });
  });

  test("provides only the target reader tool and records reads through the executor", async () => {
    const result = await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("汎用的に使える知識として体裁を整える"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Use when: / Workflow: / Verification: / Avoid:"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("失敗原因、修正方法、検証方法"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("negative の rule 候補として出す"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("完成済み rule/procedure 形式でなくても"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("source にない事実は補完せず"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("まず tool で本文を読んでください"),
          }),
        ]),
      }),
      expect.objectContaining({
        fallbackOrder: [],
        requireToolCall: true,
        usageSource: "find-candidate",
        toolDefinitions: [
          expect.objectContaining({
            function: expect.objectContaining({ name: "read_file" }),
          }),
        ],
      }),
    );
    expect(mocks.readFileDomain).toHaveBeenCalledWith(
      expect.objectContaining({ path: "rules/testing.md", fromToken: 0 }),
    );
    expect(result.insertedIds).toEqual(["candidate-1"]);
    expect(result.readRanges).toEqual([{ from: 0, toExclusive: 20 }]);
    expect(mocks.insertFindCandidateResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          type: "procedure",
          polarity: "positive",
        }),
      }),
    );
  });

  test("rejects negative procedure candidates before storage", async () => {
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor({
        id: "tool-1",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ fromToken: 0, readTokens: 20 }),
        },
      });
      return {
        content: JSON.stringify({
          candidates: [
            {
              type: "procedure",
              polarity: "negative",
              title: "Do not skip queue event checks",
              content: validProcedureBody,
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      };
    });

    const result = await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.insertFindCandidateResult).not.toHaveBeenCalled();
  });

  test("uses configured findCandidate timeout and tool-call limit", async () => {
    groupedConfig.distillation.findCandidateTimeoutMs = 123_000;
    groupedConfig.distillationTools.findCandidateMaxToolCalls = 12;

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxToolRounds: 12,
        timeoutMs: 123_000,
      }),
    );
  });

  test("reports exhausted reader evidence instead of leaking the runtime tool-loop error", async () => {
    groupedConfig.distillationTools.findCandidateMaxToolCalls = 8;
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      for (let index = 0; index < 8; index += 1) {
        await options.toolExecutor(
          {
            id: `tool-${index + 1}`,
            function: {
              name: "read_file",
              arguments: JSON.stringify({
                fromToken: index * 20,
                readTokens: 20,
              }),
            },
          },
          {},
        );
      }
      throw new Error("distillation tool loop exceeded max rounds (8)");
    });

    await expect(
      runFindCandidate({
        targetStateId: "target-1",
        callerMode: "storage",
        provider: "local-llm",
      }),
    ).rejects.toThrow(
      "findCandidate evidence_not_found: exhausted 8/8 reader tool calls without producing a final candidate response",
    );

    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "FIND_CANDIDATE_FAILED",
        payload: expect.objectContaining({
          error:
            "findCandidate evidence_not_found: exhausted 8/8 reader tool calls without producing a final candidate response",
        }),
      }),
    );
  });

  test("defaults wiki candidate extraction to the configured findCandidate provider", async () => {
    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
      }),
      expect.objectContaining({
        providerSetting: "local-llm",
      }),
    );
  });

  test("allows OpenAI/Azure candidate extraction by provider setting", async () => {
    groupedConfig.distillation.findCandidateProvider = "azure-openai";

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
      }),
      expect.objectContaining({
        fallbackOrder: [],
        providerSetting: "azure-openai",
      }),
    );
  });

  test("passes configured task-route fallback order when provider is not explicitly overridden", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "openai",
      model: "test-model",
      fallback: ["local-llm", "bedrock"] as RuntimeProviderName[],
    });

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        providerSetting: "openai",
        fallbackOrder: ["local-llm", "bedrock"],
      }),
    );
  });

  test("passes configured Azure deployment slots when provider is not explicitly overridden", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "azure-openai",
      model: "test-model",
      fallback: ["local-llm"] as RuntimeProviderName[],
      azureDeploymentSlots: [2],
    });

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        providerSetting: "azure-openai",
        azureDeploymentSlots: [2],
      }),
    );
  });

  test("preloads wiki content before Codex candidate extraction and passes the configured Codex model", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "codex",
      model: "gpt-5.4-mini",
      fallback: [] as RuntimeProviderName[],
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "procedure",
            polarity: "positive",
            title: "Run smoke tests before finalizing changes",
            content: validProcedureBody,
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      readTokens: 50,
    });

    expect(mocks.resolveDistillationModel).not.toHaveBeenCalledWith("codex");
    expect(mocks.readFileDomain).toHaveBeenCalledWith({
      path: "rules/testing.md",
      fromToken: 0,
      readTokens: 50,
      minify: true,
    });
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4-mini",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "read_file",
            content: expect.stringContaining("Run smoke tests"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("read_file tool result"),
          }),
        ]),
      }),
      expect.objectContaining({
        providerSetting: "codex",
        requireToolCall: false,
        maxToolRounds: 7,
      }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.readRanges).toEqual([{ from: 0, toExclusive: 20 }]);
  });

  test("combines finding instructions into one leading system message", async () => {
    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0];
    const messages = request?.messages ?? [];
    const systemMessages = messages.filter(
      (message: { role: string }) => message.role === "system",
    );

    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toEqual(
      expect.stringContaining("汎用的に使える知識として体裁を整える"),
    );
    expect(systemMessages[0]?.content).toEqual(
      expect.stringContaining("Use when: / Workflow: / Verification: / Avoid:"),
    );
    expect(messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
  });

  test("fails when the LLM returns candidates without using the reader tool", async () => {
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({ candidates: [] }),
      toolEvents: [],
      messages: [],
    });

    await expect(
      runFindCandidate({
        targetStateId: "target-1",
        callerMode: "storage",
        provider: "local-llm",
      }),
    ).rejects.toThrow("findCandidate reader tool was not used");
    expect(mocks.readFileDomain).not.toHaveBeenCalled();
  });

  test("preloads vibe memory with memory_reader before asking the LLM for candidates", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
      sourceUri: "vibe_memory:memory-1",
      metadata: { sessionTitle: "Rust daemon migration workbook" },
    });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content:
        "ASSISTANT: For memoryRouter distillation checks, inspect launchd, logs, queue, and DB before changing code.",
      totalTokens: 24,
      from: 0,
      toExclusive: 24,
      returnedTokens: 24,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "positive",
            title: "Check live distillation state before changing code",
            content:
              "When memoryRouter distillation appears stalled, inspect launchd, logs, queue, and DB state before changing code.",
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
      readTokens: 50,
      maxReads: 2,
      memoryReaderMode: "original",
    });

    expect(mocks.readFilteredVibeMemoryForCandidateWindow).toHaveBeenCalledWith({
      vibeMemoryId: "memory-1",
      fromToken: 0,
      readTokens: 50,
    });
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("filtered vibe memory content"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("会話が進捗報告中心でも"),
          }),
          expect.objectContaining({
            role: "tool",
            name: "memory_reader",
            content: expect.stringContaining("launchd"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("明確な再利用可能 signal がない場合だけ []"),
          }),
        ]),
      }),
      expect.objectContaining({
        requireToolCall: false,
        maxToolRounds: 1,
        usageSource: "find-candidate",
      }),
    );
    const vibeMessages = mocks.runDistillationCompletion.mock.calls[0]?.[0]?.messages ?? [];
    expect(vibeMessages.map((message: { role: string }) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(
      vibeMessages.filter((message: { role: string }) => message.role === "system"),
    ).toHaveLength(1);
    expect(result.readRanges).toEqual([{ from: 0, toExclusive: 24 }]);
    expect(result.insertedIds).toEqual(["candidate-1"]);
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not use chunked candidate generation for vibe memory even when internal chunking is enabled", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content:
        "[filtered_vibe_memory]\n[messages]\nASSISTANT: Queue stalled because the stale worker held a lease.",
      totalTokens: 18,
      from: 0,
      toExclusive: 18,
      returnedTokens: 18,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "negative",
            title: "Do not trust queue counts without worker ownership",
            content:
              "When queue processing stalls, verify live worker ownership and stale leases before treating queue counts as progress.",
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        usageSource: "find-candidate",
      }),
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: "Do not trust queue counts without worker ownership",
      }),
    ]);
  });

  test("does not write a vibe memory episode for cli_text unless requested", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content: "ASSISTANT: task completed with no durable candidate.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not write a vibe memory episode even when requested", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content: "ASSISTANT: inspect logs and DB before changing queue code.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
      writeEpisode: true,
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("uses vibe memory title when no session title is available", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content: "ASSISTANT: inspect logs and DB before changing queue code.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not look up existing vibe memory episodes during findCandidate", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.getEpisodeCardBySource.mockResolvedValue({ id: "episode-existing" });
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content: "ASSISTANT: existing task episode should be reused.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not create vibe memory episodes from storage mode", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.getEpisodeCardBySource
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "episode-concurrent" });
    mocks.createEpisodeCard.mockRejectedValueOnce(new Error("duplicate key value"));
    mocks.readFilteredVibeMemoryForCandidateWindow.mockResolvedValue({
      content: "ASSISTANT: concurrent task episode should be reused after insert race.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
  });

  test("allows additional vibe memory reads after the deterministic first read", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readFilteredVibeMemoryForCandidateWindow
      .mockResolvedValueOnce({
        content: "first memory window",
        totalTokens: 100,
        from: 0,
        toExclusive: 50,
        returnedTokens: 50,
      })
      .mockResolvedValueOnce({
        content: "second memory window",
        totalTokens: 100,
        from: 50,
        toExclusive: 100,
        returnedTokens: 50,
      });
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor({
        id: "tool-2",
        function: {
          name: "memory_reader",
          arguments: JSON.stringify({
            fromToken: "50",
            readTokens: "50",
            mode: "compressed",
          }),
        },
      });
      return {
        content: JSON.stringify({ candidates: [] }),
        toolEvents: [],
        messages: [],
      };
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
      readTokens: 50,
      maxReads: 2,
    });

    expect(mocks.readFilteredVibeMemoryForCandidateWindow).toHaveBeenCalledTimes(2);
    expect(result.readRanges).toEqual([
      { from: 0, toExclusive: 50 },
      { from: 50, toExclusive: 100 },
    ]);
    expect(result.parseDiagnostics).toMatchObject({
      rawWasEmptyArray: true,
      rawCandidateLikeCount: 0,
      plainTextFallbackUsed: false,
    });
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "FIND_CANDIDATE_COMPLETED",
        payload: expect.objectContaining({
          candidateCount: 0,
          noCandidateDiagnostics: expect.objectContaining({
            llmOutputPreview: expect.stringContaining("candidates"),
            parseDiagnostics: expect.objectContaining({
              rawCandidateLikeCount: 0,
            }),
          }),
        }),
      }),
    );
  });
});

describe("parseStorageCandidatesFromLlmOutput", () => {
  test("repairs a truncated candidates container from local LLM output", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      '{"candidates":[{"type":"rule","polarity":"positive","title":"Keep verification concrete","content":"Run the smoke command and preserve returned evidence."}',
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        polarity: "positive",
        title: "Keep verification concrete",
        content: "Run the smoke command and preserve returned evidence.",
      },
    ]);
  });

  test("keeps rule/procedure type hints when the LLM provides them", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "procedure",
            polarity: "positive",
            title: "Run focused verify before finalizing",
            content: validProcedureBody,
          },
        ],
      }),
    );

    expect(candidates).toEqual([
      {
        type: "procedure",
        polarity: "positive",
        title: "Run focused verify before finalizing",
        content: validProcedureBody,
      },
    ]);
  });

  test("drops procedure candidates with empty required skill-like sections", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "procedure",
            polarity: "positive",
            title: "Run focused verify before finalizing",
            content: [
              "Use when:",
              "- Finalizing implementation changes.",
              "",
              "Workflow:",
              "1. Run smoke tests.",
              "2. Inspect returned evidence.",
              "",
              "Verification:",
              "",
              "Avoid:",
              "",
            ].join("\n"),
          },
        ],
      }),
    );

    expect(candidates).toEqual([]);
  });

  test("keeps negative polarity hints when the LLM provides them", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "negative",
            title: "Do not trust stale queue status alone",
            content:
              "Queue diagnosis must not treat an old status row as current truth without checking recent events.",
          },
        ],
      }),
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        polarity: "negative",
        title: "Do not trust stale queue status alone",
        content:
          "Queue diagnosis must not treat an old status row as current truth without checking recent events.",
      },
    ]);
  });

  test("ignores sourceSummary from JSON output", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        type: "rule",
        polarity: "positive",
        title: "Keep summaries short",
        content: "findCandidate should store concise source summaries.",
        sourceSummary: `start ${"x".repeat(1500)}`,
      }),
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        polarity: "positive",
        title: "Keep summaries short",
        content: "findCandidate should store concise source summaries.",
      },
    ]);
  });

  test("accepts a flat single-candidate JSON object", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        type: "rule",
        polarity: "positive",
        title: "Prefer flat output",
        body: "Local LLM output should stay flat and omit non-essential fields.",
      }),
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        polarity: "positive",
        title: "Prefer flat output",
        content: "Local LLM output should stay flat and omit non-essential fields.",
      },
    ]);
  });

  test("falls back to plain text candidate blocks when JSON parsing fails", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      [
        "TYPE: procedure",
        "POLARITY: positive",
        "TITLE: Verify pipeline before finalize",
        "CONTENT:",
        validProcedureBody,
      ].join("\n"),
    );
    expect(candidates).toEqual([
      {
        type: "procedure",
        polarity: "positive",
        title: "Verify pipeline before finalize",
        content: validProcedureBody,
      },
    ]);
  });

  test("drops candidates without type or polarity", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Missing polarity",
            content: "This candidate has no polarity.",
          },
          {
            polarity: "positive",
            title: "Missing type",
            content: "This candidate has no type.",
          },
        ],
      }),
    );

    expect(candidates).toEqual([]);
  });

  test("drops neutral and negative procedure candidates", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "neutral",
            title: "Neutral candidate",
            content: "Neutral candidates are outside the findCandidate contract.",
          },
          {
            type: "procedure",
            polarity: "negative",
            title: "Negative procedure",
            content: validProcedureBody,
          },
        ],
      }),
    );

    expect(candidates).toEqual([]);
  });

  test("drops procedure candidates without skill-like sections", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        type: "procedure",
        polarity: "positive",
        title: "Loose procedure",
        content: "First run tests, then inspect output.",
      }),
    );

    expect(candidates).toEqual([]);
  });

  test("reports no-candidate parser diagnostics for rejected candidate-like output", () => {
    const result = parseStorageCandidatesWithDiagnostics(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Missing polarity",
            content: "This candidate has no polarity.",
          },
          {
            type: "procedure",
            polarity: "negative",
            title: "Negative procedure",
            content: validProcedureBody,
          },
          {
            type: "procedure",
            polarity: "positive",
            title: "Loose procedure",
            content: "First run tests, then inspect output.",
          },
        ],
      }),
    );

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rawWasEmptyArray: false,
      rawCandidateLikeCount: 3,
      droppedMissingPolarity: 1,
      droppedNegativeProcedure: 1,
      droppedInvalidProcedureShape: 1,
      plainTextFallbackUsed: true,
    });
  });

  test("distinguishes a real empty JSON array from parser rejection", () => {
    const result = parseStorageCandidatesWithDiagnostics("[]");

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rawWasEmptyArray: true,
      rawCandidateLikeCount: 0,
      plainTextFallbackUsed: false,
    });
  });

  test("treats an empty candidates container as a real empty result", () => {
    const result = parseStorageCandidatesWithDiagnostics(JSON.stringify({ candidates: [] }));

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      rawWasEmptyArray: true,
      rawCandidateLikeCount: 0,
      plainTextFallbackUsed: false,
    });
  });

  test("accepts rule, procedure, and negative rule outputs from unformatted work-log signals", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "positive",
            title: "Check live runtime truth before status summaries",
            content:
              "When diagnosing queue or daemon state, verify live DB rows, LaunchAgent/process ownership, and recent events instead of relying on a stale status summary.",
          },
          {
            type: "procedure",
            polarity: "positive",
            title: "Recover a stale queue worker from runtime evidence",
            content: [
              "Use when:",
              "- Queue work appears stuck and there is runtime evidence available.",
              "",
              "Workflow:",
              "1. Back up the database or confirm a rollback point.",
              "2. Compare queue rows, recent events, worker heartbeat, and process ownership.",
              "3. Restart only the stale worker or lease owner identified by the evidence.",
              "",
              "Verification:",
              "- New heartbeat and queue event rows appear for the intended target.",
              "",
              "Avoid:",
              "- Treating old status output as current truth without live DB or process checks.",
            ].join("\n"),
          },
          {
            type: "rule",
            polarity: "negative",
            title: "Do not force task routing to one target for convenience",
            content:
              "Do not pin task routing to a single Local LLM target merely to prioritize findCandidate or coverEvidence; preserve the configured pool unless evidence shows the route is wrong.",
          },
        ],
      }),
    );

    expect(candidates.map((candidate) => [candidate.type, candidate.polarity])).toEqual([
      ["rule", "positive"],
      ["procedure", "positive"],
      ["rule", "negative"],
    ]);
  });
});
