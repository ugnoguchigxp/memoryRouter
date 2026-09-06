import { sql } from "drizzle-orm";
import { readFileLockState } from "../../../cli/file-lock.js";
import { groupedConfig } from "../../../config.js";
import { APP_CONSTANTS } from "../../../constants.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { getDb } from "../../../db/index.js";
import type { DoctorDistillationHealth } from "../../../shared/schemas/doctor.schema.js";
import { getDistillationFailedBacklogLevel } from "../distillation-backlog.util.js";
import { isPipelineLockLikelyBlocking } from "../distillation-lock.util.js";
import { minutesSince, normalizeReasonCounts, timestampToIso } from "../doctor.utils.js";
import { inspectLaunchAgent } from "../launch-agent.util.js";

export type DistillationRunInspectorOptions = {
  canQueryDb: boolean;
};

type DistillationHealthReport = DoctorDistillationHealth;
type DistillationRuns = DistillationHealthReport["runs"];
type DistillationJobs = DistillationHealthReport["jobs"];
type DistillationQueueHealth = DistillationHealthReport["queueHealth"];
type DistillationInputSources = DistillationHealthReport["inputSources"];
type SourceKind = "wiki_file" | "vibe_memory";

export type DistillationRunInspectorConfig = {
  label: string;
  launchAgentLabel: string;
  setupScript: string;
  runCommand: string;
  logPath: string;
  targetKind: "wiki_file" | "vibe_memory";
};

type DistillationRunsRow =
  | {
      total_runs?: number;
      ok_runs?: number;
      skipped_runs?: number;
      failed_runs?: number;
      last_run_at?: Date | string | null;
      last_ok_run_at?: Date | string | null;
      skipped_run_reasons?: unknown;
      outcome_kind_counts?: unknown;
    }
  | undefined;

type DistillationQueueBlockers = NonNullable<DistillationQueueHealth["blockers"]>;
type TerminalRunRow = {
  status: string;
  last_outcome_kind: string | null;
  ended_at: string | null;
};
type QueueJobRow = {
  source_kind: string;
  status: string;
  created_at: string | null;
  locked_at: string | null;
  heartbeat_at: string | null;
  updated_at: string | null;
  next_run_at: string | null;
  last_error?: string | null;
};

function emptyRuns(): DistillationRuns {
  return {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
    outcomeKindCounts: [],
    skippedRunReasons: [],
    failedRuns: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    lastOkRunAt: null,
    lastOkRunAgeMinutes: null,
  };
}

function emptyInputSources(): DistillationInputSources {
  return {
    sources: 0,
    fragments: 0,
  };
}

function emptyJobs(): DistillationJobs {
  return {
    total: 0,
    queued: 0,
    running: 0,
    paused: 0,
    failed: 0,
    failedLast24h: 0,
    failedLast7d: 0,
    lastPausedAt: null,
    lastError: null,
  };
}

function emptyQueueHealth(): DistillationQueueHealth {
  return {
    queued: 0,
    running: 0,
    retryablePaused: 0,
    staleRunning: 0,
    blockedByHigherPriority: false,
    blockers: {
      pendingKnowledgeCandidates: 0,
      runningKnowledgeCandidates: 0,
      staleRunningKnowledgeCandidates: 0,
      retryableKnowledgeCandidates: 0,
      manualPausedKnowledgeCandidates: 0,
      pendingWiki: 0,
      runningWiki: 0,
      staleRunningWiki: 0,
      retryableWiki: 0,
      manualPausedWiki: 0,
    },
    oldestQueuedAt: null,
    oldestQueuedAgeMinutes: null,
    oldestRunningAt: null,
    oldestRunningAgeMinutes: null,
    lock: {
      path: groupedConfig.distillation.pipelineLockFile,
      exists: false,
      pid: null,
      createdAt: null,
      ageSeconds: null,
      staleByCreatedAge: false,
    },
  };
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const rebuiltUtc = new Date(
      Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ),
    );
    return Number.isNaN(rebuiltUtc.getTime()) ? null : rebuiltUtc.toISOString();
  }
  if (typeof value === "string" && value.startsWith("unix-ms:")) return timestampToIso(value);
  return timestampToIso(value);
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function timestampMs(value: string | null | undefined): number | null {
  const iso = timestampToIso(value);
  if (!iso) return null;
  const timestamp = new Date(iso).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: { value: string; timestamp: number } | null = null;
  for (const value of values) {
    const iso = timestampToIso(value);
    if (!iso) continue;
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (!latest || timestamp > latest.timestamp) latest = { value: iso, timestamp };
  }
  return latest?.value ?? null;
}

