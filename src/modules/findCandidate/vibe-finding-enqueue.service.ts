import { sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { getRuntimeSqliteCoreDatabase } from "../../db/sqlite/runtime.js";
import { enqueueFindingJob } from "../queue/core/worker.js";
import {
  type VibeFindingEnqueueOptions,
  type VibeFindingEnqueueReport,
  type VibeFindingSourceRow,
  isVibeMemoryWithinSinceDays,
  normalizeVibeFindingEnqueueOptions,
  planVibeFindingEnqueueRows,
} from "./vibe-finding-enqueue-planner.js";

export type {
  VibeFindingEnqueueMode,
  VibeFindingEnqueueOptions,
  VibeFindingEnqueueReport,
  VibeFindingEnqueueSource,
  VibeFindingSelectorVersion,
  VibeFindingSourceRow,
} from "./vibe-finding-enqueue-planner.js";

type EnqueueDependency = typeof enqueueFindingJob;

type AlreadyQueuedRow = {
  id: string;
  createdAt: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
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

async function readCandidateRowsSqlite(
  options: VibeFindingEnqueueOptions,
): Promise<VibeFindingSourceRow[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const sourceWhere =
    options.source === "all" ? "" : "and json_extract(vm.metadata, '$.sourceId') = ?";
  const params =
    options.source === "all" ? [options.scanLimit] : [options.source, options.scanLimit];
  const rows = sqlite.db
    .query<Record<string, unknown>, unknown[]>(
      `
      select
        vm.id,
        vm.session_id as sessionId,
        vm.content,
        vm.metadata,
        vm.created_at as createdAt,
        count(ad.id) as agentDiffCount
      from vibe_memories vm
      left join finding_candidate_queue fq
        on fq.source_kind = 'vibe_memory'
       and fq.source_key = vm.id
       and fq.distillation_version = ?
      left join agent_diff_entries ad on ad.vibe_memory_id = vm.id
      where fq.id is null
        and not exists (
          select 1
          from finding_candidate_queue existing_fq
          where existing_fq.source_kind = 'vibe_memory'
            and existing_fq.distillation_version = ?
            and json_extract(vm.metadata, '$.dedupeKey') is not null
            and json_extract(existing_fq.metadata, '$.dedupeKey') =
                json_extract(vm.metadata, '$.dedupeKey')
        )
        ${sourceWhere}
      group by vm.id, vm.session_id, vm.content, vm.metadata, vm.created_at
      order by vm.created_at desc
      limit ?
    `,
    )
    .all(
      APP_CONSTANTS.distillationTargetVersion,
      APP_CONSTANTS.distillationTargetVersion,
      ...params,
    );

  return rows.map((row) => ({
    id: String(row.id ?? ""),
    sessionId: String(row.sessionId ?? ""),
    content: String(row.content ?? ""),
    metadata: row.metadata,
    createdAt: String(row.createdAt ?? ""),
    agentDiffCount: Number(row.agentDiffCount ?? 0),
  }));
}

async function readAlreadyQueuedRowsSqlite(
  options: VibeFindingEnqueueOptions,
): Promise<AlreadyQueuedRow[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const sourceWhere =
    options.source === "all" ? "" : "and json_extract(vm.metadata, '$.sourceId') = ?";
  const params = options.source === "all" ? [] : [options.source];
  const rows = sqlite.db
    .query<Record<string, unknown>, unknown[]>(
      `
      select distinct
        vm.id,
        vm.created_at as createdAt
      from vibe_memories vm
      where exists (
          select 1
          from finding_candidate_queue fq
          where fq.source_kind = 'vibe_memory'
            and fq.distillation_version = ?
            and (
              fq.source_key = vm.id
              or (
                json_extract(vm.metadata, '$.dedupeKey') is not null
                and json_extract(fq.metadata, '$.dedupeKey') =
                    json_extract(vm.metadata, '$.dedupeKey')
              )
            )
        )
        ${sourceWhere}
    `,
    )
    .all(APP_CONSTANTS.distillationTargetVersion, ...params);
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    createdAt: String(row.createdAt ?? ""),
  }));
}

