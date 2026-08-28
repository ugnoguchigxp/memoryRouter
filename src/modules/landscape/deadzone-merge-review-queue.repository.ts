import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { deadZoneMergeReviewQueue } from "../../db/schema.js";
import {
  type DeadZoneMergeReviewJob,
  deadZoneMergeReviewJobSchema,
  deadZoneMergeReviewResultSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";

type QueueRow = typeof deadZoneMergeReviewQueue.$inferSelect;

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function nullableDate(value: unknown): Date | null {
  if (!value) return null;
  const date = toDate(value);
  return date.getTime() === 0 ? null : date;
}

function mapSqliteQueueRow(row: Record<string, unknown>): QueueRow {
  return {
    id: String(row.id),
    reviewItemId: row.review_item_id ? String(row.review_item_id) : null,
    deadZoneKnowledgeId: String(row.dead_zone_knowledge_id),
    canonicalKnowledgeId: row.canonical_knowledge_id ? String(row.canonical_knowledge_id) : null,
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 2),
    nextRunAt: nullableDate(row.next_run_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: nullableDate(row.locked_at),
    heartbeatAt: nullableDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    provider: String(row.provider ?? "local-llm"),
    model: row.model ? String(row.model) : null,
    inputSnapshot: parseJsonRecord(row.input_snapshot),
    result: parseJsonRecord(row.result),
    payload: parseJsonRecord(row.payload),
    metadata: parseJsonRecord(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    completedAt: nullableDate(row.completed_at),
  } as QueueRow;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeResult(value: unknown): DeadZoneMergeReviewJob["result"] {
  const parsed = deadZoneMergeReviewResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mapDeadZoneMergeReviewJob(row: QueueRow): DeadZoneMergeReviewJob {
  return deadZoneMergeReviewJobSchema.parse({
    id: row.id,
    status: row.status,
    deadZoneKnowledgeId: row.deadZoneKnowledgeId,
    canonicalKnowledgeId: row.canonicalKnowledgeId,
    reviewItemId: row.reviewItemId,
    provider: row.provider,
    model: row.model,
    lastError: row.lastError,
    lastOutcomeKind: row.lastOutcomeKind,
    result: normalizeResult(row.result),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: toIso(row.completedAt),
  });
}

export async function upsertDeadZoneMergeReviewJob(params: {
  reviewItemId?: string | null;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  idempotencyKey: string;
  priority: number;
  provider: string;
  model?: string | null;
  inputSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<DeadZoneMergeReviewJob> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const existing = sqlite.db
      .query("select * from dead_zone_merge_review_queue where idempotency_key = ? limit 1")
      .get(params.idempotencyKey) as Record<string, unknown> | null;

    const id = existing?.id ? String(existing.id) : crypto.randomUUID();
    if (existing) {
      const nextPayload = { ...parseJsonRecord(existing.payload), ...params.payload };
      sqlite.db
        .query(
          `
          update dead_zone_merge_review_queue
          set payload = ?, updated_at = ?
          where id = ?
        `,
        )
        .run(JSON.stringify(nextPayload), now, id);
    } else {
      sqlite.db
        .query(
          `
          insert into dead_zone_merge_review_queue (
            id, review_item_id, dead_zone_knowledge_id, canonical_knowledge_id, idempotency_key,
            status, priority, attempt_count, max_attempts, provider, model, input_snapshot,
            result, payload, metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, 'pending', ?, 0, 2, ?, ?, ?, '{}', ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          params.reviewItemId ?? null,
          params.deadZoneKnowledgeId,
          params.canonicalKnowledgeId,
          params.idempotencyKey,
          params.priority,
          params.provider,
          params.model ?? null,
          JSON.stringify(params.inputSnapshot),
          JSON.stringify(params.payload),
          JSON.stringify(params.metadata ?? {}),
          now,
          now,
        );
    }

    const row = sqlite.db
      .query("select * from dead_zone_merge_review_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    if (!row) throw new Error("failed to enqueue dead-zone merge review job");
    return mapDeadZoneMergeReviewJob(mapSqliteQueueRow(row));
  }

  const [row] = await db
    .insert(deadZoneMergeReviewQueue)
    .values({
      reviewItemId: params.reviewItemId ?? null,
      deadZoneKnowledgeId: params.deadZoneKnowledgeId,
      canonicalKnowledgeId: params.canonicalKnowledgeId,
      idempotencyKey: params.idempotencyKey,
      priority: params.priority,
      provider: params.provider,
      model: params.model ?? null,
      inputSnapshot: params.inputSnapshot,
      payload: params.payload,
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: deadZoneMergeReviewQueue.idempotencyKey,
      set: {
        updatedAt: new Date(),
        payload: sql`${deadZoneMergeReviewQueue.payload} || excluded.payload`,
      },
    })
    .returning();
  return mapDeadZoneMergeReviewJob(row);
}

export async function getDeadZoneMergeReviewQueueRow(id: string): Promise<QueueRow | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query("select * from dead_zone_merge_review_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    return row ? mapSqliteQueueRow(row) : null;
  }

  const [row] = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(eq(deadZoneMergeReviewQueue.id, id))
    .limit(1);
  return row ?? null;
}

export async function listDeadZoneMergeReviewJobs(params: {
  status?: string;
  deadZoneKnowledgeId?: string;
  canonicalKnowledgeId?: string;
  reviewItemId?: string;
  limit?: number;
}): Promise<DeadZoneMergeReviewJob[]> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const filters: string[] = [];
    const values: unknown[] = [];
    if (params.status && params.status !== "all") {
      filters.push("status = ?");
      values.push(params.status);
    }
    if (params.deadZoneKnowledgeId) {
      filters.push("dead_zone_knowledge_id = ?");
      values.push(params.deadZoneKnowledgeId);
    }
    if (params.canonicalKnowledgeId) {
      filters.push("canonical_knowledge_id = ?");
      values.push(params.canonicalKnowledgeId);
    }
    if (params.reviewItemId) {
      filters.push("review_item_id = ?");
      values.push(params.reviewItemId);
    }
    const where = filters.length > 0 ? `where ${filters.join(" and ")}` : "";
    const rows = sqlite.db
      .query(
        `
        select *
        from dead_zone_merge_review_queue
        ${where}
        order by updated_at desc
        limit ?
      `,
      )
      .all(...values, Math.max(1, Math.min(100, params.limit ?? 50))) as Record<string, unknown>[];
    return rows.map((row) => mapDeadZoneMergeReviewJob(mapSqliteQueueRow(row)));
  }

  const filters = [];
  if (params.status && params.status !== "all")
    filters.push(eq(deadZoneMergeReviewQueue.status, params.status));
  if (params.deadZoneKnowledgeId) {
    filters.push(eq(deadZoneMergeReviewQueue.deadZoneKnowledgeId, params.deadZoneKnowledgeId));
  }
  if (params.canonicalKnowledgeId) {
    filters.push(eq(deadZoneMergeReviewQueue.canonicalKnowledgeId, params.canonicalKnowledgeId));
  }
  if (params.reviewItemId)
    filters.push(eq(deadZoneMergeReviewQueue.reviewItemId, params.reviewItemId));

  const rows = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(deadZoneMergeReviewQueue.updatedAt))
    .limit(Math.max(1, Math.min(100, params.limit ?? 50)));
  return rows.map(mapDeadZoneMergeReviewJob);
}

export async function listLatestDeadZoneMergeReviewJobsByDeadZoneIds(
  ids: string[],
): Promise<Map<string, DeadZoneMergeReviewJob>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const result = new Map<string, DeadZoneMergeReviewJob>();
  if (uniqueIds.length === 0) return result;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = sqlite.db
      .query(
        `select * from dead_zone_merge_review_queue where dead_zone_knowledge_id in (${placeholders})`,
      )
      .all(...uniqueIds) as Record<string, unknown>[];
    const jobs = rows.map(mapSqliteQueueRow);
    jobs.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    for (const row of jobs) {
      if (!result.has(row.deadZoneKnowledgeId)) {
        result.set(row.deadZoneKnowledgeId, mapDeadZoneMergeReviewJob(row));
      }
    }
    return result;
  }

  const rows = await db
    .select()
    .from(deadZoneMergeReviewQueue)
    .where(inArray(deadZoneMergeReviewQueue.deadZoneKnowledgeId, uniqueIds));
  rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  for (const row of rows) {
    if (!result.has(row.deadZoneKnowledgeId)) {
      result.set(row.deadZoneKnowledgeId, mapDeadZoneMergeReviewJob(row));
    }
  }
  return result;
}

export async function markDeadZoneMergeReviewJobCompleted(params: {
  id: string;
  result: Record<string, unknown>;
  outcome: string;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        update dead_zone_merge_review_queue
        set status = 'completed',
            attempt_count = ?,
            result = ?,
            last_error = null,
            last_outcome_kind = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        (row?.attemptCount ?? 0) + 1,
        JSON.stringify(params.result),
        params.outcome,
        now,
        now,
        params.id,
      );
    return;
  }

  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status: "completed",
      attemptCount: (row?.attemptCount ?? 0) + 1,
      result: params.result,
      lastError: null,
      lastOutcomeKind: params.outcome,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}

export async function markDeadZoneMergeReviewJobSkipped(params: {
  id: string;
  reason: string;
  result?: Record<string, unknown>;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        update dead_zone_merge_review_queue
        set status = 'skipped',
            attempt_count = ?,
            result = ?,
            last_error = ?,
            last_outcome_kind = 'skipped',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        (row?.attemptCount ?? 0) + 1,
        JSON.stringify(params.result ?? {}),
        params.reason.slice(0, 2000),
        now,
        now,
        params.id,
      );
    return;
  }

  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status: "skipped",
      attemptCount: (row?.attemptCount ?? 0) + 1,
      result: params.result ?? {},
      lastError: params.reason.slice(0, 2000),
      lastOutcomeKind: "skipped",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}

export async function markDeadZoneMergeReviewJobFailed(params: {
  id: string;
  error: string;
  outcome: string;
  retryAt?: Date | null;
}): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(params.id);
  const retryable = Boolean(params.retryAt);
  const status = retryable ? "paused" : "failed";
  const now = new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update dead_zone_merge_review_queue
        set status = ?,
            attempt_count = ?,
            next_run_at = ?,
            last_error = ?,
            last_outcome_kind = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        status,
        (row?.attemptCount ?? 0) + 1,
        params.retryAt?.toISOString() ?? null,
        params.error.slice(0, 2000),
        params.outcome,
        retryable ? null : now.toISOString(),
        now.toISOString(),
        params.id,
      );
    return;
  }

  await db
    .update(deadZoneMergeReviewQueue)
    .set({
      status,
      attemptCount: (row?.attemptCount ?? 0) + 1,
      nextRunAt: params.retryAt ?? null,
      lastError: params.error.slice(0, 2000),
      lastOutcomeKind: params.outcome,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      completedAt: retryable ? null : now,
      updatedAt: now,
    })
    .where(eq(deadZoneMergeReviewQueue.id, params.id));
}