function earliestTimestamp(values: Array<string | null | undefined>): string | null {
  let earliest: { value: string; timestamp: number } | null = null;
  for (const value of values) {
    const iso = timestampToIso(value);
    if (!iso) continue;
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (!earliest || timestamp < earliest.timestamp) earliest = { value: iso, timestamp };
  }
  return earliest?.value ?? null;
}

function countReasons(rows: TerminalRunRow[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason =
      row.status === "completed"
        ? (row.last_outcome_kind ?? "completed")
        : row.status === "failed"
          ? (row.last_outcome_kind ?? "processing_error")
          : row.status === "skipped" && !row.last_outcome_kind
            ? "no_candidate"
            : (row.last_outcome_kind ?? row.status);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
}

function applyTerminalRows(runs: DistillationRuns, rows: TerminalRunRow[]) {
  const completedRows = rows.filter((row) => row.status === "completed");
  const skippedRows = rows.filter((row) => row.status === "skipped");
  const failedRows = rows.filter((row) => row.status === "failed");
  runs.totalRuns = rows.length;
  runs.okRuns = completedRows.length;
  runs.skippedRuns = skippedRows.length;
  runs.failedRuns = failedRows.length;
  runs.lastRunAt = latestTimestamp(rows.map((row) => row.ended_at));
  runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
  runs.lastOkRunAt = latestTimestamp(completedRows.map((row) => row.ended_at));
  runs.lastOkRunAgeMinutes = runs.lastOkRunAt ? minutesSince(runs.lastOkRunAt) : null;
  runs.skippedRunReasons = countReasons(skippedRows);
  runs.outcomeKindCounts = countReasons(rows);
}

function applyRunRow(runs: DistillationRuns, row: DistillationRunsRow) {
  const lastRunAt = toIsoString(row?.last_run_at);
  const lastOkRunAt = toIsoString(row?.last_ok_run_at);
  runs.totalRuns = Number(row?.total_runs ?? 0);
  runs.okRuns = Number(row?.ok_runs ?? 0);
  runs.skippedRuns = Number(row?.skipped_runs ?? 0);
  runs.outcomeKindCounts = normalizeReasonCounts(row?.outcome_kind_counts);
  runs.skippedRunReasons = normalizeReasonCounts(row?.skipped_run_reasons);
  runs.failedRuns = Number(row?.failed_runs ?? 0);
  runs.lastRunAt = lastRunAt;
  runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
  runs.lastOkRunAt = lastOkRunAt;
  runs.lastOkRunAgeMinutes = runs.lastOkRunAt ? minutesSince(runs.lastOkRunAt) : null;
}

function hasRecentProgress(runs: DistillationRuns): boolean {
  const ageMinutes = runs.lastRunAgeMinutes;
  return (
    typeof ageMinutes === "number" &&
    ageMinutes <= groupedConfig.distillation.pipelineLockStaleSeconds / 60
  );
}

async function loadDomainDistillationRuns(targetKind: SourceKind): Promise<DistillationRunsRow> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<TerminalRunRow, [string, string, string]>(
        `
          select status, last_outcome_kind, coalesce(completed_at, updated_at) as ended_at
          from finding_candidate_queue
          where source_kind = ?
            and status in ('completed', 'skipped', 'failed')
          union all
          select ceq.status, ceq.last_outcome_kind, coalesce(ceq.completed_at, ceq.updated_at) as ended_at
          from covering_evidence_queue ceq
          join found_candidates fc on fc.id = ceq.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
          where fq.source_kind = ?
            and ceq.status in ('failed', 'skipped')
          union all
          select fdq.status, fdq.last_outcome_kind, coalesce(fdq.completed_at, fdq.updated_at) as ended_at
          from finalize_distille_queue fdq
          join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
          join found_candidates fc on fc.id = ecr.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
          where fq.source_kind = ?
            and fdq.status in ('completed', 'skipped', 'failed')
        `,
      )
      .all(targetKind, targetKind, targetKind);
    const runs = emptyRuns();
    applyTerminalRows(runs, rows);
    return {
      total_runs: runs.totalRuns,
      ok_runs: runs.okRuns,
      skipped_runs: runs.skippedRuns,
      failed_runs: runs.failedRuns,
      last_run_at: runs.lastRunAt,
      last_ok_run_at: runs.lastOkRunAt,
      skipped_run_reasons: runs.skippedRunReasons,
      outcome_kind_counts: runs.outcomeKindCounts,
    };
  }

  const db = getDb();
  const sourceKind = targetKind;
  const result = await db.execute(sql`
    with finding as (
      select
        id,
        status,
        last_outcome_kind,
        coalesce(completed_at, updated_at) as ended_at
      from finding_candidate_queue
      where source_kind = ${sourceKind}
        and status in ('completed', 'skipped', 'failed')
    ),
    covering as (
      select
        ceq.status,
        ceq.last_outcome_kind,
        coalesce(ceq.completed_at, ceq.updated_at) as ended_at
      from covering_evidence_queue ceq
      join found_candidates fc on fc.id = ceq.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
      where fq.source_kind = ${sourceKind}
        and ceq.status in ('failed', 'skipped')
    ),
    finalizing as (
      select
        fdq.status,
        fdq.last_outcome_kind,
        coalesce(fdq.completed_at, fdq.updated_at) as ended_at
      from finalize_distille_queue fdq
      join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
      join found_candidates fc on fc.id = ecr.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
      where fq.source_kind = ${sourceKind}
        and fdq.status in ('completed', 'skipped', 'failed')
    ),
    latest as (
      select status, last_outcome_kind, ended_at from finding where status in ('skipped', 'failed')
      union all
      select status, last_outcome_kind, ended_at from covering
      union all
      select status, last_outcome_kind, ended_at from finalizing
    ),
    normalized as (
      select
        status,
        case
          when status = 'completed'
            then 'knowledge_created'
          when status = 'failed' then coalesce(last_outcome_kind, 'processing_error')
          when status = 'skipped' and coalesce(last_outcome_kind, '') = ''
            then 'no_candidate'
          when status = 'skipped' then coalesce(last_outcome_kind, 'candidate_rejected')
          else status
        end as reason,
        ended_at
      from latest
    ),
    skipped_reason_counts as (
      select
        reason,
        count(*)::int as run_count
      from normalized
      where status = 'skipped'
      group by reason
    ),
    outcome_kind_counts as (
      select
        reason,
        count(*)::int as run_count
      from normalized
      group by reason
    )
    select
      count(*)::int as total_runs,
      count(*) filter (where status = 'completed')::int as ok_runs,
      count(*) filter (where status = 'skipped')::int as skipped_runs,
      count(*) filter (where status = 'failed')::int as failed_runs,
      (max(ended_at)) at time zone 'UTC' as last_run_at,
      (max(ended_at) filter (where status = 'completed')) at time zone 'UTC' as last_ok_run_at,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('reason', reason, 'count', run_count)
          order by reason
        )
        from skipped_reason_counts
      ), '[]'::jsonb) as skipped_run_reasons,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('reason', reason, 'count', run_count)
          order by reason
        )
        from outcome_kind_counts
      ), '[]'::jsonb) as outcome_kind_counts
    from normalized
  `);
  return result.rows[0] as DistillationRunsRow;
}

