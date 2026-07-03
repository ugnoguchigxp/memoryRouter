import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { APP_CONSTANTS } from "../../../constants.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { db } from "../../../db/index.js";
import {
  coveringEvidenceQueue,
  evidenceCoverageResults,
  finalizeDistilleQueue,
  findingCandidateQueue,
  foundCandidates,
  mergeActivationFinalizeQueue,
  vibeMemories,
} from "../../../db/schema.js";
import { asRecord } from "../../../shared/utils/normalize.js";
import { type CoverEvidenceRunInput, runCoverEvidence } from "../../coverEvidence/domain.js";
import type { CoverEvidenceResult } from "../../coverEvidence/types.js";
import {
  failEpisodeDistillerJob,
  processEpisodeDistillerJob,
} from "../../episodeDistiller/worker.js";
import { type FinalizeDistilleInput, runFinalizeDistille } from "../../finalizeDistille/domain.js";
import {
  codexFindingEscalationGeneratedBy,
  isVibeMemorySelfIngestionBlocked,
  markFindingCodexEscalationAccepted,
  maybeRunFindingCodexEscalation,
} from "../../findCandidate/codex-escalation.service.js";
import { type FindCandidateResult, runFindCandidate } from "../../findCandidate/domain.js";
import {
  type KnowledgeApplicability,
  applicabilityFromCoverCandidate,
  applicabilityToCoverCandidateFields,
  normalizeApplicability,
} from "../../knowledge/applicability.js";
import { processDeadZoneMergeReviewJob } from "../../landscape/deadzone-merge-review-queue.service.js";
import { processMergeActivationFinalizeJob } from "../../landscape/merge-activation-finalize.worker.js";
import { LlmProviderHttpError } from "../../llm/provider-http-error.js";
import { runWithProviderLeaseRouteContext } from "../../settings/provider-lease-route-context.js";
import { getRuntimeSettingsSnapshot } from "../../settings/settings.service.js";
import type { RuntimeProviderPoolTarget } from "../../settings/settings.types.js";
import { researchWebSourceToMarkdown } from "../../sources/web/source-research.service.js";
import { claimNextQueueJob } from "./claim.js";
import { isQueuePaused } from "./control.js";
import { appendQueueEvent } from "./events.js";
import {
  type ProviderLease,
  heartbeatProviderLease,
  releaseProviderLease,
} from "./provider-lease.js";
import {
  keepQueueJobWaitingForProvider,
  keepQueueJobWaitingForWorker,
  pauseQueueJob,
} from "./state.js";
import { type DistillationQueueName, queueTableNameByQueue } from "./types.js";

type QueueRunResult = {
  ok: boolean;
  queue: DistillationQueueName;
  worker: string;
  idle: boolean;
  claimedJobId: string | null;
  message: string;
  completedJobId?: string;
};

type FindingSourceKind = "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";

type ProvidedCandidatePayload = {
  title: string;
  body: string;
  type?: "rule" | "procedure";
  polarity?: "positive" | "negative";
  intentTags?: string[];
  applicability?: KnowledgeApplicability;
  origin?: Record<string, unknown>;
};

type QueueWorkerTestHooks = {
  runCoverEvidence?: (input: CoverEvidenceRunInput) => ReturnType<typeof runCoverEvidence>;
  runFinalizeDistille?: (input: FinalizeDistilleInput) => ReturnType<typeof runFinalizeDistille>;
};

let queueWorkerTestHooks: QueueWorkerTestHooks = {};

export function setQueueWorkerTestHooksForTests(hooks: QueueWorkerTestHooks): void {
  queueWorkerTestHooks = hooks;
}

