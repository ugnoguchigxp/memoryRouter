import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { db } from "../../../db/index.js";
import type { DistillationQueueName, QueueRetryMode } from "./types.js";
import { queueTableNameByQueue } from "./types.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

type QueueStateRow = {
  id: string;
  status: string;
};

const workerUnavailableBackoffSecondsSql = `
  case
    when attempt_count <= 0 then 60
    when attempt_count = 1 then 120
    when attempt_count = 2 then 300
    when attempt_count = 3 then 600
    when attempt_count = 4 then 1200
    else 3600
  end
`;

function normalizeRetryAfterSeconds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(3600, Math.floor(value)));
}

async function updateSqliteQueueState(params: {
  queueName: DistillationQueueName;
  id?: string;
  setSql: string;
  whereSql: string;
  values: unknown[];
}): Promise<QueueStateRow | null> {
  const sqlite = await getSqliteCoreDatabase();
  const tableName = queueTableNameByQueue[params.queueName];
  const result = sqlite.db
    .query<QueueStateRow, unknown[]>(
      `
      update ${tableName}
      set ${params.setSql}
      where ${params.whereSql}
      returning id, status
    `,
    )
    .get(...params.values);
  return result ?? null;
}

export async function keepQueueJobWaitingForProvider(params: {
  queueName: DistillationQueueName;
  id: string;
  reason: string;
  retryAfterSeconds?: number | null;
}): Promise<QueueStateRow | null> {
  const retryAfterSeconds = normalizeRetryAfterSeconds(params.retryAfterSeconds);
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        next_run_at = datetime('now', '+' || ? || ' seconds'),
        attempt_count = attempt_count + 1,
        last_error = ?,
        last_outcome_kind = 'provider_unavailable_retry',
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status = 'running'",
      values: [retryAfterSeconds, params.reason, params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            attempt_count = attempt_count + 1,
            last_error = ${params.reason},
            last_outcome_kind = 'provider_unavailable_retry',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            next_run_at = now() + make_interval(secs => ${retryAfterSeconds}),
            attempt_count = attempt_count + 1,
            last_error = ${params.reason},
            last_outcome_kind = 'provider_unavailable_retry',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function pauseQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
  reason?: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'paused',
        last_error = ?,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status in ('pending', 'running')",
      values: [params.reason ?? "paused from queue control", params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result = await db.execute(sql`
    update ${sql.raw(tableName)}
    set
      status = 'paused',
      last_error = ${params.reason ?? "paused from queue control"},
      locked_by = null,
      locked_at = null,
      heartbeat_at = null,
      updated_at = now()
    where id = ${params.id}
      and status in ('pending', 'running')
    returning id, status
  `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function keepQueueJobWaitingForWorker(params: {
  queueName: DistillationQueueName;
  id: string;
  reason: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        next_run_at = datetime('now', '+' || ${workerUnavailableBackoffSecondsSql} || ' seconds'),
        attempt_count = attempt_count + 1,
        last_error = ?,
        last_outcome_kind = 'worker_unavailable',
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status = 'running'",
      values: [params.reason, params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            last_error = ${params.reason},
            last_outcome_kind = 'worker_unavailable',
            attempt_count = attempt_count + 1,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            next_run_at = now() + make_interval(secs => ${sql.raw(workerUnavailableBackoffSecondsSql)}),
            attempt_count = attempt_count + 1,
            last_error = ${params.reason},
            last_outcome_kind = 'worker_unavailable',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where id = ${params.id}
            and status = 'running'
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function resumeQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        next_run_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        completed_at = null,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status in ('paused', 'failed', 'skipped', 'completed')",
      values: [params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = null,
            updated_at = now()
          where id = ${params.id}
            and status in ('paused', 'failed', 'skipped', 'completed')
          returning id, status
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            next_run_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = null,
            updated_at = now()
          where id = ${params.id}
            and status in ('paused', 'failed', 'skipped', 'completed')
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function retryQueueJob(params: {
  queueName: DistillationQueueName;
  id: string;
  mode: QueueRetryMode;
  forceRefreshEvidence: boolean;
  reason?: string;
}): Promise<QueueStateRow | null> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    if (params.queueName === "coveringEvidence") {
      return updateSqliteQueueState({
        queueName: params.queueName,
        setSql: `
          status = 'pending',
          attempt_count = 0,
          next_run_at = null,
          completed_at = null,
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          last_error = ?,
          provider_policy = case
            when ? = 'cloud_api' then 'cloud_api'
            else coalesce(provider_policy, 'default')
          end,
          payload = json_set(
            coalesce(nullif(payload, ''), '{}'),
            '$.forceRefreshEvidence', json(?),
            '$.retryMode', ?,
            '$.retryReason', ?,
            '$.retryRequestedAt', CURRENT_TIMESTAMP
          ),
          updated_at = CURRENT_TIMESTAMP
        `,
        whereSql: "id = ? and status <> 'running'",
        values: [
          params.reason ?? null,
          params.mode,
          params.forceRefreshEvidence ? "true" : "false",
          params.mode,
          params.reason ?? null,
          params.id,
        ],
      });
    }
    return updateSqliteQueueState({
      queueName: params.queueName,
      setSql: `
        status = 'pending',
        attempt_count = 0,
        next_run_at = null,
        completed_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      `,
      whereSql: "id = ? and status <> 'running'",
      values: [params.reason ?? null, params.id],
    });
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "findingCandidate"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            payload = coalesce(payload, '{}'::jsonb) ||
              jsonb_build_object(
                'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                'retryMode', ${params.mode}::text,
                'retryReason', ${params.reason ?? null}::text,
                'retryRequestedAt', now()::text
              ),
            updated_at = now()
          where id = ${params.id}
            and status <> 'running'
          returning id, status
        `)
      : params.queueName === "finalizeDistille"
        ? await db.execute(sql`
            update ${sql.raw(tableName)}
            set
              status = 'pending',
              attempt_count = 0,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              provider_policy = case
                when ${params.mode}::text = 'cloud_api' then 'cloud_api'
                else provider_policy
              end,
              metadata = coalesce(metadata, '{}'::jsonb) ||
                jsonb_build_object(
                  'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                  'retryMode', ${params.mode}::text,
                  'retryReason', ${params.reason ?? null}::text,
                  'retryRequestedAt', now()::text
                ),
              updated_at = now()
            where id = ${params.id}
              and status <> 'running'
            returning id, status
          `)
        : params.queueName === "deadZoneMergeReview" ||
            params.queueName === "mergeActivationFinalize"
          ? await db.execute(sql`
            update ${sql.raw(tableName)}
            set
              status = 'pending',
              attempt_count = 0,
              next_run_at = null,
              completed_at = null,
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              last_error = null,
              payload = coalesce(payload, '{}'::jsonb) ||
                jsonb_build_object(
                  'retryMode', ${params.mode}::text,
                  'retryReason', ${params.reason ?? null}::text,
                  'retryRequestedAt', now()::text
                ),
              updated_at = now()
            where id = ${params.id}
              and status <> 'running'
            returning id, status
          `)
          : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'pending',
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            provider_policy = case
              when ${params.mode}::text = 'cloud_api' then 'cloud_api'
              else provider_policy
            end,
            payload = coalesce(payload, '{}'::jsonb) ||
              jsonb_build_object(
                'forceRefreshEvidence', ${params.forceRefreshEvidence}::boolean,
                'retryMode', ${params.mode}::text,
                'retryReason', ${params.reason ?? null}::text,
                'retryRequestedAt', now()::text
              ),
            updated_at = now()
          where id = ${params.id}
            and status <> 'running'
          returning id, status
        `);
  return (result.rows[0] as QueueStateRow | undefined) ?? null;
}

export async function pauseRunningQueueJobs(params: {
  queueName: DistillationQueueName;
  reason?: string;
}): Promise<number> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const tableName = queueTableNameByQueue[params.queueName];
    const result = sqlite.db
      .query(
        `
        update ${tableName}
        set
          status = 'paused',
          last_error = ?,
          next_run_at = CURRENT_TIMESTAMP,
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          updated_at = CURRENT_TIMESTAMP
        where status = 'running'
      `,
      )
      .run(params.reason ?? "queue paused from queue control");
    return Number(result.changes ?? 0);
  }

  const tableName = queueTableNameByQueue[params.queueName];
  const result =
    params.queueName === "finalizeDistille"
      ? await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'paused',
            last_error = ${params.reason ?? "queue paused from queue control"},
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where status = 'running'
        `)
      : await db.execute(sql`
          update ${sql.raw(tableName)}
          set
            status = 'paused',
            last_error = ${params.reason ?? "queue paused from queue control"},
            next_run_at = now(),
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            updated_at = now()
          where status = 'running'
        `);
  return result.rowCount ?? 0;
}
