import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { updateKnowledgeItem } from "../../../api/modules/knowledge/knowledge.repository.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { deadZoneMergeReviewQueue, knowledgeItems } from "../../db/schema.js";
import {
  type DeadZoneMergeReviewJob,
  type DeadZoneMergeReviewJobApplyResult,
  type DeadZoneMergeReviewJobCreateInput,
  type DeadZoneMergeReviewJobListQuery,
  type DeadZoneMergeReviewResult,
  deadZoneMergeReviewResultSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";
import {
  landscapeCurationInputSnapshotSchema,
  landscapeCurationPolicyResultSchema,
  landscapeCurationResultSchema,
} from "../../shared/schemas/landscape-curation.schema.js";
import { appendQueueEvent } from "../queue/core/events.js";
import { resolveDeadZoneMergeReviewRoute } from "../settings/settings.service.js";
import {
  type DeadZoneMergeReviewInputSnapshot,
  DeadZoneMergeReviewParseError,
  runDeadZoneMergeReviewLlm,
} from "./deadzone-merge-review-llm.js";
import {
  getDeadZoneMergeReviewQueueRow,
  listDeadZoneMergeReviewJobs,
  markDeadZoneMergeReviewJobCompleted,
  markDeadZoneMergeReviewJobFailed,
  markDeadZoneMergeReviewJobSkipped,
  upsertDeadZoneMergeReviewJob,
} from "./deadzone-merge-review-queue.repository.js";
import {
  findLandscapeCurationJobLinkByQueueJob,
  getLandscapeCurationJob,
  updateLandscapeCurationJob,
  upsertLandscapeCurationJobLink,
} from "./landscape-curation-queue.repository.js";
import { recordDeadZoneReviewDecision } from "./landscape-deadzone-review.repository.js";

type KnowledgeSnapshotRow = {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  appliesTo: Record<string, unknown>;
};

export class DeadZoneMergeReviewQueueError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "DeadZoneMergeReviewQueueError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isActiveKnowledge(row: KnowledgeSnapshotRow | undefined): row is KnowledgeSnapshotRow {
  return Boolean(row && row.status === "active");
}

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

async function loadKnowledgeRows(ids: string[]): Promise<Map<string, KnowledgeSnapshotRow>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return new Map();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = sqlite.db
      .query(
        `
        select id, title, body, type, status, applies_to
        from knowledge_items
        where id in (${placeholders})
      `,
      )
      .all(...uniqueIds) as Array<{
      id: string;
      title: string;
      body: string;
      type: string;
      status: string;
      applies_to: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title,
          body: row.body,
          type: row.type,
          status: row.status,
          appliesTo: parseJsonRecord(row.applies_to),
        },
      ]),
    );
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      appliesTo: knowledgeItems.appliesTo,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, uniqueIds));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        body: row.body,
        type: row.type,
        status: row.status,
        appliesTo: asRecord(row.appliesTo),
      },
    ]),
  );
}

function buildInputSnapshot(params: {
  deadZone: KnowledgeSnapshotRow;
  canonical: KnowledgeSnapshotRow;
  recommendation?: Record<string, unknown>;
}): DeadZoneMergeReviewInputSnapshot {
  return {
    deadZone: { ...params.deadZone, bodyHash: hashBody(params.deadZone.body) },
    canonical: { ...params.canonical, bodyHash: hashBody(params.canonical.body) },
    heuristicRecommendation: {
      confidence:
        typeof params.recommendation?.confidence === "string"
          ? params.recommendation.confidence
          : "medium",
      reasons: Array.isArray(params.recommendation?.reasons)
        ? params.recommendation.reasons.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      blockers: Array.isArray(params.recommendation?.blockers)
        ? params.recommendation.blockers.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    },
  };
}

