import { beforeEach, describe, expect, test, vi } from "vitest";
import { recoverFindingSystemMessageFailures } from "../src/modules/findCandidate/system-message-failure-recovery.service.js";

const mocks = vi.hoisted(() => ({
  backendKind: "sqlite" as "sqlite" | "postgres",
  all: vi.fn(),
  updateGet: vi.fn(),
  eventRun: vi.fn(),
  exec: vi.fn(),
  dbExecute: vi.fn(),
  txExecute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: mocks.dbExecute,
    transaction: mocks.transaction,
  },
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: async () => ({
    db: {
      query: (statement: string) => {
        if (/^\s*select/i.test(statement)) return { all: mocks.all };
        if (/^\s*update/i.test(statement)) return { get: mocks.updateGet };
        if (/^\s*insert/i.test(statement)) return { run: mocks.eventRun };
        throw new Error(`Unexpected SQL in test: ${statement}`);
      },
      exec: mocks.exec,
    },
  }),
}));

const matchingRow = {
  id: "finding-1",
  source_kind: "vibe_memory",
  source_key: "memory-1",
  attempt_count: 3,
  updated_at: "2026-07-24T11:45:23.943Z",
  last_error: "local-llm HTTP 400: System message must be at the beginning.",
};

describe("recoverFindingSystemMessageFailures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendKind = "sqlite";
    mocks.all.mockReturnValue([matchingRow]);
    mocks.updateGet.mockReturnValue({ id: "finding-1", status: "pending" });
    mocks.eventRun.mockReturnValue({ changes: 1 });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({ execute: mocks.txExecute }),
    );
  });

  test("dry-run lists matching failures without mutation", async () => {
    const result = await recoverFindingSystemMessageFailures({ mode: "dry-run", limit: 10 });

    expect(result).toMatchObject({ matched: 1, hasMore: false, requeued: 0, skipped: 0 });
    expect(result.items[0]).toMatchObject({ id: "finding-1", action: "would_requeue" });
    expect(mocks.updateGet).not.toHaveBeenCalled();
    expect(mocks.eventRun).not.toHaveBeenCalled();
  });

  test("write atomically rechecks the selected failure and records a scoped event", async () => {
    const result = await recoverFindingSystemMessageFailures({ mode: "write", limit: 1 });

    expect(result).toMatchObject({ matched: 1, hasMore: false, requeued: 1, skipped: 0 });
    expect(mocks.exec.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
    expect(mocks.updateGet).toHaveBeenCalledWith(
      "requeue after single-system-message compatibility fix",
      "requeue after single-system-message compatibility fix",
      expect.any(String),
      "finding-1",
      matchingRow.last_error,
      3,
      matchingRow.updated_at,
      "System message must be at the beginning",
    );
    const eventMetadata = JSON.parse(mocks.eventRun.mock.calls[0]?.[3] as string);
    expect(eventMetadata).toMatchObject({
      recoveryKind: "finding_system_message_compatibility",
      previousAttemptCount: 3,
      previousLastError: matchingRow.last_error,
      errorNeedle: "System message must be at the beginning",
    });
  });

  test("write reports rows that can no longer be retried as skipped", async () => {
    mocks.updateGet.mockReturnValue(null);

    const result = await recoverFindingSystemMessageFailures({ mode: "write", limit: 1 });

    expect(result).toMatchObject({ matched: 1, hasMore: false, requeued: 0, skipped: 1 });
    expect(result.items[0]).toMatchObject({ action: "skipped" });
    expect(mocks.eventRun).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
  });

  test("rolls back the queue transition when the audit event cannot be stored", async () => {
    mocks.eventRun.mockImplementation(() => {
      throw new Error("event insert failed");
    });

    await expect(recoverFindingSystemMessageFailures({ mode: "write", limit: 1 })).rejects.toThrow(
      "event insert failed",
    );

    expect(mocks.exec.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN IMMEDIATE",
      "ROLLBACK",
    ]);
  });

  test("uses a PostgreSQL transaction for the compare-and-set update and audit event", async () => {
    mocks.backendKind = "postgres";
    mocks.dbExecute.mockResolvedValue({ rows: [matchingRow] });
    mocks.txExecute
      .mockResolvedValueOnce({ rows: [{ id: "finding-1", status: "pending" }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await recoverFindingSystemMessageFailures({ mode: "write", limit: 1 });

    expect(result).toMatchObject({ matched: 1, hasMore: false, requeued: 1, skipped: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txExecute).toHaveBeenCalledTimes(2);
    const updateSql = renderSql(mocks.txExecute.mock.calls[0]?.[0]);
    const eventSql = renderSql(mocks.txExecute.mock.calls[1]?.[0]);
    expect(updateSql).toContain("and status = 'failed'");
    expect(updateSql).toContain("and last_error = ");
    expect(updateSql).toContain("and attempt_count = ");
    expect(updateSql).toContain("and updated_at = ");
    expect(eventSql).toContain("insert into distillation_queue_events");
  });

  test.each([0, 5_001, 1.5, Number.NaN])("rejects an invalid service limit: %s", async (limit) => {
    await expect(recoverFindingSystemMessageFailures({ mode: "dry-run", limit })).rejects.toThrow(
      "limit must be an integer between 1 and 5000",
    );
  });

  test("reports additional matches without exceeding the requested write limit", async () => {
    mocks.all.mockReturnValue([
      matchingRow,
      { ...matchingRow, id: "finding-2", source_key: "memory-2" },
    ]);

    const result = await recoverFindingSystemMessageFailures({ mode: "write", limit: 1 });

    expect(result).toMatchObject({ matched: 1, hasMore: true, requeued: 1 });
    expect(result.items).toHaveLength(1);
    expect(mocks.updateGet).toHaveBeenCalledTimes(1);
  });

  test("rejects an unknown service mode instead of treating it as write", async () => {
    await expect(
      recoverFindingSystemMessageFailures({ mode: "unknown" as "write", limit: 1 }),
    ).rejects.toThrow("mode must be dry-run or write");
    expect(mocks.all).not.toHaveBeenCalled();
    expect(mocks.updateGet).not.toHaveBeenCalled();
  });
});

function renderSql(value: unknown): string {
  if (!value || typeof value !== "object" || !("queryChunks" in value)) return String(value);
  return ((value as { queryChunks?: unknown[] }).queryChunks ?? [])
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const inner = (chunk as { value?: unknown }).value;
        return Array.isArray(inner) ? inner.join("") : String(inner ?? "");
      }
      return "";
    })
    .join("");
}
