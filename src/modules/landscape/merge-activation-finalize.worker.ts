import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { updateKnowledgeItem } from "../../../api/modules/knowledge/knowledge.repository.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems, mergeActivationFinalizeQueue } from "../../db/schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import { appendQueueEvent } from "../queue/core/events.js";
import {
  findLandscapeCurationJobLinkByQueueJob,
  updateLandscapeCurationJob,
  upsertLandscapeCurationJobLink,
} from "./landscape-curation-queue.repository.js";

type SnapshotKnowledge = {
  id: string;
  bodyHash: string;
  status: string;
  appliesTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type MergeActivationSnapshot = {
  mergeReviewJob?: {
    id?: string;
    proposedCanonicalBody?: string | null;
    proposedSummary?: string | null;
  };
  deadZone?: SnapshotKnowledge;
  canonical?: SnapshotKnowledge;
};

type FinalizeJobRow = typeof mergeActivationFinalizeQueue.$inferSelect;
type KnowledgeRow = Pick<
  typeof knowledgeItems.$inferSelect,
  "id" | "body" | "status" | "appliesTo" | "metadata"
>;

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function hashRecord(value: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function loadFinalizeJob(id: string): Promise<FinalizeJobRow | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query("select * from merge_activation_finalize_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      mergeReviewJobId: row.merge_review_job_id ? String(row.merge_review_job_id) : null,
      deadZoneKnowledgeId: row.dead_zone_knowledge_id ? String(row.dead_zone_knowledge_id) : null,
      canonicalKnowledgeId: row.canonical_knowledge_id ? String(row.canonical_knowledge_id) : null,
      reviewItemId: row.review_item_id ? String(row.review_item_id) : null,
      idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
      status: String(row.status),
      priority: Number(row.priority ?? 0),
      attemptCount: Number(row.attempt_count ?? 0),
      maxAttempts: Number(row.max_attempts ?? 2),
      nextRunAt: null,
      lockedBy: row.locked_by ? String(row.locked_by) : null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: row.last_error ? String(row.last_error) : null,
      lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
      provider: String(row.provider ?? "local-llm"),
      model: row.model ? String(row.model) : null,
      inputSnapshot: parseRecord(row.input_snapshot),
      activationResult: parseRecord(row.activation_result),
      knowledgeId: row.knowledge_id ? String(row.knowledge_id) : null,
      payload: parseRecord(row.payload),
      metadata: parseRecord(row.metadata),
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
      completedAt: row.completed_at ? new Date(String(row.completed_at)) : null,
    } as FinalizeJobRow;
  }
  const [job] = await db
    .select()
    .from(mergeActivationFinalizeQueue)
    .where(eq(mergeActivationFinalizeQueue.id, id))
    .limit(1);
  return job ?? null;
}

