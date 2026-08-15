import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { db } from "../src/db/client.js";
import {
  ingestAntigravityLogs,
  ingestClaudeLogs,
  ingestCodexLogs,
} from "../src/modules/agent-log-sync/ingest.service.js";
import {
  hasTargetedNightWorkersRuntimeContract,
  mergeMessageMetadata,
  sanitizeNightWorkersRuntimeContractChunk,
  sanitizeNightWorkersRuntimeContractMessage,
} from "../src/modules/agent-log-sync/sync.service.helpers.js";
import {
  buildReadableTranscript,
  chunkMessages,
  filterDistillableAgentLogMessages,
  isCodexInternalProviderPromptMessage,
  isNonDistillableAgentTaskLogMessage,
  shouldDeleteLegacyAntigravityVibeMemories,
  syncAllAgentLogs,
} from "../src/modules/agent-log-sync/sync.service.js";

vi.mock("../src/modules/agent-log-sync/ingest.service.js");
vi.mock("../src/db/client.js", () => {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(() => [{ id: "inserted-id" }]),
  };
  const mockInsert = vi.fn(() => chain);

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => []),
        })),
      })),
      insert: mockInsert,
      transaction: vi.fn((cb) => cb({ insert: mockInsert })),
    },
  };
});

function nightWorkersRuntimeContractPrompt(prefix = "実装タスク履歴を残してください。") {
  return [
    prefix,
    "",
    "[NightWorkers Runtime Contract]",
    "taskId: task-impl-1",
    "runId: run-impl-1",
    "repoRoot: /Users/y.noguchi/Code/example",
    "executionMode: implementation",
    "NightWorkers MCP:",
    "- MCP server name: nightworkers",
    "Minimal implementation behavior:",
    "- Use nightworkers.todo_list as the single Todo control tool.",
  ].join("\n");
}