export async function createDeadZoneMergeReviewJob(
  input: DeadZoneMergeReviewJobCreateInput,
): Promise<DeadZoneMergeReviewJob> {
  if (input.deadZoneKnowledgeId === input.canonicalKnowledgeId) {
    throw new DeadZoneMergeReviewQueueError("dead-zone and canonical knowledge must differ");
  }
  const rows = await loadKnowledgeRows([input.deadZoneKnowledgeId, input.canonicalKnowledgeId]);
  const deadZone = rows.get(input.deadZoneKnowledgeId);
  const canonical = rows.get(input.canonicalKnowledgeId);
  if (!deadZone) throw new DeadZoneMergeReviewQueueError("dead-zone knowledge not found", 404);
  if (!canonical) throw new DeadZoneMergeReviewQueueError("canonical knowledge not found", 404);
  if (!isActiveKnowledge(canonical)) {
    throw new DeadZoneMergeReviewQueueError("canonical knowledge must be active");
  }
  if (deadZone.status === "deprecated") {
    throw new DeadZoneMergeReviewQueueError("deprecated dead-zone knowledge cannot be queued");
  }

  const route = resolveDeadZoneMergeReviewRoute();
  const inputSnapshot = buildInputSnapshot({ deadZone, canonical });
  return upsertDeadZoneMergeReviewJob({
    reviewItemId: input.reviewItemId ?? null,
    deadZoneKnowledgeId: deadZone.id,
    canonicalKnowledgeId: canonical.id,
    idempotencyKey: [
      "dead-zone-merge-review",
      input.reviewItemId ?? "no-review",
      deadZone.id,
      canonical.id,
    ].join(":"),
    priority: 70,
    provider: route.provider === "auto" ? "local-llm" : route.provider,
    model: route.model ?? null,
    inputSnapshot: inputSnapshot as unknown as Record<string, unknown>,
    payload: {
      note: input.note ?? null,
      requestedAt: new Date().toISOString(),
    },
  });
}

export async function listDeadZoneMergeReviewQueueJobs(
  query: DeadZoneMergeReviewJobListQuery,
): Promise<DeadZoneMergeReviewJob[]> {
  return listDeadZoneMergeReviewJobs(query);
}

