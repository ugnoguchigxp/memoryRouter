import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
import { groupedConfig } from "../config.js";
import { projectIdentity, readProjectEnv } from "../project-identity.js";
import * as schema from "./schema.js";

const { Pool } = pkg;

const createDatabase = (pool: InstanceType<typeof Pool>) => drizzle(pool, { schema });

type Database = ReturnType<typeof createDatabase>;

const globalForDb = globalThis as unknown as {
  pool: InstanceType<typeof Pool> | undefined;
  database: Database | undefined;
};

function isVitestRuntime(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

function isSafeTestDatabase(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.pathname.replace(/^\//, "").includes("test");
  } catch {
    return databaseUrl.includes("test");
  }
}

function assertSafeTestDatabase(databaseUrl: string): void {
  if (!isVitestRuntime()) return;
  if (isSafeTestDatabase(databaseUrl)) return;
  if (readProjectEnv("ALLOW_DESTRUCTIVE_DB_TESTS") === "1") return;

  throw new Error(
    [
      "Refusing to open a non-test database from Vitest.",
      "Use a DATABASE_URL whose database name includes 'test', or set CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS=1 explicitly.",
    ].join(" "),
  );
}

function resolveApplicationName(): string {
  const entrypoint =
    process.argv[1]
      ?.split("/")
      .at(-1)
      ?.replace(/\.[cm]?[tj]sx?$/, "") || "process";
  return `${projectIdentity.packageName}:${entrypoint}:${process.pid}`.slice(0, 63);
}

function ensureDatabase(): Database {
  if (!globalForDb.pool) {
    assertSafeTestDatabase(groupedConfig.database.url);
    globalForDb.pool = new Pool({
      connectionString: groupedConfig.database.url,
      application_name: resolveApplicationName(),
      max: groupedConfig.database.poolMax,
      idleTimeoutMillis: groupedConfig.database.idleTimeoutMillis,
      connectionTimeoutMillis: groupedConfig.database.connectionTimeoutMillis,
    });
  }
  if (!globalForDb.database) {
    globalForDb.database = createDatabase(globalForDb.pool);
  }
  return globalForDb.database;
}

export function getDb(): Database {
  return ensureDatabase();
}

export async function closeDbPool(): Promise<void> {
  if (!globalForDb.pool) return;
  const current = globalForDb.pool;
  globalForDb.pool = undefined;
  globalForDb.database = undefined;
  await current.end();
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(ensureDatabase() as object, property, receiver);
  },
}) as Database;

/** A bounded, read-only dependency check, independent of application pool saturation. */
export async function probePostgresDatabase(query: string, timeoutMs: number): Promise<void> {
  assertSafeTestDatabase(groupedConfig.database.url);
  const client = new pkg.Client({
    connectionString: groupedConfig.database.url,
    application_name: `${projectIdentity.packageName}:readiness`,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query(query);
  } finally {
    await client.end();
  }
}