const retryableCoverStatuses = new Set<CoverEvidenceResult["status"]>([
  "reprocess_requested",
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

function coveringRetryBackoffMs(attemptCount: number): number {
  const retryIndex = Math.max(0, attemptCount - 1);
  return Math.min(5 * 60_000, 30_000 * 2 ** retryIndex);
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
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

function providerPoolTargetId(target: RuntimeProviderPoolTarget): string {
  if (target.provider === "local-llm") return target.localLlmModelId;
  if (target.provider === "azure-openai") return String(target.deploymentSlot);
  return target.targetId;
}

function inferProviderPoolTarget(targetId: string): RuntimeProviderPoolTarget | null {
  if (/^\d+$/.test(targetId)) {
    return { provider: "azure-openai", deploymentSlot: Number(targetId) };
  }
  if (targetId === "openai" || targetId === "bedrock" || targetId === "codex") {
    return { provider: targetId, targetId };
  }
  return { provider: "local-llm", localLlmModelId: targetId };
}

function providerLeaseTargetEventMetadata(
  lease: ProviderLease | undefined,
): Record<string, unknown> {
  if (!lease) return {};
  const resolved: Record<string, unknown> = {
    providerPoolId: lease.poolId,
    providerTargetId: lease.targetId,
  };

  try {
    const settings = getRuntimeSettingsSnapshot();
    const pool = settings.providerPools.find((item) => item.id === lease.poolId);
    const target =
      pool?.targets.find((item) => providerPoolTargetId(item) === lease.targetId) ??
      inferProviderPoolTarget(lease.targetId);
    if (!target) return { resolvedProviderTarget: resolved };

    resolved.provider = target.provider;
    if (target.provider === "local-llm") {
      const model = settings.providers["local-llm"].models.find(
        (item) => item.id === target.localLlmModelId,
      );
      resolved.localLlmModelId = target.localLlmModelId;
      resolved.label = model?.name.trim() || model?.model.trim() || target.localLlmModelId;
      if (model?.model.trim()) resolved.model = model.model.trim();
      if (model?.apiBaseUrl.trim()) resolved.endpoint = model.apiBaseUrl.trim();
    } else if (target.provider === "azure-openai") {
      const deployment = settings.providers["azure-openai"].deployments[target.deploymentSlot - 1];
      resolved.deploymentSlot = target.deploymentSlot;
      resolved.label =
        deployment?.name.trim() ||
        deployment?.model.trim() ||
        `Azure deployment ${target.deploymentSlot}`;
      if (deployment?.model.trim()) resolved.model = deployment.model.trim();
      if (deployment?.apiBaseUrl.trim()) resolved.endpoint = deployment.apiBaseUrl.trim();
    } else {
      const provider = settings.providers[target.provider];
      resolved.label = target.provider;
      if ("model" in provider && provider.model.trim()) resolved.model = provider.model.trim();
      if ("apiBaseUrl" in provider && provider.apiBaseUrl.trim()) {
        resolved.endpoint = provider.apiBaseUrl.trim();
      }
    }
  } catch {
    // Keep the lease identity even if runtime settings are not loaded.
  }

  return { resolvedProviderTarget: resolved };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sqliteDate(value: unknown): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  const unixMillis = trimmed.startsWith("unix-ms:")
    ? Number(trimmed.slice("unix-ms:".length))
    : Number.NaN;
  if (Number.isFinite(unixMillis)) {
    const date = new Date(unixMillis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sqliteRequiredDate(value: unknown): Date {
  return sqliteDate(value) ?? new Date(0);
}

function sqliteFindingJobRow(
  row: Record<string, unknown>,
): typeof findingCandidateQueue.$inferSelect {
  return {
    id: String(row.id),
    inputKind: String(row.input_kind),
    sourceKind: String(row.source_kind),
    sourceKey: String(row.source_key),
    sourceUri: String(row.source_uri),
    distillationVersion: String(row.distillation_version),
    payload: parseJsonRecord(row.payload),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    nextRunAt: sqliteDate(row.next_run_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: sqliteDate(row.locked_at),
    heartbeatAt: sqliteDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteRequiredDate(row.created_at),
    updatedAt: sqliteRequiredDate(row.updated_at),
    completedAt: sqliteDate(row.completed_at),
  };
}

function sqliteFoundCandidateRow(
  row: Record<string, unknown>,
): typeof foundCandidates.$inferSelect {
  return {
    id: String(row.id),
    findingJobId: String(row.finding_job_id),
    candidateIndex: Number(row.candidate_index ?? 0),
    type: row.type ? String(row.type) : null,
    title: String(row.title),
    content: String(row.content),
    sourceSummary: row.source_summary ? String(row.source_summary) : null,
    origin: parseJsonRecord(row.origin),
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteRequiredDate(row.created_at),
    updatedAt: sqliteRequiredDate(row.updated_at),
  };
}

function sqliteCoveringJobRow(
  row: Record<string, unknown>,
): typeof coveringEvidenceQueue.$inferSelect {
  return {
    id: String(row.id),
    foundCandidateId: String(row.found_candidate_id),
    distillationVersion: String(row.distillation_version),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 2),
    providerPolicy: row.provider_policy ? String(row.provider_policy) : "default",
    nextRunAt: sqliteDate(row.next_run_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: sqliteDate(row.locked_at),
    heartbeatAt: sqliteDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    payload: parseJsonRecord(row.payload),
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteRequiredDate(row.created_at),
    updatedAt: sqliteRequiredDate(row.updated_at),
    completedAt: sqliteDate(row.completed_at),
  };
}

function sqliteEvidenceCoverageRow(
  row: Record<string, unknown>,
): typeof evidenceCoverageResults.$inferSelect {
  return {
    id: String(row.id),
    foundCandidateId: String(row.found_candidate_id),
    producerQueue: String(row.producer_queue),
    producerJobId: String(row.producer_job_id),
    distillationVersion: String(row.distillation_version),
    status: String(row.status),
    stage: String(row.stage),
    type: row.type ? String(row.type) : null,
    title: row.title ? String(row.title) : null,
    body: row.body ? String(row.body) : null,
    importance:
      row.importance === null || row.importance === undefined ? null : Number(row.importance),
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    appliesTo: parseJsonRecord(row.applies_to),
    references: parseJsonArray(row.references),
    duplicateRefs: parseJsonArray(row.duplicate_refs),
    toolEvents: parseJsonArray(row.tool_events),
    reason: row.reason ? String(row.reason) : null,
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteRequiredDate(row.created_at),
    updatedAt: sqliteRequiredDate(row.updated_at),
  };
}

function sqliteFinalizeJobRow(
  row: Record<string, unknown>,
): typeof finalizeDistilleQueue.$inferSelect {
  return {
    id: String(row.id),
    evidenceResultId: String(row.evidence_result_id),
    distillationVersion: String(row.distillation_version),
    status: String(row.status),
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    providerPolicy: row.provider_policy ? String(row.provider_policy) : "default",
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: sqliteDate(row.locked_at),
    heartbeatAt: sqliteDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    knowledgeId: row.knowledge_id ? String(row.knowledge_id) : null,
    metadata: parseJsonRecord(row.metadata),
    createdAt: sqliteRequiredDate(row.created_at),
    updatedAt: sqliteRequiredDate(row.updated_at),
    completedAt: sqliteDate(row.completed_at),
  };
}

async function sqliteGetRow(
  tableName: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.db.query(`select * from ${tableName} where id = ? limit 1`).get(id) as Record<
    string,
    unknown
  > | null;
}

async function getFindingJobById(
  jobId: string,
): Promise<typeof findingCandidateQueue.$inferSelect | null> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("finding_candidate_queue", jobId);
    return row ? sqliteFindingJobRow(row) : null;
  }
  const [job] = await db
    .select()
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, jobId))
    .limit(1);
  return job ?? null;
}

async function getFoundCandidateById(
  candidateId: string,
): Promise<typeof foundCandidates.$inferSelect | null> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("found_candidates", candidateId);
    return row ? sqliteFoundCandidateRow(row) : null;
  }
  const [candidate] = await db
    .select()
    .from(foundCandidates)
    .where(eq(foundCandidates.id, candidateId))
    .limit(1);
  return candidate ?? null;
}

async function getCoveringJobById(
  jobId: string,
): Promise<typeof coveringEvidenceQueue.$inferSelect | null> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("covering_evidence_queue", jobId);
    return row ? sqliteCoveringJobRow(row) : null;
  }
  const [job] = await db
    .select()
    .from(coveringEvidenceQueue)
    .where(eq(coveringEvidenceQueue.id, jobId))
    .limit(1);
  return job ?? null;
}

async function getEvidenceCoverageById(
  evidenceId: string,
): Promise<typeof evidenceCoverageResults.$inferSelect | null> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("evidence_coverage_results", evidenceId);
    return row ? sqliteEvidenceCoverageRow(row) : null;
  }
  const [evidence] = await db
    .select()
    .from(evidenceCoverageResults)
    .where(eq(evidenceCoverageResults.id, evidenceId))
    .limit(1);
  return evidence ?? null;
}

async function getFinalizeJobById(
  jobId: string,
): Promise<typeof finalizeDistilleQueue.$inferSelect | null> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("finalize_distille_queue", jobId);
    return row ? sqliteFinalizeJobRow(row) : null;
  }
  const [job] = await db
    .select()
    .from(finalizeDistilleQueue)
    .where(eq(finalizeDistilleQueue.id, jobId))
    .limit(1);
  return job ?? null;
}

async function markMergeActivationFinalizeFailed(params: {
  jobId: string;
  attemptCount: number;
  error: string;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update merge_activation_finalize_queue
        set status = 'failed',
            attempt_count = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = 'failed',
            updated_at = ?
        where id = ?
      `,
      )
      .run(params.attemptCount, params.error, new Date().toISOString(), params.jobId);
    return;
  }
  await db
    .update(mergeActivationFinalizeQueue)
    .set({
      status: "failed",
      attemptCount: params.attemptCount,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.error,
      lastOutcomeKind: "failed",
      updatedAt: new Date(),
    })
    .where(eq(mergeActivationFinalizeQueue.id, params.jobId));
}

async function getMergeActivationFinalizeAttemptCount(jobId: string): Promise<number> {
  if (isSqliteBackend()) {
    const row = await sqliteGetRow("merge_activation_finalize_queue", jobId);
    return Number(row?.attempt_count ?? 0);
  }
  const [current] = await db
    .select()
    .from(mergeActivationFinalizeQueue)
    .where(eq(mergeActivationFinalizeQueue.id, jobId))
    .limit(1);
  return current?.attemptCount ?? 0;
}

async function markFinalizeFailed(params: {
  jobId: string;
  attemptCount: number;
  error: string;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update finalize_distille_queue
        set status = 'failed',
            attempt_count = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = 'failed',
            updated_at = ?
        where id = ?
      `,
      )
      .run(params.attemptCount, params.error, new Date().toISOString(), params.jobId);
    return;
  }
  await db
    .update(finalizeDistilleQueue)
    .set({
      status: "failed",
      attemptCount: params.attemptCount,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.error,
      lastOutcomeKind: "failed",
      updatedAt: new Date(),
    })
    .where(eq(finalizeDistilleQueue.id, params.jobId));
}

function mappedEvidenceStatus(
  status: CoverEvidenceResult["status"],
):
  | "knowledge_ready"
  | "duplicate"
  | "near_duplicate"
  | "insufficient"
  | "parse_failed"
  | "tool_failed"
  | "provider_failed" {
  return status === "reprocess_requested" ? "provider_failed" : status;
}

