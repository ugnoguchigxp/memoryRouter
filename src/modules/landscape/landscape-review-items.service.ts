import type {
  LandscapeContradictionOverlayList,
  LandscapeContradictionOverlayQuery,
} from "../../shared/schemas/landscape-contradiction-overlay.schema.js";
import {
  type LandscapeReviewItem,
  type LandscapeReviewItemCandidate,
  type LandscapeReviewItemStatus,
  landscapeReviewItemSchema,
  landscapeReviewItemStatusSchema,
} from "../../shared/schemas/landscape-review.schema.js";
import { asRecord, toIsoString } from "../../shared/utils/normalize.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { buildLandscapeContradictionCandidates } from "./landscape-contradiction.service.js";
import { buildLandscapeReplayComparison } from "./landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "./landscape-replay.service.js";
import {
  buildLandscapeReviewItemCandidates,
  normalizeEvidence,
  sortCandidatesForMaterialize,
  uniqueCandidatesByIdempotencyKey,
} from "./landscape-review-items.candidates.js";
import {
  type LandscapeReviewItemRow,
  countLandscapeReviewItemRows,
  findLandscapeReviewItemRowById,
  insertLandscapeReviewItemsIdempotent,
  listLandscapeReviewItemRows,
  updateLandscapeReviewItemRow,
} from "./landscape-review-items.repository.js";
import type {
  LandscapeReviewItemListResult,
  LandscapeReviewItemMaterializeResult,
  ListLandscapeReviewItemsInput,
  MaterializeLandscapeReviewItemsInput,
  UpdateLandscapeReviewItemStatusInput,
} from "./landscape-review-items.types.js";
import { buildLandscapeSnapshot } from "./landscape.service.js";

export { buildLandscapeReviewItemCandidates } from "./landscape-review-items.candidates.js";

