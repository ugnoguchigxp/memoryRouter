import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { contextCompileRuns, contextPackItems, knowledgeUsageEvents } from "../../db/schema.js";
import type {
  LandscapeFeedbackActor,
  LandscapeRunStatus,
  LandscapeRunStatusFilter,
  LandscapeUsageVerdict,
} from "./landscape-replay.types.js";

export type LandscapeReplayCompileRunRow = {
  id: string;
  goal: string;
  intent: string;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  matchBasis: string;
  identityContractVersion: number;
  scopeMode: string;
  input: Record<string, unknown>;
  retrievalMode: string;
  status: LandscapeRunStatus;
  degradedReasons: unknown;
  source: string;
  packSnapshot: unknown;
  createdAt: Date;
};

export type LandscapeReplayPackItemRow = {
  runId: string;
  itemKind: string;
  itemId: string;
  score: number;
  rankingReason: string;
  sourceRefs: unknown;
  createdAt: Date;
};

export type LandscapeReplayUsageEventRow = {
  runId: string;
  knowledgeId: string;
  verdict: LandscapeUsageVerdict;
  actor: LandscapeFeedbackActor;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type LandscapeReplayCorpusRows = {
  runs: LandscapeReplayCompileRunRow[];
  packItems: LandscapeReplayPackItemRow[];
  usageEvents: LandscapeReplayUsageEventRow[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asDate(value: unknown): Date {
  const parsed = new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

function normalizeRunStatus(value: string): LandscapeRunStatus {
  if (value === "degraded" || value === "failed") return value;
  return "ok";
}

function normalizeVerdict(value: string): LandscapeUsageVerdict {
  if (value === "not_used" || value === "off_topic" || value === "wrong") return value;
  return "used";
}

function normalizeActor(value: string): LandscapeFeedbackActor {
  if (value === "user" || value === "system") return value;
  return "agent";
}

export async function loadLandscapeReplayCorpus(params: {
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
}): Promise<LandscapeReplayCorpusRows> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return loadLandscapeReplayCorpusSqlite(params);
  }

  const conditions = [
    sql`${contextCompileRuns.createdAt} >= now() - (${params.windowDays} * interval '1 day')`,
  ];
  if (params.runStatus !== "all") {
    conditions.push(eq(contextCompileRuns.status, params.runStatus));
  }

  const runs = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      intent: contextCompileRuns.intent,
      projectRef: contextCompileRuns.projectRef,
      repoKey: contextCompileRuns.repoKey,
      repoPath: contextCompileRuns.repoPath,
      matchBasis: contextCompileRuns.matchBasis,
      identityContractVersion: contextCompileRuns.identityContractVersion,
      scopeMode: contextCompileRuns.scopeMode,
      input: contextCompileRuns.input,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      source: contextCompileRuns.source,
      packSnapshot: contextCompileRuns.packSnapshot,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(and(...conditions))
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(params.limit);

  const runIds = runs.map((run) => run.id);
  if (runIds.length === 0) {
    return { runs: [], packItems: [], usageEvents: [] };
  }

  const [packItems, usageEvents] = await Promise.all([
    db
      .select({
        runId: contextPackItems.runId,
        itemKind: contextPackItems.itemKind,
        itemId: contextPackItems.itemId,
        score: contextPackItems.score,
        rankingReason: contextPackItems.rankingReason,
        sourceRefs: contextPackItems.sourceRefs,
        createdAt: contextPackItems.createdAt,
      })
      .from(contextPackItems)
      .where(
        and(
          inArray(contextPackItems.runId, runIds),
          inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        ),
      )
      .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt)),
    db
      .select({
        runId: knowledgeUsageEvents.runId,
        knowledgeId: knowledgeUsageEvents.knowledgeId,
        verdict: knowledgeUsageEvents.verdict,
        actor: knowledgeUsageEvents.actor,
        reason: knowledgeUsageEvents.reason,
        metadata: knowledgeUsageEvents.metadata,
        createdAt: knowledgeUsageEvents.createdAt,
        updatedAt: knowledgeUsageEvents.updatedAt,
      })
      .from(knowledgeUsageEvents)
      .where(inArray(knowledgeUsageEvents.runId, runIds))
      .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt)),
  ]);

  return {
    runs: runs.map((run) => ({
      id: run.id,
      goal: run.goal,
      intent: run.intent,
      projectRef: run.projectRef,
      repoKey: run.repoKey,
      repoPath: run.repoPath,
      matchBasis: run.matchBasis,
      identityContractVersion: run.identityContractVersion,
      scopeMode: run.scopeMode,
      input: asRecord(run.input),
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: run.degradedReasons,
      source: run.source,
      packSnapshot: run.packSnapshot,
      createdAt: run.createdAt,
    })),
    packItems: packItems.map((item) => ({
      runId: item.runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      score: asNumber(item.score, 0),
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
      createdAt: item.createdAt,
    })),
    usageEvents: usageEvents.map((event) => ({
      runId: event.runId,
      knowledgeId: event.knowledgeId,
      verdict: normalizeVerdict(event.verdict),
      actor: normalizeActor(event.actor),
      reason: event.reason,
      metadata: asRecord(event.metadata),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    })),
  };
}

