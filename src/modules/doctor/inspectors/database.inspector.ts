import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { getDb } from "../../../db/index.js";
import { knowledgeIntentTagSlugs } from "../../../knowledge/intentTagDefinitions.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { requiredTableSqlList, requiredTables, sqliteRequiredTables } from "../doctor.constants.js";

type DatabaseInspectorOptions = {
  freshnessThresholdMinutes: number;
  staleDecayFactor: number;
  zeroUseWarningMinActiveCount: number;
};

type RustVectorHealth = {
  vecUsable?: unknown;
};

type MetricTimer = {
  elapsedMs(): number;
};

const hitlBacklogThresholdCount = groupedConfig.distillation.promotionBacklogThresholdCount;
const hitlBacklogThresholdAgeMinutes = 60 * 24 * 3;

function startMetricTimer(): MetricTimer {
  const startedAt = performance.now();
  return {
    elapsedMs: () => Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10),
  };
}

function roundMetricMs(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function ageMinutesFromIso(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
}

export type DatabaseInspection = {
  db: DoctorReport["db"];
  vector: DoctorReport["vector"];
  reachable: boolean;
  vectorInstalled: boolean;
  expectedTables: string[];
  existingTables: string[];
  missingTables: string[];
  staleKnowledgeCount: number;
  staleSourceCount: number;
  hitl: DoctorReport["hitl"];
  knowledgeLifecycle: DoctorReport["knowledgeLifecycle"];
  reasons: string[];
};

function createDefaultKnowledgeLifecycle(
  options: Pick<DatabaseInspectorOptions, "staleDecayFactor" | "zeroUseWarningMinActiveCount">,
): DoctorReport["knowledgeLifecycle"] {
  return {
    activeCount: 0,
    zeroUseActiveCount: 0,
    staleByDecayCount: 0,
    staleProcedureCount: 0,
    dynamicScoreAvg: null,
    dynamicScoreP95: null,
    lastCompiledAt: null,
    lastCompiledAgeMinutes: null,
    thresholds: {
      staleDecayFactor: options.staleDecayFactor,
      zeroUseWarningMinActiveCount: options.zeroUseWarningMinActiveCount,
    },
  };
}

const knownIntentTags = new Set<string>(knowledgeIntentTagSlugs);

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, quantile));
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function ageDaysFromIso(value: string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, (Date.now() - timestamp) / 86_400_000);
}

function inspectRustSqliteVectorHealth(
  sqlitePath: string,
): { available: boolean; durationMs: number } | null {
  const timer = startMetricTimer();
  try {
    const localBinary = path.resolve(
      process.cwd(),
      process.platform === "win32"
        ? "target/debug/context-stilld.exe"
        : "target/debug/context-stilld",
    );
    const binary =
      process.env.CONTEXT_STILLD_BIN ?? (existsSync(localBinary) ? localBinary : "context-stilld");
    const output = execFileSync(binary, ["vector", "health", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CONTEXT_STILL_SQLITE_CORE_PATH: sqlitePath,
      },
      timeout: 30_000,
    });
    const parsed = JSON.parse(output) as RustVectorHealth;
    return { available: parsed.vecUsable === true, durationMs: timer.elapsedMs() };
  } catch {
    return null;
  }
}