async function loadDomainDistillationJobs(targetKind: SourceKind): Promise<DistillationJobs> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query<
        {
          status: string;
          last_error: string | null;
          updated_at: string | null;
        },
        [string, string, string]
      >(
        `
          select status, last_error, updated_at
          from finding_candidate_queue
          where source_kind = ?
          union all
          select ceq.status, ceq.last_error, ceq.updated_at
          from covering_evidence_queue ceq
          join found_candidates fc on fc.id = ceq.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
          where fq.source_kind = ?
          union all
          select fdq.status, fdq.last_error, fdq.updated_at
          from finalize_distille_queue fdq
          join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
          join found_candidates fc on fc.id = ecr.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
          where fq.source_kind = ?
        `,
      )
      .all(targetKind, targetKind, targetKind);
    const pausedRows = rows.filter((row) => row.status === "paused");
    const failedRows = rows.filter((row) => row.status === "failed");
    const now = Date.now();
    const failedSince = (ageMs: number) =>
      failedRows.filter((row) => {
        const updatedAt = timestampMs(row.updated_at);
        return typeof updatedAt === "number" && updatedAt >= now - ageMs;
      }).length;
    const latestErrorRow = rows
      .filter((row) => row.last_error)
      .sort((a, b) => (timestampMs(b.updated_at) ?? 0) - (timestampMs(a.updated_at) ?? 0))[0];
    return {
      total: rows.length,
      queued: rows.filter((row) => row.status === "pending").length,
      running: rows.filter((row) => row.status === "running").length,
      paused: pausedRows.length,
      failed: failedRows.length,
      failedLast24h: failedSince(24 * 60 * 60 * 1000),
      failedLast7d: failedSince(7 * 24 * 60 * 60 * 1000),
      lastPausedAt: latestTimestamp(pausedRows.map((row) => row.updated_at)),
      lastError: latestErrorRow?.last_error ?? null,
    };
  }

  const db = getDb();
  const sourceKind = targetKind;
  const result = await db.execute(sql`
    with jobs as (
      select status, last_error, updated_at
      from finding_candidate_queue
      where source_kind = ${sourceKind}
      union all
      select ceq.status, ceq.last_error, ceq.updated_at
      from covering_evidence_queue ceq
      join found_candidates fc on fc.id = ceq.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
      where fq.source_kind = ${sourceKind}
      union all
      select fdq.status, fdq.last_error, fdq.updated_at
      from finalize_distille_queue fdq
      join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
      join found_candidates fc on fc.id = ecr.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
      where fq.source_kind = ${sourceKind}
    )
      select
      count(*)::int as total,
      count(*) filter (where status = 'pending')::int as queued,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'paused')::int as paused,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'failed' and updated_at >= now() - interval '24 hours')::int as failed_last_24h,
      count(*) filter (where status = 'failed' and updated_at >= now() - interval '7 days')::int as failed_last_7d,
      max(updated_at) filter (where status = 'paused') as last_paused_at,
      (array_agg(last_error order by updated_at desc) filter (where last_error is not null))[1] as last_error
    from jobs
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    queued: Number(row.queued ?? 0),
    running: Number(row.running ?? 0),
    paused: Number(row.paused ?? 0),
    failed: Number(row.failed ?? 0),
    failedLast24h: Number(row.failed_last_24h ?? 0),
    failedLast7d: Number(row.failed_last_7d ?? 0),
    lastPausedAt: toIsoString(row.last_paused_at as Date | string | null | undefined),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

async function loadDomainQueueHealth(
  targetKind: SourceKind,
): Promise<Omit<DistillationQueueHealth, "lock">> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const staleSeconds = APP_CONSTANTS.distillationTargetStaleSeconds;
    const higherPriorityKinds =
      targetKind === "vibe_memory"
        ? ["knowledge_candidate", "web_ingest", "wiki_file"]
        : targetKind === "wiki_file"
          ? ["knowledge_candidate", "web_ingest"]
          : [];
    const rows = sqlite.db
      .query<QueueJobRow, []>(
        `
          select
            fq.source_kind,
            fq.status,
            fq.created_at,
            fq.locked_at,
            fq.heartbeat_at,
            fq.updated_at,
            fq.next_run_at,
            fq.last_error
          from finding_candidate_queue fq
          union all
          select
            fq.source_kind,
            ceq.status,
            ceq.created_at,
            ceq.locked_at,
            ceq.heartbeat_at,
            ceq.updated_at,
            ceq.next_run_at,
            ceq.last_error
          from covering_evidence_queue ceq
          join found_candidates fc on fc.id = ceq.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
          union all
          select
            fq.source_kind,
            fdq.status,
            fdq.created_at,
            fdq.locked_at,
            fdq.heartbeat_at,
            fdq.updated_at,
            null as next_run_at,
            fdq.last_error
          from finalize_distille_queue fdq
          join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
          join found_candidates fc on fc.id = ecr.found_candidate_id
          join finding_candidate_queue fq on fq.id = fc.finding_job_id
        `,
      )
      .all();
    const now = Date.now();
    const isRetryablePaused = (row: QueueJobRow) =>
      row.status === "paused" && ((timestampMs(row.next_run_at) ?? 0) <= now || !row.next_run_at);
    const isStaleRunning = (row: QueueJobRow) => {
      if (row.status !== "running") return false;
      const lastProgress =
        timestampMs(row.heartbeat_at) ?? timestampMs(row.locked_at) ?? timestampMs(row.updated_at);
      return typeof lastProgress === "number" && lastProgress < now - staleSeconds * 1000;
    };
    const targetRows = rows.filter((row) => row.source_kind === targetKind);
    const higherRows = rows.filter((row) => higherPriorityKinds.includes(row.source_kind));
    const queuedRows = targetRows.filter(
      (row) => row.status === "pending" || isRetryablePaused(row),
    );
    const runningRows = targetRows.filter((row) => row.status === "running");
    const blockers: DistillationQueueBlockers = {
      pendingKnowledgeCandidates: higherRows.filter(
        (row) => row.source_kind === "knowledge_candidate" && row.status === "pending",
      ).length,
      runningKnowledgeCandidates: higherRows.filter(
        (row) => row.source_kind === "knowledge_candidate" && row.status === "running",
      ).length,
      staleRunningKnowledgeCandidates: higherRows.filter(
        (row) => row.source_kind === "knowledge_candidate" && isStaleRunning(row),
      ).length,
      retryableKnowledgeCandidates: higherRows.filter(
        (row) => row.source_kind === "knowledge_candidate" && isRetryablePaused(row),
      ).length,
      manualPausedKnowledgeCandidates: 0,
      pendingWiki: higherRows.filter(
        (row) =>
          (row.source_kind === "wiki_file" || row.source_kind === "web_ingest") &&
          row.status === "pending",
      ).length,
      runningWiki: higherRows.filter(
        (row) =>
          (row.source_kind === "wiki_file" || row.source_kind === "web_ingest") &&
          row.status === "running",
      ).length,
      staleRunningWiki: higherRows.filter(
        (row) =>
          (row.source_kind === "wiki_file" || row.source_kind === "web_ingest") &&
          isStaleRunning(row),
      ).length,
      retryableWiki: higherRows.filter(
        (row) =>
          (row.source_kind === "wiki_file" || row.source_kind === "web_ingest") &&
          isRetryablePaused(row),
      ).length,
      manualPausedWiki: 0,
    };
    const oldestQueuedAt = earliestTimestamp(queuedRows.map((row) => row.created_at));
    const oldestRunningAt = earliestTimestamp(
      runningRows.map(
        (row) =>
          timestampToIso(row.heartbeat_at) ??
          timestampToIso(row.locked_at) ??
          timestampToIso(row.updated_at),
      ),
    );
    return {
      queued: targetRows.filter((row) => row.status === "pending").length,
      running: runningRows.length,
      retryablePaused: targetRows.filter(isRetryablePaused).length,
      staleRunning: targetRows.filter(isStaleRunning).length,
      blockedByHigherPriority:
        blockers.pendingKnowledgeCandidates +
          blockers.runningKnowledgeCandidates +
          blockers.retryableKnowledgeCandidates +
          blockers.pendingWiki +
          blockers.runningWiki +
          blockers.retryableWiki >
        0,
      blockers,
      oldestQueuedAt,
      oldestQueuedAgeMinutes: oldestQueuedAt ? minutesSince(oldestQueuedAt) : null,
      oldestRunningAt,
      oldestRunningAgeMinutes: oldestRunningAt ? minutesSince(oldestRunningAt) : null,
    };
  }

  const db = getDb();
  const sourceKind = targetKind;
  const staleSeconds = APP_CONSTANTS.distillationTargetStaleSeconds;
  const higherPriorityKinds =
    targetKind === "vibe_memory"
      ? ["knowledge_candidate", "web_ingest", "wiki_file"]
      : targetKind === "wiki_file"
        ? ["knowledge_candidate", "web_ingest"]
        : [];
  const higherPriorityKindSql = sql.join(
    higherPriorityKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    with jobs as (
      select
        fq.source_kind,
        fq.status,
        fq.created_at,
        fq.locked_at,
        fq.heartbeat_at,
        fq.updated_at,
        fq.next_run_at
      from finding_candidate_queue fq
      union all
      select
        fq.source_kind,
        ceq.status,
        ceq.created_at,
        ceq.locked_at,
        ceq.heartbeat_at,
        ceq.updated_at,
        ceq.next_run_at
      from covering_evidence_queue ceq
      join found_candidates fc on fc.id = ceq.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
      union all
      select
        fq.source_kind,
        fdq.status,
        fdq.created_at,
        fdq.locked_at,
        fdq.heartbeat_at,
        fdq.updated_at,
        null::timestamp as next_run_at
      from finalize_distille_queue fdq
      join evidence_coverage_results ecr on ecr.id = fdq.evidence_result_id
      join found_candidates fc on fc.id = ecr.found_candidate_id
      join finding_candidate_queue fq on fq.id = fc.finding_job_id
    ),
    target_jobs as (
      select *
      from jobs
      where source_kind = ${sourceKind}
    ),
    higher_jobs as (
      select *
      from jobs
      where source_kind in (${higherPriorityKindSql})
    ),
    target_summary as (
      select
        count(*) filter (where status = 'pending')::int as queued,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (
          where status = 'paused'
            and (next_run_at is null or next_run_at <= now())
        )::int as retryable_paused,
        count(*) filter (
          where status = 'running'
            and coalesce(heartbeat_at, locked_at, updated_at) < now() - make_interval(secs => ${staleSeconds})
        )::int as stale_running,
        to_char(
          min(created_at) filter (
            where status = 'pending'
               or (status = 'paused' and (next_run_at is null or next_run_at <= now()))
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as oldest_queued_at,
        to_char(
          min(coalesce(heartbeat_at, locked_at, updated_at)) filter (where status = 'running'),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) as oldest_running_at
      from target_jobs
    ),
    higher_summary as (
      select
        count(*) filter (where source_kind = 'knowledge_candidate' and status = 'pending')::int
          as pending_knowledge_candidates,
        count(*) filter (where source_kind = 'knowledge_candidate' and status = 'running')::int
          as running_knowledge_candidates,
        count(*) filter (
          where source_kind = 'knowledge_candidate'
            and status = 'running'
            and coalesce(heartbeat_at, locked_at, updated_at) < now() - make_interval(secs => ${staleSeconds})
        )::int as stale_running_knowledge_candidates,
        count(*) filter (
          where source_kind = 'knowledge_candidate'
            and status = 'paused'
            and (next_run_at is null or next_run_at <= now())
        )::int as retryable_knowledge_candidates,
        count(*) filter (
          where source_kind in ('wiki_file', 'web_ingest')
            and status = 'pending'
        )::int as pending_wiki,
        count(*) filter (
          where source_kind in ('wiki_file', 'web_ingest')
            and status = 'running'
        )::int as running_wiki,
        count(*) filter (
          where source_kind in ('wiki_file', 'web_ingest')
            and status = 'running'
            and coalesce(heartbeat_at, locked_at, updated_at) < now() - make_interval(secs => ${staleSeconds})
        )::int as stale_running_wiki,
        count(*) filter (
          where source_kind in ('wiki_file', 'web_ingest')
            and status = 'paused'
            and (next_run_at is null or next_run_at <= now())
        )::int as retryable_wiki
      from higher_jobs
    )
    select
      target_summary.*,
      higher_summary.*
    from target_summary
    cross join higher_summary
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const queued = Number(row.queued ?? 0);
  const running = Number(row.running ?? 0);
  const retryablePaused = Number(row.retryable_paused ?? 0);
  const staleRunning = Number(row.stale_running ?? 0);
  const blockers: DistillationQueueBlockers = {
    pendingKnowledgeCandidates: Number(row.pending_knowledge_candidates ?? 0),
    runningKnowledgeCandidates: Number(row.running_knowledge_candidates ?? 0),
    staleRunningKnowledgeCandidates: Number(row.stale_running_knowledge_candidates ?? 0),
    retryableKnowledgeCandidates: Number(row.retryable_knowledge_candidates ?? 0),
    manualPausedKnowledgeCandidates: 0,
    pendingWiki: Number(row.pending_wiki ?? 0),
    runningWiki: Number(row.running_wiki ?? 0),
    staleRunningWiki: Number(row.stale_running_wiki ?? 0),
    retryableWiki: Number(row.retryable_wiki ?? 0),
    manualPausedWiki: 0,
  };
  const blockedByHigherPriority =
    blockers.pendingKnowledgeCandidates +
      blockers.runningKnowledgeCandidates +
      blockers.retryableKnowledgeCandidates +
      blockers.pendingWiki +
      blockers.runningWiki +
      blockers.retryableWiki >
    0;
  const oldestQueuedAt = toIsoString(row.oldest_queued_at as Date | string | null | undefined);
  const oldestRunningAt = toIsoString(row.oldest_running_at as Date | string | null | undefined);
  return {
    queued,
    running,
    retryablePaused,
    staleRunning,
    blockedByHigherPriority,
    blockers,
    oldestQueuedAt,
    oldestQueuedAgeMinutes: oldestQueuedAt ? minutesSince(oldestQueuedAt) : null,
    oldestRunningAt,
    oldestRunningAgeMinutes: oldestRunningAt ? minutesSince(oldestRunningAt) : null,
  };
}

async function loadInputSources(targetKind: SourceKind): Promise<DistillationInputSources> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    if (targetKind === "wiki_file") {
      const row = sqlite.db
        .query<{ sources: number; fragments: number }, []>(
          `
          select
            (select count(*) from sources where source_kind = 'wiki') as sources,
            (
              select count(*)
              from source_fragments sf
              join sources s on s.id = sf.source_id
              where s.source_kind = 'wiki'
            ) as fragments
          `,
        )
        .get();
      return {
        sources: Number(row?.sources ?? 0),
        fragments: Number(row?.fragments ?? 0),
      };
    }
    const row = sqlite.db
      .query<{ sources: number }, []>("select count(*) as sources from vibe_memories")
      .get();
    return {
      sources: Number(row?.sources ?? 0),
      fragments: 0,
    };
  }

  const db = getDb();
  if (targetKind === "wiki_file") {
    const result = await db.execute(sql`
      select
        (select count(*)::int from sources where source_kind = 'wiki') as sources,
        (
          select count(*)::int
          from source_fragments sf
          join sources s on s.id = sf.source_id
          where s.source_kind = 'wiki'
        ) as fragments
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    return {
      sources: Number(row.sources ?? 0),
      fragments: Number(row.fragments ?? 0),
    };
  }
  const result = await db.execute(sql`select count(*)::int as sources from vibe_memories`);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    sources: Number(row.sources ?? 0),
    fragments: 0,
  };
}

