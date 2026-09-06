import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { contextCompileEvals, contextCompileRuns } from "../../db/schema.js";

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function sqliteRepository() {
  return import("./context-compile-eval.repository.sqlite.js");
}

export type CompileEvalRecord = {
  id: string;
  runId: string;
  sessionId: string | null;
  avg: number;
  outcome: "useful" | "partial" | "misleading" | "unused";
  title: string | null;
  body: string;
  source: "mcp" | "ui" | "system" | "import";
  relevance: number | null;
  actionability: number | null;
  coverage: number | null;
  clarity: number | null;
  specificity: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CompileEvalSummary = {
  count: number;
  latestAvg: number | null;
  averageAvg: number | null;
  latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
  latestEvaluatedAt: string | null;
};

function normalizeOutcome(value: unknown): CompileEvalRecord["outcome"] {
  if (value === "useful" || value === "partial" || value === "misleading" || value === "unused") {
    return value;
  }
  throw new Error(`Invalid compile eval outcome: ${String(value)}`);
}

function normalizeSource(value: unknown): CompileEvalRecord["source"] {
  if (value === "mcp" || value === "ui" || value === "system" || value === "import") return value;
  return "mcp";
}

function toIso(value: Date): string {
  return value.toISOString();
}

function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function insertCompileEval(params: {
  runId: string;
  sessionId?: string | null;
  avg: number;
  outcome: CompileEvalRecord["outcome"];
  title?: string;
  body: string;
  source?: CompileEvalRecord["source"];
  metadata?: Record<string, unknown>;
  relevance: number;
  actionability: number;
  coverage: number;
  clarity: number;
  specificity: number;
}): Promise<CompileEvalRecord> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.insertCompileEvalSqlite(params);
  }
  const [row] = await db
    .insert(contextCompileEvals)
    .values({
      runId: params.runId,
      sessionId: params.sessionId ?? null,
      avg: params.avg,
      outcome: params.outcome,
      title: params.title ?? null,
      body: params.body,
      source: params.source ?? "mcp",
      metadata: params.metadata ?? {},
      relevance: params.relevance,
      actionability: params.actionability,
      coverage: params.coverage,
      clarity: params.clarity,
      specificity: params.specificity,
      updatedAt: new Date(),
    })
    .returning();
  return {
    id: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    avg: row.avg,
    outcome: normalizeOutcome(row.outcome),
    title: row.title,
    body: row.body,
    source: normalizeSource(row.source),
    relevance: row.relevance,
    actionability: row.actionability,
    coverage: row.coverage,
    clarity: row.clarity,
    specificity: row.specificity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCompileEvalSummaryByRunId(runId: string): Promise<CompileEvalSummary> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileEvalSummaryByRunIdSqlite(runId);
  }
  const aggRows = asRows<{ count: number; averageAvg: number | null }>(
    await db
      .select({
        count: sql<number>`count(*)::int`,
        averageAvg: sql<number | null>`round(avg(${contextCompileEvals.avg})::numeric, 1)::float8`,
      })
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId)),
  );
  const aggRow = aggRows[0];

  const latestRows = asRows<{ avg: number; outcome: string; createdAt: Date }>(
    await db
      .select({
        avg: contextCompileEvals.avg,
        outcome: contextCompileEvals.outcome,
        createdAt: contextCompileEvals.createdAt,
      })
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId))
      .orderBy(desc(contextCompileEvals.createdAt), desc(contextCompileEvals.id))
      .limit(1),
  );
  const latestRow = latestRows[0];

  return {
    count: aggRow?.count ?? 0,
    latestAvg: latestRow?.avg ?? null,
    averageAvg: aggRow?.averageAvg ?? null,
    latestOutcome:
      latestRow &&
      (latestRow.outcome === "useful" ||
        latestRow.outcome === "partial" ||
        latestRow.outcome === "misleading" ||
        latestRow.outcome === "unused")
        ? latestRow.outcome
        : null,
    latestEvaluatedAt: latestRow?.createdAt ? toIso(latestRow.createdAt) : null,
  };
}

export async function listCompileEvalsByRunId(runId: string): Promise<CompileEvalRecord[]> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.listCompileEvalsByRunIdSqlite(runId);
  }
  const rows = asRows<
    typeof contextCompileEvals.$inferSelect & {
      outcome: unknown;
      source: unknown;
    }
  >(
    await db
      .select()
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId))
      .orderBy(desc(contextCompileEvals.createdAt), desc(contextCompileEvals.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    avg: row.avg,
    outcome: normalizeOutcome(row.outcome),
    title: row.title,
    body: row.body,
    source: normalizeSource(row.source),
    relevance: row.relevance,
    actionability: row.actionability,
    coverage: row.coverage,
    clarity: row.clarity,
    specificity: row.specificity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function findRunIdForCompileEval(params: {
  sessionId: string;
}): Promise<{
  runId: string;
  resolvedFrom: "latest_session_run";
} | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.findRunIdForCompileEvalSqlite(params);
  }
  const [runRow] = await db
    .select({ id: contextCompileRuns.id })
    .from(contextCompileRuns)
    .where(
      and(
        eq(contextCompileRuns.sessionId, params.sessionId),
        isNotNull(contextCompileRuns.sessionId),
      ),
    )
    .orderBy(desc(contextCompileRuns.createdAt), desc(contextCompileRuns.id))
    .limit(1);
  if (!runRow) return null;
  return { runId: runRow.id, resolvedFrom: "latest_session_run" };
}

export async function getCompileRunSessionId(
  runId: string,
): Promise<{ id: string; sessionId: string | null } | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileRunSessionIdSqlite(runId);
  }
  const [row] = await db
    .select({ id: contextCompileRuns.id, sessionId: contextCompileRuns.sessionId })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  return row ?? null;
}
