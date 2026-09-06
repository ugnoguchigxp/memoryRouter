import type { CompileInput } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import type { KnowledgeCandidateEvidence } from "../knowledge/knowledge.service.js";
import { CONTEXT_COMPILE_LIMITS } from "./compiler-contracts.js";
import type { Rankable } from "./ranking.service.js";

export const maintenanceReasonSet = new Set([
  "KNOWLEDGE_APPLIES_TO_FALLBACK",
  "KNOWLEDGE_REPO_SCOPE_FALLBACK",
  "SOURCE_REPO_SCOPE_FALLBACK",
  "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
]);

export const usablePackFallbackReasonSet = new Set([
  "AGENTIC_REFINE_FAILED",
  "CONTEXT_RESPONSE_COMPOSE_FAILED",
]);

export const searchFailureReasonSet = new Set([
  "KNOWLEDGE_TEXT_SEARCH_FAILED",
  "KNOWLEDGE_VECTOR_SEARCH_FAILED",
  "SOURCE_SEARCH_FAILED",
  "SOURCE_VECTOR_SEARCH_FAILED",
]);

export const designDocumentPathPattern =
  /(?:^|[\s"'`(（])(?:file:\/\/\/[^\s"'`）)]+|(?:\.{1,2}\/)?(?:docs?|design|specs?|requirements?|roadmap|proposal|architecture)\/[^\s"'`）)]+)\.(?:md|mdx)(?=$|[\s"'`）).,])/i;

