import { createHash } from "node:crypto";
import pg from "pg";
import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { type SqliteCoreDatabase, openSqliteCoreDatabase } from "../../db/sqlite/index.js";
import { readProjectEnv } from "../../project-identity.js";

export type PostgresToSqliteMigrationMode = "dry-run" | "insert-only" | "replace";

export type MigrationTableSummary = {
  table: string;
  sourceExists: boolean;
  targetExists: boolean;
  sourceRows: number;
  targetRowsBefore: number;
  migratedRows: number;
  transformedColumns: string[];
  skippedColumns: string[];
  issues: string[];
};

export type PostgresToSqliteMigrationSummary = {
  ok: boolean;
  mode: PostgresToSqliteMigrationMode;
  postgresUrl: string;
  sqlitePath: string;
  startedAt: string;
  finishedAt: string;
  tables: MigrationTableSummary[];
  vectorRows: {
    knowledgeItems: number;
    sourceFragments: number;
  };
  issues: string[];
};

type MigrationTableSpec = {
  table: string;
  skipColumns?: string[];
  transformedColumns?: string[];
  columnMap?: Record<string, string>;
};

export type PostgresMigrationClient = {
  connect?(): Promise<unknown>;
  end?(): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
};

const migrationTables: MigrationTableSpec[] = [
  { table: "knowledge_items", transformedColumns: ["embedding"] },
  { table: "knowledge_tag_definitions" },
  { table: "knowledge_community_labels" },
  { table: "knowledge_quality_adjustments" },
  { table: "knowledge_origin_links" },
  { table: "sources" },
  { table: "source_fragments", transformedColumns: ["embedding"] },
  { table: "knowledge_source_links" },
  { table: "knowledge_usage_events" },
  { table: "knowledge_review_queue" },
  { table: "context_compile_runs" },
  {
    table: "context_pack_items",
    columnMap: { id: "postgres_id" },
    transformedColumns: ["id -> postgres_id"],
  },
  {
    table: "context_compile_candidate_traces",
    columnMap: { id: "postgres_id" },
    transformedColumns: ["id -> postgres_id"],
  },
  {
    table: "context_compile_task_traces",
    columnMap: { id: "postgres_id" },
    transformedColumns: ["id -> postgres_id"],
  },
  { table: "context_compile_evals" },
  { table: "vibe_goals" },
  { table: "vibe_memories" },
  { table: "agent_diff_entries" },
  { table: "episode_cards", transformedColumns: ["embedding"] },
  { table: "episode_refs" },
  { table: "episode_retrieval_feedback" },
  { table: "vibe_memory_marks" },
  { table: "vibe_migration_runs" },
  { table: "sync_states" },
  { table: "context_decision_runs" },
  { table: "context_decision_evidence" },
  { table: "context_decision_coverage_traces" },
  { table: "context_decision_human_feedback" },
  { table: "context_decision_feedback" },
  { table: "context_decision_feedback_effects" },
  { table: "distillation_target_states" },
  { table: "distillation_evidence_cache" },
  { table: "find_candidate_results" },
  { table: "cover_evidence_results" },
  { table: "finding_candidate_queue" },
  { table: "episode_distiller_queue" },
  { table: "found_candidates" },
  { table: "covering_evidence_queue" },
  { table: "evidence_coverage_results" },
  { table: "finalize_distille_queue" },
  { table: "distillation_queue_events" },
  { table: "distillation_queue_migration_map" },
  { table: "landscape_review_items" },
  { table: "landscape_review_item_candidate_links" },
  { table: "dead_zone_merge_review_queue" },
  { table: "merge_activation_finalize_queue" },
  { table: "landscape_snapshots" },
  { table: "settings" },
  { table: "audit_logs" },
  { table: "repository_identity_migration_audits" },
  { table: "llm_usage_logs" },
];

const identifierPattern = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
  if (!identifierPattern.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function contentHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return null;
}

function toSqliteValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return JSON.stringify(value);
  }
  return value;
}

function normalizeVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const vector = value.map((entry) => Number(entry));
    return vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!trimmed) return null;
  const vector = trimmed.split(",").map((entry) => Number(entry.trim()));
  return vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
}

function redactConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "REDACTED";
    if (url.username) url.username = "REDACTED";
    return url.toString();
  } catch {
    return value ? "configured" : "";
  }
}

async function sourceTableExists(client: PostgresMigrationClient, table: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
    select exists (
      select 1
      from information_schema.tables
      where table_schema = 'public' and table_name = $1
    ) as exists
  `,
    [table],
  );
  return Boolean(result.rows[0]?.exists);
}

function targetTableExists(sqlite: SqliteCoreDatabase, table: string): boolean {
  const row = sqlite.db
    .query<{ name: string }, [string]>(
      "select name from sqlite_schema where type in ('table', 'view') and name = ? limit 1",
    )
    .get(table);
  return Boolean(row);
}

async function sourceColumns(client: PostgresMigrationClient, table: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = $1
    order by ordinal_position asc
  `,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

function targetColumns(sqlite: SqliteCoreDatabase, table: string): string[] {
  return sqlite.db
    .query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => row.name);
}