async function loadLandscapeReplayCorpusSqlite(params: {
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
}): Promise<LandscapeReplayCorpusRows> {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const since = new Date(Date.now() - params.windowDays * 24 * 60 * 60 * 1000).toISOString();
  const statusClause = params.runStatus === "all" ? "" : "and status = ?";
  const runParams =
    params.runStatus === "all" ? [since, params.limit] : [since, params.runStatus, params.limit];
  const runs = sqlite.db
    .query<
      {
        id: string;
        goal: string;
        intent: string;
        project_ref: string | null;
        repo_key: string | null;
        repo_path: string | null;
        match_basis: string;
        identity_contract_version: number;
        scope_mode: string;
        input: string;
        retrieval_mode: string;
        status: string;
        degraded_reasons: string;
        source: string;
        pack_snapshot: string | null;
        created_at: string;
      },
      unknown[]
    >(
      `
        select
          id,
          goal,
          intent,
          project_ref,
          repo_key,
          repo_path,
          match_basis,
          identity_contract_version,
          scope_mode,
          input,
          retrieval_mode,
          status,
          degraded_reasons,
          source,
          pack_snapshot,
          created_at
        from context_compile_runs
        where datetime(created_at) >= datetime(?)
          ${statusClause}
        order by datetime(created_at) desc
        limit ?
      `,
    )
    .all(...runParams);

  const runIds = runs.map((run) => run.id);
  if (runIds.length === 0) {
    return { runs: [], packItems: [], usageEvents: [] };
  }

  const placeholders = runIds.map(() => "?").join(",");
  const packItems = sqlite.db
    .query<
      {
        run_id: string;
        item_kind: string;
        item_id: string;
        score: number;
        ranking_reason: string;
        source_refs: string;
        created_at: string;
      },
      unknown[]
    >(
      `
        select
          run_id,
          item_kind,
          item_id,
          score,
          ranking_reason,
          source_refs,
          created_at
        from context_pack_items
        where run_id in (${placeholders})
          and item_kind in ('rule', 'procedure')
        order by score desc, datetime(created_at) desc
      `,
    )
    .all(...runIds);
  const usageEvents = sqlite.db
    .query<
      {
        run_id: string;
        knowledge_id: string;
        verdict: string;
        actor: string;
        reason: string | null;
        metadata: string;
        created_at: string;
        updated_at: string;
      },
      unknown[]
    >(
      `
        select
          run_id,
          knowledge_id,
          verdict,
          actor,
          reason,
          metadata,
          created_at,
          updated_at
        from knowledge_usage_events
        where run_id in (${placeholders})
        order by datetime(updated_at) desc, datetime(created_at) desc
      `,
    )
    .all(...runIds);

  return {
    runs: runs.map((run) => ({
      id: run.id,
      goal: run.goal,
      intent: run.intent,
      projectRef: run.project_ref,
      repoKey: run.repo_key,
      repoPath: run.repo_path,
      matchBasis: run.match_basis,
      identityContractVersion: run.identity_contract_version,
      scopeMode: run.scope_mode,
      input: asRecord(run.input),
      retrievalMode: run.retrieval_mode,
      status: normalizeRunStatus(run.status),
      degradedReasons: parseJsonValue(run.degraded_reasons),
      source: run.source,
      packSnapshot: parseJsonValue(run.pack_snapshot),
      createdAt: asDate(run.created_at),
    })),
    packItems: packItems.map((item) => ({
      runId: item.run_id,
      itemKind: item.item_kind,
      itemId: item.item_id,
      score: asNumber(item.score, 0),
      rankingReason: item.ranking_reason,
      sourceRefs: parseJsonValue(item.source_refs),
      createdAt: asDate(item.created_at),
    })),
    usageEvents: usageEvents.map((event) => ({
      runId: event.run_id,
      knowledgeId: event.knowledge_id,
      verdict: normalizeVerdict(event.verdict),
      actor: normalizeActor(event.actor),
      reason: event.reason,
      metadata: asRecord(event.metadata),
      createdAt: asDate(event.created_at),
      updatedAt: asDate(event.updated_at),
    })),
  };
}
