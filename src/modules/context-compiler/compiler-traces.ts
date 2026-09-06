import type { ContextPackItem } from "../../shared/schemas/context-pack.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import { recordAuditLogSafe } from "../audit/audit-log.service.js";
import type {
  KnowledgeCandidateEvidence,
  KnowledgeRetrievalTraceEntry,
} from "../knowledge/knowledge.service.js";
import type { KnowledgeRankable } from "./compiler-diagnostics.js";
import { insertContextCompileCandidateTraces } from "./context-compiler.repository.js";
import type { DuplicateSuppressionInfo } from "./duplicate-suppression.service.js";
import { explainRankableScore } from "./ranking.service.js";
import type { collectUtilityTraceCandidates } from "./utility-retrieval.service.js";

export type CandidateTraceDraftRow = {
  itemKind: "rule" | "procedure";
  itemId: string;
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
  evidence: Record<string, unknown>;
};

export function toStageRankMap(
  entries: KnowledgeRetrievalTraceEntry[] | undefined,
): Map<string, { rank: number; score: number }> {
  const map = new Map<string, { rank: number; score: number }>();
  for (const entry of entries ?? []) {
    if (!entry.id || map.has(entry.id)) continue;
    map.set(entry.id, {
      rank: entry.rank,
      score: entry.score,
    });
  }
  return map;
}

export function mergeCompileRetrievalTraceEntries(
  entries: KnowledgeRetrievalTraceEntry[],
): KnowledgeRetrievalTraceEntry[] {
  const bestById = new Map<string, number>();
  for (const entry of entries) {
    const current = bestById.get(entry.id);
    if (typeof current !== "number" || entry.score > current) {
      bestById.set(entry.id, entry.score);
    }
  }
  return [...bestById.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id, score], index) => ({
      id,
      score,
      rank: index + 1,
    }));
}

export function resolveCommunityKeyFromMetadata(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const direct =
    typeof record.communityKey === "string"
      ? record.communityKey
      : typeof record.relationCommunityKey === "string"
        ? record.relationCommunityKey
        : null;
  if (direct?.trim()) return direct.trim();
  const landscape = asRecord(record.landscape);
  const fromLandscape = typeof landscape.communityKey === "string" ? landscape.communityKey : null;
  if (fromLandscape?.trim()) return fromLandscape.trim();
  return null;
}

export function sortCandidateTraceRows(rows: CandidateTraceDraftRow[]): CandidateTraceDraftRow[] {
  return [...rows].sort((left, right) => {
    const leftSelected = left.selected ? 0 : 1;
    const rightSelected = right.selected ? 0 : 1;
    if (leftSelected !== rightSelected) return leftSelected - rightSelected;

    const leftFinal = left.finalRank ?? Number.MAX_SAFE_INTEGER;
    const rightFinal = right.finalRank ?? Number.MAX_SAFE_INTEGER;
    if (leftFinal !== rightFinal) return leftFinal - rightFinal;

    const leftMerged = left.mergedRank ?? Number.MAX_SAFE_INTEGER;
    const rightMerged = right.mergedRank ?? Number.MAX_SAFE_INTEGER;
    if (leftMerged !== rightMerged) return leftMerged - rightMerged;

    return left.itemId.localeCompare(right.itemId);
  });
}

export function candidateDropClassification(params: {
  selected: boolean;
  duplicateSuppression: DuplicateSuppressionInfo | undefined;
  suppressionReason: string | null;
}): { dropStage: string; dropReason: string } {
  if (params.selected) {
    return { dropStage: "selected", dropReason: "selected" };
  }
  if (params.duplicateSuppression) {
    return { dropStage: "suppressed_duplicate", dropReason: "near_duplicate" };
  }
  if (params.suppressionReason === "agentic_rejected") {
    return { dropStage: "agentic_rejected", dropReason: "agentic_rejected" };
  }
  if (params.suppressionReason === "token_budget_section_limit") {
    return { dropStage: "ranked_but_budgeted_out", dropReason: "section_token_budget" };
  }
  return { dropStage: "retrieved_but_ranked_out", dropReason: "below_final_rank_limit" };
}

