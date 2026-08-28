import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  deadZoneMergeReviewQueue,
  knowledgeItems,
  mergeActivationFinalizeQueue,
} from "../../db/schema.js";
import { deadZoneMergeReviewResultSchema } from "../../shared/schemas/landscape-deadzone-review.schema.js";
import { appendQueueEvent } from "../queue/core/events.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveMergeActivationFinalizeRoute,
} from "../settings/settings.service.js";
import { getDeadZoneMergeReviewQueueRow } from "./deadzone-merge-review-queue.repository.js";
import { DeadZoneMergeReviewQueueError } from "./deadzone-merge-review-queue.service.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export type MergeActivationFinalizeJobCreateResult = {
  id: string;
  status: string;
  jobType: "merge_activation_finalize";
  mergeReviewJobId: string;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId: string | null;
};

export async function createMergeActivationFinalizeJob(
  mergeReviewJobId: string,
  options?: { curationJobId?: string; autonomousExactDuplicate?: boolean },
): Promise<MergeActivationFinalizeJobCreateResult> {
  const reviewJob = await getDeadZoneMergeReviewQueueRow(mergeReviewJobId);
  if (!reviewJob) throw new DeadZoneMergeReviewQueueError("merge review job not found", 404);
  if (reviewJob.status !== "completed") {
    throw new DeadZoneMergeReviewQueueError("merge review job is not completed");
  }
  if (!reviewJob.canonicalKnowledgeId) {
    throw new DeadZoneMergeReviewQueueError("merge review job has no canonical knowledge", 409);
  }

  const parsedResult = deadZoneMergeReviewResultSchema.safeParse(reviewJob.result);
  if (!parsedResult.success || parsedResult.data.decision !== "merge_recommended") {
    throw new DeadZoneMergeReviewQueueError("merge review did not recommend finalization");
  }

  const selectKnowledge = async (id: string) => {
    if (isSqliteBackend()) {
      const sqlite = await getSqliteCoreDatabase();
      const row = sqlite.db
        .query(
          `
          select id, title, body, status, applies_to, metadata
          from knowledge_items
          where id = ?
          limit 1
        `,
        )
        .get(id) as {
        id: string;
        title: string;
        body: string;
        status: string;
        applies_to: string;
        metadata: string;
      } | null;
      return row
        ? {
            id: row.id,
            title: row.title,
            body: row.body,
            status: row.status,
            appliesTo: parseJsonRecord(row.applies_to),
            metadata: parseJsonRecord(row.metadata),
          }
        : null;
    }
    const [row] = await db
      .select({
        id: knowledgeItems.id,
        title: knowledgeItems.title,
        body: knowledgeItems.body,
        status: knowledgeItems.status,
        appliesTo: knowledgeItems.appliesTo,
        metadata: knowledgeItems.metadata,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, id))
      .limit(1);
    return row ?? null;
  };

  const [deadZone, canonical] = await Promise.all([
    selectKnowledge(reviewJob.deadZoneKnowledgeId),
    selectKnowledge(reviewJob.canonicalKnowledgeId),
  ]);

  if (!deadZone || !canonical) {
    throw new DeadZoneMergeReviewQueueError("knowledge row missing", 404);
  }
  if (deadZone.id === canonical.id) {
    throw new DeadZoneMergeReviewQueueError("dead-zone and canonical knowledge must differ");
  }

  await ensureRuntimeSettingsLoaded();
  const route = resolveMergeActivationFinalizeRoute();
  const resultHash = createHash("sha256").update(JSON.stringify(parsedResult.data)).digest("hex");
  const nowIso = new Date().toISOString();
  const queueMetadata = {
    queueVersion: "v1",
    visibleQueueName: "finalizeDistille",
    jobType: "merge_activation_finalize",
    ...(options?.curationJobId ? { curationJobId: options.curationJobId } : {}),
    ...(options?.autonomousExactDuplicate ? { autonomous: true, exactDuplicate: true } : {}),
  };
  const inputSnapshot = {
    mergeReviewJob: {
      id: reviewJob.id,
      decision: parsedResult.data.decision,
      proposedCanonicalBody: parsedResult.data.proposedCanonicalBody,
      proposedSummary: parsedResult.data.proposedSummary,
      resultHash,
    },
    deadZone: {
      id: deadZone.id,
      title: deadZone.title,
      body: deadZone.body,
      status: deadZone.status,
      appliesTo: asRecord(deadZone.appliesTo),
      metadata: asRecord(deadZone.metadata),
      bodyHash: hashBody(deadZone.body),
    },
    canonical: {
      id: canonical.id,
      title: canonical.title,
      body: canonical.body,
      status: canonical.status,
      appliesTo: asRecord(canonical.appliesTo),
      metadata: asRecord(canonical.metadata),
      bodyHash: hashBody(canonical.body),
    },
    landscape: {},
    replay: {
      selectedCount: 0,
      offTopicCount: 0,
      usefulRuns: [],
      appliesToRefineCandidates: [],
    },
  };

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const idempotencyKey = `merge-activation-finalize:${reviewJob.id}`;
    const existing = sqlite.db
      .query("select * from merge_activation_finalize_queue where idempotency_key = ? limit 1")
      .get(idempotencyKey) as {
      id: string;
      status: string;
      merge_review_job_id: string;
      dead_zone_knowledge_id: string;
      canonical_knowledge_id: string;
      review_item_id: string | null;
      metadata: string;
    } | null;
    const payload = {
      sourceQueue: "deadZoneMergeReview",
      sourceQueueJobId: reviewJob.id,
      requestedAt: nowIso,
    };
    const jobId = existing?.id ?? crypto.randomUUID();
    if (existing) {
      sqlite.db
        .query(
          "update merge_activation_finalize_queue set payload = ?, metadata = ?, updated_at = ? where id = ?",
        )
        .run(
          JSON.stringify(payload),
          JSON.stringify({ ...parseJsonRecord(existing.metadata), ...queueMetadata }),
          nowIso,
          jobId,
        );
    } else {
      sqlite.db
        .query(
          `
          insert into merge_activation_finalize_queue (
            id, merge_review_job_id, dead_zone_knowledge_id, canonical_knowledge_id,
            review_item_id, idempotency_key, status, priority, provider, model,
            input_snapshot, payload, metadata, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          jobId,
          reviewJob.id,
          deadZone.id,
          canonical.id,
          reviewJob.reviewItemId,
          idempotencyKey,
          reviewJob.priority,
          route.provider === "auto" ? "local-llm" : route.provider,
          route.model ?? null,
          JSON.stringify(inputSnapshot),
          JSON.stringify(payload),
          JSON.stringify(queueMetadata),
          nowIso,
          nowIso,
        );
    }
    const job = {
      id: jobId,
      status: existing?.status ?? "pending",
      mergeReviewJobId: reviewJob.id,
      deadZoneKnowledgeId: deadZone.id,
      canonicalKnowledgeId: canonical.id,
      reviewItemId: reviewJob.reviewItemId,
    };
    await appendQueueEvent({
      queueName: "mergeActivationFinalize",
      queueJobId: job.id,
      eventType: "enqueued",
      message: "merge activation finalize enqueued",
      metadata: {
        visibleQueueName: "finalizeDistille",
        mergeReviewJobId: reviewJob.id,
      },
    });
    return {
      ...job,
      jobType: "merge_activation_finalize",
    };
  }

  const [job] = await db
    .insert(mergeActivationFinalizeQueue)
    .values({
      mergeReviewJobId: reviewJob.id,
      deadZoneKnowledgeId: deadZone.id,
      canonicalKnowledgeId: canonical.id,
      reviewItemId: reviewJob.reviewItemId,
      idempotencyKey: `merge-activation-finalize:${reviewJob.id}`,
      status: "pending",
      priority: reviewJob.priority,
      provider: route.provider === "auto" ? "local-llm" : route.provider,
      model: route.model ?? null,
      inputSnapshot,
      payload: {
        sourceQueue: "deadZoneMergeReview",
        sourceQueueJobId: reviewJob.id,
        requestedAt: nowIso,
      },
      metadata: queueMetadata,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mergeActivationFinalizeQueue.idempotencyKey,
      set: {
        payload: {
          sourceQueue: "deadZoneMergeReview",
          sourceQueueJobId: reviewJob.id,
          requestedAt: nowIso,
        },
        metadata: queueMetadata,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: mergeActivationFinalizeQueue.id,
      status: mergeActivationFinalizeQueue.status,
      mergeReviewJobId: mergeActivationFinalizeQueue.mergeReviewJobId,
      deadZoneKnowledgeId: mergeActivationFinalizeQueue.deadZoneKnowledgeId,
      canonicalKnowledgeId: mergeActivationFinalizeQueue.canonicalKnowledgeId,
      reviewItemId: mergeActivationFinalizeQueue.reviewItemId,
    });

  if (!job) throw new DeadZoneMergeReviewQueueError("failed to enqueue finalize job", 500);

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "enqueued",
    message: "merge activation finalize enqueued",
    metadata: {
      visibleQueueName: "finalizeDistille",
      mergeReviewJobId: reviewJob.id,
    },
  });

  return {
    ...job,
    jobType: "merge_activation_finalize",
  };
}
