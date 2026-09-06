import { createHash } from "node:crypto";
import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { normalizeFacetArray } from "../../shared/utils/normalize.js";
import { recordAuditLogSafe } from "../audit/audit-log.service.js";
import { recordCompileRunKnowledgeUsageSignals } from "../knowledge/knowledge-feedback.service.js";
import { upsertContextCompileTaskTrace } from "./context-compile-task-trace.repository.js";
import {
  updateCompileRunFailure,
  updateCompileRunSnapshot,
} from "./context-compiler.repository.js";

export async function updateCompileRunSnapshotSafe(
  runId: string,
  pack: ContextPack,
): Promise<boolean> {
  try {
    await updateCompileRunSnapshot(runId, pack);
    return true;
  } catch {
    return false;
  }
}

export async function updateCompileRunFailureSafe(params: {
  runId: string;
  degradedReasons: string[];
  durationMs: number;
  pack: ContextPack;
}): Promise<boolean> {
  try {
    await updateCompileRunFailure(params);
    return true;
  } catch {
    return false;
  }
}

export function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

export async function recordCompileRunKnowledgeUsageSignalsSafe(params: {
  runId: string;
  selectedKnowledgeIds: string[];
  selectedRankMap: Map<string, number>;
  agenticAcceptedKnowledgeIds: string[];
  usedKnowledge: Array<{
    id: string;
    confidence?: number;
    evidence?: string;
    outputSection?: string;
    reason?: string;
  }>;
  actor: "agent" | "system";
  scopeSnapshotByKnowledgeId: Map<string, Record<string, unknown>>;
}): Promise<void> {
  const selectedSet = new Set(params.selectedKnowledgeIds.map((id) => id.trim()).filter(Boolean));
  if (selectedSet.size === 0) return;
  const agenticAcceptedSet = new Set(
    params.agenticAcceptedKnowledgeIds.map((id) => id.trim()).filter((id) => selectedSet.has(id)),
  );

  const usedById = new Map<
    string,
    {
      confidence: number;
      evidence?: string;
      outputSection?: string;
      reason?: string;
    }
  >();
  for (const item of params.usedKnowledge) {
    const knowledgeId = item.id.trim();
    if (!selectedSet.has(knowledgeId)) continue;
    usedById.set(knowledgeId, {
      confidence: normalizeConfidence(item.confidence),
      ...(item.evidence ? { evidence: item.evidence } : {}),
      ...(item.outputSection ? { outputSection: item.outputSection } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }

  const usageItems = [...selectedSet].map((knowledgeId) => {
    const used = usedById.get(knowledgeId);
    const selectedRank = params.selectedRankMap.get(knowledgeId);
    if (used) {
      return {
        knowledgeId,
        verdict: "used" as const,
        reason: used.reason ?? "used_by_response_composer",
        metadata: {
          source: "response_composer",
          signalSource: "context_response_composer",
          agenticAccepted: agenticAcceptedSet.has(knowledgeId),
          confidence: used.confidence,
          ...(used.evidence ? { evidence: used.evidence } : {}),
          ...(used.outputSection ? { outputSection: used.outputSection } : {}),
          ...(selectedRank ? { selectedRank } : {}),
          scopeSnapshot: params.scopeSnapshotByKnowledgeId.get(knowledgeId) ?? {},
        },
      };
    }
    return {
      knowledgeId,
      verdict: "not_used" as const,
      reason: "selected_but_not_referenced",
      metadata: {
        source: "response_composer",
        signalSource: "context_response_composer",
        agenticAccepted: agenticAcceptedSet.has(knowledgeId),
        ...(selectedRank ? { selectedRank } : {}),
        scopeSnapshot: params.scopeSnapshotByKnowledgeId.get(knowledgeId) ?? {},
      },
    };
  });

  try {
    await recordCompileRunKnowledgeUsageSignals({
      runId: params.runId,
      actor: params.actor,
      items: usageItems,
    });
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "KNOWLEDGE_USAGE_SIGNAL_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        selectedKnowledgeIds: params.selectedKnowledgeIds,
        agenticAcceptedKnowledgeIds: params.agenticAcceptedKnowledgeIds,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function goalHash(goal: string): string {
  return createHash("sha1").update(goal.trim()).digest("hex");
}

export async function persistCompileTaskTraceSafe(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  projectRef: string | null;
  repoPath: string | null;
  repoKey: string | null;
  matchBasis: "project_ref" | "repo_key" | "repo_path" | "none";
  identityContractVersion: number;
  scopeMode: "global_only" | "project";
  identityFingerprint: string | null;
  identityTrust: "request_hint" | "trusted_adapter";
  bindingStatus: "verified" | "not_applicable" | "unverified";
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  goal: string;
  embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
}): Promise<void> {
  try {
    await upsertContextCompileTaskTrace({
      runId: params.runId,
      retrievalMode: params.retrievalMode,
      projectRef: params.projectRef,
      repoPath: params.repoPath,
      repoKey: params.repoKey,
      matchBasis: params.matchBasis,
      identityContractVersion: params.identityContractVersion,
      scopeMode: params.scopeMode,
      identityFingerprint: params.identityFingerprint,
      identityTrust: params.identityTrust,
      bindingStatus: params.bindingStatus,
      technologies: normalizeFacetArray(params.technologies),
      changeTypes: normalizeFacetArray(params.changeTypes),
      domains: normalizeFacetArray(params.domains),
      embeddingStatus: params.embeddingStatus,
      embeddingProvider: params.embeddingProvider,
      embeddingModel: params.embeddingModel,
      embeddingDimensions: params.embeddingDimensions,
      embedding: params.embedding,
      goalHash: goalHash(params.goal),
    });
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "CONTEXT_COMPILE_TASK_TRACE_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        retrievalMode: params.retrievalMode,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