async function inspectPipelineLock(): Promise<DistillationQueueHealth["lock"]> {
  const lockState = await readFileLockState(
    groupedConfig.distillation.pipelineLockFile,
    groupedConfig.distillation.pipelineLockStaleSeconds,
  );
  return {
    path: lockState.path,
    exists: lockState.exists,
    pid: lockState.pid,
    createdAt: lockState.createdAt,
    ageSeconds: lockState.ageSeconds,
    staleByCreatedAge: lockState.staleByCreatedAge,
  };
}

function nextActionsForDistillation(
  config: DistillationRunInspectorConfig,
  inputSources: DistillationInputSources,
  launchAgent: DistillationHealthReport["launchAgent"],
  runs: DistillationRuns,
  jobs: DistillationJobs,
  queueHealth: DistillationQueueHealth,
): string[] {
  const nextActions: string[] = [];
  if (
    config.targetKind === "wiki_file" &&
    inputSources.sources === 0 &&
    inputSources.fragments === 0 &&
    runs.totalRuns === 0 &&
    jobs.queued + jobs.running + jobs.paused + jobs.failed === 0 &&
    queueHealth.queued +
      queueHealth.running +
      queueHealth.retryablePaused +
      queueHealth.staleRunning ===
      0
  ) {
    return nextActions;
  }
  const inspectCommand = "bun run doctor";
  const repairApplyCommand = "bun run queue:finding:once";
  const freshnessThresholdMinutes =
    config.targetKind === "wiki_file" ? 72 * 60 : groupedConfig.doctor.freshnessThresholdMinutes;
  const lockLikelyBlocking = isPipelineLockLikelyBlocking({
    staleByCreatedAge: queueHealth.lock.staleByCreatedAge,
    launchAgentLoaded: launchAgent.loaded,
    staleRunning: queueHealth.staleRunning,
    running: queueHealth.running,
    runnableQueued: queueHealth.queued + queueHealth.retryablePaused,
    blockedByHigherPriority: queueHealth.blockedByHigherPriority,
  });
  if (!launchAgent.installed) {
    nextActions.push(`${config.setupScript} install で LaunchAgent を配置する`);
  } else if (!launchAgent.loaded) {
    nextActions.push(`${config.setupScript} load で LaunchAgent を読み込む`);
  }
  if (!runs.lastRunAt) {
    nextActions.push(`${config.runCommand} を一度実行して処理経路を確認する`);
  }
  if (runs.totalRuns > 0 && !runs.lastOkRunAt) {
    nextActions.push(`${config.label} の成功 run がありません。失敗原因を調査して再実行する`);
  }
  if (
    config.targetKind !== "wiki_file" &&
    runs.lastOkRunAgeMinutes !== null &&
    runs.lastOkRunAgeMinutes > freshnessThresholdMinutes
  ) {
    nextActions.push(
      `${config.label} の最新成功 run が古いです。直近の skipped/failed 理由を確認する`,
    );
  }
  if (
    getDistillationFailedBacklogLevel({
      inputSources,
      launchAgent,
      runs,
      jobs,
      queueHealth,
      nextActions: [],
    }) !== null
  ) {
    nextActions.push(
      `${config.label} は failed backlog が ${jobs.failed} 件あります。直近増分と全体比率を確認し、再実行対象だけを選別する`,
    );
  }
  if (
    runs.failedRuns > 0 &&
    runs.lastRunAt &&
    runs.lastOkRunAt &&
    new Date(runs.lastRunAt).getTime() > new Date(runs.lastOkRunAt).getTime()
  ) {
    nextActions.push(`${config.label} の直近 run に失敗があります。${config.logPath} を確認する`);
  }
  if (jobs.paused > 0) {
    nextActions.push(
      `${config.label} は paused job があります。LLM provider と draft backlog を確認する`,
    );
  }
  if (jobs.running > 0) {
    nextActions.push(
      `${config.label} は running job があります。完了しない場合は lock と worker log を確認する`,
    );
  }
  if (queueHealth.staleRunning > 0) {
    nextActions.push(
      `${config.label} は stale running job があります。${inspectCommand} と Queue 管理画面で対象を確認し、必要なら ${repairApplyCommand} を実行する`,
    );
  }
  if (lockLikelyBlocking) {
    nextActions.push(
      `${config.label} の pipeline lock が古いです。${inspectCommand} で lock 判定を確認する`,
    );
  }
  if (
    queueHealth.queued > 0 &&
    queueHealth.running === 0 &&
    !queueHealth.blockedByHigherPriority &&
    queueHealth.oldestQueuedAgeMinutes !== null &&
    queueHealth.oldestQueuedAgeMinutes > groupedConfig.distillation.pipelineLockStaleSeconds / 60 &&
    !hasRecentProgress(runs)
  ) {
    nextActions.push(
      `${config.label} のqueueが進んでいません。Queue 管理画面で v2 queue 状態を確認し、resident daemon と ${config.logPath} を確認する`,
    );
  }
  if (queueHealth.blockedByHigherPriority && queueHealth.blockers) {
    const blockerSummary = `candidate pending=${queueHealth.blockers.pendingKnowledgeCandidates}, running=${queueHealth.blockers.runningKnowledgeCandidates}, retryable=${queueHealth.blockers.retryableKnowledgeCandidates}; wiki pending=${queueHealth.blockers.pendingWiki}, running=${queueHealth.blockers.runningWiki}, retryable=${queueHealth.blockers.retryableWiki}`;
    nextActions.push(
      `${config.label} は上位priorityにより待機中です（${blockerSummary}）。Queue 管理画面で v2 queue を再確認する`,
    );
  }
  return nextActions;
}