function priorityForSourceKind(sourceKind: FindingSourceKind): number {
  switch (sourceKind) {
    case "knowledge_candidate":
      return 90;
    case "web_ingest":
      return 80;
    case "wiki_file":
      return 70;
    default:
      return 50;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFindingSourceKind(value: unknown): FindingSourceKind | null {
  return value === "wiki_file" ||
    value === "vibe_memory" ||
    value === "knowledge_candidate" ||
    value === "web_ingest"
    ? value
    : null;
}

function metadataApplicabilityForOrigin(params: {
  origin: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const metadataAppliesTo = normalizeApplicability(params.metadata);
  const originHasAppliesTo = Boolean(params.origin.appliesTo ?? params.origin.applicability);

  if (!originHasAppliesTo && metadataAppliesTo) {
    result.appliesTo = metadataAppliesTo;
  }
  const coverFields = applicabilityToCoverCandidateFields(metadataAppliesTo);
  const canonicalFields = metadataAppliesTo ?? {};
  for (const [key, value] of Object.entries({ ...canonicalFields, ...coverFields })) {
    if (params.origin[key] === undefined && value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function coverEvidenceOrigin(params: {
  candidate: typeof foundCandidates.$inferSelect;
  findingJob: typeof findingCandidateQueue.$inferSelect;
  sourceKind: FindingSourceKind;
}): Record<string, unknown> {
  const origin = asRecord(params.candidate.origin);
  const metadata = asRecord(params.candidate.metadata);
  const originReadRanges = Array.isArray(origin.readRanges) ? origin.readRanges : undefined;
  const metadataReadRanges = Array.isArray(metadata.readRanges) ? metadata.readRanges : undefined;

  return {
    ...origin,
    ...metadataApplicabilityForOrigin({ origin, metadata }),
    sourceKind:
      asFindingSourceKind(origin.sourceKind) ??
      asFindingSourceKind(metadata.sourceKind) ??
      params.sourceKind,
    sourceKey:
      asNonEmptyString(origin.sourceKey) ??
      asNonEmptyString(metadata.sourceKey) ??
      params.findingJob.sourceKey,
    sourceUri:
      asNonEmptyString(origin.sourceUri) ??
      asNonEmptyString(metadata.sourceUri) ??
      params.findingJob.sourceUri,
    ...(originReadRanges ? { readRanges: originReadRanges } : {}),
    ...(!originReadRanges && metadataReadRanges ? { readRanges: metadataReadRanges } : {}),
  };
}

function isMissingSourceError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("vibe memory not found")
  );
}

function isQueueWorkerUnavailableError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("unable to connect. is the computer able to access the url") ||
    normalized.includes("connection timed out") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset") ||
    normalized.includes("socket connection was closed unexpectedly") ||
    normalized.includes("the operation timed out") ||
    normalized.includes("the operation was aborted") ||
    normalized.includes("operation was aborted") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("fetch failed") ||
    normalized.includes("was there a typo in the url or port") ||
    normalized.includes("local-llm http 503") ||
    normalized.includes("loading model") ||
    normalized.includes("unavailable_error") ||
    normalized.includes("local-llm http 404") ||
    normalized.includes("unsupported model:")
  );
}

function providerUnavailableRetryAfterSeconds(error: unknown, message: string): number | null {
  if (error instanceof LlmProviderHttpError && error.status === 503) {
    return error.retryAfterSeconds ?? 30;
  }
  const normalized = message.toLowerCase();
  if (
    normalized.includes("local-llm http 503") ||
    normalized.includes("loading model") ||
    normalized.includes("unavailable_error")
  ) {
    return 30;
  }
  return null;
}

function parseProvidedCandidatePayload(value: unknown): ProvidedCandidatePayload | null {
  const record = asRecord(value);
  const title = asNonEmptyString(record.title);
  const body = asNonEmptyString(record.body);
  if (!title || !body) return null;
  const typeRaw = asNonEmptyString(record.type);
  const polarityRaw = asNonEmptyString(record.polarity);
  const intentTags = parseStringArray(record.intentTags);
  const applicability = normalizeApplicability(record) ?? {};
  const origin = asRecord(record.origin);
  return {
    title,
    body,
    type: typeRaw === "procedure" ? "procedure" : typeRaw === "rule" ? "rule" : undefined,
    polarity:
      polarityRaw === "negative" ? "negative" : polarityRaw === "positive" ? "positive" : undefined,
    ...(intentTags.length > 0 ? { intentTags } : {}),
    ...(Object.keys(applicability).length > 0 ? { applicability } : {}),
    origin,
  };
}

async function markFindingCompleted(params: {
  jobId: string;
  status: "completed" | "skipped";
  outcome: string;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update finding_candidate_queue
        set status = ?,
            completed_at = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = null,
            last_outcome_kind = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        params.status,
        new Date().toISOString(),
        params.outcome,
        new Date().toISOString(),
        params.jobId,
      );
    return;
  }

  await db
    .update(findingCandidateQueue)
    .set({
      status: params.status,
      completedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: null,
      lastOutcomeKind: params.outcome,
      updatedAt: new Date(),
    })
    .where(eq(findingCandidateQueue.id, params.jobId));
}

async function markFindingFailed(params: { jobId: string; error: string }): Promise<void> {
  if (isSqliteBackend()) {
    const current = await getFindingJobById(params.jobId);
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update finding_candidate_queue
        set status = 'failed',
            attempt_count = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = 'failed',
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        (current?.attemptCount ?? 0) + 1,
        params.error.slice(0, 2000),
        new Date().toISOString(),
        params.jobId,
      );
    return;
  }

  const [current] = await db
    .select({ attemptCount: findingCandidateQueue.attemptCount })
    .from(findingCandidateQueue)
    .where(eq(findingCandidateQueue.id, params.jobId))
    .limit(1);
  await db
    .update(findingCandidateQueue)
    .set({
      status: "failed",
      attemptCount: (current?.attemptCount ?? 0) + 1,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.error.slice(0, 2000),
      lastOutcomeKind: "failed",
      updatedAt: new Date(),
    })
    .where(eq(findingCandidateQueue.id, params.jobId));
}

