import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { auditLogs } from "../../db/schema.js";
import { redactSecretRecord } from "../../shared/utils/secret-redaction.js";

const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 7;
let auditLogDisabledReason: string | null = null;

export const auditEventTypes = {
  knowledgeCreated: "KNOWLEDGE_CREATED",
  knowledgeUpdated: "KNOWLEDGE_UPDATED",
  knowledgeDeleted: "KNOWLEDGE_DELETED",
  knowledgeStatusChanged: "KNOWLEDGE_STATUS_CHANGED",
  knowledgeFeedbackRecorded: "KNOWLEDGE_FEEDBACK_RECORDED",
  knowledgeQualityAdjusted: "KNOWLEDGE_QUALITY_ADJUSTED",
  sourceImported: "SOURCE_IMPORTED",
  sourceUpdated: "SOURCE_UPDATED",
  sourceDeleted: "SOURCE_DELETED",
  sourceDistillationRunStarted: "SOURCE_DISTILLATION_RUN_STARTED",
  sourceDistillationRunFinished: "SOURCE_DISTILLATION_RUN_FINISHED",
  distillationWebSearch: "DISTILLATION_WEB_SEARCH",
  distillationFetchContent: "DISTILLATION_FETCH_CONTENT",
  distillationTargetInventoryRefreshed: "DISTILLATION_TARGET_INVENTORY_REFRESHED",
  distillationTargetClaimed: "DISTILLATION_TARGET_CLAIMED",
  distillationTargetHeartbeat: "DISTILLATION_TARGET_HEARTBEAT",
  distillationTargetRecovered: "DISTILLATION_TARGET_RECOVERED",
  distillationTargetStatusChanged: "DISTILLATION_TARGET_STATUS_CHANGED",
  findCandidateStarted: "FIND_CANDIDATE_STARTED",
  findCandidateReaderUsed: "FIND_CANDIDATE_READER_USED",
  findCandidateCompleted: "FIND_CANDIDATE_COMPLETED",
  findCandidateFailed: "FIND_CANDIDATE_FAILED",
  coverEvidenceStarted: "COVER_EVIDENCE_STARTED",
  coverEvidenceCompleted: "COVER_EVIDENCE_COMPLETED",
  coverEvidenceFailed: "COVER_EVIDENCE_FAILED",
  coverEvidenceLlmStarted: "COVER_EVIDENCE_LLM_STARTED",
  coverEvidenceLlmCompleted: "COVER_EVIDENCE_LLM_COMPLETED",
  coverEvidenceLlmFailed: "COVER_EVIDENCE_LLM_FAILED",
  coverEvidenceReprocessRequested: "COVER_EVIDENCE_REPROCESS_REQUESTED",
  coverEvidenceProcedureRepairStarted: "COVER_EVIDENCE_PROCEDURE_REPAIR_STARTED",
  coverEvidenceProcedureRepairCompleted: "COVER_EVIDENCE_PROCEDURE_REPAIR_COMPLETED",
  coverEvidenceProcedureDemotedToRule: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
  finalizeDistilleStarted: "FINALIZE_DISTILLE_STARTED",
  finalizeDistilleCompleted: "FINALIZE_DISTILLE_COMPLETED",
  finalizeDistilleEmbeddingFailed: "FINALIZE_DISTILLE_EMBEDDING_FAILED",
  distillationMcpEvidence: "DISTILLATION_MCP_EVIDENCE",
  vibeDistillationRunStarted: "VIBE_DISTILLATION_RUN_STARTED",
  vibeDistillationRunFinished: "VIBE_DISTILLATION_RUN_FINISHED",
  landscapeReviewItemsMaterialized: "LANDSCAPE_REVIEW_ITEMS_MATERIALIZED",
  landscapeReviewItemStatusChanged: "LANDSCAPE_REVIEW_ITEM_STATUS_CHANGED",
  landscapeSnapshotCacheReadFailed: "LANDSCAPE_SNAPSHOT_CACHE_READ_FAILED",
  landscapeSnapshotCacheWriteFailed: "LANDSCAPE_SNAPSHOT_CACHE_WRITE_FAILED",
  landscapeSnapshotCachePurge: "LANDSCAPE_SNAPSHOT_CACHE_PURGE",
  contextCompileRun: "CONTEXT_COMPILE_RUN",
  securityIntelligenceShadowRetrieval: "SECURITY_INTELLIGENCE_SHADOW_RETRIEVAL",
  securityIntelligenceCandidateBatchReceived: "SECURITY_INTELLIGENCE_CANDIDATE_BATCH_RECEIVED",
  securityIntelligenceFeedbackBatchReceived: "SECURITY_INTELLIGENCE_FEEDBACK_BATCH_RECEIVED",
  projectIdentityProducerValidated: "PROJECT_IDENTITY_PRODUCER_VALIDATED",
  projectIdentityProducerPersisted: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
  projectIdentityProducerRejected: "PROJECT_IDENTITY_PRODUCER_REJECTED",
  systemContextSubmitted: "SYSTEM_CONTEXT_SUBMITTED",
  syncRunStarted: "SYNC_RUN_STARTED",
  syncRunFinished: "SYNC_RUN_FINISHED",
  auditLogCleanup: "AUDIT_LOG_CLEANUP",
} as const;

