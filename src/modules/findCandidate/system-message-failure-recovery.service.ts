import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";

export const findingSystemMessageFailureNeedle = "System message must be at the beginning";

export type FindingSystemMessageFailureRecoveryItem = {
  id: string;
  sourceKind: string;
  sourceKey: string;
  attemptCount: number;
  updatedAt: string;
  lastError: string;
};

export type FindingSystemMessageFailureRecoveryResult = {
  mode: "dry-run" | "write";
  limit: number;
  matched: number;
  hasMore: boolean;
  requeued: number;
  skipped: number;
  items: Array<
    FindingSystemMessageFailureRecoveryItem & { action: "would_requeue" | "requeued" | "skipped" }
  >;
};

type FindingSystemMessageFailureRow = {
  id: string;
  source_kind: string;
  source_key: string;
  attempt_count: number | string;
  updated_at: string;
  last_error: string;
};

type RecoveryQueueStateRow = {
  id: string;
  status: string;
};

const recoveryReason = "requeue after single-system-message compatibility fix";
const recoveryKind = "finding_system_message_compatibility";

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("limit must be an integer between 1 and 5000");
  }
  return limit;
}

function validateMode(mode: string): "dry-run" | "write" {
  if (mode !== "dry-run" && mode !== "write") {
    throw new Error("mode must be dry-run or write");
  }
  return mode;
}

async function findMatchingFailures(
  limit: number,
): Promise<FindingSystemMessageFailureRecoveryItem[]> {
  let rows: FindingSystemMessageFailureRow[];
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    rows = sqlite.db
      .query<FindingSystemMessageFailureRow, [string, number]>(
        `
        select id, source_kind, source_key, attempt_count, updated_at, last_error
        from finding_candidate_queue
        where status = 'failed'
          and instr(coalesce(last_error, ''), ?) > 0
        order by updated_at asc, id asc
        limit ?
      `,
      )
      .all(findingSystemMessageFailureNeedle, limit);
  } else {
    const result = await db.execute(sql`
      select id, source_kind, source_key, attempt_count, updated_at::text as updated_at, last_error
      from finding_candidate_queue
      where status = 'failed'
        and position(${findingSystemMessageFailureNeedle} in coalesce(last_error, '')) > 0
      order by updated_at asc, id asc
      limit ${limit}
    `);
    rows = result.rows as unknown as FindingSystemMessageFailureRow[];
  }

  return rows.map((row) => ({
    id: row.id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    attemptCount: Number(row.attempt_count),
    updatedAt: row.updated_at,
    lastError: row.last_error,
  }));
}

async function requeueMatchingFailure(
  item: FindingSystemMessageFailureRecoveryItem,
): Promise<RecoveryQueueStateRow | null> {
  const retryRequestedAt = new Date().toISOString();
  const eventMetadata = {
    recoveryKind,
    previousAttemptCount: item.attemptCount,
    previousUpdatedAt: item.updatedAt,
    previousLastError: item.lastError,
    errorNeedle: findingSystemMessageFailureNeedle,
  };

  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = sqlite.db
        .query<
          RecoveryQueueStateRow,
          [string, string, string, string, string, number, string, string]
        >(
          `
          update finding_candidate_queue
          set
            status = 'pending',
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            payload = json_set(
              coalesce(nullif(payload, ''), '{}'),
              '$.forceRefreshEvidence', json('false'),
              '$.retryMode', 'default',
              '$.retryReason', ?,
              '$.retryRequestedAt', ?
            ),
            updated_at = CURRENT_TIMESTAMP
          where id = ?
            and status = 'failed'
            and last_error = ?
            and attempt_count = ?
            and updated_at = ?
            and instr(coalesce(last_error, ''), ?) > 0
          returning id, status
        `,
        )
        .get(
          recoveryReason,
          recoveryReason,
          retryRequestedAt,
          item.id,
          item.lastError,
          item.attemptCount,
          item.updatedAt,
          findingSystemMessageFailureNeedle,
        );

      if (updated) {
        sqlite.db
          .query(
            `
            insert into distillation_queue_events (
              id, queue_name, queue_job_id, event_type, message, metadata, created_at
            ) values (?, 'findingCandidate', ?, 'retried', ?, ?, ?)
          `,
          )
          .run(
            crypto.randomUUID(),
            item.id,
            recoveryReason,
            JSON.stringify(eventMetadata),
            retryRequestedAt,
          );
      }
      sqlite.db.exec("COMMIT");
      return updated ?? null;
    } catch (error) {
      sqlite.db.exec("ROLLBACK");
      throw error;
    }
  }

  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      update finding_candidate_queue
      set
        status = 'pending',
        attempt_count = 0,
        next_run_at = null,
        completed_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = ${recoveryReason},
        payload = coalesce(payload, '{}'::jsonb) ||
          jsonb_build_object(
            'forceRefreshEvidence', false,
            'retryMode', 'default',
            'retryReason', ${recoveryReason}::text,
            'retryRequestedAt', ${retryRequestedAt}::text
          ),
        updated_at = now()
      where id = ${item.id}
        and status = 'failed'
        and last_error = ${item.lastError}
        and attempt_count = ${item.attemptCount}
        and updated_at = ${item.updatedAt}::timestamp
        and position(${findingSystemMessageFailureNeedle} in coalesce(last_error, '')) > 0
      returning id, status
    `);
    const updated = (result.rows[0] as RecoveryQueueStateRow | undefined) ?? null;
    if (!updated) return null;

    await tx.execute(sql`
      insert into distillation_queue_events (
        id, queue_name, queue_job_id, event_type, message, metadata, created_at
      ) values (
        ${crypto.randomUUID()}::uuid,
        'findingCandidate',
        ${item.id}::uuid,
        'retried',
        ${recoveryReason},
        ${JSON.stringify(eventMetadata)}::jsonb,
        now()
      )
    `);
    return updated;
  });
}

export async function recoverFindingSystemMessageFailures(params: {
  mode: "dry-run" | "write";
  limit: number;
}): Promise<FindingSystemMessageFailureRecoveryResult> {
  const mode = validateMode(params.mode);
  const limit = validateLimit(params.limit);
  const discoveredMatches = await findMatchingFailures(limit + 1);
  const hasMore = discoveredMatches.length > limit;
  const matches = discoveredMatches.slice(0, limit);
  if (mode === "dry-run") {
    return {
      mode,
      limit,
      matched: matches.length,
      hasMore,
      requeued: 0,
      skipped: 0,
      items: matches.map((item) => ({ ...item, action: "would_requeue" as const })),
    };
  }

  const items: FindingSystemMessageFailureRecoveryResult["items"] = [];
  let requeued = 0;
  let skipped = 0;
  for (const item of matches) {
    const updated = await requeueMatchingFailure(item);
    if (!updated) {
      skipped += 1;
      items.push({ ...item, action: "skipped" });
      continue;
    }
    requeued += 1;
    items.push({ ...item, action: "requeued" });
  }

  return {
    mode,
    limit,
    matched: matches.length,
    hasMore,
    requeued,
    skipped,
    items,
  };
}
