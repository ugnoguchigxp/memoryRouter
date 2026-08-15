import { createHash } from "node:crypto";
import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { mcpResourceUri } from "../../project-identity.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import {
  type CompileInput,
  type RetrievalMode,
  compileInputSchema,
  deriveRetrievalModeFromChangeTypes,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPack,
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";
import type {
  EpisodeCard,
  EpisodeCardSearchInput,
} from "../../shared/schemas/episode-card.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { asRecord, asStringArray, normalizeFacetArray } from "../../shared/utils/normalize.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { recordEpisodeUsage, searchEpisodes } from "../episodic-memory/episode-card.service.js";
import { normalizeKnowledgeApplicability } from "../knowledge/applicability.service.js";
import { recordCompileRunKnowledgeUsageSignals } from "../knowledge/knowledge-feedback.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../knowledge/knowledge-value.service.js";
import {
  type KnowledgeCandidateEvidence,
  type KnowledgeRetrievalTraceEntry,
  retrieveKnowledge,
} from "../knowledge/knowledge.service.js";
import {
  applyLandscapeCompileIntervention,
  isLandscapeCompileInterventionEnabled,
} from "../landscape/landscape-compile-intervention.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import { agenticRefine } from "./agentic-refine.service.js";
import { resolveCompileProjectIdentity } from "./compile-project-identity.js";
import { upsertContextCompileTaskTrace } from "./context-compile-task-trace.repository.js";
import {
  insertCompileRun,
  insertContextCompileCandidateTraces,
  insertContextPackItems,
  updateCompileRunFailure,
  updateCompileRunSnapshot,
} from "./context-compiler.repository.js";
import { composeContextResponse } from "./context-response-composer.service.js";
import {
  type DuplicateSuppressionInfo,
  suppressNearDuplicateKnowledge,
} from "./duplicate-suppression.service.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { normalizeRepoKey, normalizeRepoPath } from "./query-context.js";
import { type Rankable, explainRankableScore, rankAndDedupe } from "./ranking.service.js";
import { applySectionTokenBudget, estimateTokens } from "./token-budget.js";
import { collectUtilityTraceCandidates } from "./utility-retrieval.service.js";

const CONTEXT_COMPILE_SECTION_RATIOS = {
  rules: 0.55,
  procedures: 0.45,
  guardrails: 0.3,
} as const;

const CONTEXT_COMPILE_LIMITS = {
  vectorOnlyScoreFloor: 0.52,
  normalRankingLimit: 15,
  episodePrecedentLimit: 2,
} as const;

const maintenanceReasonSet = new Set([
  "KNOWLEDGE_APPLIES_TO_FALLBACK",
  "KNOWLEDGE_REPO_SCOPE_FALLBACK",
  "SOURCE_REPO_SCOPE_FALLBACK",
  "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
]);

const usablePackFallbackReasonSet = new Set([
  "AGENTIC_REFINE_FAILED",
  "CONTEXT_RESPONSE_COMPOSE_FAILED",
]);

const searchFailureReasonSet = new Set([
  "KNOWLEDGE_TEXT_SEARCH_FAILED",
  "KNOWLEDGE_VECTOR_SEARCH_FAILED",
  "SOURCE_SEARCH_FAILED",
  "SOURCE_VECTOR_SEARCH_FAILED",
]);
const designDocumentPathPattern =
  /(?:^|[\s"'`(（])(?:file:\/\/\/[^\s"'`）)]+|(?:\.{1,2}\/)?(?:docs?|design|specs?|requirements?|roadmap|proposal|architecture)\/[^\s"'`）)]+)\.(?:md|mdx)(?=$|[\s"'`）).,])/i;
const designDocumentFileNamePattern =
  /(?:^|[\s"'`(（])(?:design|spec|api-spec|requirements?|roadmap|proposal|architecture(?:-plan)?|plan|設計|仕様|要件)[\w.\-]*(?:\.md|\.mdx)(?=$|[\s"'`）).,])/iu;

type CandidateTraceDraftRow = {
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

type CompileEmbeddingStatus = "facets_only" | "embedding_available" | "embedding_unavailable";

type RetrievalEmbeddingStats = {
  embeddingStatus?: "provided" | "generated" | "unavailable" | "disabled";
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  queryEmbedding?: number[];
};

type CompileEmbeddingTraceDiagnostics = {
  overallStatus: CompileEmbeddingStatus;
  knowledgePositive: Record<string, unknown>;
  knowledgeNegative: Record<string, unknown>;
  sources: Record<string, unknown>;
};

function scoreSourceOverlap(text: string, candidateText: string): number {
  const baseTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]+/g)
    .filter((token) => token.length >= 3)
    .slice(0, 32);
  if (baseTokens.length === 0) return 0;
  const candidate = candidateText.toLowerCase();
  let overlap = 0;
  for (const token of baseTokens) {
    if (candidate.includes(token)) overlap += 1;
  }
  return overlap;
}

function formatSourceRef(sourceUri: string, locator: string): string {
  return `${sourceUri}#${locator}`;
}

function buildFallbackSourceRef(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  degradedReasons: string[];
}): string {
  const reason =
    params.degradedReasons.find((item) => item.startsWith("NO_")) ??
    params.degradedReasons[0] ??
    "NO_SOURCE_MATCH";
  return `${mcpResourceUri(`packs/run/${params.runId}`)}#${params.retrievalMode}:${reason}`;
}

