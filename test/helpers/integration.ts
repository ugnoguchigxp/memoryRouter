import { sql } from "drizzle-orm";
import { closeDbPool, getDb } from "../../src/db/index.js";

const requiredTables = [
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "distillation_target_states",
  "distillation_evidence_cache",
  "find_candidate_results",
  "cover_evidence_results",
  "finding_candidate_queue",
  "found_candidates",
  "covering_evidence_queue",
  "evidence_coverage_results",
  "finalize_distille_queue",
  "distillation_queue_events",
  "distillation_queue_migration_map",
  "context_compile_runs",
  "episode_cards",
  "project_identity_aliases",
  "repository_identity_migration_audits",
  "audit_logs",
  "context_compile_evals",
  "context_pack_items",
  "context_decision_runs",
  "context_decision_evidence",
  "context_decision_coverage_traces",
  "context_decision_human_feedback",
  "context_decision_feedback",
  "context_decision_feedback_effects",
  "knowledge_usage_events",
  "knowledge_review_queue",
  "landscape_review_items",
  "landscape_review_item_candidate_links",
  "knowledge_quality_adjustments",
] as const;

const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

export function isDbIntegrationEnabled(): boolean {
  return (
    process.env.CONTEXT_STILL_RUN_DB_TESTS === "1" || process.env.MEMORY_ROUTER_RUN_DB_TESTS === "1"
  );
}

function isSafeIntegrationDatabase(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.pathname.replace(/^\//, "").includes("test");
  } catch {
    return databaseUrl.includes("test");
  }
}

export async function ensureDbIntegrationReady(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router";
  if (
    !isSafeIntegrationDatabase(databaseUrl) &&
    process.env.CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS !== "1" &&
    process.env.MEMORY_ROUTER_ALLOW_DESTRUCTIVE_DB_TESTS !== "1"
  ) {
    throw new Error(
      [
        "DB integration tests truncate tables and must not run against the live contextStill database.",
        "Use a test database whose name includes 'test', or set CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS=1 explicitly.",
      ].join(" "),
    );
  }

  const db = getDb();
  await db.execute(sql`select 1 as ok`);

  const result = await db.execute(sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        ${sql.raw(requiredTableSqlList)}
      )
  `);
  const existing = (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
  const missing = requiredTables.filter((name) => !existing.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `DB integration tests require migrated schema. Missing tables: ${missing.join(", ")}`,
    );
  }
}

export async function truncateIntegrationTables(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    truncate table
      context_pack_items,
      context_decision_feedback_effects,
      context_decision_feedback,
      context_decision_human_feedback,
      context_decision_coverage_traces,
      context_decision_evidence,
      context_decision_runs,
      context_compile_runs,
      episode_cards,
      repository_identity_migration_audits,
      project_identity_aliases,
      audit_logs,
      context_compile_evals,
      knowledge_quality_adjustments,
      landscape_review_item_candidate_links,
      landscape_review_items,
      knowledge_review_queue,
      knowledge_usage_events,
      cover_evidence_results,
      find_candidate_results,
      distillation_evidence_cache,
      distillation_target_states,
      finalize_distille_queue,
      evidence_coverage_results,
      covering_evidence_queue,
      found_candidates,
      finding_candidate_queue,
      distillation_queue_events,
      distillation_queue_migration_map,
      agent_diff_entries,
      vibe_memories,
      knowledge_source_links,
      source_fragments,
      sources,
      knowledge_items
    restart identity cascade
  `);
}

export async function closeIntegrationDb(): Promise<void> {
  await closeDbPool();
}