async function sourceCount(client: PostgresMigrationClient, table: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from ${quoteIdentifier(table)}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function targetCount(sqlite: SqliteCoreDatabase, table: string): number {
  const row = sqlite.db
    .query<{ count: number }>(`select count(*) as count from ${quoteIdentifier(table)}`)
    .get();
  return Number(row?.count ?? 0);
}

function insertRow(params: {
  sqlite: SqliteCoreDatabase;
  table: string;
  columns: string[];
  row: Record<string, unknown>;
  mode: Exclude<PostgresToSqliteMigrationMode, "dry-run">;
}): void {
  const placeholders = params.columns.map(() => "?").join(", ");
  const columnsSql = params.columns.map(quoteIdentifier).join(", ");
  const values = params.columns.map((column) => toSqliteValue(params.row[column]));
  if (params.mode === "replace") {
    params.sqlite.db
      .query(
        `insert or replace into ${quoteIdentifier(params.table)} (${columnsSql}) values (${placeholders})`,
      )
      .run(...values);
    return;
  }
  params.sqlite.db
    .query(`insert into ${quoteIdentifier(params.table)} (${columnsSql}) values (${placeholders})`)
    .run(...values);
}

function refreshFts(sqlite: SqliteCoreDatabase): void {
  sqlite.db.query("delete from knowledge_items_fts").run();
  sqlite.db
    .query(
      "insert into knowledge_items_fts(id, title, body) select id, title, body from knowledge_items",
    )
    .run();
  sqlite.db.query("delete from sources_fts").run();
  sqlite.db
    .query("insert into sources_fts(id, title, uri, body) select id, title, uri, body from sources")
    .run();
  sqlite.db.query("delete from source_fragments_fts").run();
  sqlite.db
    .query(
      "insert into source_fragments_fts(id, heading, content) select id, heading, content from source_fragments",
    )
    .run();
  sqlite.db.query("delete from vibe_memories_fts").run();
  sqlite.db
    .query(
      "insert into vibe_memories_fts(rowid, id, content) select rowid, id, content from vibe_memories",
    )
    .run();
  sqlite.db.query("delete from agent_diff_entries_fts").run();
  sqlite.db
    .query(
      `insert into agent_diff_entries_fts(rowid, id, vibe_memory_id, file_path, diff_hunk, symbol_name, symbol_kind, signature)
       select rowid, id, vibe_memory_id, file_path, diff_hunk, symbol_name, symbol_kind, signature
       from agent_diff_entries`,
    )
    .run();
  sqlite.db.query("delete from episode_cards_fts").run();
  sqlite.db
    .query(
      `insert into episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
       select rowid, id, title, situation, observations, action, outcome, lesson
       from episode_cards`,
    )
    .run();
}

async function migrateVectors(params: {
  client: PostgresMigrationClient;
  sqlite: SqliteCoreDatabase;
}): Promise<PostgresToSqliteMigrationSummary["vectorRows"]> {
  let knowledgeItems = 0;
  let sourceFragments = 0;
  if (await sourceTableExists(params.client, "knowledge_items")) {
    const rows = await params.client.query<{
      id: string;
      title: string;
      body: string;
      embedding: unknown;
      updated_at: unknown;
    }>(
      "select id::text, title, body, embedding, updated_at from knowledge_items where embedding is not null",
    );
    for (const row of rows.rows) {
      const vector = normalizeVector(row.embedding);
      if (!vector) continue;
      params.sqlite.db
        .query(
          `insert or replace into knowledge_items_vec_fallback
            (knowledge_id, embedding_json, embedding_dimension, content_hash, updated_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          JSON.stringify(vector),
          vector.length,
          contentHash(row.title ?? "", row.body ?? ""),
          normalizeDate(row.updated_at) ?? new Date().toISOString(),
        );
      knowledgeItems += 1;
    }
  }
  if (await sourceTableExists(params.client, "source_fragments")) {
    const rows = await params.client.query<{
      id: string;
      content: string;
      embedding: unknown;
      created_at: unknown;
    }>(
      "select id::text, content, embedding, created_at from source_fragments where embedding is not null",
    );
    for (const row of rows.rows) {
      const vector = normalizeVector(row.embedding);
      if (!vector) continue;
      params.sqlite.db
        .query(
          `insert or replace into source_fragments_vec_fallback
            (source_fragment_id, embedding_json, embedding_dimension, content_hash, updated_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          JSON.stringify(vector),
          vector.length,
          contentHash(row.content ?? ""),
          normalizeDate(row.created_at) ?? new Date().toISOString(),
        );
      sourceFragments += 1;
    }
  }
  return { knowledgeItems, sourceFragments };
}

export async function migratePostgresToSqlite(input: {
  mode: PostgresToSqliteMigrationMode;
  databaseUrl?: string;
  sqlitePath?: string;
  client?: PostgresMigrationClient;
  sqlite?: SqliteCoreDatabase;
}): Promise<PostgresToSqliteMigrationSummary> {
  const startedAt = new Date().toISOString();
  const postgresUrl =
    input.databaseUrl ?? process.env.DATABASE_URL ?? readProjectEnv("DATABASE_URL") ?? "";
  if (!postgresUrl) throw new Error("DATABASE_URL is required for PostgreSQL source migration");
  const backend = resolveDatabaseBackendConfig({
    backend: "sqlite",
    sqlitePath: input.sqlitePath,
  });
  if (!backend.sqlitePath) throw new Error("SQLite target path could not be resolved");

  const client: PostgresMigrationClient =
    input.client ?? (new pg.Client({ connectionString: postgresUrl }) as PostgresMigrationClient);
  const sqlite =
    input.sqlite ??
    (await openSqliteCoreDatabase({
      path: backend.sqlitePath,
      vectorDimension: groupedConfig.embedding.dimension,
    }));
  const summaries: MigrationTableSummary[] = [];
  const issues: string[] = [];
  let vectorRows: PostgresToSqliteMigrationSummary["vectorRows"] = {
    knowledgeItems: 0,
    sourceFragments: 0,
  };

  if (!input.client) await client.connect?.();
  try {
    if (input.mode !== "dry-run") {
      sqlite.db.query("BEGIN IMMEDIATE").run();
    }
    for (const spec of migrationTables) {
      const sourceExists = await sourceTableExists(client, spec.table);
      const targetExists = targetTableExists(sqlite, spec.table);
      const summary: MigrationTableSummary = {
        table: spec.table,
        sourceExists,
        targetExists,
        sourceRows: 0,
        targetRowsBefore: targetExists ? targetCount(sqlite, spec.table) : 0,
        migratedRows: 0,
        transformedColumns: spec.transformedColumns ?? [],
        skippedColumns: [],
        issues: [],
      };
      summaries.push(summary);
      if (!sourceExists) {
        summary.issues.push("source table missing");
        continue;
      }
      summary.sourceRows = await sourceCount(client, spec.table);
      if (!targetExists) {
        summary.issues.push("target table missing");
        issues.push(`target table missing: ${spec.table}`);
        continue;
      }

      const skip = new Set(spec.skipColumns ?? []);
      const source = await sourceColumns(client, spec.table);
      const target = targetColumns(sqlite, spec.table);
      const mappedSourceColumns = new Set(Object.keys(spec.columnMap ?? {}));
      const columns = source.filter(
        (column) =>
          target.includes(column) && !skip.has(column) && !mappedSourceColumns.has(column),
      );
      const mappedColumns = Object.entries(spec.columnMap ?? {}).filter(
        ([sourceColumn, targetColumn]) =>
          source.includes(sourceColumn) && target.includes(targetColumn),
      );
      const transformed = new Set(spec.transformedColumns ?? []);
      for (const [sourceColumn] of mappedColumns) {
        transformed.add(sourceColumn);
      }
      summary.skippedColumns = source.filter(
        (column) => !columns.includes(column) && !transformed.has(column),
      );
      const selectedSourceColumns = [
        ...columns,
        ...mappedColumns.map(([sourceColumn]) => sourceColumn),
      ];
      if (
        input.mode === "dry-run" ||
        selectedSourceColumns.length === 0 ||
        summary.sourceRows === 0
      ) {
        continue;
      }

      const selectedColumns = selectedSourceColumns.map(quoteIdentifier).join(", ");
      const result = await client.query<Record<string, unknown>>(
        `select ${selectedColumns} from ${quoteIdentifier(spec.table)}`,
      );
      for (const row of result.rows) {
        const migrationRow = { ...row };
        for (const [sourceColumn, targetColumn] of mappedColumns) {
          migrationRow[targetColumn] = row[sourceColumn];
        }
        insertRow({
          sqlite,
          table: spec.table,
          columns: [...columns, ...mappedColumns.map(([, targetColumn]) => targetColumn)],
          row: migrationRow,
          mode: input.mode,
        });
        summary.migratedRows += 1;
      }
    }

    if (input.mode !== "dry-run") {
      vectorRows = await migrateVectors({ client, sqlite });
      refreshFts(sqlite);
      sqlite.db.query("COMMIT").run();
      sqlite.db.query("PRAGMA wal_checkpoint(PASSIVE)").run();
    }
  } catch (error) {
    if (input.mode !== "dry-run") {
      try {
        sqlite.db.query("ROLLBACK").run();
      } catch {
        // Keep the original migration error.
      }
    }
    throw error;
  } finally {
    if (!input.client) await client.end?.();
    if (!input.sqlite) sqlite.db.close();
  }

  for (const table of summaries) {
    issues.push(
      ...table.issues
        .filter((issue) => issue !== "source table missing")
        .map((issue) => `${table.table}: ${issue}`),
    );
  }
  return {
    ok: issues.length === 0,
    mode: input.mode,
    postgresUrl: redactConnectionString(postgresUrl),
    sqlitePath: backend.sqlitePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    tables: summaries,
    vectorRows,
    issues,
  };
}
