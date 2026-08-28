import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import {
  type LandscapeCurationFindingType,
  type LandscapeCurationInputSnapshotV1,
  type LandscapeCurationResultV1,
  landscapeCurationInputSnapshotSchema,
  landscapeCurationResultSchema,
} from "../../shared/schemas/landscape-curation.schema.js";
import {
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationMessage } from "../distillation/types.js";
import { appendQueueEvent } from "../queue/core/events.js";
import { resolveLandscapeCurationRoute } from "../settings/settings.service.js";
import {
  createDeadZoneMergeReviewJob,
  reconcileLandscapeCurationMergeReviewJob,
} from "./deadzone-merge-review-queue.service.js";
import { evaluateLandscapeCurationPolicy } from "./landscape-curation-policy.js";
import {
  countLandscapeCurationDailyDownstreamUsage,
  enqueueLandscapeCurationJob,
  getLandscapeCurationJob,
  listLandscapeCurationJobs,
  updateLandscapeCurationJob,
  upsertLandscapeCurationJobLink,
} from "./landscape-curation-queue.repository.js";
import { getLandscapeReviewItem } from "./landscape-review-items.service.js";

export class LandscapeCurationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "LandscapeCurationError";
  }
}

const AUTONOMOUS_DOWNSTREAM_DAILY_LIMIT = 5;
const AUTONOMOUS_DOWNSTREAM_REPOSITORY_DAILY_LIMIT = 2;
const DOWNSTREAM_POLL_INTERVAL_MS = 30_000;
const DOWNSTREAM_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
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

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function loadKnowledgeForCuration(
  ids: string[],
): Promise<Array<typeof knowledgeItems.$inferSelect>> {
  if (resolveDatabaseBackendConfig().kind !== "sqlite")
    return db.select().from(knowledgeItems).where(inArray(knowledgeItems.id, ids));
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const rows = sqlite.db
    .query(`select * from knowledge_items where id in (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Record<string, unknown>[];
  return rows.map(
    (row) =>
      ({
        id: String(row.id),
        title: String(row.title),
        body: String(row.body),
        type: String(row.type),
        polarity: String(row.polarity),
        scope: String(row.scope),
        classificationStatus: String(row.classification_status),
        status: String(row.status),
        appliesTo: parseRecord(row.applies_to),
        confidence: Number(row.confidence),
        importance: Number(row.importance),
        projectRef: row.project_ref ? String(row.project_ref) : null,
        repoKey: row.repo_key ? String(row.repo_key) : null,
        repoPath: row.repo_path ? String(row.repo_path) : null,
        createdAt: new Date(String(row.created_at)),
        updatedAt: new Date(String(row.updated_at)),
        lastVerifiedAt: row.last_verified_at ? new Date(String(row.last_verified_at)) : null,
      }) as typeof knowledgeItems.$inferSelect,
  );
}

export async function enqueueLandscapeCurationForReview(params: {
  reviewItemId: string;
  candidateKnowledgeIds?: string[];
}): Promise<string> {
  const review = await getLandscapeReviewItem(params.reviewItemId);
  if (!review) throw new LandscapeCurationError("review item not found", 404);
  if (!review.knowledgeId)
    throw new LandscapeCurationError("review item with knowledge is required", 400);
  const candidateIds = [
    ...new Set(
      params.candidateKnowledgeIds ??
        (Array.isArray(review.payload.candidateKnowledgeIds)
          ? review.payload.candidateKnowledgeIds.filter(
              (id): id is string => typeof id === "string",
            )
          : []),
    ),
  ]
    .filter((id) => id !== review.knowledgeId)
    .slice(0, 5);
  const rows = await loadKnowledgeForCuration([review.knowledgeId, ...candidateIds]);
  const subject = rows.find((row) => row.id === review.knowledgeId);
  if (!subject) throw new LandscapeCurationError("subject knowledge not found", 404);
  const loadedCandidateIds = rows
    .filter((row) => row.id !== subject.id)
    .map((row) => row.id)
    .slice(0, 5);
  const snap = (row: typeof knowledgeItems.$inferSelect, similarity?: number) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    bodyHash: hash(row.body),
    appliesToHash: hash(row.appliesTo),
    status: row.status,
    type: row.type,
    polarity: row.polarity,
    scope: row.scope,
    classificationStatus: row.classificationStatus,
    projectRef: row.projectRef ?? null,
    repoKey: row.repoKey ?? null,
    repoPath: row.repoPath ?? null,
    appliesTo: record(row.appliesTo),
    confidence: row.confidence,
    importance: row.importance,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    similarity: similarity ?? null,
    scopeOverlap: null,
  });
  const findingType: LandscapeCurationFindingType =
    review.reason === "duplicate_candidate" || review.reason === "semantic_merge"
      ? "duplicate_candidate"
      : review.reason.includes("dead_zone")
        ? "reachability_gap"
        : review.reason === "contradiction_review"
          ? "contradiction_candidate"
          : "applicability_issue";
  const evidenceHash = hash({
    reviewId: review.id,
    evidence: review.evidence,
    payload: review.payload,
  });
  const input = {
    schemaVersion: 1 as const,
    capturedAt: new Date().toISOString(),
    finding: { type: findingType, reviewItemId: review.id, evidenceHash },
    subject: snap(subject),
    candidates: rows.filter((row) => loadedCandidateIds.includes(row.id)).map((row) => snap(row)),
    evidence: review.evidence.slice(0, 100).map((value, index) => ({
      id: `review:${review.id}:${index}`,
      kind: "review_evidence",
      knowledgeId: review.knowledgeId,
      value,
      observedAt: review.updatedAt,
      source: "landscape_review_item",
    })),
    usage: {},
    lineage: {},
    reviewItem: review as unknown as Record<string, unknown>,
    capabilities: { directDeprecation: false, mode: "autonomous_policy" },
    versions: {
      detector: "curation-detector-v1",
      policy: "curation-policy-v1",
      prompt: "landscape-curation-v1",
    },
  };
  const route = resolveLandscapeCurationRoute();
  const job = await enqueueLandscapeCurationJob({
    reviewItemId: review.id,
    findingType,
    subjectKnowledgeId: subject.id,
    candidateKnowledgeIds: loadedCandidateIds,
    repositoryIdentity: {
      key: subject.repoKey ?? null,
      path: subject.repoPath ?? null,
      projectRef: subject.projectRef ?? null,
    },
    fingerprint: hash({
      findingType,
      subject: subject.id,
      candidates: loadedCandidateIds.sort(),
      evidenceHash,
    }),
    idempotencyKey: `landscape-curation:${review.id}:${evidenceHash}`,
    evidenceHash,
    priority: review.priority,
    provider: route.provider === "auto" ? "local-llm" : route.provider,
    model: route.model ?? null,
    inputSnapshot: input,
  });
  await appendQueueEvent({
    queueName: "landscapeCuration",
    queueJobId: job.id,
    eventType: "enqueued",
    message: "curation finding queued",
    metadata: { reviewItemId: review.id, findingType },
  });
  return job.id;
}

export { getLandscapeCurationJob, listLandscapeCurationJobs };

function extractJsonObject(value: string): unknown {
  const source = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new LandscapeCurationError("curation response did not contain JSON");
  return JSON.parse(source.slice(start, end + 1));
}

function excerpt(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}

export { evaluateLandscapeCurationPolicy };

async function reconcileOrScheduleLandscapeCurationDownstream(params: {
  jobId: string;
  mergeReviewJobId: string;
  createdAt: string;
}): Promise<void> {
  if (Date.now() - new Date(params.createdAt).getTime() >= DOWNSTREAM_TIMEOUT_MS) {
    await updateLandscapeCurationJob(params.jobId, {
      status: "failed",
      phase: "awaiting_downstream",
      nextRunAt: null,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: "downstream processing exceeded 24 hours",
      lastOutcomeKind: "downstream_timeout",
      completedAt: new Date(),
    });
    await appendQueueEvent({
      queueName: "landscapeCuration",
      queueJobId: params.jobId,
      eventType: "failed",
      message: "curation downstream processing timed out",
      metadata: { mergeReviewJobId: params.mergeReviewJobId },
    });
    return;
  }

  await reconcileLandscapeCurationMergeReviewJob(params.mergeReviewJobId);
  const reconciled = await getLandscapeCurationJob(params.jobId);
  if (!reconciled) throw new LandscapeCurationError("curation job disappeared during reconcile");
  if (reconciled.status === "failed" || reconciled.phase !== "awaiting_downstream") {
    await updateLandscapeCurationJob(params.jobId, {
      nextRunAt: null,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
    });
    return;
  }
  await updateLandscapeCurationJob(params.jobId, {
    status: "paused",
    phase: "awaiting_downstream",
    nextRunAt: new Date(Date.now() + DOWNSTREAM_POLL_INTERVAL_MS),
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    lastError: null,
    lastOutcomeKind: "downstream_waiting",
    completedAt: null,
  });
}

function validateResultReferences(
  input: LandscapeCurationInputSnapshotV1,
  result: LandscapeCurationResultV1,
): void {
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
  if (result.canonicalKnowledgeId && !candidateIds.has(result.canonicalKnowledgeId)) {
    throw new LandscapeCurationError("curation result referenced an unknown canonical knowledge");
  }
  const evidenceIds = new Set(input.evidence.map((evidence) => evidence.id));
  if (result.supportingEvidenceIds.some((id) => !evidenceIds.has(id))) {
    throw new LandscapeCurationError("curation result referenced unknown supporting evidence");
  }
}

async function isInputSnapshotStale(input: LandscapeCurationInputSnapshotV1): Promise<boolean> {
  const snapshots = [input.subject, ...input.candidates];
  const rows = await loadKnowledgeForCuration(snapshots.map((snapshot) => snapshot.id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return snapshots.some((snapshot) => {
    const row = rowsById.get(snapshot.id);
    return (
      !row ||
      row.status !== snapshot.status ||
      hash(row.body) !== snapshot.bodyHash ||
      hash(row.appliesTo) !== snapshot.appliesToHash ||
      row.scope !== snapshot.scope ||
      row.repoKey !== snapshot.repoKey ||
      row.repoPath !== snapshot.repoPath ||
      row.projectRef !== snapshot.projectRef
    );
  });
}

export async function runLandscapeCurationLlm(params: {
  inputSnapshot: LandscapeCurationInputSnapshotV1;
  signal?: AbortSignal;
}): Promise<LandscapeCurationResultV1> {
  const route = resolveLandscapeCurationRoute();
  const providerSetting = route.provider === "auto" ? "local-llm" : route.provider;
  const model = resolveRouteModelForProvider({
    provider: providerSetting,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  const messages: DistillationMessage[] = [
    {
      role: "user",
      content: JSON.stringify({
        task: "landscape_curation",
        instruction:
          "Assess the supplied finding conservatively. Never recommend direct deletion. Return JSON only.",
        requiredJsonShape: {
          schemaVersion: 1,
          decision:
            "merge_review | deprecate_duplicate | repair_scope | keep_separate | needs_evidence | observe | escalate",
          confidence: "low | medium | high",
          canonicalKnowledgeId: "id or null",
          rationale: ["reason"],
          supportingEvidenceIds: ["id"],
          counterEvidence: [],
          blockers: [],
          proposedAppliesTo: "object or null",
          proposedSummary: "string or null",
        },
        input: params.inputSnapshot,
      }),
    },
  ];
  const completion = await runDistillationCompletion(
    { model, messages, maxTokens: 2200 },
    {
      providerSetting,
      fallbackOrder: route.fallback,
      azureDeploymentSlots: route.azureDeploymentSlots,
      localLlmModel: route.localLlmModel,
      enableTools: false,
      maxToolRounds: 0,
      usageSource: "landscape-curation",
      timeoutMs: 90_000,
      signal: params.signal,
    },
  );
  const parsed = landscapeCurationResultSchema.safeParse(extractJsonObject(completion.content));
  if (!parsed.success) throw new LandscapeCurationError(parsed.error.message);
  validateResultReferences(params.inputSnapshot, parsed.data);
  return { ...parsed.data, rawOutputExcerpt: excerpt(completion.content), parseStatus: "parsed" };
}

export async function processLandscapeCurationJob(id: string, signal?: AbortSignal): Promise<void> {
  const job = await getLandscapeCurationJob(id);
  if (!job) throw new LandscapeCurationError("curation job not found", 404);
  const parsedInput = landscapeCurationInputSnapshotSchema.safeParse(job.inputSnapshot);
  if (!parsedInput.success) {
    throw new LandscapeCurationError(`invalid curation snapshot: ${parsedInput.error.message}`);
  }
  const input = parsedInput.data;
  if (job.phase === "awaiting_downstream") {
    const mergeReviewLink = job.links.find((link) => link.role === "merge_review");
    if (!mergeReviewLink) {
      throw new LandscapeCurationError("curation job is awaiting an unlinked downstream job");
    }
    await reconcileOrScheduleLandscapeCurationDownstream({
      jobId: id,
      mergeReviewJobId: mergeReviewLink.queueJobId,
      createdAt: job.createdAt,
    });
    return;
  }

  const persistedResult = landscapeCurationResultSchema.safeParse(job.result);
  const canResumePolicy = job.phase === "policy" && persistedResult.success;
  const result = canResumePolicy
    ? persistedResult.data
    : await (async () => {
        await updateLandscapeCurationJob(id, { phase: "llm_review" });
        return runLandscapeCurationLlm({ inputSnapshot: input, signal });
      })();
  validateResultReferences(input, result);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const repositoryIdentity =
    typeof job.repositoryIdentity.key === "string"
      ? job.repositoryIdentity.key
      : typeof job.repositoryIdentity.path === "string"
        ? job.repositoryIdentity.path
        : typeof job.repositoryIdentity.projectRef === "string"
          ? job.repositoryIdentity.projectRef
          : null;
  const [dailyUsage, repositoryUsage] = await Promise.all([
    countLandscapeCurationDailyDownstreamUsage({ since: dayStart }),
    repositoryIdentity
      ? countLandscapeCurationDailyDownstreamUsage({
          since: dayStart,
          repositoryIdentity,
        })
      : Promise.resolve(0),
  ]);
  const policyResult = evaluateLandscapeCurationPolicy({
    result,
    inputSnapshot: input,
    staleInput: await isInputSnapshotStale(input),
    dailyRemaining: Math.max(0, AUTONOMOUS_DOWNSTREAM_DAILY_LIMIT - dailyUsage),
    repoRemaining: repositoryIdentity
      ? Math.max(0, AUTONOMOUS_DOWNSTREAM_REPOSITORY_DAILY_LIMIT - repositoryUsage)
      : AUTONOMOUS_DOWNSTREAM_DAILY_LIMIT,
  });
  await updateLandscapeCurationJob(id, {
    phase: "policy",
    decision: result.decision,
    disposition: policyResult.disposition,
    result,
    policyResult,
  });
  await appendQueueEvent({
    queueName: "landscapeCuration",
    queueJobId: id,
    eventType: "policy_decided",
    message: "curation policy decided",
    metadata: {
      decision: result.decision,
      disposition: policyResult.disposition,
      reasonCodes: policyResult.reasonCodes,
      releaseMode: policyResult.releaseMode,
      policyVersion: policyResult.policyVersion,
      resumedFromPolicy: canResumePolicy,
      inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    },
  });
  if (policyResult.disposition === "enqueue_downstream") {
    if (!result.canonicalKnowledgeId)
      throw new LandscapeCurationError("policy delegated without canonical knowledge");
    const downstream = await createDeadZoneMergeReviewJob({
      reviewItemId: job.reviewItemId ?? undefined,
      deadZoneKnowledgeId: job.subjectKnowledgeId,
      canonicalKnowledgeId: result.canonicalKnowledgeId,
      note: `Automatically delegated by LANDSCAPE Curation ${id}`,
    });
    await upsertLandscapeCurationJobLink({
      curationJobId: id,
      role: "merge_review",
      queueName: "deadZoneMergeReview",
      queueJobId: downstream.id,
      status: downstream.status,
      metadata: { autonomous: true },
    });
    await appendQueueEvent({
      queueName: "landscapeCuration",
      queueJobId: id,
      eventType: "downstream_linked",
      message: "curation decision delegated to merge review",
      metadata: { downstreamQueue: "deadZoneMergeReview", downstreamJobId: downstream.id },
    });
    await updateLandscapeCurationJob(id, {
      status: "running",
      phase: "awaiting_downstream",
      decision: result.decision,
      disposition: policyResult.disposition,
      result,
      policyResult,
      attemptCount: job.attemptCount + 1,
      nextRunAt: null,
      lastError: null,
      lastOutcomeKind: "delegated_downstream",
      completedAt: null,
    });
    await reconcileOrScheduleLandscapeCurationDownstream({
      jobId: id,
      mergeReviewJobId: downstream.id,
      createdAt: job.createdAt,
    });
    return;
  }
  const terminalStatus =
    policyResult.disposition === "blocked" || policyResult.disposition === "await_evidence"
      ? "skipped"
      : "completed";
  await updateLandscapeCurationJob(id, {
    status: terminalStatus,
    phase: "policy",
    decision: result.decision,
    disposition: policyResult.disposition,
    result,
    policyResult,
    attemptCount: job.attemptCount + 1,
    nextRunAt: null,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    completedAt: new Date(),
    lastOutcomeKind:
      policyResult.disposition === "record_only" ? "autonomous_recorded" : policyResult.disposition,
  });
}
