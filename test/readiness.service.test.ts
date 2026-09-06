import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkReadiness } from "../api/modules/health/readiness.service.js";
import { probePostgresDatabase } from "../src/db/client.js";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import { probeSqliteWriter } from "../src/db/sqlite/writer-client.js";

vi.mock("../src/db/client.js", () => ({ probePostgresDatabase: vi.fn() }));
vi.mock("../src/db/sqlite/runtime.js", () => ({ getRuntimeSqliteCoreDatabase: vi.fn() }));
vi.mock("../src/db/sqlite/writer-client.js", () => ({ probeSqliteWriter: vi.fn() }));

beforeEach(() => {
  vi.stubEnv("CONTEXT_STILL_DB_BACKEND", "sqlite");
  vi.mocked(probeSqliteWriter).mockResolvedValue(undefined);
  vi.mocked(getRuntimeSqliteCoreDatabase).mockResolvedValue({
    db: { query: () => ({ all: () => [] }) },
  } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("readiness dependency probes", () => {
  it("requires database schema and the authenticated writer", async () => {
    await expect(checkReadiness()).resolves.toEqual({ database: "ok", writer: "ok" });
    vi.mocked(getRuntimeSqliteCoreDatabase).mockRejectedValueOnce(
      new Error("missing /private/db secret=abc"),
    );
    await expect(checkReadiness()).resolves.toEqual({ database: "unavailable", writer: "ok" });
    vi.mocked(probeSqliteWriter).mockRejectedValueOnce(new Error("connection refused"));
    await expect(checkReadiness()).resolves.toEqual({ database: "ok", writer: "unavailable" });
    await expect(checkReadiness()).resolves.toEqual({ database: "ok", writer: "ok" });
  });

  it("bounds a stalled writer and aborts its transport", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(probeSqliteWriter).mockImplementation((value) => {
      signal = value;
      return new Promise(() => {});
    });
    const result = checkReadiness();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual({ database: "ok", writer: "unavailable" });
    expect(signal?.aborted).toBe(true);
  });

  it("checks PostgreSQL without requiring the SQLite writer", async () => {
    vi.stubEnv("CONTEXT_STILL_DB_BACKEND", "postgres");
    vi.mocked(probePostgresDatabase).mockRejectedValueOnce(new Error("offline"));
    await expect(checkReadiness()).resolves.toEqual({ database: "unavailable" });
    expect(probeSqliteWriter).not.toHaveBeenCalled();
  });
});
