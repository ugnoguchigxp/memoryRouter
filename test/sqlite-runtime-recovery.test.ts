import { afterEach, expect, it, vi } from "vitest";
import { openSqliteCoreDatabase } from "../src/db/sqlite/client.js";
import {
  getRuntimeSqliteCoreDatabase,
  resetRuntimeSqliteCoreDatabaseForTests,
} from "../src/db/sqlite/runtime.js";
vi.mock("../src/db/sqlite/client.js", () => ({ openSqliteCoreDatabase: vi.fn() }));
afterEach(() => {
  resetRuntimeSqliteCoreDatabaseForTests();
  vi.resetAllMocks();
});
it("retries opening SQLite after initialization fails while deduplicating opens", async () => {
  const database = { path: "/tmp/initialized.sqlite" };
  vi.mocked(openSqliteCoreDatabase)
    .mockRejectedValueOnce(new Error("not initialized"))
    .mockResolvedValueOnce(database as never);
  const first = getRuntimeSqliteCoreDatabase();
  expect(getRuntimeSqliteCoreDatabase()).toBe(first);
  await expect(first).rejects.toThrow("not initialized");
  await expect(getRuntimeSqliteCoreDatabase()).resolves.toBe(database);
  expect(openSqliteCoreDatabase).toHaveBeenCalledTimes(2);
});