export async function inspectDistillationRunHealth(
  options: DistillationRunInspectorOptions,
  config: DistillationRunInspectorConfig,
): Promise<DistillationHealthReport> {
  const launchAgent = await inspectLaunchAgent(config.launchAgentLabel);
  let inputSources = emptyInputSources();
  const runs = emptyRuns();
  let jobs = emptyJobs();
  let queueHealth = emptyQueueHealth();

  if (options.canQueryDb) {
    try {
      inputSources = await loadInputSources(config.targetKind);
    } catch {
      inputSources = emptyInputSources();
    }
    try {
      const row = await loadDomainDistillationRuns(config.targetKind);
      applyRunRow(runs, row);
    } catch {
      // Keep doctor resilient. Query failures are surfaced by caller-level DB checks.
    }
    try {
      jobs = await loadDomainDistillationJobs(config.targetKind);
    } catch {
      jobs = emptyJobs();
    }
    try {
      queueHealth = {
        ...(await loadDomainQueueHealth(config.targetKind)),
        lock: await inspectPipelineLock(),
      };
    } catch {
      queueHealth = emptyQueueHealth();
    }
  } else {
    queueHealth = {
      ...queueHealth,
      lock: await inspectPipelineLock(),
    };
  }

  return {
    inputSources,
    launchAgent,
    runs,
    jobs,
    queueHealth,
    nextActions: nextActionsForDistillation(
      config,
      inputSources,
      launchAgent,
      runs,
      jobs,
      queueHealth,
    ),
  };
}