async function enqueueCoveringJob(params: {
  foundCandidateId: string;
  distillationVersion: string;
  providerPolicy?: "default" | "cloud_api";
  priority?: number;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const existing = sqlite.db
      .query("select id from covering_evidence_queue where found_candidate_id = ? limit 1")
      .get(params.foundCandidateId) as { id?: string } | null;
    if (existing?.id) return;
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, distillation_version, status, priority,
          provider_policy, payload, metadata, created_at, updated_at
        ) values (?, ?, ?, 'pending', ?, ?, '{}', '{}', ?, ?)
      `,
      )
      .run(
        crypto.randomUUID(),
        params.foundCandidateId,
        params.distillationVersion,
        params.priority ?? 50,
        params.providerPolicy ?? "default",
        now,
        now,
      );
    return;
  }

  await db
    .insert(coveringEvidenceQueue)
    .values({
      foundCandidateId: params.foundCandidateId,
      distillationVersion: params.distillationVersion,
      status: "pending",
      priority: params.priority ?? 50,
      providerPolicy: params.providerPolicy ?? "default",
      payload: {},
      metadata: {},
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: coveringEvidenceQueue.foundCandidateId });
}

async function vibeMemorySourceExists(sourceKey: string): Promise<boolean> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query("select id from vibe_memories where id = ? limit 1")
      .get(sourceKey) as { id?: string } | null;
    return Boolean(row);
  }

  const [row] = await db
    .select({ id: vibeMemories.id })
    .from(vibeMemories)
    .where(eq(vibeMemories.id, sourceKey))
    .limit(1);
  return Boolean(row);
}

async function upsertFoundCandidateRow(params: {
  findingJobId: string;
  candidateIndex: number;
  title: string;
  content: string;
  type?: "rule" | "procedure";
  origin?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const existing = sqlite.db
      .query(
        `
        select id
        from found_candidates
        where finding_job_id = ?
          and candidate_index = ?
        limit 1
      `,
      )
      .get(params.findingJobId, params.candidateIndex) as { id?: string } | null;
    const id = existing?.id ?? crypto.randomUUID();
    if (existing?.id) {
      sqlite.db
        .query(
          `
          update found_candidates
          set type = ?,
              title = ?,
              content = ?,
              source_summary = ?,
              origin = ?,
              metadata = ?,
              updated_at = ?
          where id = ?
        `,
        )
        .run(
          params.type ?? null,
          params.title,
          params.content,
          null,
          JSON.stringify(params.origin ?? {}),
          JSON.stringify(params.metadata ?? {}),
          now,
          id,
        );
      return id;
    }
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, type, title, content,
          source_summary, origin, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        params.findingJobId,
        params.candidateIndex,
        params.type ?? null,
        params.title,
        params.content,
        null,
        JSON.stringify(params.origin ?? {}),
        JSON.stringify(params.metadata ?? {}),
        now,
        now,
      );
    return id;
  }

  const [row] = await db
    .insert(foundCandidates)
    .values({
      findingJobId: params.findingJobId,
      candidateIndex: params.candidateIndex,
      type: params.type ?? null,
      title: params.title,
      content: params.content,
      sourceSummary: null,
      origin: params.origin ?? {},
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
      set: {
        type: params.type ?? null,
        title: params.title,
        content: params.content,
        sourceSummary: null,
        origin: params.origin ?? {},
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning({ id: foundCandidates.id });
  if (!row) throw new Error("failed to upsert found_candidates row");
  return row.id;
}

async function runSourceTargetFindCandidate(params: {
  findingJob: typeof findingCandidateQueue.$inferSelect;
  signal?: AbortSignal;
}): Promise<FindCandidateResult> {
  const sourceKind = params.findingJob.sourceKind as FindingSourceKind;
  let targetKey = params.findingJob.sourceKey;
  let sourceUri = params.findingJob.sourceUri;

  if (sourceKind === "web_ingest") {
    const sourceUrl =
      sourceUri.startsWith("http://") || sourceUri.startsWith("https://") ? sourceUri : targetKey;
    const research = await researchWebSourceToMarkdown({
      url: sourceUrl,
      normalizedUrl: targetKey,
    });
    targetKey = research.savedWikiTargetKey;
    sourceUri = research.savedWikiTargetKey;
  }
  if (sourceKind === "knowledge_candidate") {
    throw new Error("knowledge_candidate source_target is not supported");
  }

  return runFindCandidate({
    sourceInput: {
      targetKind: sourceKind,
      targetKey,
      sourceUri,
      metadata: params.findingJob.metadata as Record<string, unknown>,
    },
    callerMode: "cli_text",
    writeEpisode: false,
    signal: params.signal,
  });
}

async function processFindingCandidate(jobId: string, signal?: AbortSignal): Promise<void> {
  const job = await getFindingJobById(jobId);
  if (!job) throw new Error(`finding queue job not found: ${jobId}`);

  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: job.id,
    eventType: "claimed",
    message: "finding candidate claimed",
  });

  if (job.inputKind === "provided_candidate") {
    const payload = parseProvidedCandidatePayload(job.payload);
    if (!payload) {
      throw new Error("provided_candidate payload is invalid");
    }
    const foundCandidateId = await upsertFoundCandidateRow({
      findingJobId: job.id,
      candidateIndex: 0,
      title: payload.title,
      content: payload.body,
      type: payload.type,
      origin: {
        ...(payload.origin ?? {}),
        queueVersion: "v2",
        providedCandidate: true,
        ...(payload.polarity ? { polarity: payload.polarity } : {}),
        ...(payload.intentTags?.length ? { intentTags: payload.intentTags } : {}),
        ...(payload.applicability ? { appliesTo: payload.applicability } : {}),
        ...(payload.applicability
          ? applicabilityToCoverCandidateFields(payload.applicability)
          : {}),
      },
      metadata: {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
        ...(payload.polarity ? { polarity: payload.polarity } : {}),
        ...(payload.intentTags?.length ? { intentTags: payload.intentTags } : {}),
        ...(payload.applicability ? { appliesTo: payload.applicability } : {}),
        ...(payload.applicability
          ? applicabilityToCoverCandidateFields(payload.applicability)
          : {}),
      },
    });
    await enqueueCoveringJob({
      foundCandidateId,
      distillationVersion: job.distillationVersion,
      providerPolicy: "default",
      priority: job.priority,
    });
    await markFindingCompleted({
      jobId: job.id,
      status: "completed",
      outcome: "provided_candidate_registered",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: job.id,
      eventType: "completed",
      message: "provided candidate moved to covering queue",
      metadata: { foundCandidateId },
    });
    return;
  }

  if (job.sourceKind === "vibe_memory" && (await isVibeMemorySelfIngestionBlocked(job.sourceKey))) {
    await markFindingCompleted({
      jobId: job.id,
      status: "skipped",
      outcome: "self_ingestion_blocked",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: job.id,
      eventType: "completed",
      message: "self ingestion blocked",
      metadata: {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        reason: "codex_finding_escalation_self_ingestion",
      },
    });
    return;
  }

  const findResult = await runSourceTargetFindCandidate({ findingJob: job, signal });
  const candidates = findResult.candidates;
  const foundCandidateIds: string[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const foundCandidateId = await upsertFoundCandidateRow({
      findingJobId: job.id,
      candidateIndex: index,
      type: candidate.type,
      title: candidate.title,
      content: candidate.content,
      origin: {
        queueVersion: "v2",
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
        polarity: candidate.polarity,
      },
      metadata: {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
        readRanges: findResult.readRanges,
        polarity: candidate.polarity,
      },
    });
    foundCandidateIds.push(foundCandidateId);
    await enqueueCoveringJob({
      foundCandidateId,
      distillationVersion: job.distillationVersion,
      providerPolicy: "default",
      priority: job.priority,
    });
  }

  if (foundCandidateIds.length === 0) {
    const escalation = await maybeRunFindingCodexEscalation({
      findingJob: job,
      findResult,
      signal,
    });
    if (
      escalation.mode === "write" &&
      escalation.escalationId &&
      escalation.candidates.length > 0
    ) {
      for (const [index, candidate] of escalation.candidates.entries()) {
        const foundCandidateId = await upsertFoundCandidateRow({
          findingJobId: job.id,
          candidateIndex: index,
          type: candidate.type,
          title: candidate.title,
          content: candidate.content,
          origin: {
            queueVersion: "v2",
            sourceKind: job.sourceKind,
            sourceKey: job.sourceKey,
            sourceUri: job.sourceUri,
            polarity: candidate.polarity,
            codexEscalation: true,
            escalationId: escalation.escalationId,
          },
          metadata: {
            sourceKind: job.sourceKind,
            sourceKey: job.sourceKey,
            sourceUri: job.sourceUri,
            readRanges: escalation.readRanges ?? [],
            polarity: candidate.polarity,
            generatedBy: codexFindingEscalationGeneratedBy,
            excludedFromVibeMemory: true,
            escalationId: escalation.escalationId,
          },
        });
        foundCandidateIds.push(foundCandidateId);
        await enqueueCoveringJob({
          foundCandidateId,
          distillationVersion: job.distillationVersion,
          providerPolicy: "default",
          priority: job.priority,
        });
      }
      await markFindingCodexEscalationAccepted(escalation.escalationId, foundCandidateIds.length);
      await markFindingCompleted({
        jobId: job.id,
        status: "completed",
        outcome: "codex_escalated_candidates_found",
      });
      await appendQueueEvent({
        queueName: "findingCandidate",
        queueJobId: job.id,
        eventType: "completed",
        message: "codex escalated candidates moved to covering queue",
        metadata: {
          candidateCount: foundCandidateIds.length,
          foundCandidateIds,
          escalationId: escalation.escalationId,
          escalationStatus: escalation.status,
        },
      });
      return;
    }

    await markFindingCompleted({
      jobId: job.id,
      status: "skipped",
      outcome: "no_candidate",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: job.id,
      eventType: "completed",
      message: "no candidate found",
      metadata:
        findResult.parseDiagnostics || escalation.escalationId
          ? {
              noCandidateDiagnostics: {
                parseDiagnostics: findResult.parseDiagnostics,
                codexEscalation: escalation.escalationId
                  ? {
                      id: escalation.escalationId,
                      mode: escalation.mode,
                      status: escalation.status,
                      reason: escalation.reason,
                      candidateCount: escalation.candidates.length,
                    }
                  : undefined,
              },
            }
          : undefined,
    });
    return;
  }

  await markFindingCompleted({
    jobId: job.id,
    status: "completed",
    outcome: "candidates_found",
  });
  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: job.id,
    eventType: "completed",
    message: "finding candidate completed",
    metadata: {
      candidateCount: foundCandidateIds.length,
      foundCandidateIds,
    },
  });
}

async function markCoveringCompleted(params: {
  jobId: string;
  status: "pending" | "completed" | "failed" | "paused" | "skipped";
  attemptCount?: number;
  nextRunAt?: Date | null;
  outcome: string;
  lastError?: string | null;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        update covering_evidence_queue
        set status = ?,
            attempt_count = coalesce(?, attempt_count),
            next_run_at = ?,
            completed_at = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        params.status,
        params.attemptCount ?? null,
        params.nextRunAt ? params.nextRunAt.toISOString() : null,
        params.status === "completed" || params.status === "skipped" ? now : null,
        params.lastError ?? null,
        params.outcome,
        now,
        params.jobId,
      );
    return;
  }

  await db
    .update(coveringEvidenceQueue)
    .set({
      status: params.status,
      attemptCount: params.attemptCount ?? coveringEvidenceQueue.attemptCount,
      nextRunAt: params.nextRunAt ?? null,
      completedAt: params.status === "completed" || params.status === "skipped" ? new Date() : null,
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: params.lastError ?? null,
      lastOutcomeKind: params.outcome,
      updatedAt: new Date(),
    })
    .where(eq(coveringEvidenceQueue.id, params.jobId));
}

async function processCoveringJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<{ terminal: boolean }> {
  const job = await getCoveringJobById(jobId);
  if (!job) throw new Error(`coveringEvidence job not found: ${jobId}`);

  const candidate = await getFoundCandidateById(job.foundCandidateId);
  if (!candidate) throw new Error(`found candidate not found: ${job.foundCandidateId}`);

  await appendQueueEvent({
    queueName: "coveringEvidence",
    queueJobId: job.id,
    eventType: "claimed",
    message: "covering evidence claimed",
  });

  const findingJob = await getFindingJobById(candidate.findingJobId);
  if (!findingJob) throw new Error(`finding job not found: ${candidate.findingJobId}`);

  const sourceKind =
    findingJob.sourceKind === "web_ingest" ||
    findingJob.sourceKind === "wiki_file" ||
    findingJob.sourceKind === "vibe_memory" ||
    findingJob.sourceKind === "knowledge_candidate"
      ? findingJob.sourceKind
      : "vibe_memory";
  const origin = coverEvidenceOrigin({ candidate, findingJob, sourceKind });
  const coverTargetKind = asFindingSourceKind(origin.sourceKind) ?? sourceKind;
  const queuePayload = asRecord(job.payload);
  const forceRefreshEvidence = queuePayload.forceRefreshEvidence === true;
  const cover = await (queueWorkerTestHooks.runCoverEvidence ?? runCoverEvidence)({
    id: candidate.id,
    candidate: {
      id: candidate.id,
      status: "selected",
      title: candidate.title,
      content: candidate.content,
      origin,
      targetStateId: null,
      targetKind: coverTargetKind,
      targetKey: asNonEmptyString(origin.sourceKey) ?? findingJob.sourceKey,
      sourceUri: asNonEmptyString(origin.sourceUri) ?? findingJob.sourceUri,
    },
    providerPolicy: (job.providerPolicy as "default" | "cloud_api") ?? "default",
    write: false,
    forceRefreshEvidence,
    signal,
  });

  const mappedStatus = mappedEvidenceStatus(cover.result.status);

  let evidenceResultId: string | null = null;
  if (mappedStatus) {
    if (isSqliteBackend()) {
      const sqlite = await getSqliteCoreDatabase();
      const now = new Date().toISOString();
      const existing = sqlite.db
        .query(
          `
          select id
          from evidence_coverage_results
          where found_candidate_id = ?
            and producer_queue = 'coveringEvidence'
          limit 1
        `,
        )
        .get(candidate.id) as { id?: string } | null;
      evidenceResultId = existing?.id ?? crypto.randomUUID();
      if (existing?.id) {
        sqlite.db
          .query(
            `
            update evidence_coverage_results
            set producer_job_id = ?,
                distillation_version = ?,
                status = ?,
                stage = ?,
                type = ?,
                title = ?,
                body = ?,
                importance = ?,
                confidence = ?,
                applies_to = ?,
                "references" = ?,
                duplicate_refs = ?,
                tool_events = ?,
                reason = ?,
                metadata = ?,
                updated_at = ?
            where id = ?
          `,
          )
          .run(
            job.id,
            job.distillationVersion,
            mappedStatus,
            cover.result.stage,
            cover.result.candidate?.type ?? candidate.type ?? null,
            cover.result.candidate?.title ?? candidate.title,
            cover.result.candidate?.body ?? candidate.content,
            cover.result.candidate?.importance ?? null,
            cover.result.candidate?.confidence ?? null,
            JSON.stringify(applicabilityFromCoverCandidate(cover.result.candidate)),
            JSON.stringify(cover.result.references),
            JSON.stringify(cover.result.duplicateRefs),
            JSON.stringify(cover.result.toolEvents),
            cover.result.reason ?? null,
            JSON.stringify({ queueVersion: "v2" }),
            now,
            evidenceResultId,
          );
      } else {
        sqlite.db
          .query(
            `
            insert into evidence_coverage_results (
              id, found_candidate_id, producer_queue, producer_job_id,
              distillation_version, status, stage, type, title, body,
              importance, confidence, applies_to, "references", duplicate_refs,
              tool_events, reason, metadata, created_at, updated_at
            ) values (?, ?, 'coveringEvidence', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            evidenceResultId,
            candidate.id,
            job.id,
            job.distillationVersion,
            mappedStatus,
            cover.result.stage,
            cover.result.candidate?.type ?? candidate.type ?? null,
            cover.result.candidate?.title ?? candidate.title,
            cover.result.candidate?.body ?? candidate.content,
            cover.result.candidate?.importance ?? null,
            cover.result.candidate?.confidence ?? null,
            JSON.stringify(applicabilityFromCoverCandidate(cover.result.candidate)),
            JSON.stringify(cover.result.references),
            JSON.stringify(cover.result.duplicateRefs),
            JSON.stringify(cover.result.toolEvents),
            cover.result.reason ?? null,
            JSON.stringify({ queueVersion: "v2" }),
            now,
            now,
          );
      }
    } else {
      const [saved] = await db
        .insert(evidenceCoverageResults)
        .values({
          foundCandidateId: candidate.id,
          producerQueue: "coveringEvidence",
          producerJobId: job.id,
          distillationVersion: job.distillationVersion,
          status: mappedStatus,
          stage: cover.result.stage,
          type: cover.result.candidate?.type ?? candidate.type ?? null,
          title: cover.result.candidate?.title ?? candidate.title,
          body: cover.result.candidate?.body ?? candidate.content,
          importance: cover.result.candidate?.importance ?? null,
          confidence: cover.result.candidate?.confidence ?? null,
          appliesTo: applicabilityFromCoverCandidate(cover.result.candidate),
          references: cover.result.references,
          duplicateRefs: cover.result.duplicateRefs,
          toolEvents: cover.result.toolEvents,
          reason: cover.result.reason,
          metadata: {
            queueVersion: "v2",
          },
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [evidenceCoverageResults.foundCandidateId, evidenceCoverageResults.producerQueue],
          set: {
            status: mappedStatus,
            stage: cover.result.stage,
            type: cover.result.candidate?.type ?? candidate.type ?? null,
            title: cover.result.candidate?.title ?? candidate.title,
            body: cover.result.candidate?.body ?? candidate.content,
            importance: cover.result.candidate?.importance ?? null,
            confidence: cover.result.candidate?.confidence ?? null,
            appliesTo: applicabilityFromCoverCandidate(cover.result.candidate),
            references: cover.result.references,
            duplicateRefs: cover.result.duplicateRefs,
            toolEvents: cover.result.toolEvents,
            reason: cover.result.reason,
            metadata: {
              queueVersion: "v2",
            },
            updatedAt: new Date(),
          },
        })
        .returning({ id: evidenceCoverageResults.id });
      evidenceResultId = saved?.id ?? null;
    }
  }

  const nextAttemptCount = job.attemptCount + 1;
  const exhausted = nextAttemptCount >= job.maxAttempts;

  if (cover.result.status === "knowledge_ready" && evidenceResultId) {
    const finalizePriority = priorityForSourceKind(
      (candidate.metadata as Record<string, unknown> | null)?.sourceKind === "web_ingest"
        ? "web_ingest"
        : (candidate.metadata as Record<string, unknown> | null)?.sourceKind === "wiki_file"
          ? "wiki_file"
          : (candidate.metadata as Record<string, unknown> | null)?.sourceKind ===
              "knowledge_candidate"
            ? "knowledge_candidate"
            : "vibe_memory",
    );
    if (isSqliteBackend()) {
      const sqlite = await getSqliteCoreDatabase();
      const existing = sqlite.db
        .query("select id from finalize_distille_queue where evidence_result_id = ? limit 1")
        .get(evidenceResultId) as { id?: string } | null;
      if (!existing?.id) {
        const now = new Date().toISOString();
        sqlite.db
          .query(
            `
            insert into finalize_distille_queue (
              id, evidence_result_id, distillation_version, status, priority,
              provider_policy, metadata, created_at, updated_at
            ) values (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
          `,
          )
          .run(
            crypto.randomUUID(),
            evidenceResultId,
            job.distillationVersion,
            finalizePriority,
            job.providerPolicy,
            JSON.stringify({
              queueVersion: "v2",
              sourceQueue: "coveringEvidence",
              sourceQueueJobId: job.id,
            }),
            now,
            now,
          );
      }
    } else {
      await db
        .insert(finalizeDistilleQueue)
        .values({
          evidenceResultId,
          distillationVersion: job.distillationVersion,
          status: "pending",
          priority: finalizePriority,
          providerPolicy: job.providerPolicy,
          metadata: {
            queueVersion: "v2",
            sourceQueue: "coveringEvidence",
            sourceQueueJobId: job.id,
          },
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: finalizeDistilleQueue.evidenceResultId });
    }
  }

  if (retryableCoverStatuses.has(cover.result.status)) {
    if (exhausted) {
      await markCoveringCompleted({
        jobId: job.id,
        status: "failed",
        attemptCount: nextAttemptCount,
        outcome: cover.result.status,
        lastError: cover.result.reason ?? cover.result.status,
      });
      return { terminal: true };
    }
    await markCoveringCompleted({
      jobId: job.id,
      status: "pending",
      attemptCount: nextAttemptCount,
      nextRunAt: new Date(Date.now() + coveringRetryBackoffMs(nextAttemptCount)),
      outcome: cover.result.status,
      lastError: cover.result.reason ?? cover.result.status,
    });
    return { terminal: false };
  }

  await markCoveringCompleted({
    jobId: job.id,
    status:
      cover.result.status === "knowledge_ready" ||
      cover.result.status === "duplicate" ||
      cover.result.status === "near_duplicate" ||
      cover.result.status === "insufficient"
        ? "completed"
        : "failed",
    attemptCount: nextAttemptCount,
    outcome: cover.result.status,
    lastError: cover.result.reason ?? null,
  });
  return { terminal: true };
}