function selectSourceRefsForKnowledge(
  item: { title: string; content: string },
  sourceItems: Array<{ sourceUri: string; locator: string; content: string; score: number }>,
  knownSourceRefs: string[],
): string[] {
  if (knownSourceRefs.length > 0) {
    return [...new Set(knownSourceRefs)].slice(0, 4);
  }
  if (sourceItems.length === 0) return [];
  const scored = sourceItems
    .map((sourceItem) => {
      const overlap = scoreSourceOverlap(
        `${item.title}\n${item.content}`,
        `${sourceItem.sourceUri}\n${sourceItem.content}`,
      );
      return {
        ref: formatSourceRef(sourceItem.sourceUri, sourceItem.locator),
        score: sourceItem.score + overlap * 0.05,
        overlap,
      };
    })
    .sort((a, b) => b.score - a.score);

  const overlapRefs = scored
    .filter((entry) => entry.overlap > 0)
    .slice(0, 2)
    .map((entry) => entry.ref);
  if (overlapRefs.length > 0) return [...new Set(overlapRefs)];
  return [];
}

function buildMinimalTasks(retrievalMode: RetrievalMode): string[] {
  switch (retrievalMode) {
    case "review_context":
      return [
        "有効なルールと手順を確認する",
        "変更内容が既知の制約に反しないか検証する",
        "指摘は根拠を明確にして優先順位順にまとめる",
      ];
    case "debug_context":
      return [
        "関連する既知手順を先に確認する",
        "原因候補を狭めてから最小変更で修正する",
        "修正箇所に絞った再現・検証を行う",
      ];
    case "architecture_context":
      return [
        "既存ルールと制約を先に確認する",
        "設計候補のトレードオフを比較する",
        "実装境界と検証方法を明確化する",
      ];
    case "procedure_context":
      return [
        "手順候補を上から順に確認する",
        "必要最小限のコマンドのみ実行する",
        "結果と次の検証ステップを記録する",
      ];
    default:
      return ["関連する知識を確認する", "安全な最小変更で実装する", "変更箇所を重点検証する"];
  }
}

function normalizeKnowledgeType(value: string): KnowledgeItem["type"] {
  return value === "procedure" ? "procedure" : "rule";
}

function normalizeKnowledgeStatus(value: string): KnowledgeStatus {
  if (value === "deprecated") return "deprecated";
  if (value === "draft") return "draft";
  return "active";
}

function toKnowledgePackItem(item: {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
  polarity?: string;
}): ContextPackItem {
  const section =
    item.polarity === "negative"
      ? "guardrails"
      : item.type === "procedure"
        ? "procedures"
        : "rules";
  return {
    id: `knowledge:${item.id}`,
    itemKind: item.type,
    itemId: item.id,
    section,
    title: item.title,
    content: item.content,
    score: item.score,
    rankingReason: `ranked by weighted score (${item.status})`,
    sourceRefs: item.sourceRefs,
  };
}

type EpisodePrecedentRetrievalResult = {
  items: EpisodeCard[];
  stats: {
    hitCount: number;
    selectedCount: number;
    searchFailed: boolean;
    selectedIds?: string[];
    selectedTitles?: string[];
    scopedHitCount?: number;
    globalHitCount?: number;
    usedFor?: "compile_precedent";
    error?: string;
  };
};

function buildEpisodeRefValue(ref: EpisodeCard["refs"][number]): string {
  const value = ref.refValue.trim();
  const locator = ref.locator?.trim();
  if (!value) return "";
  if (locator) return `${value}#${locator}`;
  return `${ref.refKind}:${value}`;
}

function episodeSourceRefs(episode: EpisodeCard): string[] {
  return [
    mcpResourceUri(`episodes/${episode.id}`),
    ...episode.refs.map(buildEpisodeRefValue).filter(Boolean),
  ].slice(0, 5);
}

function normalizeEpisodeScore(episode: EpisodeCard, index: number): number {
  const searchScore = Math.max(0, Number(episode.score ?? 0));
  const confidenceScore = Math.min(1, Math.max(0, episode.confidence / 100));
  const importanceScore = Math.min(1, Math.max(0, episode.importance / 100));
  const qualityBoost = importanceScore * 0.09 + confidenceScore * 0.05;
  return Math.min(0.75, 0.35 + Math.min(0.18, searchScore / 100) + qualityBoost - index * 0.03);
}

function compactEpisodeText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
}

function episodeToPackItem(episode: EpisodeCard, index: number): ContextPackItem {
  const sourceRefs = episodeSourceRefs(episode);
  const refHint =
    sourceRefs.length > 1
      ? `Source refs: ${sourceRefs.slice(1, 4).join(" | ")}`
      : "Source refs: EpisodeCard only; verify against raw evidence when possible.";
  const content = [
    "Use when: A similar past task may inform the current compile context; treat this as precedent, not primary evidence.",
    "Workflow:",
    `1. Situation: ${compactEpisodeText(episode.situation)}`,
    `2. Prior action: ${compactEpisodeText(episode.action || episode.observations || "No action recorded.")}`,
    `3. Outcome: ${compactEpisodeText(episode.outcome || "No outcome recorded.")}`,
    `4. Lesson: ${compactEpisodeText(episode.lesson || "No lesson recorded.")}`,
    "Verification:",
    `- ${refHint}`,
    "- Confirm the precedent still applies before using it to guide implementation.",
    "Avoid:",
    "- Do not treat EpisodeCard precedent as a decision source or as verified source material by itself.",
  ].join("\n");
  return {
    id: `episode_card:${episode.id}`,
    itemKind: "episode_card",
    itemId: episode.id,
    section: "procedures",
    title: `Past episode: ${episode.title}`,
    content,
    score: normalizeEpisodeScore(episode, index),
    rankingReason: `supplemental EpisodeCard precedent (importance ${episode.importance}, confidence ${episode.confidence}, ${episode.outcomeKind})`,
    sourceRefs,
    changeTypes: episode.changeTypes,
    technologies: episode.technologies,
    domains: episode.domains,
  };
}

