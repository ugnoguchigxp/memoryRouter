import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationTargetKind, DistillationTargetStatus } from "./domain.js";
import { isManualPauseTarget } from "./manual-pause.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  rowHeartbeatMs,
  staleThresholdMs,
} from "./repository-helpers.js";

export type RecoveryResult = {
  recoveredToPending: number;
  failed: number;
  skipped: number;
};

export async function releaseRetryablePausedDistillationTargets(
  params: {
    distillationVersion?: string;
    now?: Date;
    targetKind?: DistillationTargetKind;
    limit?: number;
    excludeManualPauseReasons?: boolean;
  } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const pausedConditions = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    eq(distillationTargetStates.status, "paused"),
  ];
  if (params.targetKind) {
    pausedConditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }
  const retryExhaustedTerminalConditions = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    inArray(distillationTargetStates.status, ["pending", "paused"]),
  ];
  if (params.targetKind) {
    retryExhaustedTerminalConditions.push(
      eq(distillationTargetStates.targetKind, params.targetKind),
    );
  }
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : null;
  const maxAttempts = APP_CONSTANTS.distillationTargetMaxAttempts;
  const retryReadyAtCondition = or(
    isNull(distillationTargetStates.nextRetryAt),
    lte(distillationTargetStates.nextRetryAt, now),
  );
  const retryReadyConditions = [...pausedConditions, retryReadyAtCondition];
  const actionablePausedConditions = [
    ...pausedConditions,
    or(gte(distillationTargetStates.attemptCount, maxAttempts), retryReadyAtCondition),
  ];
  const retryExhaustedSet = {
    status: "skipped" as const,
    phase: "stored" as const,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    nextRetryAt: null,
    lastOutcomeKind: "paused_retry_limit_exceeded",
    lastError: "paused_retry_limit_exceeded",
    metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
      retryLimitExceeded: true,
      retryLimitExceededAt: now.toISOString(),
      maxAttempts,
    })}::jsonb` as never,
    completedAt: now,
    updatedAt: now,
  };

  // Fast path: avoid row hydration when manual-pause filtering and limiting are not required.
  if (!params.excludeManualPauseReasons && limit === null) {
    await db
      .update(distillationTargetStates)
      .set(retryExhaustedSet)
      .where(
        and(
          ...retryExhaustedTerminalConditions,
          gte(distillationTargetStates.attemptCount, maxAttempts),
        ),
      )
      .returning({ id: distillationTargetStates.id });

    const rows = await db
      .update(distillationTargetStates)
      .set({
        status: "pending",
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(and(...retryReadyConditions, lt(distillationTargetStates.attemptCount, maxAttempts)))
      .returning({ id: distillationTargetStates.id });
    return rows.length;
  }

  const query = db
    .select({
      id: distillationTargetStates.id,
      attemptCount: distillationTargetStates.attemptCount,
      nextRetryAt: distillationTargetStates.nextRetryAt,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
    })
    .from(distillationTargetStates)
    .where(and(...actionablePausedConditions))
    .orderBy(asc(distillationTargetStates.updatedAt));

  const pausedRows = limit === null ? await query : await query.limit(limit);
  const eligibleRows = pausedRows.filter((row) =>
    params.excludeManualPauseReasons ? !isManualPauseTarget(row) : true,
  );
  const retryExhaustedIds = eligibleRows
    .filter((row) => row.attemptCount >= maxAttempts)
    .map((row) => row.id);
  const retryableIds = eligibleRows
    .filter(
      (row) =>
        row.attemptCount < maxAttempts &&
        (!row.nextRetryAt || row.nextRetryAt.getTime() <= now.getTime()),
    )
    .map((row) => row.id);

  if (retryExhaustedIds.length > 0) {
    await db
      .update(distillationTargetStates)
      .set(retryExhaustedSet)
      .where(
        and(
          eq(distillationTargetStates.distillationVersion, distillationVersion),
          inArray(distillationTargetStates.id, retryExhaustedIds),
        ),
      )
      .returning({ id: distillationTargetStates.id });
  }

  if (retryableIds.length < 1) return 0;

  const rows = await db
    .update(distillationTargetStates)
    .set({
      status: "pending",
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, distillationVersion),
        inArray(distillationTargetStates.id, retryableIds),
      ),
    )
    .returning({ id: distillationTargetStates.id });

  return rows.length;
}

export async function recoverStaleDistillationTargets(
  params: {
    distillationVersion?: string;
    staleSeconds?: number;
    maxAttempts?: number;
    now?: Date;
    targetKind?: DistillationTargetKind;
    limit?: number;
  } = {},
): Promise<RecoveryResult> {
  const now = params.now ?? new Date();
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const thresholdMs = staleThresholdMs(
    params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
    now,
  );
  const maxAttempts = params.maxAttempts ?? APP_CONSTANTS.distillationTargetMaxAttempts;
  const runningConditions = [
    eq(distillationTargetStates.distillationVersion, distillationVersion),
    eq(distillationTargetStates.status, "running"),
  ];
  if (params.targetKind) {
    runningConditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }
  const runningRows = await db
    .select()
    .from(distillationTargetStates)
    .where(and(...runningConditions));
  const staleRows = runningRows
    .filter((row) => rowHeartbeatMs(row) <= thresholdMs)
    .slice(
      0,
      typeof params.limit === "number" ? Math.max(1, params.limit) : Number.MAX_SAFE_INTEGER,
    );

  let recoveredToPending = 0;
  const failed = 0;
  let skipped = 0;

  for (const stale of staleRows) {
    const nextStatus: DistillationTargetStatus =
      stale.attemptCount >= maxAttempts ? "skipped" : "pending";
    const [row] = await db
      .update(distillationTargetStates)
      .set({
        status: nextStatus,
        phase: nextStatus === "skipped" ? "stored" : "selected",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastOutcomeKind: "stale_running_recovered",
        lastError:
          nextStatus === "skipped"
            ? "stale_running_retry_limit_exceeded"
            : "stale_running_recovered",
        metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify({
          staleRecovered: true,
          staleRecoveredAt: now.toISOString(),
        })}::jsonb` as never,
        completedAt: nextStatus === "skipped" ? now : null,
        updatedAt: now,
      })
      .where(eq(distillationTargetStates.id, stale.id))
      .returning();
    if (!row) continue;
    if (nextStatus === "skipped") skipped += 1;
    else recoveredToPending += 1;
  }

  if (recoveredToPending > 0 || failed > 0 || skipped > 0) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.distillationTargetRecovered,
      actor: "system",
      payload: {
        distillationVersion,
        targetKind: params.targetKind ?? null,
        recoveredToPending,
        failed,
        skipped,
        limit: params.limit ?? null,
        staleSeconds: params.staleSeconds ?? APP_CONSTANTS.distillationTargetStaleSeconds,
      },
    });
  }

  return { recoveredToPending, failed, skipped };
}