function queueTargetKindFromSourceKind(
  sourceKind: string,
): "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest" {
  if (sourceKind === "wiki_file") return "wiki_file";
  if (sourceKind === "web_ingest") return "web_ingest";
  if (sourceKind === "knowledge_candidate") return "knowledge_candidate";
  return "vibe_memory";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function processFinalizeJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const job = await getFinalizeJobById(jobId);
  if (!job) throw new Error(`finalize job not found: ${jobId}`);

  const evidence = await getEvidenceCoverageById(job.evidenceResultId);
  if (!evidence) throw new Error(`evidence result not found: ${job.evidenceResultId}`);
  const candidate = await getFoundCandidateById(evidence.foundCandidateId);
  if (!candidate) throw new Error(`found candidate not found: ${evidence.foundCandidateId}`);
  const findingJob = await getFindingJobById(candidate.findingJobId);
  if (!findingJob) throw new Error(`finding job not found: ${candidate.findingJobId}`);

  await appendQueueEvent({
    queueName: "finalizeDistille",
    queueJobId: job.id,
    eventType: "claimed",
    message: "finalize claimed",
  });

  const appliesTo = normalizeApplicability(evidence.appliesTo);
  const candidateTypeRaw =
    evidence.type === "rule" || evidence.type === "procedure"
      ? evidence.type
      : candidate.type === "rule" || candidate.type === "procedure"
        ? candidate.type
        : null;
  const queueCoverResult: CoverEvidenceResult = {
    schemaVersion: 1,
    status:
      evidence.status === "knowledge_ready" ||
      evidence.status === "duplicate" ||
      evidence.status === "near_duplicate" ||
      evidence.status === "insufficient" ||
      evidence.status === "parse_failed" ||
      evidence.status === "tool_failed" ||
      evidence.status === "provider_failed"
        ? evidence.status
        : "parse_failed",
    stage:
      evidence.stage === "load" ||
      evidence.stage === "source_support" ||
      evidence.stage === "dedupe" ||
      evidence.stage === "evidence_need" ||
      evidence.stage === "web" ||
      evidence.stage === "mcp" ||
      evidence.stage === "final"
        ? evidence.stage
        : "final",
    candidate:
      candidateTypeRaw && evidence.title && evidence.body
        ? {
            type: candidateTypeRaw,
            title: evidence.title,
            body: evidence.body,
            importance: Number(evidence.importance ?? 70),
            confidence: Number(evidence.confidence ?? 70),
            ...applicabilityToCoverCandidateFields(appliesTo),
          }
        : null,
    references: asArray<CoverEvidenceResult["references"][number]>(evidence.references),
    duplicateRefs: asArray<CoverEvidenceResult["duplicateRefs"][number]>(evidence.duplicateRefs),
    toolEvents: asArray<CoverEvidenceResult["toolEvents"][number]>(evidence.toolEvents),
    reason: typeof evidence.reason === "string" ? evidence.reason : null,
  };
  const finalized = await (queueWorkerTestHooks.runFinalizeDistille ?? runFinalizeDistille)({
    coverEvidenceResultId: evidence.id,
    resultOverride: queueCoverResult,
    candidateContext: {
      foundCandidateId: candidate.id,
      targetStateId: null,
      findCandidateResultId: null,
      targetKind: queueTargetKindFromSourceKind(findingJob.sourceKind),
      targetKey: findingJob.sourceKey,
      sourceUri: findingJob.sourceUri,
    },
    write: true,
    signal,
  });

  const status =
    finalized.status === "stored"
      ? "completed"
      : finalized.status === "rejected"
        ? "skipped"
        : "failed";
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        update finalize_distille_queue
        set status = ?,
            attempt_count = ?,
            knowledge_id = ?,
            completed_at = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = ?,
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        status,
        job.attemptCount + 1,
        finalized.knowledgeId,
        status === "completed" || status === "skipped" ? now : null,
        finalized.reason,
        finalized.status,
        now,
        job.id,
      );
  } else {
    await db
      .update(finalizeDistilleQueue)
      .set({
        status,
        attemptCount: job.attemptCount + 1,
        knowledgeId: finalized.knowledgeId,
        completedAt: status === "completed" || status === "skipped" ? new Date() : null,
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        lastError: finalized.reason,
        lastOutcomeKind: finalized.status,
        updatedAt: new Date(),
      })
      .where(eq(finalizeDistilleQueue.id, job.id));
  }

  await appendQueueEvent({
    queueName: "finalizeDistille",
    queueJobId: job.id,
    eventType: "completed",
    message: "finalize completed",
    metadata: {
      finalizeStatus: finalized.status,
      knowledgeId: finalized.knowledgeId,
    },
  });
}

