import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { db } from "../../../db/index.js";
import { isQueuePaused } from "./control.js";
import type { DistillationQueueName } from "./types.js";
import { queueTableNameByQueue } from "./types.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function sqliteTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export async function claimNextQueueJob(params: {
  queueName: DistillationQueueName;
  workerId: string;
}): Promise<{ id: string } | null> {
  if (await isQueuePaused(params.queueName)) {
    return null;
  }
  const tableName = queueTableNameByQueue[params.queueName];
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const staleSeconds = Math.max(
      30,
      Math.min(120, Math.floor(groupedConfig.distillation.lockTtlSeconds)),
    );
    const staleCutoff = sqliteTimestamp(new Date(Date.now() - staleSeconds * 1000));
    sqlite.db.query("BEGIN IMMEDIATE").run();
    try {
      sqlite.db
        .query(
          `
          update ${tableName}
          set
            status = 'paused',
            next_run_at = CURRENT_TIMESTAMP,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = coalesce(last_error, 'stale_running_recovered'),
            last_outcome_kind = 'stale_recovered',
            updated_at = CURRENT_TIMESTAMP
          where status = 'running'
            and coalesce(heartbeat_at, locked_at, updated_at) < ?
        `,
        )
        .run(staleCutoff);
      const running = sqlite.db
        .query<{ id: string }, []>(`select id from ${tableName} where status = 'running' limit 1`)
        .get();
      if (running) {
        sqlite.db.query("COMMIT").run();
        return null;
      }
      const picked = sqlite.db
        .query<{ id: string }, []>(
          `
          select id
          from ${tableName}
          where status in ('pending', 'paused')
            and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP)
          order by priority desc, created_at asc, id asc
          limit 1
        `,
        )
        .get();
      if (!picked?.id) {
        sqlite.db.query("COMMIT").run();
        return null;
      }
      sqlite.db
        .query(
          `
          update ${tableName}
          set
            status = 'running',
            locked_by = ?,
            locked_at = CURRENT_TIMESTAMP,
            heartbeat_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          where id = ?
        `,
        )
        .run(params.workerId, picked.id);
      sqlite.db.query("COMMIT").run();
      return { id: picked.id };
    } catch (error) {
      sqlite.db.query("ROLLBACK").run();
      throw error;
    }
  }

  const staleSeconds = Math.max(
    30,
    Math.min(120, Math.floor(groupedConfig.distillation.lockTtlSeconds)),
  );
  return db.transaction(async (tx) => {
    // 同一キューの claim を直列化し、複数プロセス起動時でも queue ごとの同時実行を 1 件に制限する。
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        94721,
        hashtext(${tableName})
      )
    `);

    if (params.queueName === "finalizeDistille") {
      await tx.execute(sql`
        update ${sql.raw(tableName)}
        set
          status = 'paused',
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          last_error = coalesce(last_error, 'stale_running_recovered'),
          last_outcome_kind = 'stale_recovered',
          updated_at = now()
        where status = 'running'
          and coalesce(heartbeat_at, locked_at, updated_at) < now() - make_interval(secs => ${staleSeconds})
      `);
    } else {
      await tx.execute(sql`
        update ${sql.raw(tableName)}
        set
          status = 'paused',
          next_run_at = now(),
          locked_by = null,
          locked_at = null,
          heartbeat_at = null,
          last_error = coalesce(last_error, 'stale_running_recovered'),
          last_outcome_kind = 'stale_recovered',
          updated_at = now()
        where status = 'running'
          and coalesce(heartbeat_at, locked_at, updated_at) < now() - make_interval(secs => ${staleSeconds})
      `);
    }

    const result =
      params.queueName === "finalizeDistille"
        ? await tx.execute(sql`
            with has_running as (
              select 1
              from ${sql.raw(tableName)}
              where status = 'running'
              limit 1
            ),
            picked as (
              select id
              from ${sql.raw(tableName)}
              where status in ('pending', 'paused')
                and not exists (select 1 from has_running)
              order by priority desc, created_at asc, id asc
              for update skip locked
              limit 1
            )
            update ${sql.raw(tableName)} q
            set
              status = 'running',
              locked_by = ${params.workerId},
              locked_at = now(),
              heartbeat_at = now(),
              updated_at = now()
            from picked
            where q.id = picked.id
            returning q.id
          `)
        : await tx.execute(sql`
            with has_running as (
              select 1
              from ${sql.raw(tableName)}
              where status = 'running'
              limit 1
            ),
            picked as (
              select id
              from ${sql.raw(tableName)}
              where status in ('pending', 'paused')
                and (next_run_at is null or next_run_at <= now())
                and not exists (select 1 from has_running)
              order by priority desc, created_at asc, id asc
              for update skip locked
              limit 1
            )
            update ${sql.raw(tableName)} q
            set
              status = 'running',
              locked_by = ${params.workerId},
              locked_at = now(),
              heartbeat_at = now(),
              updated_at = now()
            from picked
            where q.id = picked.id
            returning q.id
          `);

    const row = result.rows[0] as { id?: string } | undefined;
    if (!row?.id) return null;
    return { id: row.id };
  });
}