export async function reconcileLandscapeCurationMergeReviewJob(jobId: string): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(jobId);
  if (!row) return;
  const curationLink = await findLandscapeCurationJobLinkByQueueJob({
    queueName: "deadZoneMergeReview",
    queueJobId: row.id,
    role: "merge_review",
  });
  if (!curationLink) return;

  if (row.status === "failed" || row.status === "skipped") {
    await upsertLandscapeCurationJobLink({
      curationJobId: curationLink.curationJobId,
      role: "merge_review",
      queueName: "deadZoneMergeReview",
      queueJobId: row.id,
      status: row.status,
      outcomeKind: row.lastOutcomeKind,
      metadata: { ...curationLink.metadata, autonomous: true },
      completedAt: row.completedAt,
    });
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "failed",
      phase: "awaiting_downstream",
      nextRunAt: null,
      lastError: row.lastError ?? `merge review ${row.status}`,
      lastOutcomeKind: `downstream_${row.lastOutcomeKind ?? row.status}`,
      completedAt: null,
    });
    return;
  }
  if (row.status !== "completed") return;

  const parsedResult = deadZoneMergeReviewResultSchema.safeParse(row.result);
  if (!parsedResult.success) {
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "failed",
      phase: "awaiting_downstream",
      nextRunAt: null,
      lastError: "merge review completed with an invalid result",
      lastOutcomeKind: "downstream_invalid_result",
      completedAt: null,
    });
    return;
  }
  const result = parsedResult.data;
  await upsertLandscapeCurationJobLink({
    curationJobId: curationLink.curationJobId,
    role: "merge_review",
    queueName: "deadZoneMergeReview",
    queueJobId: row.id,
    status: "completed",
    outcomeKind: result.decision,
    metadata: { ...curationLink.metadata, autonomous: true },
    completedAt: row.completedAt ?? new Date(),
  });

  const curation = await getLandscapeCurationJob(curationLink.curationJobId);
  const curationInput = landscapeCurationInputSnapshotSchema.safeParse(curation?.inputSnapshot);
  const curationResult = landscapeCurationResultSchema.safeParse(curation?.result);
  const curationPolicy = landscapeCurationPolicyResultSchema.safeParse(curation?.policyResult);
  const canonicalSnapshot = curationInput.success
    ? curationInput.data.candidates.find((candidate) => candidate.id === row.canonicalKnowledgeId)
    : undefined;
  const autonomousExactDuplicate = Boolean(
    curationInput.success &&
      curationResult.success &&
      curationPolicy.success &&
      curationPolicy.data.disposition === "enqueue_downstream" &&
      curationPolicy.data.releaseMode === "auto_bounded" &&
      curationPolicy.data.reasonCodes.includes("AUTONOMOUS_SAFE_DOWNSTREAM") &&
      curationResult.data.canonicalKnowledgeId === row.canonicalKnowledgeId &&
      curationInput.data.subject.id === row.deadZoneKnowledgeId &&
      canonicalSnapshot &&
      curationInput.data.subject.bodyHash === canonicalSnapshot.bodyHash &&
      curationInput.data.subject.appliesToHash === canonicalSnapshot.appliesToHash,
  );
  const proposedBodyPreservesCanonical = Boolean(
    canonicalSnapshot &&
      result.proposedCanonicalBody?.trim() &&
      hashBody(result.proposedCanonicalBody.trim()) === canonicalSnapshot.bodyHash,
  );
  const autoFinalizeEligible =
    result.decision === "merge_recommended" &&
    result.confidence === "high" &&
    result.blockers.length === 0 &&
    autonomousExactDuplicate &&
    proposedBodyPreservesCanonical;
  if (result.decision === "merge_recommended" && !autoFinalizeEligible) {
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "completed",
      phase: "policy",
      nextRunAt: null,
      lastError: null,
      lastOutcomeKind: "downstream_merge_not_auto_eligible",
      completedAt: new Date(),
    });
    return;
  }
  if (!autoFinalizeEligible) {
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "completed",
      phase: "policy",
      nextRunAt: null,
      lastError: null,
      lastOutcomeKind: `downstream_${result.decision}`,
      completedAt: new Date(),
    });
    return;
  }

  try {
    const { createMergeActivationFinalizeJob } = await import(
      "./merge-activation-finalize.service.js"
    );
    const finalize = await createMergeActivationFinalizeJob(row.id, {
      curationJobId: curationLink.curationJobId,
      autonomousExactDuplicate: true,
    });
    await upsertLandscapeCurationJobLink({
      curationJobId: curationLink.curationJobId,
      role: "merge_finalize",
      queueName: "mergeActivationFinalize",
      queueJobId: finalize.id,
      status: finalize.status,
      metadata: {
        autonomous: true,
        exactDuplicate: true,
        mergeReviewJobId: row.id,
      },
      completedAt:
        finalize.status === "completed" || finalize.status === "skipped" ? new Date() : null,
    });
    await appendQueueEvent({
      queueName: "landscapeCuration",
      queueJobId: curationLink.curationJobId,
      eventType: "downstream_linked",
      message: "merge review automatically delegated to finalize",
      metadata: {
        downstreamQueue: "mergeActivationFinalize",
        downstreamJobId: finalize.id,
      },
    });
    if (finalize.status === "completed") {
      await updateLandscapeCurationJob(curationLink.curationJobId, {
        status: "completed",
        phase: "postcheck",
        nextRunAt: null,
        lastError: null,
        lastOutcomeKind: "downstream_completed",
        completedAt: new Date(),
      });
    } else if (finalize.status === "failed" || finalize.status === "skipped") {
      await updateLandscapeCurationJob(curationLink.curationJobId, {
        status: "failed",
        phase: "awaiting_downstream",
        nextRunAt: null,
        lastError: `existing finalize job is ${finalize.status}`,
        lastOutcomeKind: `downstream_finalize_${finalize.status}`,
        completedAt: null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "failed",
      phase: "awaiting_downstream",
      nextRunAt: null,
      lastError: message,
      lastOutcomeKind: "downstream_finalize_failed",
      completedAt: null,
    });
    throw error;
  }
}

export async function processDeadZoneMergeReviewJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<void> {
  const row = await getDeadZoneMergeReviewQueueRow(jobId);
  if (!row) throw new Error(`dead-zone merge review job not found: ${jobId}`);

  await appendQueueEvent({
    queueName: "deadZoneMergeReview",
    queueJobId: row.id,
    eventType: "claimed",
    message: "dead-zone merge review claimed",
  });

  const inputSnapshot = row.inputSnapshot as unknown as DeadZoneMergeReviewInputSnapshot;
  const ids = [inputSnapshot.deadZone?.id, inputSnapshot.canonical?.id].filter(Boolean);
  const currentRows = await loadKnowledgeRows(ids);
  const deadZone = currentRows.get(inputSnapshot.deadZone.id);
  const canonical = currentRows.get(inputSnapshot.canonical.id);
  if (
    !deadZone ||
    !canonical ||
    canonical.status !== "active" ||
    deadZone.status === "deprecated"
  ) {
    const result: DeadZoneMergeReviewResult = {
      decision: "merge_blocked",
      confidence: "high",
      rationale: ["Current knowledge state no longer permits this merge."],
      blockers: ["knowledge status changed before review"],
      proposedCanonicalBody: null,
      proposedSummary: null,
      rawOutputExcerpt: "",
      parseStatus: "parsed",
    };
    await markDeadZoneMergeReviewJobSkipped({
      id: row.id,
      reason: "knowledge status changed before review",
      result,
    });
    const curationLink = await findLandscapeCurationJobLinkByQueueJob({
      queueName: "deadZoneMergeReview",
      queueJobId: row.id,
      role: "merge_review",
    });
    if (curationLink) {
      await updateLandscapeCurationJob(curationLink.curationJobId, {
        status: "failed",
        phase: "awaiting_downstream",
        nextRunAt: null,
        lastError: "knowledge status changed before merge review",
        lastOutcomeKind: "downstream_stale_input",
        completedAt: null,
      });
    }
    return;
  }

  let result: DeadZoneMergeReviewResult;
  try {
    result = await runDeadZoneMergeReviewLlm({ inputSnapshot, signal });
  } catch (error) {
    const outcome =
      error instanceof DeadZoneMergeReviewParseError ? "parse_failed" : "provider_failed";
    const attemptCount = (row.attemptCount ?? 0) + 1;
    const retryable = attemptCount < (row.maxAttempts ?? 2);
    const retryDelayMs = 60_000 * 5 ** Math.max(0, attemptCount - 1);
    const retryAt = retryable ? new Date(Date.now() + retryDelayMs) : null;
    await markDeadZoneMergeReviewJobFailed({
      id: row.id,
      error: error instanceof Error ? error.message : String(error),
      outcome: retryable ? "retry_scheduled" : outcome,
      retryAt,
    });
    const curationLink = await findLandscapeCurationJobLinkByQueueJob({
      queueName: "deadZoneMergeReview",
      queueJobId: row.id,
      role: "merge_review",
    });
    if (curationLink) {
      await upsertLandscapeCurationJobLink({
        curationJobId: curationLink.curationJobId,
        role: "merge_review",
        queueName: "deadZoneMergeReview",
        queueJobId: row.id,
        status: retryable ? "paused" : "failed",
        outcomeKind: retryable ? "retry_scheduled" : outcome,
        metadata: { ...curationLink.metadata, autonomous: true },
        completedAt: retryable ? null : new Date(),
      });
      await updateLandscapeCurationJob(curationLink.curationJobId, {
        status: retryable ? "paused" : "failed",
        phase: "awaiting_downstream",
        nextRunAt: retryable ? new Date(Date.now() + 30_000) : null,
        lastError: error instanceof Error ? error.message : String(error),
        lastOutcomeKind: retryable ? "downstream_merge_review_retrying" : `downstream_${outcome}`,
        completedAt: retryable ? null : new Date(),
      });
    }
    if (retryable) {
      await appendQueueEvent({
        queueName: "deadZoneMergeReview",
        queueJobId: row.id,
        eventType: "retried",
        message: "dead-zone merge review scheduled for automatic retry",
        metadata: { outcome, attemptCount, retryDelayMs },
      });
      return;
    }
    throw error;
  }
  await markDeadZoneMergeReviewJobCompleted({
    id: row.id,
    result,
    outcome: result.decision,
  });
  await appendQueueEvent({
    queueName: "deadZoneMergeReview",
    queueJobId: row.id,
    eventType: "completed",
    message: "dead-zone merge review completed",
    metadata: { decision: result.decision },
  });
  await reconcileLandscapeCurationMergeReviewJob(row.id);
}

