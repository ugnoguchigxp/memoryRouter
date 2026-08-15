import type { Database as NativeBunSqliteDatabase } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { groupedConfig } from "../../config.js";
import { createSqliteCoreSchemaSql } from "./core-schema.js";
import { RemoteWriterSqliteClient } from "./remote-client.js";
import * as schema from "./schema.js";

type BunSqliteDatabase = {
  filename: string;
  exec(sql: string): void;
  serialize(name?: string): Buffer;
  query<T = unknown, P extends unknown[] = unknown[]>(
    sql: string,
  ): {
    all(...params: P): T[];
    get(...params: P): T | null;
    run(...params: P): { changes: number; lastInsertRowid: number | bigint };
    values(...params: P): unknown[][];
  };
  loadExtension?(file: string, entrypoint?: string): void;
  close(): void;
};

type SqliteTableInfoRow = {
  name: string;
};

export type SqliteVectorCapability = {
  available: boolean;
  extensionPath: string | null;
  reason: string | null;
};

export type SqliteCoreDatabase = {
  db: BunSqliteDatabase;
  orm: ReturnType<typeof createSqliteDrizzle>;
  path: string;
  vector: SqliteVectorCapability;
};

function createSqliteDrizzle(db: BunSqliteDatabase) {
  return drizzle(db as unknown as NativeBunSqliteDatabase, { schema });
}

export async function openSqliteCoreDatabase(input: {
  path: string;
  vectorDimension?: number;
  loadVectorExtension?: boolean;
  /** Reserved for guarded offline maintenance commands while the resident writer is stopped. */
  directWrite?: boolean;
}): Promise<SqliteCoreDatabase> {
  if (!input.directWrite && !isDirectWriteTestRuntime()) {
    const sqlite = await import("bun:sqlite");
    const readOnly = new sqlite.Database(input.path, {
      readonly: true,
      strict: true,
    }) as unknown as NativeBunSqliteDatabase;
    const db = new RemoteWriterSqliteClient(readOnly, input.path) as unknown as BunSqliteDatabase;
    return {
      db,
      orm: createSqliteDrizzle(db),
      path: input.path,
      vector: {
        available: false,
        extensionPath: null,
        reason: "sqlite-vec writes are owned by the resident Rust writer",
      },
    };
  }

  await mkdir(path.dirname(input.path), { recursive: true });
  const sqlite = await import("bun:sqlite");
  const db = new sqlite.Database(input.path, { create: true }) as BunSqliteDatabase;
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  const vector =
    input.loadVectorExtension === false ? disabledVectorCapability() : await loadVec(db);
  migrateRepositoryIdentityColumns(db);
  db.exec(
    createSqliteCoreSchemaSql({
      vectorDimension: input.vectorDimension ?? groupedConfig.embedding.dimension,
    }),
  );
  migrateSqliteCoreSchema(db);
  if (vector.available) {
    createVecVirtualTables(db, input.vectorDimension ?? groupedConfig.embedding.dimension);
  }

  return { db, orm: createSqliteDrizzle(db), path: input.path, vector };
}

function isDirectWriteTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined
  );
}

function hasColumn(db: BunSqliteDatabase, tableName: string, columnName: string): boolean {
  return db
    .query<SqliteTableInfoRow, []>(`PRAGMA table_info(${tableName})`)
    .all()
    .some((row) => row.name === columnName);
}

function hasTable(db: BunSqliteDatabase, tableName: string): boolean {
  return Boolean(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(tableName),
  );
}

