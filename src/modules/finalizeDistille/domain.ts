import { groupedConfig } from "../../config.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  coverEvidenceResultFromRow,
  selectCoverEvidenceResultById,
} from "../coverEvidence/repository.js";
import type { CoverEvidenceReference, CoverEvidenceResult } from "../coverEvidence/types.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  assessProcedureQuality,
  hasSkillLikeProcedureBody,
  validateCandidateQualityForStorage,
} from "../distillation/procedure-quality.js";
import { embedOne } from "../embedding/embedding.service.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import {
  applicabilityFromCoverCandidate,
  missingRequiredApplicabilityFacets,
} from "../knowledge/applicability.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import {
  getLandscapeReviewLinkForFinalize,
  getLandscapeReviewLinkForFinalizeByFoundCandidate,
  markLandscapeReviewLinkFinalizedForCandidate,
  markLandscapeReviewLinkFinalizedForFoundCandidate,
  markLandscapeReviewLinkReviewRequiredForCandidate,
  markLandscapeReviewLinkReviewRequiredForFoundCandidate,
} from "../landscape/landscape-review-candidate.service.js";
import {
  type FinalizeCandidateContext,
  type FinalizeSummary,
  buildFinalizeSummary,
  prepareFinalizeCandidate,
  restructureProcedureCandidate,
} from "./anonymization.service.js";
import { findSourceFragmentByReference, selectKnowledgeByFinalizeSourceUri } from "./repository.js";
import { linkKnowledgeToOrigin, linkKnowledgeToSourceFragment } from "./source-link.repository.js";

export type FinalizeDistilleInput = {
  coverEvidenceResultId: string;
  resultOverride?: CoverEvidenceResult;
  candidateContext?: FinalizeCandidateContext;
  write?: boolean;
  signal?: AbortSignal;
};

export type FinalizeDistilleResult = {
  coverEvidenceResultId: string;
  knowledgeId: string | null;
  status: "stored" | "dry_run" | "rejected";
  embeddingStatus: "stored" | "unavailable" | "failed";
  sourceReferenceCount: number;
  sourceLinkCount: number;
  reason: string | null;
  finalizeSummary: FinalizeSummary;
};

const FINALIZE_SOURCE_PREFIX = "cover-evidence-result://";

function finalizeSourceUri(coverEvidenceResultId: string): string {
  return `${FINALIZE_SOURCE_PREFIX}${coverEvidenceResultId}`;
}

function embeddingStatusFromError(error: unknown): FinalizeDistilleResult["embeddingStatus"] {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("disabled") || lowered.includes("no embedding provider available")) {
    return "unavailable";
  }
  return "failed";
}

function unitConfidence(confidence: number | undefined): number {
  const normalized = Number(confidence ?? 70);
  if (!Number.isFinite(normalized)) return 0.7;
  if (normalized <= 1) return Math.max(0, Math.min(1, normalized));
  return Math.max(0, Math.min(1, normalized / 100));
}

function sourceLinkCandidate(reference: CoverEvidenceReference): boolean {
  return reference.kind === "source" && reference.evidenceRole === "supports_candidate";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  throw error;
}

async function linkResolvableSourceReferences(params: {
  knowledgeId: string;
  references: CoverEvidenceReference[];
  metadataReferences?: CoverEvidenceReference[];
  confidence: number;
  coverEvidenceResultId: string;
}): Promise<number> {
  let linked = 0;
  for (const [index, reference] of params.references.entries()) {
    if (!sourceLinkCandidate(reference)) continue;
    const fragment = await findSourceFragmentByReference({
      uri: reference.uri,
      locator: reference.locator,
    });
    if (!fragment) continue;
    await linkKnowledgeToSourceFragment({
      knowledgeId: params.knowledgeId,
      sourceFragmentId: fragment.sourceFragmentId,
      confidence: params.confidence,
      metadata: {
        source: "finalizeDistille",
        coverEvidenceResultId: params.coverEvidenceResultId,
        reference: params.metadataReferences?.[index] ?? {
          ...reference,
          uri: "the source document",
          locator: reference.locator ? "the source locator" : undefined,
        },
      },
    });
    linked += 1;
  }
  return linked;
}