async function loadKnowledge(id: string | null): Promise<KnowledgeRow | null> {
  if (!id) return null;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query(
        "select id, body, status, applies_to, metadata from knowledge_items where id = ? limit 1",
      )
      .get(id) as Record<string, unknown> | null;
    return row
      ? {
          id: String(row.id),
          body: String(row.body),
          status: String(row.status),
          appliesTo: parseRecord(row.applies_to),
          metadata: parseRecord(row.metadata),
        }
      : null;
  }
  const [row] = await db
    .select({
      id: knowledgeItems.id,
      body: knowledgeItems.body,
      status: knowledgeItems.status,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .limit(1);
  return row ?? null;
}

async function updateFinalizeQueue(
  id: string,
  input: {
    status: "completed" | "skipped";
    attemptCount?: number;
    lastError: string | null;
    lastOutcomeKind: string;
    activationResult?: Record<string, unknown>;
    knowledgeId?: string;
  },
): Promise<void> {
  const now = new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `update merge_activation_finalize_queue
         set status = ?, attempt_count = coalesce(?, attempt_count), locked_by = null,
             locked_at = null, heartbeat_at = null, last_error = ?, last_outcome_kind = ?,
             activation_result = coalesce(?, activation_result), knowledge_id = coalesce(?, knowledge_id),
             completed_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(
        input.status,
        input.attemptCount ?? null,
        input.lastError,
        input.lastOutcomeKind,
        input.activationResult ? JSON.stringify(input.activationResult) : null,
        input.knowledgeId ?? null,
        now.toISOString(),
        now.toISOString(),
        id,
      );
    return;
  }
  await db
    .update(mergeActivationFinalizeQueue)
    .set({
      status: input.status,
      ...(input.attemptCount === undefined ? {} : { attemptCount: input.attemptCount }),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: input.lastError,
      lastOutcomeKind: input.lastOutcomeKind,
      ...(input.activationResult ? { activationResult: input.activationResult } : {}),
      ...(input.knowledgeId ? { knowledgeId: input.knowledgeId } : {}),
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(mergeActivationFinalizeQueue.id, id));
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

function unionAppliesTo(
  canonical: Record<string, unknown>,
  deadZone: Record<string, unknown>,
): {
  appliesTo: Record<string, unknown>;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
} {
  const technologies = [
    ...new Set([...stringArray(canonical.technologies), ...stringArray(deadZone.technologies)]),
  ];
  const changeTypes = [
    ...new Set([...stringArray(canonical.changeTypes), ...stringArray(deadZone.changeTypes)]),
  ];
  const domains = [
    ...new Set([...stringArray(canonical.domains), ...stringArray(deadZone.domains)]),
  ];
  const appliesTo: Record<string, unknown> = {
    ...canonical,
    ...(typeof canonical.general === "boolean"
      ? { general: canonical.general }
      : typeof deadZone.general === "boolean"
        ? { general: deadZone.general }
        : {}),
    ...(technologies.length ? { technologies } : {}),
    ...(changeTypes.length ? { changeTypes } : {}),
    ...(domains.length ? { domains } : {}),
  };
  if (typeof canonical.repoPath === "string") appliesTo.repoPath = canonical.repoPath;
  if (typeof canonical.repoKey === "string") appliesTo.repoKey = canonical.repoKey;
  return {
    appliesTo,
    ...(technologies.length ? { technologies } : {}),
    ...(changeTypes.length ? { changeTypes } : {}),
    ...(domains.length ? { domains } : {}),
  };
}

async function markSkipped(params: { id: string; outcome: string; reason: string }) {
  await updateFinalizeQueue(params.id, {
    status: "skipped",
    lastError: params.reason,
    lastOutcomeKind: params.outcome,
  });
  const curationLink = await findLandscapeCurationJobLinkByQueueJob({
    queueName: "mergeActivationFinalize",
    queueJobId: params.id,
    role: "merge_finalize",
  });
  if (curationLink) {
    await upsertLandscapeCurationJobLink({
      curationJobId: curationLink.curationJobId,
      role: "merge_finalize",
      queueName: "mergeActivationFinalize",
      queueJobId: params.id,
      status: "skipped",
      outcomeKind: params.outcome,
      metadata: curationLink.metadata,
      completedAt: new Date(),
    });
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "failed",
      phase: "awaiting_downstream",
      nextRunAt: null,
      lastError: params.reason,
      lastOutcomeKind: `downstream_${params.outcome}`,
      completedAt: null,
    });
  }
}

export async function processMergeActivationFinalizeJob(
  jobId: string,
  _signal?: AbortSignal,
): Promise<void> {
  const job = await loadFinalizeJob(jobId);
  if (!job) throw new Error(`merge activation finalize job not found: ${jobId}`);

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "claimed",
    message: "merge activation finalize claimed",
    metadata: { visibleQueueName: "finalizeDistille" },
  });

  const snapshot = asRecord(job.inputSnapshot) as MergeActivationSnapshot;
  const [deadZone, canonical] = await Promise.all([
    loadKnowledge(job.deadZoneKnowledgeId),
    loadKnowledge(job.canonicalKnowledgeId),
  ]);
  if (!deadZone || !canonical) {
    await markSkipped({ id: job.id, outcome: "stale_input", reason: "knowledge row missing" });
    return;
  }
  const curationLink = await findLandscapeCurationJobLinkByQueueJob({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    role: "merge_finalize",
  });
  const queueMetadata = asRecord(job.metadata);
  const autonomousExactDuplicate =
    (queueMetadata.autonomous === true && queueMetadata.exactDuplicate === true) ||
    (curationLink?.metadata.autonomous === true && curationLink.metadata.exactDuplicate === true);
  const priorDeprecation = asRecord(asRecord(deadZone.metadata).deprecation);
  const alreadyApplied =
    autonomousExactDuplicate &&
    deadZone.status === "deprecated" &&
    priorDeprecation.finalizeJobId === job.id &&
    priorDeprecation.mergedIntoKnowledgeId === canonical.id &&
    canonical.status === "active";
  if (alreadyApplied) {
    await updateFinalizeQueue(job.id, {
      status: "completed",
      attemptCount: job.attemptCount + 1,
      lastError: null,
      lastOutcomeKind: "duplicate_deprecated",
      activationResult: {
        outcome: "duplicate_deprecated",
        confidence: "high",
        rationale: ["Recovered an already-applied autonomous duplicate deprecation."],
        blockers: [],
        persistedAppliesTo: canonical.appliesTo,
      },
      knowledgeId: canonical.id,
    });
    if (curationLink) {
      await upsertLandscapeCurationJobLink({
        curationJobId: curationLink.curationJobId,
        role: "merge_finalize",
        queueName: "mergeActivationFinalize",
        queueJobId: job.id,
        status: "completed",
        outcomeKind: "duplicate_deprecated",
        metadata: curationLink.metadata,
        completedAt: new Date(),
      });
      await updateLandscapeCurationJob(curationLink.curationJobId, {
        status: "completed",
        phase: "postcheck",
        nextRunAt: null,
        lastError: null,
        lastOutcomeKind: "downstream_completed",
        completedAt: new Date(),
      });
    }
    return;
  }
  const appliesToChanged =
    (snapshot.deadZone?.appliesTo !== undefined &&
      hashRecord(snapshot.deadZone.appliesTo) !== hashRecord(asRecord(deadZone.appliesTo))) ||
    (snapshot.canonical?.appliesTo !== undefined &&
      hashRecord(snapshot.canonical.appliesTo) !== hashRecord(asRecord(canonical.appliesTo)));
  if (
    snapshot.deadZone?.bodyHash !== hashBody(deadZone.body) ||
    snapshot.canonical?.bodyHash !== hashBody(canonical.body) ||
    appliesToChanged ||
    deadZone.status === "deprecated" ||
    canonical.status !== "active"
  ) {
    await markSkipped({
      id: job.id,
      outcome: "stale_input",
      reason: "knowledge body/status/applicability changed before finalize",
    });
    return;
  }

  const proposedBody = snapshot.mergeReviewJob?.proposedCanonicalBody?.trim();
  if (!proposedBody) {
    await markSkipped({
      id: job.id,
      outcome: "activation_blocked",
      reason: "merge review did not provide a canonical body",
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const union = unionAppliesTo(asRecord(canonical.appliesTo), asRecord(deadZone.appliesTo));
  const activationMetadata = {
    finalizeJobId: job.id,
    mergeReviewJobId: job.mergeReviewJobId,
    activationOutcome: "scope_refined",
    appliedAt: nowIso,
    mergedDeadZoneKnowledgeId: deadZone.id,
    appliesToSource: "deterministic_union",
    appliesToWarnings: [],
    proposedAppliesTo: null,
  };

  if (
    autonomousExactDuplicate &&
    (hashBody(deadZone.body) !== hashBody(canonical.body) ||
      hashRecord(asRecord(deadZone.appliesTo)) !== hashRecord(asRecord(canonical.appliesTo)) ||
      hashBody(proposedBody) !== hashBody(canonical.body))
  ) {
    await markSkipped({
      id: job.id,
      outcome: "activation_blocked",
      reason: "autonomous finalization is restricted to unchanged exact duplicates",
    });
    return;
  }

  if (!autonomousExactDuplicate) {
    const updatedCanonical = await updateKnowledgeItem(canonical.id, {
      body: proposedBody,
      appliesTo: union.appliesTo,
      technologies: union.technologies,
      changeTypes: union.changeTypes,
      domains: union.domains,
      metadata: {
        deadZoneMergeActivation: activationMetadata,
      },
    });
    if (!updatedCanonical) {
      throw new Error(`canonical knowledge update failed: ${canonical.id}`);
    }
  }

  const updatedDeadZone = await updateKnowledgeItem(deadZone.id, {
    status: "deprecated",
    metadata: {
      deprecation: {
        reason: "merged",
        mergedIntoKnowledgeId: canonical.id,
        mergeReviewJobId: job.mergeReviewJobId,
        finalizeJobId: job.id,
        deprecatedAt: nowIso,
      },
    },
  });
  if (!updatedDeadZone) {
    throw new Error(`dead-zone knowledge deprecation failed: ${deadZone.id}`);
  }

  await updateFinalizeQueue(job.id, {
    status: "completed",
    attemptCount: job.attemptCount + 1,
    lastError: null,
    lastOutcomeKind: autonomousExactDuplicate ? "duplicate_deprecated" : "scope_refined",
    activationResult: {
      outcome: autonomousExactDuplicate ? "duplicate_deprecated" : "scope_refined",
      confidence: autonomousExactDuplicate ? "high" : "medium",
      rationale: [
        autonomousExactDuplicate
          ? "Deprecated an exact duplicate without changing the canonical knowledge."
          : "Applied merge review body with deterministic appliesTo union.",
      ],
      blockers: [],
      persistedAppliesTo: union.appliesTo,
    },
    knowledgeId: canonical.id,
  });

  if (curationLink) {
    await upsertLandscapeCurationJobLink({
      curationJobId: curationLink.curationJobId,
      role: "merge_finalize",
      queueName: "mergeActivationFinalize",
      queueJobId: job.id,
      status: "completed",
      outcomeKind: autonomousExactDuplicate ? "duplicate_deprecated" : "scope_refined",
      metadata: curationLink.metadata,
      completedAt: new Date(),
    });
    await updateLandscapeCurationJob(curationLink.curationJobId, {
      status: "completed",
      phase: "postcheck",
      nextRunAt: null,
      lastError: null,
      lastOutcomeKind: "downstream_completed",
      completedAt: new Date(),
    });
  }

  await appendQueueEvent({
    queueName: "mergeActivationFinalize",
    queueJobId: job.id,
    eventType: "completed",
    message: "merge activation finalize completed",
    metadata: {
      visibleQueueName: "finalizeDistille",
      activationOutcome: autonomousExactDuplicate ? "duplicate_deprecated" : "scope_refined",
      knowledgeId: canonical.id,
    },
  });
}