export function buildCandidateTraceRows(params: {
  knowledgeItems: Array<{
    id: string;
    type: KnowledgeItem["type"];
    status: KnowledgeStatus;
    score: number;
    metadata?: Record<string, unknown>;
    candidateEvidence?: KnowledgeCandidateEvidence;
    scopeSnapshot?: Record<string, unknown>;
  }>;
  rankedKnowledgeBeforeIntervention: KnowledgeRankable[];
  filteredKnowledge: KnowledgeRankable[];
  finalKnowledge: KnowledgeRankable[];
  duplicateSuppressedById: Map<string, DuplicateSuppressionInfo>;
  selectedPackItems: ContextPackItem[];
  retrievalTrace: {
    text: KnowledgeRetrievalTraceEntry[];
    vector: KnowledgeRetrievalTraceEntry[];
    merged: KnowledgeRetrievalTraceEntry[];
  } | null;
  agenticUsed: boolean;
}): CandidateTraceDraftRow[] {
  const knowledgeById = new Map<
    string,
    {
      id: string;
      type: KnowledgeItem["type"];
      status: KnowledgeStatus;
      score: number;
      metadata?: Record<string, unknown>;
      candidateEvidence?: KnowledgeCandidateEvidence;
      scopeSnapshot?: Record<string, unknown>;
    }
  >();
  for (const item of params.knowledgeItems) {
    knowledgeById.set(item.id, item);
  }
  for (const item of params.rankedKnowledgeBeforeIntervention) {
    if (knowledgeById.has(item.id)) continue;
    knowledgeById.set(item.id, {
      id: item.id,
      type: item.type,
      status: item.status,
      score: item.score,
      candidateEvidence: item.candidateEvidence,
      scopeSnapshot: item.scopeSnapshot,
    });
  }

  const textRanks = toStageRankMap(params.retrievalTrace?.text);
  const vectorRanks = toStageRankMap(params.retrievalTrace?.vector);
  const mergedRanks = toStageRankMap(params.retrievalTrace?.merged);
  const finalRanks = new Map<string, { rank: number; score: number }>();
  for (const [index, item] of params.finalKnowledge.entries()) {
    if (finalRanks.has(item.id)) continue;
    const scoreExplanation = explainRankableScore(item);
    finalRanks.set(item.id, {
      rank: index + 1,
      score: scoreExplanation.weightedScore,
    });
  }

  const filteredIds = new Set(params.filteredKnowledge.map((item) => item.id));
  const finalIds = new Set(params.finalKnowledge.map((item) => item.id));
  const rankedIds = new Set(params.rankedKnowledgeBeforeIntervention.map((item) => item.id));
  const rankableById = new Map<string, KnowledgeRankable>();
  for (const item of params.rankedKnowledgeBeforeIntervention) rankableById.set(item.id, item);
  for (const item of params.filteredKnowledge) rankableById.set(item.id, item);
  for (const item of params.finalKnowledge) rankableById.set(item.id, item);
  const selectedItemById = new Map(
    params.selectedPackItems.map((item) => [item.itemId, item.rankingReason] as const),
  );

  const candidateIds = new Set<string>();
  for (const key of textRanks.keys()) candidateIds.add(key);
  for (const key of vectorRanks.keys()) candidateIds.add(key);
  for (const key of mergedRanks.keys()) candidateIds.add(key);
  for (const key of finalRanks.keys()) candidateIds.add(key);
  for (const key of rankedIds.keys()) candidateIds.add(key);
  for (const key of selectedItemById.keys()) candidateIds.add(key);

  const rows: CandidateTraceDraftRow[] = [];
  for (const itemId of candidateIds) {
    const knowledge = knowledgeById.get(itemId);
    if (!knowledge) continue;
    const itemKind = knowledge.type === "procedure" ? "procedure" : "rule";
    const text = textRanks.get(itemId);
    const vector = vectorRanks.get(itemId);
    const merged = mergedRanks.get(itemId);
    const final = finalRanks.get(itemId);
    const selected = selectedItemById.has(itemId);
    const duplicateSuppression = params.duplicateSuppressedById.get(itemId);
    const rankable = rankableById.get(itemId);

    let suppressionReason: string | null = null;
    if (duplicateSuppression) {
      suppressionReason = "near_duplicate_suppressed";
    } else if (!filteredIds.has(itemId) && rankedIds.has(itemId)) {
      suppressionReason = "low_confidence_vector_only";
    } else if (filteredIds.has(itemId) && !finalIds.has(itemId) && params.agenticUsed) {
      suppressionReason = "agentic_rejected";
    } else if (finalIds.has(itemId) && !selected) {
      suppressionReason = "token_budget_section_limit";
    }

    const agenticDecision: CandidateTraceDraftRow["agenticDecision"] = !params.agenticUsed
      ? "not_evaluated"
      : finalIds.has(itemId)
        ? "accepted"
        : filteredIds.has(itemId)
          ? "rejected"
          : "skipped";
    const drop = candidateDropClassification({
      selected,
      duplicateSuppression,
      suppressionReason,
    });

    rows.push({
      itemKind,
      itemId,
      textRank: text?.rank ?? null,
      textScore: text?.score ?? null,
      vectorRank: vector?.rank ?? null,
      vectorScore: vector?.score ?? null,
      mergedRank: merged?.rank ?? null,
      mergedScore: merged?.score ?? null,
      finalRank: final?.rank ?? null,
      finalScore: final?.score ?? null,
      selected,
      suppressed: Boolean(suppressionReason),
      suppressionReason,
      agenticDecision,
      rankingReason:
        selectedItemById.get(itemId) ??
        (duplicateSuppression
          ? `near_duplicate_suppressed:${duplicateSuppression.representativeId}`
          : suppressionReason),
      communityKey: resolveCommunityKeyFromMetadata(knowledge.metadata),
      evidence: {
        dropStage: drop.dropStage,
        dropReason: drop.dropReason,
        status: knowledge.status,
        candidateEvidence: knowledge.candidateEvidence ?? null,
        scopeSnapshot: knowledge.scopeSnapshot ?? null,
        rankingScore: rankable
          ? explainRankableScore(rankable)
          : explainRankableScore({
              id: knowledge.id,
              title: "",
              content: "",
              score: knowledge.score,
              status: knowledge.status,
              stale: knowledge.status === "deprecated",
            }),
        duplicateSuppression: duplicateSuppression
          ? {
              representativeId: duplicateSuppression.representativeId,
              reason: duplicateSuppression.reason,
              confidence: duplicateSuppression.confidence,
            }
          : null,
      },
    });
  }

  return sortCandidateTraceRows(rows);
}