describe("Agent Log Sync Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTEXT_STILL_DELETE_LEGACY_ANTIGRAVITY_VIBE_MEMORIES = undefined;
    process.env.MEMORY_ROUTER_DELETE_LEGACY_ANTIGRAVITY_VIBE_MEMORIES = undefined;
    groupedConfig.agentLogSync.excludedProjectNames = [];
    groupedConfig.agentLogSync.excludedSessionIds = [];
    groupedConfig.agentLogSync.excludedSessionTitleContains = [];
    groupedConfig.agentLogSync.minDistillableChars = 0;
    vi.mocked(ingestAntigravityLogs).mockResolvedValue({
      ok: true,
      messages: [],
      cursor: {},
      checkedFiles: 0,
      errors: [],
      warnings: [],
      skipped: true,
    } as any);
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [],
      cursor: {},
      checkedFiles: 0,
      errors: [],
      warnings: [],
      skipped: true,
    } as any);
    vi.mocked(ingestClaudeLogs).mockResolvedValue({
      ok: true,
      messages: [],
      cursor: {},
      checkedFiles: 0,
      errors: [],
      warnings: [],
      skipped: true,
    } as any);
  });

  test("chunkMessages splits by count and size", () => {
    const messages = [
      { role: "user", content: "Hello", metadata: {} },
      { role: "assistant", content: "Hi", metadata: {} },
      { role: "user", content: "Long message ".repeat(10), metadata: {} },
    ] as any;

    const chunks = chunkMessages(messages, 2, 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2); // Hello + Hi = ~7 chars < 20, but count limit reached
    expect(chunks[1]).toHaveLength(1); // Long message
  });

  test("buildReadableTranscript strips diffs and empty lines", () => {
    const messages = [
      {
        role: "user",
        content:
          "Check this diff:\ndiff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
        metadata: { messageKind: "chat" },
      },
      {
        role: "assistant",
        content: "Got it.",
        metadata: { messageKind: "chat" },
      },
    ] as any;

    const transcript = buildReadableTranscript(messages);
    expect(transcript).toContain("USER: Check this diff:");
    expect(transcript).not.toContain("diff --git");
    expect(transcript).toContain("ASSISTANT: Got it.");
  });

  test("syncAllAgentLogs handles ingest failure", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: false,
      errors: ["Ingest failed"],
      warnings: [],
      messages: [],
      cursor: {},
      maxObservedMtimeMs: 0,
      checkedFiles: 0,
    } as any);

    const summary = await syncAllAgentLogs();
    expect(summary.ok).toBe(false);
    expect(summary.sources[0].errors).toContain("Ingest failed");
  });

  test("deduplicates vibe memories", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "M1",
          metadata: {
            sessionId: "s1",
            timestamp: new Date().toISOString(),
            projectRoot: "/repo/context-still",
          },
        },
        {
          role: "user",
          content: "M2",
          metadata: {
            sessionId: "s2",
            timestamp: new Date().toISOString(),
            projectRoot: "/repo/context-still",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    // First vibeMemory insert succeeds, its episode job is enqueued, second memory is deduped.
    const chain = db.insert({} as any) as any;

    chain.returning
      .mockResolvedValueOnce([{ id: "m1" }]) // Vibe 1
      .mockResolvedValueOnce([{ id: "e1" }]) // Episode distiller job for Vibe 1
      .mockResolvedValueOnce([]); // Vibe 2 (dedupe)

    const summary = await syncAllAgentLogs();
    expect(summary.imported).toBe(1);
  });

  test("syncAllAgentLogs skips configured excluded projects before storing memories", async () => {
    groupedConfig.agentLogSync.excludedProjectNames = ["nightworkers-codex-supervisor-decisions"];
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "Noisy SDK task",
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightworkers-codex-supervisor-decisions",
            sessionId: "sdk-session",
          },
        },
        {
          role: "user",
          content: "Keep normal session",
          metadata: {
            sourceId: "codex_logs",
            projectName: "contextStill",
            projectRoot: "/repo/context-still",
            sessionId: "normal-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(1);
    expect(summary.sources.find((source) => source.id === "codex_logs")?.messages).toBe(1);
  });

  test("does not infer repository identity from projectName or cwd", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "Do not infer this repository",
          metadata: {
            sourceId: "codex_logs",
            projectName: "contextStill",
            cwd: "/repo/context-still",
            sessionId: "identity-less-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(0);
    expect(summary.sources.flatMap((source) => source.warnings).join("\n")).toContain(
      "without valid identity",
    );
  });

  test("syncAllAgentLogs skips short chunks below the distillable character threshold", async () => {
    groupedConfig.agentLogSync.minDistillableChars = 2000;
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "short status update",
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightWorkers",
            projectRoot: "/repo/nightworkers",
            sessionId: "short-session",
          },
        },
        {
          role: "user",
          content: "valuable context ".repeat(160),
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightWorkers",
            projectRoot: "/repo/nightworkers",
            sessionId: "long-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(1);
    expect(summary.sources.find((source) => source.id === "codex_logs")?.messages).toBe(2);
  });

  test("syncAllAgentLogs does not let large diff-only chunks bypass the text threshold", async () => {
    groupedConfig.agentLogSync.minDistillableChars = 2000;
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "assistant",
          content: [
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1 +1 @@",
            "-old",
            `+${"new line ".repeat(400)}`,
          ].join("\n"),
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightWorkers",
            sessionId: "diff-only-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(0);
    expect(summary.insertedDiffs).toBe(0);
    expect(summary.sources.find((source) => source.id === "codex_logs")?.messages).toBe(1);
  });

  test("syncAllAgentLogs stores NightWorkers implementation history without Runtime Contract", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: nightWorkersRuntimeContractPrompt(
            "実装依頼: 保存前 sanitizer を追加してください。",
          ),
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightWorkers",
            projectRoot: "/repo/nightworkers",
            sessionId: "nightworkers-impl-session",
          },
        },
        {
          role: "assistant",
          content: "sanitize 処理を追加し、テストを実行しました。",
          metadata: {
            sourceId: "codex_logs",
            projectName: "nightWorkers",
            projectRoot: "/repo/nightworkers",
            sessionId: "nightworkers-impl-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const chain = db.insert({} as any) as any;
    chain.returning
      .mockResolvedValueOnce([{ id: "memory-nightworkers" }])
      .mockResolvedValueOnce([]);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(1);
    const memoryInsert = chain.values.mock.calls.find(([value]: [Record<string, unknown>]) =>
      Object.prototype.hasOwnProperty.call(value, "content"),
    )?.[0] as { content: string; metadata: Record<string, unknown> } | undefined;

    expect(memoryInsert).toBeDefined();
    expect(memoryInsert?.content).toContain("実装依頼: 保存前 sanitizer を追加してください。");
    expect(memoryInsert?.content).toContain("sanitize 処理を追加し、テストを実行しました。");
    expect(memoryInsert?.content).not.toContain("[NightWorkers Runtime Contract]");
    expect(memoryInsert?.metadata).toMatchObject({
      rawMessageCount: 2,
      messageCount: 2,
      nightWorkersRuntimeContractStripped: true,
      nightWorkersRuntimeContractStrippedCount: 1,
      nightWorkersRuntimeContractExecutionMode: "implementation",
      nightWorkersTaskId: "task-impl-1",
      nightWorkersRunId: "run-impl-1",
    });
  });

  test("buildReadableTranscript excludes tool calls", () => {
    const messages = [
      {
        role: "assistant",
        content: "calling tool",
        metadata: { messageKind: "tool_call" },
      },
      {
        role: "assistant",
        content: "Result",
        metadata: { messageKind: "chat" },
      },
    ] as any;
    const transcript = buildReadableTranscript(messages);
    expect(transcript).not.toContain("calling tool");
    expect(transcript).toContain("ASSISTANT: Result");
  });

  test("sanitizes only NightWorkers implementation Runtime Contract while keeping task history", () => {
    const message = {
      role: "user" as const,
      content: nightWorkersRuntimeContractPrompt("ユーザー依頼: API のバグを直してください。"),
      metadata: { sourceId: "codex_logs", sessionId: "nightworkers-session" },
    };

    expect(hasTargetedNightWorkersRuntimeContract(message.content)).toBe(true);

    const sanitized = sanitizeNightWorkersRuntimeContractMessage(message);

    expect(sanitized).not.toBeNull();
    expect(sanitized?.content).toBe("ユーザー依頼: API のバグを直してください。");
    expect(sanitized?.content).not.toContain("[NightWorkers Runtime Contract]");
    expect(sanitized?.metadata).toMatchObject({
      nightWorkersRuntimeContractStripped: true,
      nightWorkersRuntimeContractExecutionMode: "implementation",
      nightWorkersTaskId: "task-impl-1",
      nightWorkersRunId: "run-impl-1",
    });
  });

  test("does not sanitize non-implementation NightWorkers Runtime Contract lanes", () => {
    const message = {
      role: "user" as const,
      content: nightWorkersRuntimeContractPrompt("計画だけ確認してください。").replace(
        "executionMode: implementation",
        "executionMode: planning",
      ),
      metadata: { sourceId: "codex_logs", sessionId: "nightworkers-session" },
    };

    expect(hasTargetedNightWorkersRuntimeContract(message.content)).toBe(false);
    expect(sanitizeNightWorkersRuntimeContractMessage(message)).toEqual(message);
  });

  test("sanitizes Runtime Contract fields with label spacing", () => {
    const message = {
      role: "user" as const,
      content: nightWorkersRuntimeContractPrompt("空白つき field の実装依頼です。")
        .replace("taskId:", " taskId :")
        .replace("runId:", " runId :")
        .replace("executionMode:", " executionMode :"),
      metadata: { sourceId: "codex_logs", sessionId: "nightworkers-session" },
    };

    const sanitized = sanitizeNightWorkersRuntimeContractMessage(message);

    expect(sanitized?.content).toBe("空白つき field の実装依頼です。");
    expect(sanitized?.metadata).toMatchObject({
      nightWorkersRuntimeContractExecutionMode: "implementation",
      nightWorkersTaskId: "task-impl-1",
      nightWorkersRunId: "run-impl-1",
    });
  });

  test("drops contract-only implementation Runtime Contract messages", () => {
    const message = {
      role: "user" as const,
      content: nightWorkersRuntimeContractPrompt("").trim(),
      metadata: { sourceId: "codex_logs", sessionId: "nightworkers-session" },
    };

    expect(sanitizeNightWorkersRuntimeContractMessage(message)).toBeNull();
  });

  test("sanitizes after chunking so raw chunk identity can be preserved", () => {
    const messages = [
      {
        role: "user" as const,
        content: nightWorkersRuntimeContractPrompt("重要な実装依頼です。"),
        metadata: {
          sourceId: "codex_logs",
          sessionId: "nightworkers-session",
          projectName: "nightWorkers",
        },
      },
      {
        role: "assistant" as const,
        content: "修正して verify しました。",
        metadata: {
          sourceId: "codex_logs",
          sessionId: "nightworkers-session",
          projectName: "nightWorkers",
        },
      },
    ];
    const rawChunks = chunkMessages(messages, 2, nightWorkersRuntimeContractPrompt().length + 1000);

    expect(rawChunks).toHaveLength(1);

    const sanitizedChunk = sanitizeNightWorkersRuntimeContractChunk(rawChunks[0]);
    const metadata = mergeMessageMetadata({ id: "codex_logs", label: "Codex" }, sanitizedChunk, {
      rawMessageCount: rawChunks[0].length,
    });

    expect(sanitizedChunk).toHaveLength(2);
    expect(metadata).toMatchObject({
      rawMessageCount: 2,
      messageCount: 2,
      nightWorkersRuntimeContractStripped: true,
      nightWorkersRuntimeContractStrippedCount: 1,
      nightWorkersRuntimeContractExecutionMode: "implementation",
      nightWorkersTaskId: "task-impl-1",
      nightWorkersRunId: "run-impl-1",
    });
    expect(buildReadableTranscript(sanitizedChunk)).not.toContain(
      "[NightWorkers Runtime Contract]",
    );
  });

  test("identifies Antigravity background task log messages as non-distillable", () => {
    expect(
      isNonDistillableAgentTaskLogMessage({
        role: "assistant",
        content: [
          "Created At: 2026-05-22T05:20:27Z",
          "Tool is running as a background task with task id: session/task-240",
          "Task Description: build check",
          "Log: /Users/y.noguchi/.gemini/antigravity/task-240.log",
        ].join("\n"),
        metadata: { sourceId: "antigravity_logs", projectName: "task-240.log" },
      }),
    ).toBe(true);

    expect(
      isNonDistillableAgentTaskLogMessage({
        role: "assistant",
        content:
          "Created At: 2026-05-22T05:20:27Z\nTask: session/task-240\nStatus: DONE\nLog: /tmp/task-240.log",
        metadata: { sourceId: "antigravity_logs" },
      }),
    ).toBe(true);
  });

  test("identifies Codex provider internal prompts as non-distillable", () => {
    const message = {
      role: "user" as const,
      content: [
        "[System Instructions]",
        "Return JSON for this task.",
        "",
        "[User]",
        "ping",
        "",
        "[Instructions]",
        "Based on the instructions and history above, generate the final response. Output only the requested content/JSON structure directly, without markdown blocks or conversational text outside the format.",
      ].join("\n"),
      metadata: {
        sourceId: "codex_logs",
        sessionId: "codex-provider-session",
      },
    };

    expect(isCodexInternalProviderPromptMessage(message)).toBe(true);
    expect(isNonDistillableAgentTaskLogMessage(message)).toBe(true);
  });

  test("keeps legacy Antigravity memory cleanup opt-in", () => {
    expect(shouldDeleteLegacyAntigravityVibeMemories()).toBe(false);

    process.env.CONTEXT_STILL_DELETE_LEGACY_ANTIGRAVITY_VIBE_MEMORIES = "1";
    expect(shouldDeleteLegacyAntigravityVibeMemories()).toBe(true);
  });

  test("filterDistillableAgentLogMessages drops Codex provider prompt and immediate response only", () => {
    const messages = [
      {
        role: "user" as const,
        content: [
          "[System Instructions]",
          "Return JSON for this task.",
          "",
          "[User]",
          "ping",
          "",
          "[Instructions]",
          "Based on the instructions and history above, generate the final response. Output only the requested content/JSON structure directly, without markdown blocks or conversational text outside the format.",
        ].join("\n"),
        metadata: { sourceId: "codex_logs", sessionId: "internal-session" },
      },
      {
        role: "assistant" as const,
        content: '{"type":"rule","title":"noise","content":"prompt-derived"}',
        metadata: { sourceId: "codex_logs", sessionId: "internal-session" },
      },
      {
        role: "user" as const,
        content: "[System Instructions] という文字列をREADMEで説明してください",
        metadata: { sourceId: "codex_logs", sessionId: "normal-session" },
      },
      {
        role: "assistant" as const,
        content: "説明しました。",
        metadata: { sourceId: "codex_logs", sessionId: "normal-session" },
      },
    ];

    expect(filterDistillableAgentLogMessages(messages)).toEqual(messages.slice(2));
  });

  test("syncAllAgentLogs skips background task log messages", async () => {
    vi.mocked(ingestAntigravityLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "assistant",
          content: [
            "Created At: 2026-05-22T05:20:27Z",
            "Tool is running as a background task with task id: session/task-240",
            "Task Description: build check",
            "Log: /Users/y.noguchi/.gemini/antigravity/task-240.log",
          ].join("\n"),
          metadata: {
            sourceId: "antigravity_logs",
            projectName: "task-240.log",
            sessionId: "antigravity-session",
          },
        },
        {
          role: "user",
          content: "Keep this real user request",
          metadata: {
            sourceId: "antigravity_logs",
            projectName: "memoryRouter",
            projectRoot: "/repo/memory-router",
            sessionId: "antigravity-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 4000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(1);
    expect(summary.sources.find((source) => source.id === "antigravity_logs")?.messages).toBe(1);
  });

  test("syncAllAgentLogs skips Codex provider internal prompt records", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: [
            "[System Instructions]",
            "Return JSON for this task.",
            "",
            "[User]",
            "ping",
            "",
            "[Instructions]",
            "Based on the instructions and history above, generate the final response. Output only the requested content/JSON structure directly, without markdown blocks or conversational text outside the format.",
          ].join("\n"),
          metadata: {
            sourceId: "codex_logs",
            projectName: "contextStill",
            sessionId: "internal-session",
          },
        },
        {
          role: "assistant",
          content: '{"ok":true}',
          metadata: {
            sourceId: "codex_logs",
            projectName: "contextStill",
            sessionId: "internal-session",
          },
        },
        {
          role: "user",
          content: "Keep this real Codex user request",
          metadata: {
            sourceId: "codex_logs",
            projectName: "contextStill",
            projectRoot: "/repo/context-still",
            sessionId: "normal-session",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 4500,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();

    expect(summary.imported).toBe(1);
    expect(summary.sources.find((source) => source.id === "codex_logs")?.messages).toBe(1);
  });

  test("syncAllAgentLogs redacts secrets before storing memories and metadata", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789\nKeep this line",
          metadata: {
            sessionId: "s1",
            timestamp: new Date().toISOString(),
            projectRoot: "/repo/context-still",
            authToken: "raw-token-value",
            toolCalls: [
              {
                name: "apply_patch",
                targetFile: "secret.ts",
                contentPreview: "password=super-secret-value",
              },
            ],
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 5000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    await syncAllAgentLogs();

    const insertChain = vi.mocked(db.insert).mock.results[0]?.value as any;
    const serialized = JSON.stringify(insertChain.values.mock.calls);
    expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
    expect(serialized).toContain("Keep this line");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("super-secret-value");
  });

  test("syncAllAgentLogs inserts diff entries", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "assistant",
          content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
          metadata: {
            sessionId: "s1",
            timestamp: new Date().toISOString(),
            projectRoot: "/repo/context-still",
          },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 3000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();
    expect(summary.insertedDiffs).toBeGreaterThan(0);
  });
});