const allowedTransitions: Record<LandscapeReviewItemStatus, LandscapeReviewItemStatus[]> = {
  pending: ["reviewing", "resolved", "dismissed"],
  reviewing: ["pending", "resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

export class LandscapeReviewItemsError extends Error {
  readonly statusCode: 400 | 409;

  constructor(statusCode: 400 | 409, message: string) {
    super(message);
    this.name = "LandscapeReviewItemsError";
    this.statusCode = statusCode;
  }
}

function mapReviewItemRow(row: LandscapeReviewItemRow): LandscapeReviewItem {
  return landscapeReviewItemSchema.parse({
    id: row.id,
    source: row.source,
    reason: row.reason,
    status: row.status,
    proposedAction: row.proposedAction,
    priority: row.priority,
    confidence: row.confidence,
    knowledgeId: row.knowledgeId ?? null,
    runId: row.runId ?? null,
    triggerEventId: row.triggerEventId ?? null,
    communityKey: row.communityKey ?? null,
    communityLabel: row.communityLabel ?? null,
    suggestedAppliesTo: asRecord(row.suggestedAppliesTo),
    evidence: normalizeEvidence(row.evidence),
    payload: asRecord(row.payload),
    note: row.note ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    resolvedAt: row.resolvedAt ? toIsoString(row.resolvedAt) : null,
  });
}

export async function getLandscapeReviewItem(id: string): Promise<LandscapeReviewItem | null> {
  const row = await findLandscapeReviewItemRowById(id);
  return row ? mapReviewItemRow(row) : null;
}

export async function materializeLandscapeReviewItems(
  input: MaterializeLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemMaterializeResult> {
  const supportedSources = new Set<LandscapeReviewItemCandidate["source"]>([
    "replay_compare",
    "landscape_snapshot",
    "semantic_relation_comparison",
    "promotion_gate",
    "contradiction_detection",
  ]);
  const unsupportedSources = input.sources.filter((source) => !supportedSources.has(source));
  if (unsupportedSources.length > 0) {
    throw new LandscapeReviewItemsError(
      400,
      `unsupported sources in current phase: ${unsupportedSources.join(", ")}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const [comparison, landscapeSnapshot, landscapeReplaySnapshot, contradictionCandidates] =
    await Promise.all([
      input.sources.includes("replay_compare") || input.sources.includes("promotion_gate")
        ? buildLandscapeReplayComparison({
            windowDays: input.windowDays,
            limit: input.limit,
            runStatus: input.runStatus,
            currentLimit: input.currentLimit,
            includeRuns: false,
          })
        : Promise.resolve(null),
      input.sources.includes("landscape_snapshot")
        ? buildLandscapeSnapshot({
            windowDays: input.windowDays,
            limit: input.landscapeLimit,
            status: input.landscapeStatus,
            relationAxes: input.relationAxes,
            minSelectedCount: input.minSelectedCount,
            minFeedbackCount: input.minFeedbackCount,
          })
        : Promise.resolve(null),
      input.sources.includes("semantic_relation_comparison")
        ? buildLandscapeReplaySnapshot({
            windowDays: input.windowDays,
            limit: input.limit,
            landscapeLimit: input.landscapeLimit,
            runStatus: input.runStatus,
            landscapeStatus: input.landscapeStatus,
            relationAxes: input.relationAxes,
            minSelectedCount: input.minSelectedCount,
            minFeedbackCount: input.minFeedbackCount,
            minSimilarity: input.minSimilarity,
            semanticTopK: input.semanticTopK,
            includeRuns: false,
          })
        : Promise.resolve(null),
      input.sources.includes("contradiction_detection")
        ? buildLandscapeContradictionCandidates({
            windowDays: input.windowDays,
            knowledgeLimit: Math.max(input.materializeLimit * 6, 160),
            candidateLimit: Math.max(input.materializeLimit * 3, 120),
            landscapeStatus: input.landscapeStatus,
            relationAxes: input.relationAxes,
            semanticMinSimilarity: Math.max(input.minSimilarity, 0.82),
            confidenceThreshold: 0.62,
            recentSelectionMin: 2,
          })
        : Promise.resolve([]),
    ]);

  const candidateBuild = await buildLandscapeReviewItemCandidates({
    generatedAt,
    runStatus: input.runStatus,
    sources: input.sources,
    appliesToRefineCandidates: comparison?.appliesToRefineCandidates ?? [],
    landscapeSnapshot,
    landscapeReplaySnapshot,
    landscapeReplayComparison: comparison,
    contradictionCandidates,
  });
  const prioritizedCandidates = sortCandidatesForMaterialize(
    uniqueCandidatesByIdempotencyKey(candidateBuild.candidates),
  );
  const materializeCandidates = prioritizedCandidates.slice(0, input.materializeLimit);
  const skippedCount = Math.max(0, prioritizedCandidates.length - materializeCandidates.length);

  if (input.dryRun) {
    return {
      dryRun: true,
      generatedAt: candidateBuild.generatedAt,
      candidateCount: prioritizedCandidates.length,
      insertedCount: 0,
      existingCount: 0,
      skippedCount,
      items: [],
      candidates: materializeCandidates,
    };
  }

  const { inserted, existing } = await insertLandscapeReviewItemsIdempotent(materializeCandidates);
  const rowByKey = new Map(
    [...inserted, ...existing].map((row) => [row.idempotencyKey, row] as const),
  );
  const items = materializeCandidates
    .map((candidate) => rowByKey.get(candidate.idempotencyKey))
    .filter((row): row is LandscapeReviewItemRow => Boolean(row))
    .map(mapReviewItemRow);

  await recordAuditLogSafe({
    eventType: auditEventTypes.landscapeReviewItemsMaterialized,
    actor: "agent",
    payload: {
      dryRun: false,
      candidateCount: prioritizedCandidates.length,
      insertedCount: inserted.length,
      existingCount: existing.length,
      skippedCount,
      sourceCount: input.sources.length,
      runStatus: input.runStatus,
      windowDays: input.windowDays,
    },
  });

  return {
    dryRun: false,
    generatedAt: candidateBuild.generatedAt,
    candidateCount: prioritizedCandidates.length,
    insertedCount: inserted.length,
    existingCount: existing.length,
    skippedCount,
    items,
    candidates: materializeCandidates,
  };
}

export async function listLandscapeReviewItems(
  input: ListLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemListResult> {
  const [rows, count] = await Promise.all([
    listLandscapeReviewItemRows(input),
    countLandscapeReviewItemRows(input),
  ]);
  const items = rows.map(mapReviewItemRow);
  return {
    items,
    count,
  };
}

function labelToConfidenceScore(value: LandscapeReviewItem["confidence"]): number {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.75;
  return 0.5;
}

function parseConfidenceFromPayload(payload: Record<string, unknown>): number | null {
  const raw = Number(payload.confidence);
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

function contradictionIdsFromPayload(
  item: LandscapeReviewItem,
  payload: Record<string, unknown>,
): { leftKnowledgeId: string; rightKnowledgeId: string } | null {
  const leftKnowledgeId =
    typeof payload.leftKnowledgeId === "string"
      ? payload.leftKnowledgeId.trim()
      : (item.knowledgeId ?? "").trim();
  const rightKnowledgeId =
    typeof payload.rightKnowledgeId === "string" ? payload.rightKnowledgeId.trim() : "";

  if (!leftKnowledgeId || !rightKnowledgeId) return null;
  return {
    leftKnowledgeId,
    rightKnowledgeId,
  };
}

export async function listLandscapeContradictionOverlay(
  input: LandscapeContradictionOverlayQuery,
): Promise<LandscapeContradictionOverlayList> {
  const list = await listLandscapeReviewItems({
    status: input.status,
    source: "contradiction_detection",
    reason: "contradiction_review",
    proposedAction: "all",
    priorityMin: 0,
    limit: input.limit,
  });

  const items = list.items
    .map((item) => {
      const payload = asRecord(item.payload);
      const ids = contradictionIdsFromPayload(item, payload);
      if (!ids) return null;

      const confidence =
        parseConfidenceFromPayload(payload) ?? labelToConfidenceScore(item.confidence);
      if (confidence < input.confidenceMin) return null;

      const pairKeyRaw = typeof payload.pairKey === "string" ? payload.pairKey.trim() : "";
      const pairKey = pairKeyRaw || `${ids.leftKnowledgeId}::${ids.rightKnowledgeId}`;

      return {
        reviewItemId: item.id,
        leftKnowledgeId: ids.leftKnowledgeId,
        rightKnowledgeId: ids.rightKnowledgeId,
        pairKey,
        confidence: Number(confidence.toFixed(4)),
        confidenceLabel: item.confidence,
        status: item.status,
        evidence: item.evidence,
        communityKey: item.communityKey,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    })
    .filter((item): item is LandscapeContradictionOverlayList["items"][number] => item !== null);

  return {
    items,
    count: items.length,
  };
}

export async function updateLandscapeReviewItemStatus(
  input: UpdateLandscapeReviewItemStatusInput,
): Promise<LandscapeReviewItem | null> {
  const row = await findLandscapeReviewItemRowById(input.id);
  if (!row) return null;

  const currentStatusParsed = landscapeReviewItemStatusSchema.safeParse(row.status);
  if (!currentStatusParsed.success) {
    throw new LandscapeReviewItemsError(409, `invalid current status: ${row.status}`);
  }
  const currentStatus = currentStatusParsed.data;

  if (input.status === currentStatus) {
    return mapReviewItemRow(row);
  }

  if (!allowedTransitions[currentStatus].includes(input.status)) {
    throw new LandscapeReviewItemsError(
      409,
      `invalid status transition: ${currentStatus} -> ${input.status}`,
    );
  }

  const now = new Date();
  const resolvedAt = input.status === "resolved" || input.status === "dismissed" ? now : null;
  const updated = await updateLandscapeReviewItemRow({
    id: input.id,
    status: input.status,
    note: input.note,
    resolvedAt,
    updatedAt: now,
  });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.landscapeReviewItemStatusChanged,
    actor: "agent",
    payload: {
      id: input.id,
      previousStatus: currentStatus,
      status: input.status,
      note: input.note ?? null,
    },
  });

  return mapReviewItemRow(updated);
}