async function inspectSqliteDatabase({
  freshnessThresholdMinutes,
  staleDecayFactor,
  zeroUseWarningMinActiveCount,
}: DatabaseInspectorOptions): Promise<DatabaseInspection> {
  const totalTimer = startMetricTimer();
  const responseTimer = startMetricTimer();
  const expectedTables = [...sqliteRequiredTables];

  try {
    const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db.query("select 1 as ok").get();
    const responseMs = responseTimer.elapsedMs();
    let queryMs = 0;
    const placeholders = expectedTables.map(() => "?").join(", ");
    const tableTimer = startMetricTimer();
    const existingTables = sqlite.db
      .query<{ name: string }, string[]>(
        `select name from sqlite_schema where type in ('table', 'view') and name in (${placeholders})`,
      )
      .all(...expectedTables)
      .map((row) => row.name);
    queryMs += tableTimer.elapsedMs();
    const missingTables = expectedTables.filter((tableName) => !existingTables.includes(tableName));
    const rustVectorHealth = inspectRustSqliteVectorHealth(sqlite.path);
    const vectorInstalled = rustVectorHealth?.available ?? sqlite.vector.available;
    const reasons: string[] = [];
    if (missingTables.length > 0) {
      reasons.push("MISSING_REQUIRED_TABLES");
    }
    if (!vectorInstalled) {
      reasons.push("SQLITE_VECTOR_EXTENSION_UNAVAILABLE");
    }

    let staleKnowledgeCount = 0;
    const hitl: DoctorReport["hitl"] = {
      draftCount: 0,
      oldestDraftAt: null,
      oldestDraftAgeMinutes: null,
      backlogThresholdCount: hitlBacklogThresholdCount,
      backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
    };
    const knowledgeLifecycle = createDefaultKnowledgeLifecycle({
      staleDecayFactor,
      zeroUseWarningMinActiveCount,
    });

    if (existingTables.includes("knowledge_items")) {
      try {
        const timer = startMetricTimer();
        const staleRow = sqlite.db
          .query<{ count: number }, []>(
            "select count(*) as count from knowledge_items where status = 'deprecated'",
          )
          .get();
        queryMs += timer.elapsedMs();
        staleKnowledgeCount = Number(staleRow?.count ?? 0);
      } catch {
        reasons.push("STALE_KNOWLEDGE_COUNT_QUERY_FAILED");
      }

      try {
        const timer = startMetricTimer();
        const draftRow = (sqlite.db
          .query<{ draft_count: number; oldest_draft_at: string | null }, []>(`
            select
              sum(case when status = 'draft' then 1 else 0 end) as draft_count,
              min(case when status = 'draft' then updated_at end) as oldest_draft_at
            from knowledge_items
          `)
          .get() ?? {
          draft_count: 0,
          oldest_draft_at: null,
        }) as { draft_count: number; oldest_draft_at: string | null };
        queryMs += timer.elapsedMs();
        hitl.draftCount = Number(draftRow.draft_count ?? 0);
        hitl.oldestDraftAt = toIso(draftRow.oldest_draft_at);
        hitl.oldestDraftAgeMinutes = ageMinutesFromIso(hitl.oldestDraftAt);
        if (hitl.draftCount > hitl.backlogThresholdCount) {
          reasons.push("HITL_DRAFT_BACKLOG_HIGH");
        }
        if (
          hitl.oldestDraftAgeMinutes !== null &&
          hitl.oldestDraftAgeMinutes > hitl.backlogThresholdAgeMinutes
        ) {
          reasons.push("HITL_DRAFT_REVIEW_STALE");
        }
      } catch {
        reasons.push("HITL_BACKLOG_QUERY_FAILED");
      }

      try {
        const timer = startMetricTimer();
        const activeRows = sqlite.db
          .query<
            {
              type: string;
              scope: string;
              compile_select_count: number;
              dynamic_score: number;
              last_compiled_at: string | null;
              freshness_base: string | null;
            },
            []
          >(`
            select
              type,
              scope,
              compile_select_count,
              dynamic_score,
              last_compiled_at,
              coalesce(last_verified_at, updated_at) as freshness_base
            from knowledge_items
            where status = 'active'
          `)
          .all();
        queryMs += timer.elapsedMs();
        const dynamicScores = activeRows
          .map((row) => Number(row.dynamic_score))
          .filter((value) => Number.isFinite(value));
        const decayFactors = activeRows.map((row) => {
          const perDay = row.type === "procedure" ? 0.004 : 0.001;
          const scopeMultiplier = row.scope === "global" ? 0.5 : 1.0;
          return Math.exp(-(perDay * scopeMultiplier * ageDaysFromIso(toIso(row.freshness_base))));
        });
        knowledgeLifecycle.activeCount = activeRows.length;
        knowledgeLifecycle.zeroUseActiveCount = activeRows.filter(
          (row) => Number(row.compile_select_count ?? 0) === 0,
        ).length;
        knowledgeLifecycle.staleByDecayCount = decayFactors.filter(
          (value) => value < staleDecayFactor,
        ).length;
        knowledgeLifecycle.staleProcedureCount = activeRows.filter(
          (row, index) => row.type === "procedure" && (decayFactors[index] ?? 1) < staleDecayFactor,
        ).length;
        knowledgeLifecycle.dynamicScoreAvg =
          dynamicScores.length > 0
            ? dynamicScores.reduce((sum, value) => sum + value, 0) / dynamicScores.length
            : null;
        knowledgeLifecycle.dynamicScoreP95 = percentile(dynamicScores, 0.95);
        knowledgeLifecycle.lastCompiledAt =
          activeRows
            .map((row) => toIso(row.last_compiled_at))
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? null;
        knowledgeLifecycle.lastCompiledAgeMinutes = ageMinutesFromIso(
          knowledgeLifecycle.lastCompiledAt,
        );

        if (
          knowledgeLifecycle.activeCount >= zeroUseWarningMinActiveCount &&
          knowledgeLifecycle.zeroUseActiveCount / Math.max(1, knowledgeLifecycle.activeCount) >= 0.7
        ) {
          reasons.push("KNOWLEDGE_ZERO_USE_HIGH");
        }
        if (knowledgeLifecycle.staleByDecayCount >= 10) {
          reasons.push("KNOWLEDGE_DECAY_STALE_HIGH");
        }
      } catch {
        reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
      }

      try {
        const timer = startMetricTimer();
        const rows = sqlite.db
          .query<
            {
              id: string;
              intent_tags: string;
              polarity: string;
              type: string;
              metadata: string;
              origin_links: number;
              source_links: number;
            },
            []
          >(`
            select
              ki.id,
              ki.intent_tags,
              ki.polarity,
              ki.type,
              ki.metadata,
              (select count(*) from knowledge_origin_links kol where kol.knowledge_id = ki.id)
                as origin_links,
              (select count(*) from knowledge_source_links ksl where ksl.knowledge_id = ki.id)
                as source_links
            from knowledge_items ki
          `)
          .all();
        queryMs += timer.elapsedMs();
        if (
          rows.some((row) =>
            parseJsonArray(row.intent_tags).some(
              (tag) => typeof tag === "string" && !knownIntentTags.has(tag),
            ),
          )
        ) {
          reasons.push("KNOWLEDGE_UNKNOWN_INTENT_TAGS");
        }
        if (
          rows.some((row) => {
            const metadata = parseJsonObject(row.metadata);
            return (
              row.polarity === "negative" &&
              Number(row.origin_links) === 0 &&
              Number(row.source_links) === 0 &&
              typeof metadata.sourceDocumentUri !== "string"
            );
          })
        ) {
          reasons.push("KNOWLEDGE_NEGATIVE_WITHOUT_ORIGIN");
        }
        if (rows.some((row) => row.polarity === "negative" && row.type === "procedure")) {
          reasons.push("KNOWLEDGE_NEGATIVE_AS_POSITIVE");
        }
      } catch {
        // 非ブロッキング
      }
    }

    if (existingTables.includes("audit_logs")) {
      try {
        const timer = startMetricTimer();
        const row = sqlite.db
          .query<{ count: number }, [string]>(
            "select count(*) as count from audit_logs where event_type = 'KNOWLEDGE_VALUE_UPDATE_FAILED' and created_at >= ?",
          )
          .get(new Date(Date.now() - freshnessThresholdMinutes * 60_000).toISOString());
        queryMs += timer.elapsedMs();
        const recentFailureCount = Number(row?.count ?? 0);
        if (recentFailureCount > 0 && !reasons.includes("KNOWLEDGE_VALUE_UPDATE_FAILED")) {
          reasons.push("KNOWLEDGE_VALUE_UPDATE_FAILED");
        }
      } catch {
        if (!reasons.includes("KNOWLEDGE_VALUE_QUERY_FAILED")) {
          reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
        }
      }
    }

    return {
      db: {
        reachable: true,
        durationMs: Math.round(responseMs),
        responseMs,
        queryMs: roundMetricMs(queryMs),
        totalInspectionMs: totalTimer.elapsedMs(),
      },
      reachable: true,
      vector: {
        installed: vectorInstalled,
        healthMs: rustVectorHealth?.durationMs ?? null,
        source: rustVectorHealth ? "rust" : sqlite.vector.available ? "bun" : "unavailable",
      },
      vectorInstalled,
      expectedTables,
      existingTables,
      missingTables,
      staleKnowledgeCount,
      staleSourceCount: 0,
      hitl,
      knowledgeLifecycle,
      reasons,
    };
  } catch (error) {
    const elapsedMs = totalTimer.elapsedMs();
    return {
      db: {
        reachable: false,
        durationMs: Math.round(elapsedMs),
        responseMs: elapsedMs,
        queryMs: 0,
        totalInspectionMs: elapsedMs,
        error: error instanceof Error ? error.message : String(error),
      },
      reachable: false,
      vector: {
        installed: false,
        healthMs: null,
        source: "unavailable",
      },
      vectorInstalled: false,
      expectedTables,
      existingTables: [],
      missingTables: expectedTables,
      staleKnowledgeCount: 0,
      staleSourceCount: 0,
      hitl: {
        draftCount: 0,
        oldestDraftAt: null,
        oldestDraftAgeMinutes: null,
        backlogThresholdCount: hitlBacklogThresholdCount,
        backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
      },
      knowledgeLifecycle: createDefaultKnowledgeLifecycle({
        staleDecayFactor,
        zeroUseWarningMinActiveCount,
      }),
      reasons: ["DB_UNREACHABLE"],
    };
  }
}