function originKindForFinalizeContext(
  context: FinalizeCandidateContext,
):
  | "vibe_memory"
  | "episode_card"
  | "agent_candidate"
  | "landscape_review_item"
  | "review_finding"
  | "external_review_run"
  | "review_correction" {
  if (context.targetKind === "vibe_memory") return "vibe_memory";
  if (context.sourceUri.startsWith("landscape://")) return "landscape_review_item";
  if (context.sourceUri.startsWith("review:") || context.sourceUri.startsWith("manual_review:")) {
    return "review_finding";
  }
  if (context.targetKind === "knowledge_candidate") return "agent_candidate";
  if (context.targetKind === "web_ingest") return "external_review_run";
  return "agent_candidate";
}

async function linkNegativeKnowledgeOrigin(params: {
  knowledgeId: string;
  candidateContext: FinalizeCandidateContext;
  coverEvidenceResultId: string;
  confidence: number;
  enabled: boolean;
}): Promise<void> {
  if (!params.enabled) return;
  const originUri = params.candidateContext.sourceUri.trim();
  if (!originUri) return;
  await linkKnowledgeToOrigin({
    knowledgeId: params.knowledgeId,
    originKind: originKindForFinalizeContext(params.candidateContext),
    originUri,
    originKey: params.candidateContext.targetKey || originUri,
    confidence: params.confidence,
    metadata: {
      source: "finalizeDistille",
      coverEvidenceResultId: params.coverEvidenceResultId,
      findCandidateResultId: params.candidateContext.findCandidateResultId ?? null,
      foundCandidateId: params.candidateContext.foundCandidateId || null,
      targetKind: params.candidateContext.targetKind,
    },
  });
}

function rejectedResult(
  coverEvidenceResultId: string,
  result: CoverEvidenceResult | null,
  reason: string,
  finalizeSummary = buildFinalizeSummary({
    decision: "rejected",
    reason,
  }),
): FinalizeDistilleResult {
  return {
    coverEvidenceResultId,
    knowledgeId: null,
    status: "rejected",
    embeddingStatus: "unavailable",
    sourceReferenceCount: result?.references.length ?? 0,
    sourceLinkCount: 0,
    reason,
    finalizeSummary,
  };
}

