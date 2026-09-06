import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { probePostgresDatabase } from "../../../src/db/client.js";
import { getRuntimeSqliteCoreDatabase } from "../../../src/db/sqlite/runtime.js";
import { probeSqliteWriter } from "../../../src/db/sqlite/writer-client.js";

export type ReadinessChecks = {
  database: "ok" | "unavailable";
  writer?: "ok" | "unavailable";
};

// Resolve required tables/columns without scanning records or invoking providers.
export const READINESS_SCHEMA_PROBE =
  "SELECT k.id, s.id, r.id FROM knowledge_items k, settings s, context_compile_runs r WHERE 1 = 0";
const TIMEOUT_MS = 1500;

async function probeDatabase(): Promise<void> {
  if (resolveDatabaseBackendConfig().kind === "postgres") {
    await probePostgresDatabase(READINESS_SCHEMA_PROBE, TIMEOUT_MS);
    return;
  }
  const database = await getRuntimeSqliteCoreDatabase();
  database.db.query(READINESS_SCHEMA_PROBE).all();
}

async function boundedCheck(probe: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("readiness timeout"));
        }, TIMEOUT_MS);
      }),
    ]);
    return "ok" as const;
  } catch {
    // Health is unauthenticated: never return dependency errors, paths or credentials.
    return "unavailable" as const;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(): Promise<ReadinessChecks> {
  const backend = resolveDatabaseBackendConfig();
  if (backend.kind === "postgres") {
    return { database: await boundedCheck(probeDatabase) };
  }
  const [database, writer] = await Promise.all([
    boundedCheck(probeDatabase),
    boundedCheck((signal) => probeSqliteWriter(signal, backend.sqlitePath ?? "")),
  ]);
  return { database, writer };
}
