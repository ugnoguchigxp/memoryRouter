import os from "node:os";
import path from "node:path";

function isDirectWriteTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined
  );
}

export function assertSafeDirectWriteTestPath(sqlitePath: string): void {
  if (!isDirectWriteTestRuntime()) return;
  if (process.env.CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS === "1") return;

  const relativeToTemp = path.relative(path.resolve(os.tmpdir()), path.resolve(sqlitePath));
  const isInsideTemp =
    relativeToTemp === "" ||
    (relativeToTemp !== ".." && !relativeToTemp.startsWith(`..${path.sep}`));
  if (isInsideTemp) return;

  throw new Error(
    [
      "Refusing to open a non-temporary SQLite database for direct writes from a test runtime.",
      "Set CONTEXT_STILL_SQLITE_CORE_PATH to a path under the OS temporary directory,",
      "or set CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS=1 explicitly.",
    ].join(" "),
  );
}