async function getLandscapeLinkForContext(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<{
  status: "draft_created" | "review_required" | "approved" | "rejected" | "finalized";
  linkId: string;
} | null> {
  if (params.foundCandidateId) {
    return getLandscapeReviewLinkForFinalizeByFoundCandidate(params.foundCandidateId);
  }
  if (params.findCandidateResultId) {
    return getLandscapeReviewLinkForFinalize(params.findCandidateResultId);
  }
  return null;
}

async function markLandscapeReviewRequired(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<void> {
  if (params.foundCandidateId) {
    await markLandscapeReviewLinkReviewRequiredForFoundCandidate(params.foundCandidateId);
    return;
  }
  if (params.findCandidateResultId) {
    await markLandscapeReviewLinkReviewRequiredForCandidate(params.findCandidateResultId);
  }
}

async function markLandscapeFinalized(params: {
  findCandidateResultId?: string | null;
  foundCandidateId?: string | null;
}): Promise<void> {
  if (params.foundCandidateId) {
    await markLandscapeReviewLinkFinalizedForFoundCandidate(params.foundCandidateId);
    return;
  }
  if (params.findCandidateResultId) {
    await markLandscapeReviewLinkFinalizedForCandidate(params.findCandidateResultId);
  }
}

export async function runFinalizeDistille(
  input: FinalizeDistilleInput,
): Promise<FinalizeDistilleResult> {
  throwIfAborted(input.signal);
  const coverEvidenceResultId = input.coverEvidenceResultId.trim();
  if (!coverEvidenceResultId) {
    throw new Error("coverEvidenceResultId is required");
  }

  let result: CoverEvidenceResult;
  if (input.resultOverride) {
    result = input.resultOverride;
  } else {
    const row = await selectCoverEvidenceResultById(coverEvidenceResultId);
    throwIfAborted(input.signal);
    if (!row) {
      throw new Error(`cover evidence result not found: ${coverEvidenceResultId}`);
    }
    result = coverEvidenceResultFromRow(row);
  }
  const sourceReferenceCount = result.references.length;

  if (result.status !== "knowledge_ready" || !result.candidate) {
    return rejectedResult(
      coverEvidenceResultId,
      result,
      result.reason ?? `cover evidence status is ${result.status}`,
    );
  }

  if (result.candidate.importance <= groupedConfig.distillation.lowImportanceRejectThreshold) {
    return rejectedResult(coverEvidenceResultId, result, "low_importance");
  }

  let candidate = result.candidate;
  const restructured = restructureProcedureCandidate(candidate);
  const finalizeToolEvents = restructured
    ? [...result.toolEvents, restructured.event]
    : result.toolEvents;
  if (restructured) {
    candidate = restructured.candidate;
  }

  let demotionReason: string | null = null;
  if (candidate.type === "rule") {
    const validation = validateCandidateQualityForStorage(candidate);
    if (validation.action === "reject") {
      return rejectedResult(coverEvidenceResultId, result, validation.reason);
    }
  } else if (candidate.type === "procedure" && !hasSkillLikeProcedureBody(candidate.body)) {
    const decision = assessProcedureQuality({ title: candidate.title, body: candidate.body });
    if (decision.action === "demote_to_rule") {
      candidate = {
        ...candidate,
        type: "rule",
      };
      demotionReason = decision.reason;
    } else {
      return rejectedResult(
        coverEvidenceResultId,
        result,
        decision.action === "reject_insufficient"
          ? decision.reason
          : PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
      );
    }
  }

  const missingFacets = missingRequiredApplicabilityFacets(candidate);
  if (missingFacets.length > 0) {
    return rejectedResult(coverEvidenceResultId, result, "applies_to_categories_required");
  }
  const authoritativeProjectIdentity = {
    repoPath: candidate.repoPath,
    repoKey: candidate.repoKey,
  };

  let candidateContext = input.candidateContext;
  if (!candidateContext) {
    const candidateRow = await getFindCandidateResultById(coverEvidenceResultId);
    if (!candidateRow) {
      throw new Error(`find candidate result not found: ${coverEvidenceResultId}`);
    }
    candidateContext = {
      foundCandidateId: "",
      targetStateId: candidateRow.targetStateId,
      findCandidateResultId: coverEvidenceResultId,
      targetKind: candidateRow.targetKind,
      targetKey: candidateRow.targetKey,
      sourceUri: candidateRow.sourceUri,
    };
  }

  const landscapeLink = await getLandscapeLinkForContext({
    findCandidateResultId: candidateContext.findCandidateResultId,
    foundCandidateId: candidateContext.foundCandidateId || null,
  });
  const requiresLandscapeApproval =
    candidateContext.targetKind === "knowledge_candidate" && Boolean(landscapeLink);
  if (
    requiresLandscapeApproval &&
    landscapeLink &&
    landscapeLink.status !== "approved" &&
    landscapeLink.status !== "finalized"
  ) {
    if (input.write) {
      await markLandscapeReviewRequired({
        findCandidateResultId: candidateContext.findCandidateResultId,
        foundCandidateId: candidateContext.foundCandidateId || null,
      });
    }
    return rejectedResult(coverEvidenceResultId, result, "landscape_manual_approval_required");
  }

  const sourceUri = finalizeSourceUri(coverEvidenceResultId);
  const finalizedAt = new Date().toISOString();
  const prepared = prepareFinalizeCandidate({
    candidate,
    context: candidateContext,
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: finalizeToolEvents,
  });
  candidate = prepared.candidate;
  const postAnonymizationValidation = validateCandidateQualityForStorage(candidate);
  if (postAnonymizationValidation.action === "reject") {
    return rejectedResult(
      coverEvidenceResultId,
      result,
      postAnonymizationValidation.reason,
      buildFinalizeSummary({
        decision: "rejected",
        reason: postAnonymizationValidation.reason,
        anonymization: prepared.anonymization,
        qualityGates: ["importance", "candidate_quality", "applicability", "anonymization"],
      }),
    );
  }
  const finalizeSummary = buildFinalizeSummary({
    decision: input.write ? "stored" : "dry_run",
    anonymization: prepared.anonymization,
    qualityGates: ["importance", "candidate_quality", "applicability", "embedding"],
  });
  const metadata = {
    sourceUri,
    coverEvidenceResultId,
    findCandidateResultId: candidateContext.findCandidateResultId ?? null,
    foundCandidateId: candidateContext.foundCandidateId || null,
    targetStateId: candidateContext.targetStateId ?? null,
    targetKind: candidateContext.targetKind,
    targetKey: "the source target",
    sourceDocumentUri: "the source document",
    references: prepared.references,
    duplicateRefs: prepared.duplicateRefs,
    toolEvents: demotionReason
      ? [
          ...prepared.toolEvents,
          {
            name: "procedure_demoted_to_rule",
            ok: true,
            metadata: {
              reason: demotionReason,
              source: "finalizeDistille",
            },
          },
        ]
      : prepared.toolEvents,
    finalizeSummary,
    anonymization: prepared.anonymization,
    origin: {
      coverEvidenceResultId,
      findCandidateResultId: candidateContext.findCandidateResultId ?? null,
      foundCandidateId: candidateContext.foundCandidateId || null,
      targetStateId: candidateContext.targetStateId ?? null,
      targetKind: candidateContext.targetKind,
      rawOriginStored: false,
    },
    finalizedBy: "finalizeDistille",
    finalizedAt,
  };

  if (!input.write) {
    return {
      coverEvidenceResultId,
      knowledgeId: null,
      status: "dry_run",
      embeddingStatus: "unavailable",
      sourceReferenceCount,
      sourceLinkCount: 0,
      reason: null,
      finalizeSummary,
    };
  }

  await recordAuditLogSafe({
    eventType: auditEventTypes.finalizeDistilleStarted,
    actor: "system",
    payload: {
      coverEvidenceResultId,
      targetStateId: candidateContext.targetStateId ?? null,
      targetKind: candidateContext.targetKind,
      targetKey: "the source target",
      sourceDocumentUri: "the source document",
    },
  });
  if (demotionReason) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureDemotedToRule,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        targetStateId: candidateContext.targetStateId ?? null,
        targetKind: candidateContext.targetKind,
        targetKey: "the source target",
        sourceDocumentUri: "the source document",
        reason: demotionReason,
        source: "finalizeDistille",
      },
    });
  }

  const negativeEvent = result.toolEvents.find((e) => e.name === "negative_coverage" && e.ok);
  const isNegativeKnowledge =
    negativeEvent?.metadata && typeof negativeEvent.metadata === "object"
      ? (negativeEvent.metadata as any).polarity === "negative"
      : false;

  const existing = await selectKnowledgeByFinalizeSourceUri(sourceUri);
  if (existing) {
    await linkNegativeKnowledgeOrigin({
      knowledgeId: existing.id,
      candidateContext,
      coverEvidenceResultId,
      confidence: unitConfidence(candidate.confidence),
      enabled: isNegativeKnowledge,
    });
    const sourceLinkCount = await linkResolvableSourceReferences({
      knowledgeId: existing.id,
      references: result.references,
      metadataReferences: prepared.references,
      confidence: unitConfidence(candidate.confidence),
      coverEvidenceResultId,
    });
    if (requiresLandscapeApproval && landscapeLink?.status === "approved") {
      await markLandscapeFinalized({
        findCandidateResultId: candidateContext.findCandidateResultId,
        foundCandidateId: candidateContext.foundCandidateId || null,
      });
    }
    await recordAuditLogSafe({
      eventType: auditEventTypes.finalizeDistilleCompleted,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        knowledgeId: existing.id,
        embeddingStatus: "stored",
        sourceReferenceCount,
        sourceLinkCount,
        existing: true,
      },
    });
    return {
      coverEvidenceResultId,
      knowledgeId: existing.id,
      status: "stored",
      embeddingStatus: "stored",
      sourceReferenceCount,
      sourceLinkCount,
      reason: null,
      finalizeSummary,
    };
  }

  let embedding: number[];
  try {
    throwIfAborted(input.signal);
    embedding = await embedOne(`${candidate.title}\n${candidate.body}`, "passage");
    throwIfAborted(input.signal);
  } catch (error) {
    const embeddingStatus = embeddingStatusFromError(error);
    await recordAuditLogSafe({
      eventType: auditEventTypes.finalizeDistilleEmbeddingFailed,
      actor: "system",
      payload: {
        coverEvidenceResultId,
        embeddingStatus,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throwIfAborted(input.signal);
    throw new Error(
      `finalizeDistille requires knowledge embedding before storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  throwIfAborted(input.signal);

  const polarity =
    negativeEvent?.metadata && typeof negativeEvent.metadata === "object"
      ? (negativeEvent.metadata as any).polarity
      : undefined;
  const intentTags =
    negativeEvent?.metadata && typeof negativeEvent.metadata === "object"
      ? (negativeEvent.metadata as any).intentTags
      : undefined;

  const knowledgeId = await upsertKnowledgeFromSource({
    sourceUri,
    type: candidate.type,
    status: "draft",
    scope: "repo",
    repoPath: authoritativeProjectIdentity.repoPath,
    repoKey: authoritativeProjectIdentity.repoKey,
    identityProducer: "finalize-distille",
    polarity,
    intentTags,
    title: candidate.title,
    body: candidate.body,
    confidence: candidate.confidence,
    importance: candidate.importance,
    appliesTo: applicabilityFromCoverCandidate(candidate),
    metadata,
    embedding,
  });

  throwIfAborted(input.signal);
  await linkNegativeKnowledgeOrigin({
    knowledgeId,
    candidateContext,
    coverEvidenceResultId,
    confidence: unitConfidence(candidate.confidence),
    enabled: polarity === "negative",
  });

  throwIfAborted(input.signal);
  const sourceLinkCount = await linkResolvableSourceReferences({
    knowledgeId,
    references: result.references,
    metadataReferences: prepared.references,
    confidence: unitConfidence(candidate.confidence),
    coverEvidenceResultId,
  });

  await recordAuditLogSafe({
    eventType: auditEventTypes.finalizeDistilleCompleted,
    actor: "system",
    payload: {
      coverEvidenceResultId,
      knowledgeId,
      embeddingStatus: "stored",
      sourceReferenceCount,
      sourceLinkCount,
    },
  });

  if (requiresLandscapeApproval && landscapeLink?.status === "approved") {
    await markLandscapeFinalized({
      findCandidateResultId: candidateContext.findCandidateResultId,
      foundCandidateId: candidateContext.foundCandidateId || null,
    });
  }

  return {
    coverEvidenceResultId,
    knowledgeId,
    status: "stored",
    embeddingStatus: "stored",
    sourceReferenceCount,
    sourceLinkCount,
    reason: null,
    finalizeSummary,
  };
}

export async function runFinalizeDistilleSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  const id = typeof input.coverEvidenceResultId === "string" ? input.coverEvidenceResultId : "";
  if (!id.trim()) {
    return {
      domain: "finalizeDistille",
      implemented: true,
      status: "prepared",
      checkedAt: new Date().toISOString(),
      message: "finalizeDistille runtime is wired. Pass coverEvidenceResultId for dry-run smoke.",
      receivedInput: input,
      nextContracts: [
        "knowledge_ready cover evidence results can be dry-run finalized",
        "write-side finalize is available via finalize-distille CLI",
      ],
    };
  }

  const result = await runFinalizeDistille({
    coverEvidenceResultId: id,
    write: false,
  });

  return {
    domain: "finalizeDistille",
    implemented: true,
    status: result.status === "dry_run" ? "ok" : "prepared",
    checkedAt: new Date().toISOString(),
    message:
      result.status === "dry_run"
        ? "finalizeDistille dry-run completed for a knowledge_ready cover evidence result."
        : "finalizeDistille rejected a non-ready cover evidence result.",
    receivedInput: input,
    nextContracts: [
      "write=true stores draft knowledge through upsertKnowledgeFromSource",
      "source references are abstracted in knowledge metadata",
      "resolvable source fragments are linked through knowledge_source_links",
    ],
  };
}