export function mergeUtilityTraceCandidates(
  rows: CandidateTraceDraftRow[],
  utilityCandidates: Awaited<ReturnType<typeof collectUtilityTraceCandidates>>,
): CandidateTraceDraftRow[] {
  if (utilityCandidates.length === 0) return rows;
  const byKey = new Map<string, CandidateTraceDraftRow>(
    rows.map((row) => [`${row.itemKind}:${row.itemId}`, row]),
  );
  const mergedRows = [...rows];
  for (const candidate of utilityCandidates) {
    const key = `${candidate.itemKind}:${candidate.itemId}`;
    const existing = byKey.get(key);
    if (existing) {
      const utilitySignals = asRecord(existing.evidence.utilitySignals);
      existing.evidence = {
        ...existing.evidence,
        utilitySignals: {
          ...utilitySignals,
          [candidate.lane]: candidate.evidence,
        },
      };
      continue;
    }
    const row: CandidateTraceDraftRow = {
      itemKind: candidate.itemKind,
      itemId: candidate.itemId,
      textRank: null,
      textScore: null,
      vectorRank: null,
      vectorScore: null,
      mergedRank: null,
      mergedScore: null,
      finalRank: null,
      finalScore: null,
      selected: false,
      suppressed: false,
      suppressionReason: null,
      agenticDecision: "not_evaluated",
      rankingReason: candidate.rankingReason,
      communityKey: null,
      evidence: {
        ...candidate.evidence,
        utilityScore: candidate.score,
      },
    };
    byKey.set(key, row);
    mergedRows.push(row);
  }
  return sortCandidateTraceRows(mergedRows);
}