async function runWithHeartbeat<T>(params: {
  queueName: DistillationQueueName;
  jobId: string;
  providerLease?: ProviderLease;
  run: () => Promise<T>;
}): Promise<T> {
  const tableName = queueTableNameByQueue[params.queueName];
  const heartbeatMs = 30_000;
  const timer = setInterval(() => {
    if (params.providerLease) {
      void heartbeatProviderLease(params.providerLease.id).catch(() => {
        // Provider lease heartbeat failure should not mask the active worker result.
      });
    }
    if (isSqliteBackend()) {
      void getSqliteCoreDatabase()
        .then((sqlite) => {
          sqlite.db
            .query(
              `
              update ${tableName}
              set heartbeat_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
              where id = ?
                and status = 'running'
            `,
            )
            .run(params.jobId);
        })
        .catch(() => {
          // Heartbeat failure should not mask the active worker result.
        });
    } else {
      void db.execute(sql`
        update ${sql.raw(tableName)}
        set
          heartbeat_at = now(),
          updated_at = now()
        where id = ${params.jobId}
          and status = 'running'
      `);
    }
  }, heartbeatMs);
  try {
    return await params.run();
  } finally {
    clearInterval(timer);
  }
}

async function runWithTimeout<T>(params: {
  timeoutMs: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeoutMs = Math.max(1_000, Math.floor(params.timeoutMs));
  const timeoutController = new AbortController();
  const mergedController = new AbortController();
  const abortMerged = (reason: unknown) => {
    if (!mergedController.signal.aborted) {
      mergedController.abort(reason);
    }
  };

  timeoutController.signal.addEventListener(
    "abort",
    () => {
      abortMerged(timeoutController.signal.reason ?? "queue_job_timeout");
    },
    { once: true },
  );
  if (params.signal) {
    if (params.signal.aborted) {
      abortMerged(params.signal.reason ?? "queue_control_aborted");
    } else {
      params.signal.addEventListener(
        "abort",
        () => {
          abortMerged(params.signal?.reason ?? "queue_control_aborted");
        },
        { once: true },
      );
    }
  }

  const timer = setTimeout(() => {
    timeoutController.abort("queue_job_timeout");
  }, timeoutMs);
  try {
    return await params.run(mergedController.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name?: string }).name === "AbortError";
  }
  return false;
}