async function retrieveEpisodePrecedents(params: {
  input: CompileInput;
  repoPath: string;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
}): Promise<EpisodePrecedentRetrievalResult> {
  try {
    const baseSearch: EpisodeCardSearchInput = {
      query: params.input.goal,
      technologies:
        params.technologies.length > 0 ? params.technologies : params.input.technologies,
      changeTypes: params.changeTypes.length > 0 ? params.changeTypes : params.input.changeTypes,
      domains: params.domains.length > 0 ? params.domains : params.input.domains,
      status: "active",
      limit: 5,
    };
    const scopedRepoKey = params.input.repoKey ?? params.repoKey ?? undefined;
    const scopedRepoPath = scopedRepoKey ? undefined : params.input.repoPath;
    const scopedItems =
      scopedRepoKey || scopedRepoPath
        ? await searchEpisodes({
            ...baseSearch,
            repoKey: scopedRepoKey,
            repoPath: scopedRepoPath,
          })
        : [];
    const scopedIds = new Set(scopedItems.map((item) => item.id));
    const globalItems =
      scopedItems.length < CONTEXT_COMPILE_LIMITS.episodePrecedentLimit
        ? (await searchEpisodes(baseSearch)).filter((item) => !scopedIds.has(item.id))
        : [];
    const items = [...scopedItems, ...globalItems];
    const selected = items.slice(0, CONTEXT_COMPILE_LIMITS.episodePrecedentLimit);
    const selectedIds = selected.map((item) => item.id);
    const selectedTitles = selected.map((item) => item.title);
    return {
      items: selected,
      stats: {
        hitCount: items.length,
        selectedCount: selected.length,
        searchFailed: false,
        selectedIds,
        selectedTitles,
        scopedHitCount: scopedItems.length,
        globalHitCount: globalItems.length,
        ...(selected.length > 0 ? { usedFor: "compile_precedent" as const } : {}),
      },
    };
  } catch (error) {
    return {
      items: [],
      stats: {
        hitCount: 0,
        selectedCount: 0,
        searchFailed: true,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

type KnowledgeRankable = Rankable & {
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  sourceRefs: string[];
  candidateEvidence?: KnowledgeCandidateEvidence;
  polarity: string;
};

type CompileReasonBuckets = {
  blockingReasons: string[];
  hardFailureReasons: string[];
  maintenanceWarnings: string[];
};

type InputFacetSummary = {
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

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function classifyCompileReasons(params: {
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

function normalizeCompileEmbeddingStatus(stats: RetrievalEmbeddingStats): CompileEmbeddingStatus {
  if (stats.embeddingStatus === "provided" || stats.embeddingStatus === "generated") {
    return "embedding_available";
  }
  if (stats.embeddingStatus === "unavailable") return "embedding_unavailable";
  return "facets_only";
}

function embeddingTraceEntry(stats: RetrievalEmbeddingStats): Record<string, unknown> {
  return {
    embeddingStatus: stats.embeddingStatus ?? "disabled",
    compileStatus: normalizeCompileEmbeddingStatus(stats),
    embeddingProvider: stats.embeddingProvider ?? null,
    embeddingModel: stats.embeddingModel ?? null,
    embeddingDimensions: stats.embeddingDimensions ?? null,
    hasQueryEmbedding: Boolean(stats.queryEmbedding && stats.queryEmbedding.length > 0),
  };
}

function buildEmbeddingTraceDiagnostics(params: {
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

function firstAvailableKnowledgeEmbedding(
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

function resolveKnowledgeTaskTraceEmbeddingStatus(params: {
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

function goalContainsDesignDocumentReference(goal: string): boolean {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return false;
  return (
    designDocumentPathPattern.test(trimmedGoal) || designDocumentFileNamePattern.test(trimmedGoal)
  );
}

function isLowConfidenceVectorOnlyCandidate(evidence?: KnowledgeCandidateEvidence): boolean {
  if (!evidence?.vectorMatched) return false;
  if (evidence.textMatched || evidence.facetMatched) return false;
  const score = typeof evidence.vectorScore === "number" ? evidence.vectorScore : 0;
  return score < CONTEXT_COMPILE_LIMITS.vectorOnlyScoreFloor;
}

function filterByCandidateEvidence(items: KnowledgeRankable[]): {
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

function buildInputFacets(params: {
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

function filterBenignNegativeKnowledgeReasons(reasons: string[]): string[] {
  const benignReasons = new Set([
    "NO_ACTIVE_KNOWLEDGE_MATCH",
    "KNOWLEDGE_REPO_SCOPE_FALLBACK",
    "KNOWLEDGE_APPLIES_TO_FALLBACK",
  ]);
  return reasons.filter((reason) => !benignReasons.has(reason));
}

async function updateCompileRunSnapshotSafe(runId: string, pack: ContextPack): Promise<boolean> {
  try {
    await updateCompileRunSnapshot(runId, pack);
    return true;
  } catch {
    return false;
  }
}

async function updateCompileRunFailureSafe(params: {
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

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

async function recordCompileRunKnowledgeUsageSignalsSafe(params: {
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

function goalHash(goal: string): string {
  return createHash("sha1").update(goal.trim()).digest("hex");
}

async function persistCompileTaskTraceSafe(params: {
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

function toStageRankMap(
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

function mergeCompileRetrievalTraceEntries(
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

function resolveCommunityKeyFromMetadata(metadata: unknown): string | null {
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

function sortCandidateTraceRows(rows: CandidateTraceDraftRow[]): CandidateTraceDraftRow[] {
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

function candidateDropClassification(params: {
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

function buildCandidateTraceRows(params: {
  knowledgeItems: Array<{
    id: string;
    type: KnowledgeItem["type"];
    status: KnowledgeStatus;
    score: number;
    metadata?: Record<string, unknown>;
    candidateEvidence?: KnowledgeCandidateEvidence;
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

function mergeUtilityTraceCandidates(
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

function applyCandidateTraceLimit(
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

async function persistCandidateTraceRows(params: {
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

function attachOutputMarkdownToPack(pack: ContextPack, markdown: string): ContextPack {
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  return {
    ...pack,
    diagnostics: {
      ...pack.diagnostics,
      retrievalStats: {
        ...retrievalStats,
        responseComposer: {
          ...responseComposer,
          outputMarkdown: markdown,
        },
      },
    },
  };
}

function legacyIntentFromRetrievalMode(retrievalMode: RetrievalMode): string {
  if (retrievalMode === "debug_context") return "debug";
  if (retrievalMode === "review_context") return "review";
  if (retrievalMode === "architecture_context") return "plan";
  if (retrievalMode === "procedure_context") return "edit";
  if (retrievalMode === "learning_context") return "finish";
  return "edit";
}

export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource; sessionId?: string },
): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const compileStartedAt = Date.now();
  const input = compileInputSchema.parse(rawInput);
  const projectIdentity = resolveCompileProjectIdentity(input);
  const retrievalMode =
    input.retrievalMode ?? deriveRetrievalModeFromChangeTypes(input.changeTypes);
  // T1 preserves the current retrieval lane while stopping daemon cwd from being persisted as
  // caller identity. T4 removes this legacy fallback from candidate selection.
  const legacyWorkspaceRepoPath = normalizeRepoPath(process.cwd()) ?? process.cwd();
  const legacyWorkspaceRepoKey =
    normalizeRepoKey(legacyWorkspaceRepoPath) ?? normalizeRepoKey(process.cwd()) ?? null;
  const tokenBudget = input.tokenBudget ?? groupedConfig.compile.defaultTokenBudget;
  const candidateTraceLimit = groupedConfig.compile.candidateTraceLimit;
  const persistedInput = {
    goal: input.goal,
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.retrievalMode ? { retrievalMode: input.retrievalMode } : {}),
    ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
    ...(input.technologies ? { technologies: input.technologies } : {}),
    ...(input.domains ? { domains: input.domains } : {}),
    ...(input.files ? { files: input.files } : {}),
    ...(projectIdentity.projectRef ? { projectRef: projectIdentity.projectRef } : {}),
    ...(projectIdentity.repoPath ? { repoPath: projectIdentity.repoPath } : {}),
    ...(projectIdentity.repoKey ? { repoKey: projectIdentity.repoKey } : {}),
    ...(input.includeDraft !== undefined ? { includeDraft: input.includeDraft } : {}),
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    projectIdentity,
  };

  const normalizedApplicability = await normalizeKnowledgeApplicability({
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
  });

  const matchedTechnologies = asStringArray(normalizedApplicability.appliesTo.technologies);
  const matchedChangeTypes = asStringArray(normalizedApplicability.appliesTo.changeTypes);
  const matchedDomains = asStringArray(normalizedApplicability.appliesTo.domains);
  const unknownFacetsByKind = normalizedApplicability.unknownTagCandidates.reduce<
    Record<string, string[]>
  >((acc, candidate) => {
    const current = acc[candidate.kind] ?? [];
    if (!current.includes(candidate.value)) current.push(candidate.value);
    acc[candidate.kind] = current;
    return acc;
  }, {});

  const inputFacets = buildInputFacets({
    input,
    matchedChangeTypes,
    matchedTechnologies,
    matchedDomains,
    unknownFacetsByKind,
  });

  if (goalContainsDesignDocumentReference(input.goal)) {
    const degradedReasons = ["GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE"];
    const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const reasonBuckets = classifyCompileReasons({
      reasons: degradedReasons,
      selectedKnowledgeCount: 0,
    });
    const runId = await insertCompileRun({
      goal: input.goal,
      intent: legacyIntentFromRetrievalMode(retrievalMode),
      sessionId: options?.sessionId,
      projectRef: projectIdentity.projectRef,
      repoKey: projectIdentity.repoKey,
      repoPath: projectIdentity.repoPath ?? undefined,
      matchBasis: projectIdentity.matchBasis,
      identityContractVersion: projectIdentity.contractVersion,
      scopeMode: projectIdentity.scopeMode,
      input: persistedInput,
      retrievalMode,
      status: "degraded",
      degradedReasons,
      tokenBudget,
      durationMs: compileDurationMs,
      source: options?.source ?? "unknown",
    });
    await persistCompileTaskTraceSafe({
      runId,
      retrievalMode,
      projectRef: projectIdentity.projectRef,
      repoPath: projectIdentity.repoPath,
      repoKey: projectIdentity.repoKey,
      matchBasis: projectIdentity.matchBasis,
      identityContractVersion: projectIdentity.contractVersion,
      scopeMode: projectIdentity.scopeMode,
      identityFingerprint: projectIdentity.identityFingerprint,
      identityTrust: projectIdentity.trust,
      bindingStatus: projectIdentity.bindingStatus,
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
      goal: input.goal,
      embeddingStatus: "facets_only",
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embedding: null,
    });

    const pack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "degraded",
      minimalTasks: buildMinimalTasks(retrievalMode),
      rules: [],
      procedures: [],
      warnings: [],
      sourceRefs: [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })],
      diagnostics: {
        degradedReasons,
        retrievalStats: {
          knowledge: { skipped: true, reason: "goal_design_document_reference" },
          sources: { skipped: true, reason: "goal_design_document_reference" },
          episodes: { skipped: true, reason: "goal_design_document_reference" },
          tokenBudget,
          compileDurationMs,
          candidateTraceSavedCount: 0,
          candidateTraceTruncated: false,
          candidateTraceLimit,
          candidateTraceSkippedReason: "goal_design_document_reference",
          agenticUsed: false,
          reasonBuckets: {
            blocking: reasonBuckets.blockingReasons,
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: reasonBuckets.hardFailureReasons,
          },
          suggestedNextCalls: [],
        },
        inputFacets,
      },
    });

    const markdown = renderContextPackMarkdown(pack);
    const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
    await updateCompileRunSnapshotSafe(runId, packWithMarkdown);
    await recordKnowledgeCompileSelectionSafe({
      runId,
      selectedKnowledgeIds: [],
      agenticAcceptedKnowledgeIds: [],
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "degraded",
        degradedReasons,
        tokenBudget,
        compileDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: { rules: 0, procedures: 0, guardrails: 0 },
      },
    });

    return { pack: packWithMarkdown, markdown };
  }

  const [positiveKnowledge, negativeKnowledge, sourceContext, episodePrecedents] =
    await Promise.all([
      retrieveKnowledge(input, {
        retrievalMode,
        polarities: ["positive"],
        facetFilters: {
          technologies: matchedTechnologies,
          changeTypes: matchedChangeTypes,
          domains: matchedDomains,
        },
      }),
      retrieveKnowledge(input, {
        retrievalMode,
        polarities: ["negative"],
        facetFilters: {
          technologies: matchedTechnologies,
          changeTypes: matchedChangeTypes,
          domains: matchedDomains,
        },
      }),
      retrieveSources(input, { retrievalMode }),
      retrieveEpisodePrecedents({
        input,
        repoPath: legacyWorkspaceRepoPath,
        repoKey: legacyWorkspaceRepoKey,
        technologies: matchedTechnologies,
        changeTypes: matchedChangeTypes,
        domains: matchedDomains,
      }),
    ]);

  const degradedReasons = [
    ...positiveKnowledge.degradedReasons,
    ...filterBenignNegativeKnowledgeReasons(negativeKnowledge.degradedReasons),
    ...sourceContext.degradedReasons,
  ];

  const combinedItems = [...positiveKnowledge.items, ...negativeKnowledge.items];

  const rankedKnowledgeBeforeIntervention = rankAndDedupe<KnowledgeRankable>(
    combinedItems.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      sourceRefs: item.sourceRefs,
      sourceRefCount: item.sourceRefs.length,
      hasSourceLinks: item.hasSourceLinks,
      stale: item.status === "deprecated",
      applicabilityScore: item.applicabilityScore,
      candidateEvidence: item.candidateEvidence,
      polarity: item.polarity ?? "positive",
    })),
    isLandscapeCompileInterventionEnabled() ? 24 : CONTEXT_COMPILE_LIMITS.normalRankingLimit,
  );
  const landscapeIntervention = applyLandscapeCompileIntervention(
    rankedKnowledgeBeforeIntervention,
    { limit: CONTEXT_COMPILE_LIMITS.normalRankingLimit },
  );
  const rankedKnowledge = landscapeIntervention.items;

  const knowledgeFilterResult = filterByCandidateEvidence(rankedKnowledge);
  const filteredKnowledge = knowledgeFilterResult.items;
  const duplicateSuppression = suppressNearDuplicateKnowledge(filteredKnowledge);
  const compressedKnowledge = duplicateSuppression.items;
  if (knowledgeFilterResult.suppressedCount > 0) {
    pushUnique(degradedReasons, "LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
  }
  if (
    rankedKnowledge.length > 0 &&
    compressedKnowledge.length === 0 &&
    episodePrecedents.items.length === 0
  ) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const agenticResult = await agenticRefine(
    compressedKnowledge.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs: item.sourceRefs,
      polarity:
        item.polarity === "negative" || item.polarity === "neutral" ? item.polarity : "positive",
      section:
        item.polarity === "negative"
          ? "guardrails"
          : item.type === "procedure"
            ? "procedures"
            : "rules",
    })),
    input,
    retrievalMode,
  );

  if (agenticResult.error) {
    console.warn(
      "[compileContextPack] agenticRefine failed, but falling back gracefully to original candidates. Error:",
      agenticResult.error,
    );
    if (agenticResult.error === "AGENTIC_REFINE_SKIPPED_RATE_LIMIT") {
      pushUnique(degradedReasons, "OPENAI_RATE_LIMIT_COOLDOWN_ACTIVE");
      pushUnique(degradedReasons, "AGENTIC_REFINE_SKIPPED_RATE_LIMIT");
    } else {
      pushUnique(degradedReasons, "AGENTIC_REFINE_FAILED");
    }
  }

  const refinedKnowledgeMap = new Map(compressedKnowledge.map((k) => [k.id, k]));
  const finalKnowledge = agenticResult.items
    .map((item) => refinedKnowledgeMap.get(item.id))
    .filter((k): k is KnowledgeRankable => k !== undefined);
  if (finalKnowledge.length === 0 && episodePrecedents.items.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const knowledgePackItems = finalKnowledge.map((item) => {
    const sourceRefs = selectSourceRefsForKnowledge(
      { title: item.title, content: item.content },
      sourceContext.items,
      item.sourceRefs,
    );
    return toKnowledgePackItem({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs,
      polarity: item.polarity,
    });
  });
  const episodePackItems = episodePrecedents.items.map(episodeToPackItem);
  if (episodePrecedents.items.length > 0) {
    await recordEpisodeUsage({
      usageKind: "compile",
      episodeIds: episodePrecedents.items.map((episode) => episode.id),
    });
  }
  const packItems = [...knowledgePackItems, ...episodePackItems];

  const budgetedRules = applySectionTokenBudget(
    packItems.filter((item) => item.section === "rules"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.rules),
  );
  const budgetedProcedures = applySectionTokenBudget(
    packItems.filter((item) => item.section === "procedures"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.procedures),
  );
  const budgetedGuardrails = applySectionTokenBudget(
    packItems.filter((item) => item.section === "guardrails"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.guardrails),
  );

  if (budgetedRules.dropped || budgetedProcedures.dropped || budgetedGuardrails.dropped) {
    pushUnique(degradedReasons, "TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [
    ...budgetedRules.items,
    ...budgetedProcedures.items,
    ...budgetedGuardrails.items,
  ];
  const selectedKnowledgeIds = [
    ...new Set(
      selectedPackItems
        .filter((item) => item.itemKind === "rule" || item.itemKind === "procedure")
        .map((item) => item.itemId),
    ),
  ];
  const selectedPackItemCount = selectedPackItems.length;
  if (selectedPackItemCount === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }
  const directCandidateTraceRows = buildCandidateTraceRows({
    knowledgeItems: combinedItems.map((item) => ({
      id: item.id,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      score: item.score,
      metadata: item.metadata,
      candidateEvidence: item.candidateEvidence,
    })),
    rankedKnowledgeBeforeIntervention,
    filteredKnowledge: compressedKnowledge,
    finalKnowledge,
    duplicateSuppressedById: duplicateSuppression.suppressedById,
    selectedPackItems,
    retrievalTrace: {
      text: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.text ?? []),
        ...(negativeKnowledge.trace?.text ?? []),
      ]),
      vector: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.vector ?? []),
        ...(negativeKnowledge.trace?.vector ?? []),
      ]),
      merged: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.merged ?? []),
        ...(negativeKnowledge.trace?.merged ?? []),
      ]),
    },
    agenticUsed: agenticResult.agenticUsed,
  });
  const utilityTraceCandidates = await collectUtilityTraceCandidates({
    input,
    retrievalMode,
    selectedKnowledgeIds,
    existingCandidateIds: directCandidateTraceRows.map((row) => row.itemId),
    facets: {
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
    },
  });
  const candidateTraceRows = mergeUtilityTraceCandidates(
    directCandidateTraceRows,
    utilityTraceCandidates,
  );
  const composedResponse = await composeContextResponse({
    input,
    retrievalMode,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    guardrails: budgetedGuardrails.items,
  });
  if (composedResponse.error) {
    pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSE_FAILED");
    if (composedResponse.error === "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT") {
      pushUnique(degradedReasons, "OPENAI_RATE_LIMIT_COOLDOWN_ACTIVE");
      pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT");
    }
  }
  if (composedResponse.markdown === "No Content" && selectedPackItemCount > 0) {
    pushUnique(degradedReasons, "COMPOSED_CONTEXT_NO_ALIGNMENT");
  }
  const forceNoContentDueToRateLimit =
    agenticResult.error === "AGENTIC_REFINE_SKIPPED_RATE_LIMIT" ||
    composedResponse.error === "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT";
  if (forceNoContentDueToRateLimit) {
    pushUnique(degradedReasons, "CONTEXT_COMPILE_LLM_UNAVAILABLE_NO_CONTENT");
  }
  const sourceRefsCandidate = [
    ...new Set([
      ...selectedPackItems.flatMap((item) => item.sourceRefs),
      ...sourceContext.items.map((item) => formatSourceRef(item.sourceUri, item.locator)),
    ]),
  ];
  const embeddingTrace = buildEmbeddingTraceDiagnostics({
    positiveKnowledge: positiveKnowledge.stats,
    negativeKnowledge: negativeKnowledge.stats,
    sources: sourceContext.stats,
  });
  const reasonBuckets = classifyCompileReasons({
    reasons: degradedReasons,
    selectedKnowledgeCount: selectedPackItemCount,
  });
  const status =
    reasonBuckets.hardFailureReasons.length >= 2
      ? "failed"
      : reasonBuckets.blockingReasons.length > 0
        ? "degraded"
        : "ok";
  const minimalTasks = buildMinimalTasks(retrievalMode);
  const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
  const suggestedNextCalls: string[] = [];
  if (degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
    suggestedNextCalls.push("search_knowledge");
  }
  if (degradedReasons.includes("NO_SOURCE_MATCH")) {
    suggestedNextCalls.push("search_memory");
  }
  if (
    degradedReasons.some(
      (reason) =>
        reason.endsWith("_FAILED") ||
        reason === "AGENTIC_REFINE_FAILED" ||
        reason === "QUERY_EMBEDDING_UNAVAILABLE" ||
        reason === "SOURCE_QUERY_EMBEDDING_UNAVAILABLE",
    )
  ) {
    suggestedNextCalls.push("doctor");
  }

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: legacyIntentFromRetrievalMode(retrievalMode),
    sessionId: options?.sessionId,
    projectRef: projectIdentity.projectRef,
    repoKey: projectIdentity.repoKey,
    repoPath: projectIdentity.repoPath ?? undefined,
    matchBasis: projectIdentity.matchBasis,
    identityContractVersion: projectIdentity.contractVersion,
    scopeMode: projectIdentity.scopeMode,
    input: persistedInput,
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
    durationMs: compileDurationMs,
    source: options?.source ?? "unknown",
  });
  const taskTraceEmbeddingStats = firstAvailableKnowledgeEmbedding(
    positiveKnowledge.stats,
    negativeKnowledge.stats,
  );
  const taskTraceEmbeddingStatus = resolveKnowledgeTaskTraceEmbeddingStatus({
    selected: taskTraceEmbeddingStats,
    positiveKnowledge: positiveKnowledge.stats,
    negativeKnowledge: negativeKnowledge.stats,
  });
  await persistCompileTaskTraceSafe({
    runId,
    retrievalMode,
    projectRef: projectIdentity.projectRef,
    repoPath: projectIdentity.repoPath,
    repoKey: projectIdentity.repoKey,
    matchBasis: projectIdentity.matchBasis,
    identityContractVersion: projectIdentity.contractVersion,
    scopeMode: projectIdentity.scopeMode,
    identityFingerprint: projectIdentity.identityFingerprint,
    identityTrust: projectIdentity.trust,
    bindingStatus: projectIdentity.bindingStatus,
    technologies: matchedTechnologies,
    changeTypes: matchedChangeTypes,
    domains: matchedDomains,
    goal: input.goal,
    embeddingStatus: taskTraceEmbeddingStatus,
    embeddingProvider: taskTraceEmbeddingStats.embeddingProvider ?? null,
    embeddingModel: taskTraceEmbeddingStats.embeddingModel ?? null,
    embeddingDimensions: taskTraceEmbeddingStats.embeddingDimensions ?? null,
    embedding: taskTraceEmbeddingStats.queryEmbedding ?? null,
  });
  const selectedRankMap = new Map<string, number>();
  for (const [index, item] of selectedPackItems.entries()) {
    if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
    if (selectedRankMap.has(item.itemId)) continue;
    selectedRankMap.set(item.itemId, index + 1);
  }
  const agenticAcceptedKnowledgeIds = agenticResult.agenticUsed
    ? [...new Set(finalKnowledge.map((item) => item.id))]
    : [];

  let candidateTracePersistResult: Awaited<ReturnType<typeof persistCandidateTraceRows>> = {
    savedCount: 0,
    truncated: false,
    skippedReason: "not_attempted",
  };
  try {
    const [candidateTraceSettled, packItemsSettled] = await Promise.allSettled([
      persistCandidateTraceRows({
        runId,
        rows: candidateTraceRows,
        traceLimit: candidateTraceLimit,
      }),
      insertContextPackItems(
        runId,
        selectedPackItems.map((item) => ({
          itemKind: item.itemKind,
          itemId: item.itemId,
          section: item.section,
          score: item.score,
          rankingReason: item.rankingReason,
          sourceRefs: item.sourceRefs,
        })),
      ),
    ]);
    if (candidateTraceSettled.status === "fulfilled") {
      candidateTracePersistResult = candidateTraceSettled.value;
    } else {
      candidateTracePersistResult = {
        savedCount: 0,
        truncated: false,
        skippedReason: "save_failed",
      };
      await recordAuditLogSafe({
        eventType: "CONTEXT_COMPILE_CANDIDATE_TRACE_SAVE_FAILED",
        actor: "system",
        payload: {
          runId,
          traceLimit: candidateTraceLimit,
          candidateCount: candidateTraceRows.length,
          error:
            candidateTraceSettled.reason instanceof Error
              ? candidateTraceSettled.reason.message
              : String(candidateTraceSettled.reason),
        },
      });
    }
    if (packItemsSettled.status === "rejected") {
      throw packItemsSettled.reason;
    }
  } catch (error) {
    const failureReasons = [...new Set([...degradedReasons, "CONTEXT_PACK_PERSIST_FAILED"])];
    const failedDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const failedPack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "failed",
      minimalTasks,
      rules: budgetedRules.items,
      procedures: budgetedProcedures.items,
      guardrails: budgetedGuardrails.items,
      warnings: [],
      sourceRefs:
        sourceRefsCandidate.length > 0
          ? sourceRefsCandidate
          : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons: failureReasons })],
      diagnostics: {
        degradedReasons: failureReasons,
        retrievalStats: {
          knowledge: {
            ...positiveKnowledge.stats,
            textHitCount:
              positiveKnowledge.stats.textHitCount + negativeKnowledge.stats.textHitCount,
            vectorHitCount:
              positiveKnowledge.stats.vectorHitCount + negativeKnowledge.stats.vectorHitCount,
            mergedCount: positiveKnowledge.stats.mergedCount + negativeKnowledge.stats.mergedCount,
          },
          sources: sourceContext.stats,
          episodes: episodePrecedents.stats,
          embeddingTrace,
          tokenBudget,
          compileDurationMs: failedDurationMs,
          candidateTraceSavedCount: candidateTracePersistResult.savedCount,
          candidateTraceTruncated: candidateTracePersistResult.truncated,
          candidateTraceLimit,
          candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
          persistenceState: {
            contextPackItemsSaved: false,
            candidateTraceSavedCount: candidateTracePersistResult.savedCount,
            candidateTraceTruncated: candidateTracePersistResult.truncated,
            candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
          },
          duplicateSuppressedCount: duplicateSuppression.suppressedById.size,
          duplicateSuppressedGroupCount: duplicateSuppression.groups.length,
          landscapeIntervention: landscapeIntervention.diagnostics,
          agenticUsed: agenticResult.agenticUsed,
          agenticReasoning: agenticResult.reasoning,
          agenticSelectionReason: agenticResult.selectionReason ?? null,
          reasonBuckets: {
            blocking: [
              ...new Set([...reasonBuckets.blockingReasons, "CONTEXT_PACK_PERSIST_FAILED"]),
            ],
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: [
              ...new Set([...reasonBuckets.hardFailureReasons, "CONTEXT_PACK_PERSIST_FAILED"]),
            ],
          },
          responseComposer: {
            used: composedResponse.agenticUsed,
            markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
            ...(composedResponse.noContentReason
              ? { noContentReason: composedResponse.noContentReason }
              : {}),
            ...(composedResponse.error ? { error: composedResponse.error } : {}),
          },
          persistError: error instanceof Error ? error.message : String(error),
          suggestedNextCalls: [...new Set([...suggestedNextCalls, "doctor"])],
        },
        inputFacets,
      },
    });
    const failedPackWithMarkdown = attachOutputMarkdownToPack(failedPack, "No Content");
    await updateCompileRunFailureSafe({
      runId,
      degradedReasons: failureReasons,
      durationMs: failedDurationMs,
      pack: failedPackWithMarkdown,
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "failed",
        degradedReasons: failureReasons,
        tokenBudget,
        compileDurationMs: failedDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: {
          rules: budgetedRules.items.length,
          procedures: budgetedProcedures.items.length,
          guardrails: budgetedGuardrails.items.length,
        },
        persistError: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  await recordKnowledgeCompileSelectionSafe({
    runId,
    selectedKnowledgeIds,
    agenticAcceptedKnowledgeIds,
  });

  await recordCompileRunKnowledgeUsageSignalsSafe({
    runId,
    selectedKnowledgeIds,
    selectedRankMap,
    agenticAcceptedKnowledgeIds,
    usedKnowledge: composedResponse.usedKnowledge,
    actor: composedResponse.agenticUsed ? "agent" : "system",
  });

  const sourceRefs =
    sourceRefsCandidate.length > 0
      ? sourceRefsCandidate
      : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    guardrails: budgetedGuardrails.items,
    warnings: [],
    sourceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: {
          ...positiveKnowledge.stats,
          textHitCount: positiveKnowledge.stats.textHitCount + negativeKnowledge.stats.textHitCount,
          vectorHitCount:
            positiveKnowledge.stats.vectorHitCount + negativeKnowledge.stats.vectorHitCount,
          mergedCount: positiveKnowledge.stats.mergedCount + negativeKnowledge.stats.mergedCount,
        },
        sources: sourceContext.stats,
        episodes: episodePrecedents.stats,
        embeddingTrace,
        tokenBudget,
        compileDurationMs,
        candidateTraceSavedCount: candidateTracePersistResult.savedCount,
        candidateTraceTruncated: candidateTracePersistResult.truncated,
        candidateTraceLimit,
        candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
        persistenceState: {
          contextPackItemsSaved: true,
          candidateTraceSavedCount: candidateTracePersistResult.savedCount,
          candidateTraceTruncated: candidateTracePersistResult.truncated,
          candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
        },
        duplicateSuppressedCount: duplicateSuppression.suppressedById.size,
        duplicateSuppressedGroupCount: duplicateSuppression.groups.length,
        landscapeIntervention: landscapeIntervention.diagnostics,
        agenticUsed: agenticResult.agenticUsed,
        agenticReasoning: agenticResult.reasoning,
        agenticSelectionReason: agenticResult.selectionReason ?? null,
        reasonBuckets: {
          blocking: reasonBuckets.blockingReasons,
          maintenanceWarnings: reasonBuckets.maintenanceWarnings,
          hardFailures: reasonBuckets.hardFailureReasons,
        },
        responseComposer: {
          used: composedResponse.agenticUsed,
          markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
          ...(composedResponse.noContentReason
            ? { noContentReason: composedResponse.noContentReason }
            : {}),
          ...(composedResponse.error ? { error: composedResponse.error } : {}),
        },
        suggestedNextCalls: [...new Set(suggestedNextCalls)],
      },
      inputFacets,
    },
  });

  const markdown = forceNoContentDueToRateLimit
    ? "No Content"
    : composedResponse.markdown || renderContextPackMarkdown(pack);
  const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
  await updateCompileRunSnapshotSafe(runId, packWithMarkdown);

  await recordAuditLogSafe({
    eventType: auditEventTypes.contextCompileRun,
    actor: "agent",
    payload: {
      runId,
      goal: input.goal,
      retrievalMode,
      status,
      degradedReasons,
      tokenBudget,
      compileDurationMs,
      source: options?.source ?? "unknown",
      selectedCounts: {
        rules: budgetedRules.items.length,
        procedures: budgetedProcedures.items.length,
        guardrails: budgetedGuardrails.items.length,
      },
    },
  });

  return { pack: packWithMarkdown, markdown };
}