export async function applyDeadZoneMergeReviewJob(
  jobId: string,
): Promise<DeadZoneMergeReviewJobApplyResult> {
  const row = await getDeadZoneMergeReviewQueueRow(jobId);
  if (!row) throw new DeadZoneMergeReviewQueueError("merge review job not found", 404);
  if (row.status !== "completed") {
    throw new DeadZoneMergeReviewQueueError("merge review job is not completed");
  }
  const result = deadZoneMergeReviewResultSchema.safeParse(row.result);
  if (!result.success || result.data.decision !== "merge_recommended") {
    throw new DeadZoneMergeReviewQueueError("merge review did not recommend applying a merge");
  }
  const proposedCanonicalBody = result.data.proposedCanonicalBody?.trim();
  if (!proposedCanonicalBody) {
    throw new DeadZoneMergeReviewQueueError("merge review did not produce a canonical body");
  }

  const inputSnapshot = row.inputSnapshot as unknown as DeadZoneMergeReviewInputSnapshot;
  const currentRows = await loadKnowledgeRows([
    row.deadZoneKnowledgeId,
    row.canonicalKnowledgeId ?? "",
  ]);
  const deadZone = currentRows.get(row.deadZoneKnowledgeId);
  const canonical = row.canonicalKnowledgeId ? currentRows.get(row.canonicalKnowledgeId) : null;
  if (!deadZone || !canonical) {
    throw new DeadZoneMergeReviewQueueError("knowledge row missing", 404);
  }
  if (
    hashBody(deadZone.body) !== inputSnapshot.deadZone.bodyHash ||
    hashBody(canonical.body) !== inputSnapshot.canonical.bodyHash
  ) {
    throw new DeadZoneMergeReviewQueueError("knowledge body changed after review", 409);
  }
  if (canonical.status !== "active" || deadZone.status === "deprecated") {
    throw new DeadZoneMergeReviewQueueError("knowledge status changed after review", 409);
  }

  await updateKnowledgeItem(canonical.id, {
    body: proposedCanonicalBody,
    metadata: {
      deadZoneMergeReview: {
        jobId: row.id,
        mergedDeadZoneKnowledgeId: deadZone.id,
        appliedAt: new Date().toISOString(),
        summary: result.data.proposedSummary,
      },
    },
  });
  await updateKnowledgeItem(deadZone.id, { status: "deprecated" });
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update dead_zone_merge_review_queue
        set last_outcome_kind = ?,
            metadata = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        "applied",
        JSON.stringify({
          ...asRecord(row.metadata),
          appliedAt: new Date().toISOString(),
          appliedCanonicalKnowledgeId: canonical.id,
          deprecatedKnowledgeId: deadZone.id,
        }),
        new Date().toISOString(),
        row.id,
      );
  } else {
    await db
      .update(deadZoneMergeReviewQueue)
      .set({
        lastOutcomeKind: "applied",
        metadata: {
          ...asRecord(row.metadata),
          appliedAt: new Date().toISOString(),
          appliedCanonicalKnowledgeId: canonical.id,
          deprecatedKnowledgeId: deadZone.id,
        },
        updatedAt: new Date(),
      })
      .where(eq(deadZoneMergeReviewQueue.id, row.id));
  }
  await recordDeadZoneReviewDecision({
    reviewItemId: row.reviewItemId,
    deadZoneKnowledgeId: deadZone.id,
    canonicalKnowledgeId: canonical.id,
    action: "merge_deadzone_into_canonical",
    note: `Applied reviewed merge job ${row.id}`,
    status: "applied",
    message: "Reviewed merge applied; canonical knowledge was re-embedded.",
  });
  return {
    status: "applied",
    jobId: row.id,
    keptKnowledgeId: canonical.id,
    deprecatedKnowledgeId: deadZone.id,
    reviewItemId: row.reviewItemId,
  };
}