export async function runQueueWorkerOnce(params: {
  queueName: DistillationQueueName;
  workerId: string;
  claimedJob?: { id: string };
  providerLease?: ProviderLease;
}): Promise<QueueRunResult> {
  if (!params.claimedJob && (await isQueuePaused(params.queueName))) {
    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: true,
      claimedJobId: null,
      message: "queue paused by lane control",
    };
  }

  const claimed =
    params.claimedJob ??
    (await claimNextQueueJob({
      queueName: params.queueName,
      workerId: params.workerId,
    }));
  if (!claimed) {
    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: true,
      claimedJobId: null,
      message: "no runnable job",
    };
  }

  try {
    const pauseController = new AbortController();
    const pausePollTimer = setInterval(() => {
      void (async () => {
        const paused = await isQueuePaused(params.queueName);
        if (paused && !pauseController.signal.aborted) {
          pauseController.abort("queue_lane_paused");
        }
      })().catch(() => {
        // Ignore transient control-plane read errors and continue worker cycle.
      });
    }, 2_000);
    if (await isQueuePaused(params.queueName)) {
      pauseController.abort("queue_lane_paused");
    }

    let completedJobId: string | undefined = claimed.id;
    let providerLeaseReleaseReason = "worker_failed";
    try {
      await runWithHeartbeat({
        queueName: params.queueName,
        jobId: claimed.id,
        providerLease: params.providerLease,
        run: async () => {
          await runWithProviderLeaseRouteContext(
            params.providerLease
              ? {
                  poolId: params.providerLease.poolId,
                  targetId: params.providerLease.targetId,
                }
              : null,
            async () => {
              if (params.queueName === "findingCandidate") {
                await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processFindingCandidate(claimed.id, signal),
                });
              } else if (params.queueName === "episodeDistiller") {
                await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processEpisodeDistillerJob(claimed.id, signal),
                });
              } else if (params.queueName === "coveringEvidence") {
                const coverResult = await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processCoveringJob(claimed.id, signal),
                });
                completedJobId = coverResult.terminal ? claimed.id : undefined;
              } else if (params.queueName === "deadZoneMergeReview") {
                await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processDeadZoneMergeReviewJob(claimed.id, signal),
                });
              } else if (params.queueName === "mergeActivationFinalize") {
                await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.timeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processMergeActivationFinalizeJob(claimed.id, signal),
                });
              } else {
                await runWithTimeout({
                  timeoutMs: groupedConfig.distillation.timeoutMs,
                  signal: pauseController.signal,
                  run: (signal) => processFinalizeJob(claimed.id, signal),
                });
              }
            },
          );
        },
      });
      providerLeaseReleaseReason = "worker_finished";
    } finally {
      clearInterval(pausePollTimer);
      if (params.providerLease) {
        await releaseProviderLease(params.providerLease.id, providerLeaseReleaseReason).catch(
          () => {
            // Stale provider lease recovery is the fallback if release fails here.
          },
        );
      }
    }

    return {
      ok: true,
      queue: params.queueName,
      worker: params.workerId,
      idle: false,
      claimedJobId: claimed.id,
      ...(completedJobId ? { completedJobId } : {}),
      message: "processed job",
    };
  } catch (error) {
    const pausedByLaneControl =
      (typeof error === "string" && error.includes("queue_lane_paused")) ||
      (error instanceof Error && error.message.includes("queue_lane_paused")) ||
      isAbortError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (pausedByLaneControl && (await isQueuePaused(params.queueName))) {
      await pauseQueueJob({
        queueName: params.queueName,
        id: claimed.id,
        reason: "paused by queue lane control",
      });
      await appendQueueEvent({
        queueName: params.queueName,
        queueJobId: claimed.id,
        eventType: "paused",
        message: "paused by queue lane control",
      });
      return {
        ok: true,
        queue: params.queueName,
        worker: params.workerId,
        idle: false,
        claimedJobId: claimed.id,
        message: "paused by queue lane control",
      };
    }

    const providerRetryAfterSeconds = providerUnavailableRetryAfterSeconds(error, message);
    if (providerRetryAfterSeconds !== null) {
      const reason = `provider_unavailable_retry:${message}`.slice(0, 500);
      await keepQueueJobWaitingForProvider({
        queueName: params.queueName,
        id: claimed.id,
        reason,
        retryAfterSeconds: providerRetryAfterSeconds,
      });
      await appendQueueEvent({
        queueName: params.queueName,
        queueJobId: claimed.id,
        eventType: "retried",
        message: "job returned to queue because LLM provider is temporarily unavailable",
        metadata: {
          error: message,
          reason,
          retryAfterSeconds: providerRetryAfterSeconds,
          status: error instanceof LlmProviderHttpError ? error.status : 503,
          ...providerLeaseTargetEventMetadata(params.providerLease),
        },
      });
      return {
        ok: false,
        queue: params.queueName,
        worker: params.workerId,
        idle: false,
        claimedJobId: claimed.id,
        message: reason,
      };
    }

    if (isQueueWorkerUnavailableError(message)) {
      const reason = `worker_unavailable:${message}`.slice(0, 500);
      await keepQueueJobWaitingForWorker({
        queueName: params.queueName,
        id: claimed.id,
        reason,
      });
      await appendQueueEvent({
        queueName: params.queueName,
        queueJobId: claimed.id,
        eventType: "retried",
        message: "job kept waiting because worker dependency is unavailable",
        metadata: {
          error: message,
          reason,
        },
      });
      return {
        ok: false,
        queue: params.queueName,
        worker: params.workerId,
        idle: false,
        claimedJobId: claimed.id,
        message: reason,
      };
    }

    if (params.queueName === "findingCandidate") {
      if (isMissingSourceError(message)) {
        await markFindingCompleted({
          jobId: claimed.id,
          status: "skipped",
          outcome: "source_missing",
        });
        await appendQueueEvent({
          queueName: params.queueName,
          queueJobId: claimed.id,
          eventType: "completed",
          message: "source missing skipped",
          metadata: {
            reason: message,
          },
        });
        return {
          ok: true,
          queue: params.queueName,
          worker: params.workerId,
          idle: false,
          claimedJobId: claimed.id,
          completedJobId: claimed.id,
          message: "source missing skipped",
        };
      }
      await markFindingFailed({
        jobId: claimed.id,
        error: message,
      });
    } else if (params.queueName === "episodeDistiller") {
      await failEpisodeDistillerJob(claimed.id, message);
    } else if (params.queueName === "coveringEvidence") {
      const current = await getCoveringJobById(claimed.id);
      const currentAttempt = current?.attemptCount ?? 0;
      await markCoveringCompleted({
        jobId: claimed.id,
        status: "failed",
        attemptCount: currentAttempt + 1,
        outcome: "failed",
        lastError: message,
      });
    } else if (params.queueName === "deadZoneMergeReview") {
      // The merge-review service records job failure details so it can classify parse/provider failures.
    } else if (params.queueName === "mergeActivationFinalize") {
      const currentAttempt = await getMergeActivationFinalizeAttemptCount(claimed.id);
      await markMergeActivationFinalizeFailed({
        jobId: claimed.id,
        attemptCount: currentAttempt + 1,
        error: message,
      });
    } else {
      const current = await getFinalizeJobById(claimed.id);
      const currentAttempt = current?.attemptCount ?? 0;
      await markFinalizeFailed({
        jobId: claimed.id,
        attemptCount: currentAttempt + 1,
        error: message,
      });
    }
    await appendQueueEvent({
      queueName: params.queueName,
      queueJobId: claimed.id,
      eventType: "failed",
      message: "worker failed",
      metadata: {
        error: message,
        ...providerLeaseTargetEventMetadata(params.providerLease),
      },
    });
    return {
      ok: params.queueName === "findingCandidate" && isMissingSourceError(message),
      queue: params.queueName,
      worker: params.workerId,
      idle: false,
      claimedJobId: claimed.id,
      message,
    };
  }
}