export function applyCandidateTraceLimit(
  rows: CandidateTraceDraftRow[],
  traceLimit: number,
): { rows: CandidateTraceDraftRow[]; truncated: boolean } {
  if (rows.length <= traceLimit) {
    return { rows, truncated: false };
  }

  const selectedRows = rows.filter((row) => row.selected);
  const selectedIds = new Set(selectedRows.map((row) => row.itemId));
  const isUtilityTraceRow = (row: CandidateTraceDraftRow) =>
    row.evidence.traceOnly === true || typeof row.evidence.utilityLane === "string";
  const utilityTraceScore = (row: CandidateTraceDraftRow) =>
    typeof row.evidence.utilityScore === "number" ? row.evidence.utilityScore : 0;
  const utilityRows = rows
    .filter((row) => !selectedIds.has(row.itemId) && isUtilityTraceRow(row))
    .sort(
      (left, right) =>
        utilityTraceScore(right) - utilityTraceScore(left) ||
        left.itemId.localeCompare(right.itemId),
    );
  const utilityIds = new Set(utilityRows.map((row) => row.itemId));
  const remaining = rows
    .filter((row) => !selectedIds.has(row.itemId) && !utilityIds.has(row.itemId))
    .sort((left, right) => {
      const leftMerged = left.mergedRank ?? Number.MAX_SAFE_INTEGER;
      const rightMerged = right.mergedRank ?? Number.MAX_SAFE_INTEGER;
      if (leftMerged !== rightMerged) return leftMerged - rightMerged;
      const leftFinal = left.finalRank ?? Number.MAX_SAFE_INTEGER;
      const rightFinal = right.finalRank ?? Number.MAX_SAFE_INTEGER;
      if (leftFinal !== rightFinal) return leftFinal - rightFinal;
      return left.itemId.localeCompare(right.itemId);
    });

  const remainingCapacity = Math.max(0, traceLimit - selectedRows.length);
  const selectedUtilityRows = utilityRows.slice(0, remainingCapacity);
  const finalRemainingCapacity = Math.max(0, remainingCapacity - selectedUtilityRows.length);
  const limited = [
    ...selectedRows,
    ...selectedUtilityRows,
    ...remaining.slice(0, finalRemainingCapacity),
  ];
  return {
    rows: sortCandidateTraceRows(limited),
    truncated: limited.length < rows.length,
  };
}

export async function persistCandidateTraceRows(params: {
  runId: string;
  rows: CandidateTraceDraftRow[];
  traceLimit: number;
}): Promise<{
  savedCount: number;
  truncated: boolean;
  skippedReason: string | null;
}> {
  if (params.rows.length === 0) {
    return {
      savedCount: 0,
      truncated: false,
      skippedReason: "no_candidate_rows",
    };
  }

  const limited = applyCandidateTraceLimit(params.rows, params.traceLimit);
  try {
    await insertContextCompileCandidateTraces(params.runId, limited.rows);
    return {
      savedCount: limited.rows.length,
      truncated: limited.truncated,
      skippedReason: null,
    };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "CONTEXT_COMPILE_CANDIDATE_TRACE_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        traceLimit: params.traceLimit,
        candidateCount: params.rows.length,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      savedCount: 0,
      truncated: false,
      skippedReason: "save_failed",
    };
  }
}