async function readCandidateRowsPostgres(
  options: VibeFindingEnqueueOptions,
): Promise<VibeFindingSourceRow[]> {
  const sourceFilter =
    options.source === "all" ? sql`true` : sql`vm.metadata ->> 'sourceId' = ${options.source}`;
  const result = await db.execute(sql`
    select
      vm.id::text as "id",
      vm.session_id as "sessionId",
      vm.content as "content",
      vm.metadata as "metadata",
      vm.created_at::text as "createdAt",
      count(ad.id)::int as "agentDiffCount"
    from vibe_memories vm
    left join finding_candidate_queue fq
      on fq.source_kind = 'vibe_memory'
     and fq.source_key = vm.id::text
     and fq.distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
    left join agent_diff_entries ad on ad.vibe_memory_id = vm.id
    where fq.id is null
      and not exists (
        select 1
        from finding_candidate_queue existing_fq
        where existing_fq.source_kind = 'vibe_memory'
          and existing_fq.distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
          and vm.metadata ->> 'dedupeKey' is not null
          and existing_fq.metadata ->> 'dedupeKey' = vm.metadata ->> 'dedupeKey'
      )
      and ${sourceFilter}
    group by vm.id, vm.session_id, vm.content, vm.metadata, vm.created_at
    order by vm.created_at desc
    limit ${options.scanLimit}
  `);
  return result.rows as unknown as VibeFindingSourceRow[];
}

async function readAlreadyQueuedRowsPostgres(
  options: VibeFindingEnqueueOptions,
): Promise<AlreadyQueuedRow[]> {
  const sourceFilter =
    options.source === "all" ? sql`true` : sql`vm.metadata ->> 'sourceId' = ${options.source}`;
  const result = await db.execute(sql`
    select distinct
      vm.id::text as "id",
      vm.created_at::text as "createdAt"
    from vibe_memories vm
    where exists (
        select 1
        from finding_candidate_queue fq
        where fq.source_kind = 'vibe_memory'
          and fq.distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
          and (
            fq.source_key = vm.id::text
            or (
              vm.metadata ->> 'dedupeKey' is not null
              and fq.metadata ->> 'dedupeKey' = vm.metadata ->> 'dedupeKey'
            )
          )
      )
      and ${sourceFilter}
  `);
  return result.rows as unknown as AlreadyQueuedRow[];
}

async function readCandidateRows(
  options: VibeFindingEnqueueOptions,
): Promise<VibeFindingSourceRow[]> {
  return resolveDatabaseBackendConfig().kind === "sqlite"
    ? readCandidateRowsSqlite(options)
    : readCandidateRowsPostgres(options);
}

async function readSkippedAlreadyQueuedCount(options: VibeFindingEnqueueOptions): Promise<number> {
  const rows =
    resolveDatabaseBackendConfig().kind === "sqlite"
      ? await readAlreadyQueuedRowsSqlite(options)
      : await readAlreadyQueuedRowsPostgres(options);
  return rows.filter((row) => isVibeMemoryWithinSinceDays(row.createdAt, options.sinceDays)).length;
}

export async function runVibeFindingEnqueue(
  inputOptions: Partial<VibeFindingEnqueueOptions>,
  enqueueJob: EnqueueDependency = enqueueFindingJob,
): Promise<VibeFindingEnqueueReport> {
  const options = normalizeVibeFindingEnqueueOptions(inputOptions);
  const [rows, skippedAlreadyQueued] = await Promise.all([
    readCandidateRows(options),
    readSkippedAlreadyQueuedCount(options),
  ]);
  const report = planVibeFindingEnqueueRows(rows, options);
  report.skippedAlreadyQueued = skippedAlreadyQueued;
  if (options.mode !== "write") return report;

  for (const item of report.items) {
    if (item.action !== "enqueued") continue;
    const row = rows.find((candidate) => candidate.id === item.vibeMemoryId);
    if (!row) continue;
    const metadata = asRecord(row.metadata);
    const job = await enqueueJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: row.id,
      sourceUri: `vibe_memory:${row.id}`,
      distillationVersion: APP_CONSTANTS.distillationTargetVersion,
      metadata: {
        enqueuedBy: "vibe-finding-controlled-enqueue",
        enqueueReason: "eligible_vibe_memory",
        sourceId: item.sourceId,
        sessionId: row.sessionId,
        chunkIndex: metadata.chunkIndex,
        dedupeKey: metadata.dedupeKey,
        eligibilityScore: item.score,
        eligibilitySignals: item.signals,
        eligibilityReasonCodes: item.reasonCodes,
        selectorVersion: item.selectorVersion,
        sourceCreatedAt: row.createdAt,
        projectIdentity: metadata.projectIdentity,
        backfill: true,
      },
    });
    if (job?.id) {
      item.findingJobId = job.id;
      report.enqueued += 1;
    } else {
      item.action = "rejected";
      item.rejectReasons = ["enqueue_returned_null"];
      report.rejected += 1;
      report.eligible = Math.max(0, report.eligible - 1);
    }
  }

  return report;
}