export async function enqueueFindingJob(params: {
  inputKind: "source_target" | "provided_candidate";
  sourceKind: FindingSourceKind;
  sourceKey: string;
  sourceUri: string;
  distillationVersion?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority?: number;
}): Promise<typeof findingCandidateQueue.$inferSelect | null> {
  if (params.sourceKind === "vibe_memory" && !(await vibeMemorySourceExists(params.sourceKey))) {
    return null;
  }

  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const priority = params.priority ?? priorityForSourceKind(params.sourceKind);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const existing = sqlite.db
      .query(
        `
        select *
        from finding_candidate_queue
        where input_kind = ?
          and source_kind = ?
          and source_key = ?
          and distillation_version = ?
        limit 1
      `,
      )
      .get(params.inputKind, params.sourceKind, params.sourceKey, distillationVersion) as Record<
      string,
      unknown
    > | null;

    const id = existing?.id ? String(existing.id) : crypto.randomUUID();
    if (existing) {
      sqlite.db
        .query(
          `
          update finding_candidate_queue
          set source_uri = ?,
              payload = ?,
              metadata = ?,
              priority = ?,
              next_run_at = null,
              completed_at = null,
              status = 'pending',
              locked_by = null,
              locked_at = null,
              heartbeat_at = null,
              updated_at = ?
          where id = ?
        `,
        )
        .run(
          params.sourceUri,
          JSON.stringify(params.payload ?? {}),
          JSON.stringify(params.metadata ?? {}),
          priority,
          now,
          id,
        );
    } else {
      sqlite.db
        .query(
          `
          insert into finding_candidate_queue (
            id, input_kind, source_kind, source_key, source_uri, distillation_version,
            payload, metadata, priority, status, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `,
        )
        .run(
          id,
          params.inputKind,
          params.sourceKind,
          params.sourceKey,
          params.sourceUri,
          distillationVersion,
          JSON.stringify(params.payload ?? {}),
          JSON.stringify(params.metadata ?? {}),
          priority,
          now,
          now,
        );
    }

    const row = sqlite.db
      .query("select * from finding_candidate_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    if (!row) throw new Error("failed to enqueue finding candidate job");
    const normalized = sqliteFindingJobRow(row);
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: normalized.id,
      eventType: "enqueued",
      message: "finding candidate enqueued",
      metadata: {
        sourceKind: normalized.sourceKind,
        sourceKey: normalized.sourceKey,
        inputKind: normalized.inputKind,
      },
    });
    return normalized;
  }

  const [row] = await db
    .insert(findingCandidateQueue)
    .values({
      inputKind: params.inputKind,
      sourceKind: params.sourceKind,
      sourceKey: params.sourceKey,
      sourceUri: params.sourceUri,
      distillationVersion,
      payload: params.payload ?? {},
      metadata: params.metadata ?? {},
      priority,
      status: "pending",
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        findingCandidateQueue.inputKind,
        findingCandidateQueue.sourceKind,
        findingCandidateQueue.sourceKey,
        findingCandidateQueue.distillationVersion,
      ],
      set: {
        sourceUri: params.sourceUri,
        payload: params.payload ?? {},
        metadata: params.metadata ?? {},
        priority,
        nextRunAt: null,
        completedAt: null,
        status: "pending",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to enqueue finding candidate job");
  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: row.id,
    eventType: "enqueued",
    message: "finding candidate enqueued",
    metadata: {
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
      inputKind: row.inputKind,
    },
  });
  return row;
}

export async function findFindingJob(params: {
  inputKind: "source_target" | "provided_candidate";
  sourceKind: FindingSourceKind;
  sourceKey: string;
  distillationVersion?: string;
}): Promise<typeof findingCandidateQueue.$inferSelect | null> {
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query(
        `
        select *
        from finding_candidate_queue
        where input_kind = ?
          and source_kind = ?
          and source_key = ?
          and distillation_version = ?
        limit 1
      `,
      )
      .get(params.inputKind, params.sourceKind, params.sourceKey, distillationVersion) as Record<
      string,
      unknown
    > | null;
    return row ? sqliteFindingJobRow(row) : null;
  }

  const [row] = await db
    .select()
    .from(findingCandidateQueue)
    .where(
      and(
        eq(findingCandidateQueue.inputKind, params.inputKind),
        eq(findingCandidateQueue.sourceKind, params.sourceKind),
        eq(findingCandidateQueue.sourceKey, params.sourceKey),
        eq(findingCandidateQueue.distillationVersion, distillationVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}