export async function inspectDatabase({
  freshnessThresholdMinutes,
  staleDecayFactor,
  zeroUseWarningMinActiveCount,
}: DatabaseInspectorOptions): Promise<DatabaseInspection> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return inspectSqliteDatabase({
      freshnessThresholdMinutes,
      staleDecayFactor,
      zeroUseWarningMinActiveCount,
    });
  }

  const db = getDb();
  const totalTimer = startMetricTimer();
  const responseTimer = startMetricTimer();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    const elapsedMs = totalTimer.elapsedMs();
    return {
      db: {
        reachable: false,
        durationMs: Math.round(elapsedMs),
        responseMs: elapsedMs,
        queryMs: 0,
        totalInspectionMs: elapsedMs,
        error: error instanceof Error ? error.message : String(error),
      },
      reachable: false,
      vector: {
        installed: false,
        healthMs: null,
        source: "postgres",
      },
      vectorInstalled: false,
      expectedTables: [...requiredTables],
      existingTables: [],
      missingTables: [...requiredTables],
      staleKnowledgeCount: 0,
      staleSourceCount: 0,
      hitl: {
        draftCount: 0,
        oldestDraftAt: null,
        oldestDraftAgeMinutes: null,
        backlogThresholdCount: hitlBacklogThresholdCount,
        backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
      },
      knowledgeLifecycle: createDefaultKnowledgeLifecycle({
        staleDecayFactor,
        zeroUseWarningMinActiveCount,
      }),
      reasons: ["DB_UNREACHABLE"],
    };
  }
  const responseMs = responseTimer.elapsedMs();

  const reasons: string[] = [];
  let queryMs = 0;

  let vectorInstalled = false;
  let vectorHealthMs: number | null = null;
  try {
    const timer = startMetricTimer();
    const result = await db.execute(
      sql`select exists(select 1 from pg_extension where extname = 'vector') as installed`,
    );
    vectorHealthMs = timer.elapsedMs();
    vectorInstalled = Boolean((result.rows as Array<{ installed: boolean }>)[0]?.installed);
    if (!vectorInstalled) {
      reasons.push("VECTOR_EXTENSION_MISSING");
    }
  } catch {
    reasons.push("VECTOR_EXTENSION_CHECK_FAILED");
  }

  let existingTables: string[] = [];
  try {
    const timer = startMetricTimer();
    const result = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          ${sql.raw(requiredTableSqlList)}
        )
    `);
    queryMs += timer.elapsedMs();
    existingTables = (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
  } catch {
    reasons.push("REQUIRED_TABLES_CHECK_FAILED");
  }

  const missingTables = requiredTables.filter((tableName) => !existingTables.includes(tableName));
  if (missingTables.length > 0) {
    reasons.push("MISSING_REQUIRED_TABLES");
  }

  let staleKnowledgeCount = 0;
  let staleSourceCount = 0;
  const hitl: DoctorReport["hitl"] = {
    draftCount: 0,
    oldestDraftAt: null,
    oldestDraftAgeMinutes: null,
    backlogThresholdCount: hitlBacklogThresholdCount,
    backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
  };
  const knowledgeLifecycle = createDefaultKnowledgeLifecycle({
    staleDecayFactor,
    zeroUseWarningMinActiveCount,
  });

  if (!missingTables.includes("knowledge_items")) {
    try {
      const timer = startMetricTimer();
      const result = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where status = 'deprecated'
      `);
      queryMs += timer.elapsedMs();
      staleKnowledgeCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
    } catch {
      reasons.push("STALE_KNOWLEDGE_COUNT_QUERY_FAILED");
    }

    try {
      const timer = startMetricTimer();
      const draftResult = await db.execute(sql`
        select
          count(*) filter (where status = 'draft')::int as draft_count,
          min(case when status = 'draft' then updated_at end) as oldest_draft_at
        from knowledge_items
      `);
      queryMs += timer.elapsedMs();
      const draftRow = (draftResult.rows as Array<Record<string, unknown>>)[0] ?? {};
      hitl.draftCount = Number(draftRow.draft_count ?? 0);
      hitl.oldestDraftAt = toIso(draftRow.oldest_draft_at);
      hitl.oldestDraftAgeMinutes = ageMinutesFromIso(hitl.oldestDraftAt);
      if (hitl.draftCount > hitl.backlogThresholdCount) {
        reasons.push("HITL_DRAFT_BACKLOG_HIGH");
      }
      if (
        hitl.oldestDraftAgeMinutes !== null &&
        hitl.oldestDraftAgeMinutes > hitl.backlogThresholdAgeMinutes
      ) {
        reasons.push("HITL_DRAFT_REVIEW_STALE");
      }
    } catch {
      reasons.push("HITL_BACKLOG_QUERY_FAILED");
    }

    try {
      const timer = startMetricTimer();
      const lifecycleResult = await db.execute(sql`
        with active_items as (
          select
            status,
            type,
            scope,
            compile_select_count,
            dynamic_score,
            last_compiled_at,
            coalesce(last_verified_at, updated_at) as freshness_base
          from knowledge_items
          where status = 'active'
        ),
        scored as (
          select
            *,
            exp(
              -(
                (case when type = 'procedure' then 0.004 else 0.001 end) *
                (case when scope = 'global' then 0.5 else 1.0 end) *
                greatest(0, extract(epoch from (now() - freshness_base)) / 86400.0)
              )
            ) as decay_factor
          from active_items
        )
        select
          count(*)::int as active_count,
          count(*) filter (where compile_select_count = 0)::int as zero_use_active_count,
          count(*) filter (where decay_factor < ${staleDecayFactor})::int as stale_by_decay_count,
          count(*) filter (
            where type = 'procedure' and decay_factor < ${staleDecayFactor}
          )::int as stale_procedure_count,
          avg(dynamic_score)::float as dynamic_score_avg,
          percentile_cont(0.95) within group (order by dynamic_score)::float as dynamic_score_p95,
          max(last_compiled_at) as last_compiled_at
        from scored
      `);
      queryMs += timer.elapsedMs();
      const lifecycleRow = (lifecycleResult.rows as Array<Record<string, unknown>>)[0] ?? {};

      knowledgeLifecycle.activeCount = Number(lifecycleRow.active_count ?? 0);
      knowledgeLifecycle.zeroUseActiveCount = Number(lifecycleRow.zero_use_active_count ?? 0);
      knowledgeLifecycle.staleByDecayCount = Number(lifecycleRow.stale_by_decay_count ?? 0);
      knowledgeLifecycle.staleProcedureCount = Number(lifecycleRow.stale_procedure_count ?? 0);

      const dynamicScoreAvgRaw = lifecycleRow.dynamic_score_avg;
      const dynamicScoreP95Raw = lifecycleRow.dynamic_score_p95;
      knowledgeLifecycle.dynamicScoreAvg =
        dynamicScoreAvgRaw === null || dynamicScoreAvgRaw === undefined
          ? null
          : Number(dynamicScoreAvgRaw);
      knowledgeLifecycle.dynamicScoreP95 =
        dynamicScoreP95Raw === null || dynamicScoreP95Raw === undefined
          ? null
          : Number(dynamicScoreP95Raw);

      knowledgeLifecycle.lastCompiledAt = toIso(lifecycleRow.last_compiled_at);
      knowledgeLifecycle.lastCompiledAgeMinutes = ageMinutesFromIso(
        knowledgeLifecycle.lastCompiledAt,
      );

      if (
        knowledgeLifecycle.activeCount >= zeroUseWarningMinActiveCount &&
        knowledgeLifecycle.zeroUseActiveCount / Math.max(1, knowledgeLifecycle.activeCount) >= 0.7
      ) {
        reasons.push("KNOWLEDGE_ZERO_USE_HIGH");
      }
      if (knowledgeLifecycle.staleByDecayCount >= 10) {
        reasons.push("KNOWLEDGE_DECAY_STALE_HIGH");
      }
    } catch {
      reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
    }

    try {
      const timer = startMetricTimer();
      const unknownTagsResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items,
             jsonb_array_elements_text(intent_tags) as tag
        where tag not in (${sql.join(
          knowledgeIntentTagSlugs.map((tag) => sql`${tag}`),
          sql`, `,
        )})
      `);
      queryMs += timer.elapsedMs();
      const unknownTagsCount = Number(
        (unknownTagsResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (unknownTagsCount > 0) {
        reasons.push("KNOWLEDGE_UNKNOWN_INTENT_TAGS");
      }

      const negativeWithoutOriginTimer = startMetricTimer();
      const negativeWithoutOriginResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where polarity = 'negative'
          and id not in (select knowledge_id from knowledge_origin_links)
          and id not in (select knowledge_id from knowledge_source_links)
          and nullif(metadata ->> 'sourceDocumentUri', '') is null
      `);
      queryMs += negativeWithoutOriginTimer.elapsedMs();
      const negativeWithoutOriginCount = Number(
        (negativeWithoutOriginResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (negativeWithoutOriginCount > 0) {
        reasons.push("KNOWLEDGE_NEGATIVE_WITHOUT_ORIGIN");
      }

      const negativeAsPositiveTimer = startMetricTimer();
      const negativeAsPositiveResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where polarity = 'negative' and type = 'procedure'
      `);
      queryMs += negativeAsPositiveTimer.elapsedMs();
      const negativeAsPositiveCount = Number(
        (negativeAsPositiveResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (negativeAsPositiveCount > 0) {
        reasons.push("KNOWLEDGE_NEGATIVE_AS_POSITIVE");
      }
    } catch {
      // 非ブロッキング
    }
  }

  // sources は時間経過で stale と判定する必要がないため、検出を廃止します。
  staleSourceCount = 0;

  if (!missingTables.includes("audit_logs")) {
    try {
      const timer = startMetricTimer();
      const result = await db.execute(sql`
        select count(*)::int as count
        from audit_logs
        where event_type = 'KNOWLEDGE_VALUE_UPDATE_FAILED'
          and created_at >= now() - (${freshnessThresholdMinutes} * interval '1 minute')
      `);
      queryMs += timer.elapsedMs();
      const recentFailureCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
      if (recentFailureCount > 0 && !reasons.includes("KNOWLEDGE_VALUE_UPDATE_FAILED")) {
        reasons.push("KNOWLEDGE_VALUE_UPDATE_FAILED");
      }
    } catch {
      if (!reasons.includes("KNOWLEDGE_VALUE_QUERY_FAILED")) {
        reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
      }
    }
  }

  return {
    db: {
      reachable: true,
      durationMs: Math.round(responseMs),
      responseMs,
      queryMs: roundMetricMs(queryMs),
      totalInspectionMs: totalTimer.elapsedMs(),
    },
    reachable: true,
    vector: {
      installed: vectorInstalled,
      healthMs: vectorHealthMs,
      source: "postgres",
    },
    vectorInstalled,
    expectedTables: [...requiredTables],
    existingTables,
    missingTables,
    staleKnowledgeCount,
    staleSourceCount,
    hitl,
    knowledgeLifecycle,
    reasons,
  };
}