export type AuditActor = "agent" | "user" | "system";

type RecordAuditLogInput = {
  eventType: string;
  actor: AuditActor;
  payload?: Record<string, unknown>;
  createdAt?: Date;
};

export type AuditLogItem = {
  id: string;
  eventType: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type AuditLogListInput = {
  page?: number;
  limit?: number;
  eventType?: string;
  actor?: string;
};

export type AuditLogListResult = {
  items: AuditLogItem[];
  total: number;
  page: number;
  limit: number;
  availableEventTypes: string[];
};

export type CleanupAuditLogsResult = {
  retentionDays: number;
  trigger: string;
  cutoffIso: string;
  deletedCount: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isMissingAuditLogTableError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("audit_logs") &&
    (lowered.includes("does not exist") ||
      lowered.includes("undefined_table") ||
      lowered.includes("no such table"))
  );
}

function isAuditLogInsertFailure(message: string): boolean {
  return message.includes('insert into "audit_logs"');
}

async function isAuditLogsTableAvailable(): Promise<boolean | null> {
  try {
    const result = await db.execute(sql`select to_regclass('public.audit_logs') as regclass`);
    const row = (result.rows as Array<Record<string, unknown>>)[0];
    const value = row?.regclass;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== null && value !== undefined;
  } catch {
    return null;
  }
}

function normalizePagination(input: AuditLogListInput): { page: number; limit: number } {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  return { page, limit };
}

export async function recordAuditLog(input: RecordAuditLogInput): Promise<void> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await import("./audit-log.repository.sqlite.js");
    return sqlite.recordAuditLogSqlite(input);
  }
  const eventType = normalizeText(input.eventType);
  if (!eventType) return;
  await db.insert(auditLogs).values({
    eventType,
    actor: input.actor,
    payload: redactSecretRecord(input.payload ?? {}),
    createdAt: input.createdAt ?? new Date(),
  });
}

export async function recordAuditLogSafe(input: RecordAuditLogInput): Promise<void> {
  if (auditLogDisabledReason) return;
  try {
    await recordAuditLog(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingAuditLogTableError(message)) {
      auditLogDisabledReason = message;
      return;
    }
    if (isAuditLogInsertFailure(message)) {
      const tableAvailable = await isAuditLogsTableAvailable();
      if (tableAvailable === false) {
        auditLogDisabledReason = message;
        return;
      }
    }
    console.warn(`[audit-log] failed to record event=${input.eventType}: ${message}`);
  }
}

export async function listAuditLogs(input: AuditLogListInput = {}): Promise<AuditLogListResult> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await import("./audit-log.repository.sqlite.js");
    return sqlite.listAuditLogsSqlite(input);
  }
  const { page, limit } = normalizePagination(input);
  const eventType = normalizeText(input.eventType);
  const actor = normalizeText(input.actor);

  const conditions = [];
  if (eventType) conditions.push(eq(auditLogs.eventType, eventType));
  if (actor) conditions.push(eq(auditLogs.actor, actor));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRows = await db.select({ count: sql<string>`count(*)` }).from(auditLogs).where(where);
  const total = Number(totalRows[0]?.count ?? 0);

  const rows = await db
    .select({
      id: auditLogs.id,
      eventType: auditLogs.eventType,
      actor: auditLogs.actor,
      payload: auditLogs.payload,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const distinctTypeRows = await db
    .selectDistinct({
      eventType: auditLogs.eventType,
    })
    .from(auditLogs)
    .orderBy(asc(auditLogs.eventType));

  return {
    items: rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      actor: row.actor,
      payload: asRecord(row.payload),
      createdAt: row.createdAt,
    })),
    total,
    page,
    limit,
    availableEventTypes: distinctTypeRows.map((row) => row.eventType).filter(Boolean),
  };
}

export async function cleanupExpiredAuditLogs(input?: {
  retentionDays?: number;
  trigger?: string;
}): Promise<CleanupAuditLogsResult> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await import("./audit-log.repository.sqlite.js");
    return sqlite.cleanupExpiredAuditLogsSqlite({
      retentionDays: input?.retentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS,
      trigger: input?.trigger,
    });
  }
  const retentionDays = Math.max(
    1,
    Math.floor(input?.retentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS),
  );
  const trigger = normalizeText(input?.trigger) ?? "unknown";
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const deletedRows = await db
    .delete(auditLogs)
    .where(lt(auditLogs.createdAt, cutoff))
    .returning({ id: auditLogs.id });

  return {
    retentionDays,
    trigger,
    cutoffIso: cutoff.toISOString(),
    deletedCount: deletedRows.length,
  };
}

export async function cleanupExpiredAuditLogsSafe(input?: {
  retentionDays?: number;
  trigger?: string;
}): Promise<CleanupAuditLogsResult | null> {
  if (auditLogDisabledReason) return null;
  try {
    const result = await cleanupExpiredAuditLogs(input);
    if (result.deletedCount > 0) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.auditLogCleanup,
        actor: "system",
        payload: result,
      });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const trigger = normalizeText(input?.trigger) ?? "unknown";
    console.warn(`[audit-log] cleanup failed trigger=${trigger}: ${message}`);
    return null;
  }
}

/** @internal - For testing only */
export function resetAuditLogStatus(): void {
  auditLogDisabledReason = null;
}