export const designDocumentFileNamePattern =
  /(?:^|[\s"'`(（])(?:design|spec|api-spec|requirements?|roadmap|proposal|architecture(?:-plan)?|plan|設計|仕様|要件)[\w.\-]*(?:\.md|\.mdx)(?=$|[\s"'`）).,])/iu;

export type CompileEmbeddingStatus =
  | "facets_only"
  | "embedding_available"
  | "embedding_unavailable";

export type RetrievalEmbeddingStats = {
  embeddingStatus?: "provided" | "generated" | "unavailable" | "disabled";
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  queryEmbedding?: number[];
};

export type CompileEmbeddingTraceDiagnostics = {
  overallStatus: CompileEmbeddingStatus;
  knowledgePositive: Record<string, unknown>;
  knowledgeNegative: Record<string, unknown>;
  sources: Record<string, unknown>;
};

export type KnowledgeRankable = Rankable & {
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  sourceRefs: string[];
  candidateEvidence?: KnowledgeCandidateEvidence;
  polarity: string;
  scopeSnapshot: Record<string, unknown>;
};

export type CompileReasonBuckets = {
  blockingReasons: string[];
  hardFailureReasons: string[];
  maintenanceWarnings: string[];
};

export type InputFacetSummary = {
  requested: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  matched: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  unknown: {
    change_type: string[];
    technology: string[];
    domain: string[];
  };
};

export function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

export function classifyCompileReasons(params: {
  reasons: string[];
  selectedKnowledgeCount: number;
}): CompileReasonBuckets {
  const uniqueReasons = [...new Set(params.reasons.map((reason) => reason.trim()).filter(Boolean))];
  const blockingReasons: string[] = [];
  const hardFailureReasons: string[] = [];
  const maintenanceWarnings: string[] = [];
  const hasKnowledge = params.selectedKnowledgeCount > 0;

  for (const reason of uniqueReasons) {
    if (maintenanceReasonSet.has(reason)) {
      maintenanceWarnings.push(reason);
      continue;
    }
    if (usablePackFallbackReasonSet.has(reason) && hasKnowledge) {
      maintenanceWarnings.push(reason);
      continue;
    }
    if (reason === "NO_ACTIVE_KNOWLEDGE_MATCH") {
      if (!hasKnowledge) blockingReasons.push(reason);
      continue;
    }
    if (reason === "NO_SOURCE_MATCH") {
      if (hasKnowledge) maintenanceWarnings.push(reason);
      else blockingReasons.push(reason);
      continue;
    }
    if (reason.endsWith("_FAILED") || reason.includes("ERROR")) {
      if (searchFailureReasonSet.has(reason)) {
        blockingReasons.push(reason);
      } else {
        hardFailureReasons.push(reason);
        blockingReasons.push(reason);
      }
      continue;
    }
    blockingReasons.push(reason);
  }

  return {
    blockingReasons,
    hardFailureReasons,
    maintenanceWarnings,
  };
}

export function normalizeCompileEmbeddingStatus(
  stats: RetrievalEmbeddingStats,
): CompileEmbeddingStatus {
  if (stats.embeddingStatus === "provided" || stats.embeddingStatus === "generated") {
    return "embedding_available";
  }
  if (stats.embeddingStatus === "unavailable") return "embedding_unavailable";
  return "facets_only";
}

export function embeddingTraceEntry(stats: RetrievalEmbeddingStats): Record<string, unknown> {
  return {
    embeddingStatus: stats.embeddingStatus ?? "disabled",
    compileStatus: normalizeCompileEmbeddingStatus(stats),
    embeddingProvider: stats.embeddingProvider ?? null,
    embeddingModel: stats.embeddingModel ?? null,
    embeddingDimensions: stats.embeddingDimensions ?? null,
    hasQueryEmbedding: Boolean(stats.queryEmbedding && stats.queryEmbedding.length > 0),
  };
}

export function buildEmbeddingTraceDiagnostics(params: {
  positiveKnowledge: RetrievalEmbeddingStats;
  negativeKnowledge: RetrievalEmbeddingStats;
  sources: RetrievalEmbeddingStats;
}): CompileEmbeddingTraceDiagnostics {
  const statuses = [
    normalizeCompileEmbeddingStatus(params.positiveKnowledge),
    normalizeCompileEmbeddingStatus(params.negativeKnowledge),
    normalizeCompileEmbeddingStatus(params.sources),
  ];
  const overallStatus = statuses.includes("embedding_unavailable")
    ? "embedding_unavailable"
    : statuses.includes("embedding_available")
      ? "embedding_available"
      : "facets_only";
  return {
    overallStatus,
    knowledgePositive: embeddingTraceEntry(params.positiveKnowledge),
    knowledgeNegative: embeddingTraceEntry(params.negativeKnowledge),
    sources: embeddingTraceEntry(params.sources),
  };
}

export function firstAvailableKnowledgeEmbedding(
  ...stats: RetrievalEmbeddingStats[]
): RetrievalEmbeddingStats {
  return (
    stats.find((item) => item.queryEmbedding && item.queryEmbedding.length > 0) ??
    stats.find(
      (item) => item.embeddingProvider || item.embeddingModel || item.embeddingDimensions,
    ) ??
    stats[0] ??
    {}
  );
}

export function resolveKnowledgeTaskTraceEmbeddingStatus(params: {
  selected: RetrievalEmbeddingStats;
  positiveKnowledge: RetrievalEmbeddingStats;
  negativeKnowledge: RetrievalEmbeddingStats;
}): CompileEmbeddingStatus {
  if (params.selected.queryEmbedding && params.selected.queryEmbedding.length > 0) {
    return "embedding_available";
  }
  if (
    params.positiveKnowledge.embeddingStatus === "unavailable" ||
    params.negativeKnowledge.embeddingStatus === "unavailable"
  ) {
    return "embedding_unavailable";
  }
  return normalizeCompileEmbeddingStatus(params.selected);
}

export function goalContainsDesignDocumentReference(goal: string): boolean {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return false;
  return (
    designDocumentPathPattern.test(trimmedGoal) || designDocumentFileNamePattern.test(trimmedGoal)
  );
}

export function isLowConfidenceVectorOnlyCandidate(evidence?: KnowledgeCandidateEvidence): boolean {
  if (!evidence?.vectorMatched) return false;
  if (evidence.textMatched || evidence.facetMatched) return false;
  const score = typeof evidence.vectorScore === "number" ? evidence.vectorScore : 0;
  return score < CONTEXT_COMPILE_LIMITS.vectorOnlyScoreFloor;
}

export function filterByCandidateEvidence(items: KnowledgeRankable[]): {
  items: KnowledgeRankable[];
  suppressedCount: number;
} {
  const selected = items.filter(
    (item) => !isLowConfidenceVectorOnlyCandidate(item.candidateEvidence),
  );
  return {
    items: selected,
    suppressedCount: Math.max(0, items.length - selected.length),
  };
}

export function buildInputFacets(params: {
  input: CompileInput;
  matchedChangeTypes: string[];
  matchedTechnologies: string[];
  matchedDomains: string[];
  unknownFacetsByKind: Record<string, string[]>;
}): InputFacetSummary {
  return {
    requested: {
      changeTypes: params.input.changeTypes ?? [],
      technologies: params.input.technologies ?? [],
      domains: params.input.domains ?? [],
    },
    matched: {
      changeTypes: params.matchedChangeTypes,
      technologies: params.matchedTechnologies,
      domains: params.matchedDomains,
    },
    unknown: {
      change_type: params.unknownFacetsByKind.change_type ?? [],
      technology: params.unknownFacetsByKind.technology ?? [],
      domain: params.unknownFacetsByKind.domain ?? [],
    },
  };
}

export function filterBenignNegativeKnowledgeReasons(reasons: string[]): string[] {
  const benignReasons = new Set([
    "NO_ACTIVE_KNOWLEDGE_MATCH",
    "KNOWLEDGE_REPO_SCOPE_FALLBACK",
    "KNOWLEDGE_APPLIES_TO_FALLBACK",
  ]);
  return reasons.filter((reason) => !benignReasons.has(reason));
}