function addColumnIfMissing(
  db: BunSqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (hasTable(db, tableName) && !hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition};`);
  }
}

function migrateRepositoryIdentityColumns(db: BunSqliteDatabase): void {
  for (const tableName of ["knowledge_items", "sources", "episode_cards"]) {
    addColumnIfMissing(
      db,
      tableName,
      "classification_status",
      "classification_status TEXT NOT NULL DEFAULT 'unresolved'",
    );
    addColumnIfMissing(db, tableName, "scope", "scope TEXT NOT NULL DEFAULT 'repo'");
    addColumnIfMissing(db, tableName, "project_ref", "project_ref TEXT");
    addColumnIfMissing(db, tableName, "repo_key", "repo_key TEXT");
    addColumnIfMissing(db, tableName, "repo_path", "repo_path TEXT");
  }
  addColumnIfMissing(db, "context_compile_runs", "project_ref", "project_ref TEXT");
  addColumnIfMissing(db, "context_compile_runs", "repo_key", "repo_key TEXT");
  addColumnIfMissing(db, "context_compile_runs", "repo_path", "repo_path TEXT");
  addColumnIfMissing(
    db,
    "context_compile_runs",
    "match_basis",
    "match_basis TEXT NOT NULL DEFAULT 'none'",
  );
  addColumnIfMissing(
    db,
    "context_compile_runs",
    "identity_contract_version",
    "identity_contract_version INTEGER NOT NULL DEFAULT 1",
  );
  addColumnIfMissing(
    db,
    "context_compile_runs",
    "scope_mode",
    "scope_mode TEXT NOT NULL DEFAULT 'global_only'",
  );
}

function migrateSqliteCoreSchema(db: BunSqliteDatabase): void {
  db.exec("UPDATE episode_cards SET status = 'active' WHERE status = 'draft';");
  if (!hasColumn(db, "episode_cards", "importance")) {
    db.exec("ALTER TABLE episode_cards ADD COLUMN importance INTEGER NOT NULL DEFAULT 50;");
  }
  if (!hasColumn(db, "episode_cards", "compile_use_count")) {
    db.exec("ALTER TABLE episode_cards ADD COLUMN compile_use_count INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn(db, "episode_cards", "decision_use_count")) {
    db.exec("ALTER TABLE episode_cards ADD COLUMN decision_use_count INTEGER NOT NULL DEFAULT 0;");
  }
  if (hasColumn(db, "episode_cards", "evidence_status")) {
    db.exec(`
DROP INDEX IF EXISTS episode_cards_evidence_status_idx;
ALTER TABLE episode_cards DROP COLUMN evidence_status;
`);
  }
  if (!hasColumn(db, "finding_candidate_escalations", "distillation_version")) {
    db.exec(`
ALTER TABLE finding_candidate_escalations
  ADD COLUMN distillation_version TEXT NOT NULL DEFAULT 'v1';
`);
  }
  if (!hasColumn(db, "security_candidate_batch_items", "provenance_json")) {
    db.exec("ALTER TABLE security_candidate_batch_items ADD COLUMN provenance_json TEXT;");
  }
  db.exec(`
DROP INDEX IF EXISTS finding_candidate_escalations_source_provider_model_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS finding_candidate_escalations_source_provider_model_unique_idx
  ON finding_candidate_escalations(source_kind, source_key, distillation_version, escalation_provider, escalation_model);
`);
}

function disabledVectorCapability(): SqliteVectorCapability {
  return {
    available: false,
    extensionPath: null,
    reason: "sqlite-vec loading disabled by caller",
  };
}

async function loadVec(db: BunSqliteDatabase): Promise<SqliteVectorCapability> {
  let extensionPath: string | null = null;
  try {
    const sqliteVec = await import("sqlite-vec");
    extensionPath = sqliteVec.getLoadablePath();
    if (typeof db.loadExtension !== "function") {
      return {
        available: false,
        extensionPath,
        reason: "SQLite binding does not expose loadExtension",
      };
    }
    db.loadExtension(extensionPath);
    return { available: true, extensionPath, reason: null };
  } catch (error) {
    return {
      available: false,
      extensionPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function createVecVirtualTables(db: BunSqliteDatabase, vectorDimension: number): void {
  const dimension = Math.max(1, Math.trunc(vectorDimension));
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_vec USING vec0(
  embedding float[${dimension}]
);
CREATE VIRTUAL TABLE IF NOT EXISTS source_fragments_vec USING vec0(
  embedding float[${dimension}]
);
`);
}
