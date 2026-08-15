import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import {
  type KnowledgeItem,
  type KnowledgeStatus,
  knowledgeSearchInputSchema,
} from "../../shared/schemas/knowledge.schema.js";
import {
  type ResolvedCompileProjectIdentity,
  resolveCompileProjectIdentity,
} from "../context-compiler/compile-project-identity.js";
import { buildRetrievalQueryText } from "../context-compiler/query-context.js";
import { embedOne } from "../embedding/embedding.service.js";
import { resolveKnowledgeSearchStatuses } from "./knowledge-lifecycle.service.js";
import {
  type KnowledgeSearchResult,
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "./knowledge.repository.js";

export type KnowledgeCandidateEvidence = {
  textMatched: boolean;
  vectorMatched: boolean;
  vectorScore?: number;
  facetMatched: boolean;
};

type KnowledgeSearchResultWithEvidence = KnowledgeSearchResult & {
  candidateEvidence?: KnowledgeCandidateEvidence;
};

export type KnowledgeRetrievalTraceEntry = {
  id: string;
  rank: number;
  score: number;
};

export type KnowledgeRetrievalTrace = {
  text: KnowledgeRetrievalTraceEntry[];
  vector: KnowledgeRetrievalTraceEntry[];
  merged: KnowledgeRetrievalTraceEntry[];
};

export type KnowledgeRetrievalResult = {
  items: KnowledgeSearchResultWithEvidence[];
  degradedReasons: string[];
  trace: KnowledgeRetrievalTrace;
  stats: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    textFailed: boolean;
    vectorFailed: boolean;
    embeddingStatus: "provided" | "generated" | "unavailable" | "disabled";
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    queryEmbedding?: number[];
    scopedSearch: boolean;
    repoScopeFallbackUsed: boolean;
    queryText: string;
    searchedQueries?: string[];
    roundsExecuted?: number;
    laneCoverage?: string[];
  };
};

function getKnowledgeRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  types?: KnowledgeItem["type"][];
} {
  switch (retrievalMode) {
    case "review_context":
      return { limit: 12, types: ["rule", "procedure"] };
    case "debug_context":
      return { limit: 14, types: ["procedure", "rule"] };
    case "architecture_context":
      return { limit: 12, types: ["rule"] };
    case "procedure_context":
      return { limit: 10, types: ["procedure"] };
    case "learning_context":
      return { limit: 15 };
    default:
      return { limit: 12 };
  }
}

type KnowledgeSearchScope = {
  projectIdentity: ResolvedCompileProjectIdentity;
};

type InternalKnowledgeSearchParams = {
  primaryQuery: string;
  queryText: string;
  textQueries?: string[];
  limit: number;
  statuses: KnowledgeStatus[];
  status: KnowledgeStatus;
  includeDraft: boolean;
  types?: KnowledgeItem["type"][];
  polarities?: Array<"positive" | "negative" | "neutral">;
  intentTags?: string[];
  projectIdentity: ResolvedCompileProjectIdentity;
  scopedSearch: boolean;
  queryEmbedding?: number[];
  generateEmbeddingIfMissing: boolean;
  noMatchReason: string;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  includeGeneral?: boolean;
};

type RetrievalRoundName = "intent" | "domain" | "combined";

type RetrievalQueryRound = {
  name: RetrievalRoundName;
  queries: string[];
  minimumContribution: number;
};

function uniqueNonEmptyStrings(values: Array<string | undefined | null>): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped];
}

function splitGoalClauses(goal: string): string[] {
  const clauses = goal
    .split(/[\n\r,，、。;；]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  return clauses.length > 0 ? [...new Set(clauses)] : [goal.trim()];
}

function buildFacetLines(
  input: Pick<CompileInput, "changeTypes" | "technologies" | "domains">,
): string[] {
  const changeTypes = uniqueNonEmptyStrings(input.changeTypes ?? []);
  const technologies = uniqueNonEmptyStrings(input.technologies ?? []);
  const domains = uniqueNonEmptyStrings(input.domains ?? []);
  const lines: string[] = [];
  if (changeTypes.length > 0) lines.push(`changeTypes: ${changeTypes.join(" ")}`);
  if (technologies.length > 0) lines.push(`technologies: ${technologies.join(" ")}`);
  if (domains.length > 0) lines.push(`domains: ${domains.join(" ")}`);
  return lines;
}

function expandClauseKeywords(clause: string): string[] {
  const roughTokens = clause
    .split(/[\s+/|,，、。;；:：()（）[\]{}「」『』・]+/u)
    .flatMap((token) => token.split(/[のをにがはでとやへ]/u))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const stopWords = new Set(["こと", "ため", "する", "したい", "です", "ます", "実装", "作る"]);
  const filtered = roughTokens.filter((token) => !stopWords.has(token));
  return [...new Set(filtered)].slice(0, 6);
}

function buildRetrievalRounds(
  input: Pick<CompileInput, "goal" | "changeTypes" | "technologies" | "domains">,
): RetrievalQueryRound[] {
  const goal = input.goal.trim();
  const clauses = splitGoalClauses(goal);
  const intentSeed = clauses.at(-1) ?? goal;
  const domainSeed = clauses[0] ?? goal;
  const facetLines = buildFacetLines(input);
  const intentKeywords = expandClauseKeywords(intentSeed);
  const domainKeywords = expandClauseKeywords(domainSeed);

  const intentQueries = uniqueNonEmptyStrings([
    intentSeed,
    ...intentKeywords,
    ...clauses.slice(1),
    goal,
  ]);
  const domainQueries = uniqueNonEmptyStrings([
    domainSeed,
    ...domainKeywords,
    ...clauses.slice(0, Math.max(0, clauses.length - 1)),
    ...facetLines,
  ]).filter((query) => !intentQueries.includes(query));
  const combinedQuery = buildRetrievalQueryText(input);
  const combinedQueries = uniqueNonEmptyStrings([combinedQuery]).filter(
    (query) => !intentQueries.includes(query) && !domainQueries.includes(query),
  );

  const rounds: RetrievalQueryRound[] = [
    { name: "intent", queries: intentQueries, minimumContribution: 1 },
  ];
  if (domainQueries.length > 0) {
    rounds.push({ name: "domain", queries: domainQueries, minimumContribution: 1 });
  }
  if (combinedQueries.length > 0) {
    rounds.push({ name: "combined", queries: combinedQueries, minimumContribution: 1 });
  }
  return rounds;
}

function mergeRetrievalTraceEntries(
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
    .sort((a, b) => b[1] - a[1])
    .map(([id, score], index) => ({
      id,
      score,
      rank: index + 1,
    }));
}

function mergeRetrievalItems(
  items: KnowledgeSearchResultWithEvidence[],
): KnowledgeSearchResultWithEvidence[] {
  const mergedById = new Map<string, KnowledgeSearchResultWithEvidence>();
  for (const item of items) {
    const existing = mergedById.get(item.id);
    if (!existing) {
      mergedById.set(item.id, { ...item });
      continue;
    }
    const mergedEvidence = mergeCandidateEvidence(
      existing.candidateEvidence,
      item.candidateEvidence ?? {},
    );
    const preferred = item.score > existing.score ? item : existing;
    mergedById.set(item.id, {
      ...preferred,
      candidateEvidence: mergedEvidence,
    });
  }
  return [...mergedById.values()].sort((a, b) => b.score - a.score);
}

function selectItemsWithLaneQuota(params: {
  mergedItems: KnowledgeSearchResultWithEvidence[];
  roundResults: Array<{ lane: RetrievalRoundName; items: KnowledgeSearchResultWithEvidence[] }>;
  requiredLanes: Set<RetrievalRoundName>;
  limit: number;
}): KnowledgeSearchResultWithEvidence[] {
  const laneOrder: RetrievalRoundName[] = ["intent", "domain", "combined"];
  const mergedById = new Map(params.mergedItems.map((item) => [item.id, item]));
  const selected: KnowledgeSearchResultWithEvidence[] = [];
  const selectedIds = new Set<string>();

  for (const lane of laneOrder) {
    if (!params.requiredLanes.has(lane)) continue;
    const laneBest = params.roundResults
      .filter((round) => round.lane === lane)
      .flatMap((round) => round.items)
      .sort((a, b) => b.score - a.score)
      .find((item) => !selectedIds.has(item.id) && mergedById.has(item.id));
    if (!laneBest) continue;
    const mergedItem = mergedById.get(laneBest.id);
    if (!mergedItem) continue;
    selected.push(mergedItem);
    selectedIds.add(mergedItem.id);
  }

  for (const item of params.mergedItems) {
    if (selectedIds.has(item.id)) continue;
    selected.push(item);
    selectedIds.add(item.id);
    if (selected.length >= params.limit) break;
  }

  return selected.slice(0, params.limit);
}

function chooseEmbeddingStatus(
  statuses: Array<KnowledgeRetrievalResult["stats"]["embeddingStatus"]>,
): KnowledgeRetrievalResult["stats"]["embeddingStatus"] {
  const priority: Record<KnowledgeRetrievalResult["stats"]["embeddingStatus"], number> = {
    generated: 3,
    provided: 2,
    unavailable: 1,
    disabled: 0,
  };
  return (
    statuses.reduce<KnowledgeRetrievalResult["stats"]["embeddingStatus"]>(
      (best, current) => (priority[current] > priority[best] ? current : best),
      "disabled",
    ) ?? "disabled"
  );
}

function mergeKnowledgeHits(hits: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
  const mergedById = new Map<string, KnowledgeSearchResult>();
  for (const item of hits) {
    const existing = mergedById.get(item.id);
    if (!existing || item.score > existing.score) {
      mergedById.set(item.id, item);
    }
  }
  return [...mergedById.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function hasFacetMatch(item: KnowledgeSearchResult): boolean {
  const matches = item.applicabilityMatches;
  if (!matches) return false;
  return (
    matches.technologies.length > 0 ||
    matches.changeTypes.length > 0 ||
    matches.domains.length > 0 ||
    matches.general
  );
}

function mergeCandidateEvidence(
  target: KnowledgeCandidateEvidence | undefined,
  incoming: Partial<KnowledgeCandidateEvidence>,
): KnowledgeCandidateEvidence {
  const merged: KnowledgeCandidateEvidence = {
    textMatched: target?.textMatched ?? false,
    vectorMatched: target?.vectorMatched ?? false,
    facetMatched: target?.facetMatched ?? false,
    ...(typeof target?.vectorScore === "number" ? { vectorScore: target.vectorScore } : {}),
  };

  if (incoming.textMatched) merged.textMatched = true;
  if (incoming.vectorMatched) merged.vectorMatched = true;
  if (incoming.facetMatched) merged.facetMatched = true;
  if (typeof incoming.vectorScore === "number") {
    merged.vectorScore =
      typeof merged.vectorScore === "number"
        ? Math.max(merged.vectorScore, incoming.vectorScore)
        : incoming.vectorScore;
  }

  return merged;
}

function buildCandidateEvidenceMap(params: {
  textHits: KnowledgeSearchResult[];
  vectorHits: KnowledgeSearchResult[];
  merged: KnowledgeSearchResult[];
}): Map<string, KnowledgeCandidateEvidence> {
  const evidenceById = new Map<string, KnowledgeCandidateEvidence>();

  for (const hit of params.textHits) {
    evidenceById.set(
      hit.id,
      mergeCandidateEvidence(evidenceById.get(hit.id), {
        textMatched: true,
        facetMatched: hasFacetMatch(hit),
      }),
    );
  }

  for (const hit of params.vectorHits) {
    evidenceById.set(
      hit.id,
      mergeCandidateEvidence(evidenceById.get(hit.id), {
        vectorMatched: true,
        vectorScore: hit.score,
        facetMatched: hasFacetMatch(hit),
      }),
    );
  }

  for (const item of params.merged) {
    evidenceById.set(
      item.id,
      mergeCandidateEvidence(evidenceById.get(item.id), {
        facetMatched: hasFacetMatch(item),
      }),
    );
  }

  return evidenceById;
}

function appendDegradedReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function buildRankedTraceEntries(items: KnowledgeSearchResult[]): KnowledgeRetrievalTraceEntry[] {
  const deduped = [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => b.score - a.score,
  );
  return deduped.map((item, index) => ({
    id: item.id,
    rank: index + 1,
    score: item.score,
  }));
}

async function executeKnowledgeSearch(
  params: InternalKnowledgeSearchParams,
): Promise<KnowledgeRetrievalResult> {
  const degradedReasons: string[] = [];
  let workingEmbedding = params.queryEmbedding;
  let embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"] =
    workingEmbedding && workingEmbedding.length > 0 ? "provided" : "disabled";
  let embeddingProvider: string | undefined =
    workingEmbedding && workingEmbedding.length > 0 ? groupedConfig.embedding.provider : undefined;
  let embeddingModel: string | undefined =
    workingEmbedding && workingEmbedding.length > 0
      ? groupedConfig.embedding.provider === "openai"
        ? groupedConfig.embedding.openaiModel
        : undefined
      : undefined;
  let embeddingDimensions: number | undefined =
    workingEmbedding && workingEmbedding.length > 0 ? workingEmbedding.length : undefined;

  const buildSearchInput = (query: string, limit: number, scope: KnowledgeSearchScope) =>
    knowledgeSearchInputSchema.parse({
      query,
      limit,
      types: params.types,
      statuses: params.statuses,
      status: params.status,
      polarities: params.polarities,
      intentTags: params.intentTags,
      includeDraft: params.includeDraft,
      technologies: params.technologies,
      changeTypes: params.changeTypes,
      domains: params.domains,
      includeGeneral: params.includeGeneral ?? true,
      ...(scope.projectIdentity.projectRef ? { projectRef: scope.projectIdentity.projectRef } : {}),
      ...(scope.projectIdentity.repoKey ? { repoKey: scope.projectIdentity.repoKey } : {}),
      ...(scope.projectIdentity.repoPath ? { repoPath: scope.projectIdentity.repoPath } : {}),
    });

  const normalizedTextQueries =
    params.textQueries && params.textQueries.length > 0
      ? uniqueNonEmptyStrings([params.primaryQuery, ...params.textQueries])
      : uniqueNonEmptyStrings([
          params.primaryQuery,
          params.queryText !== params.primaryQuery ? params.queryText : undefined,
        ]);
  const secondaryQueryLimit = Math.max(
    1,
    Math.floor(params.limit / Math.max(2, normalizedTextQueries.length)),
  );

  const runScopedSearch = async (
    scope: KnowledgeSearchScope,
  ): Promise<{
    textHits: KnowledgeSearchResult[];
    vectorHits: KnowledgeSearchResult[];
    textFailed: boolean;
    vectorFailed: boolean;
  }> => {
    let textHits: KnowledgeSearchResult[] = [];
    let vectorHits: KnowledgeSearchResult[] = [];
    let textFailed = false;
    let vectorFailed = false;

    const searchOptions = {
      projectIdentity: scope.projectIdentity,
      types: params.types,
      polarities: params.polarities,
      intentTags: params.intentTags,
      technologies: params.technologies,
      changeTypes: params.changeTypes,
      domains: params.domains,
      includeGeneral: params.includeGeneral ?? true,
    } as const;

    const textResults = await Promise.all(
      normalizedTextQueries.map(async (query, index) => {
        try {
          return await searchKnowledge(
            buildSearchInput(query, index === 0 ? params.limit : secondaryQueryLimit, scope),
            searchOptions,
          );
        } catch {
          textFailed = true;
          appendDegradedReason(degradedReasons, "KNOWLEDGE_TEXT_SEARCH_FAILED");
          return [];
        }
      }),
    );
    textHits = [...new Map(textResults.flat().map((item) => [item.id, item])).values()];

    if (
      groupedConfig.compile.enableVectorSearch &&
      resolveDatabaseBackendConfig().kind === "sqlite"
    ) {
      embeddingStatus = "disabled";
      workingEmbedding = undefined;
      embeddingProvider = undefined;
      embeddingModel = undefined;
      embeddingDimensions = undefined;
      appendDegradedReason(degradedReasons, "KNOWLEDGE_VECTOR_SCOPE_PREFILTER_UNAVAILABLE");
    } else if (groupedConfig.compile.enableVectorSearch) {
      if (
        (!workingEmbedding || workingEmbedding.length === 0) &&
        params.generateEmbeddingIfMissing
      ) {
        try {
          workingEmbedding = await embedOne(params.primaryQuery, "query");
          embeddingStatus = "generated";
          embeddingProvider = groupedConfig.embedding.provider;
          embeddingModel =
            groupedConfig.embedding.provider === "openai"
              ? groupedConfig.embedding.openaiModel
              : undefined;
          embeddingDimensions = workingEmbedding.length;
        } catch {
          embeddingStatus = "unavailable";
          appendDegradedReason(degradedReasons, "QUERY_EMBEDDING_UNAVAILABLE");
        }
      }
      if (workingEmbedding && workingEmbedding.length > 0) {
        try {
          vectorHits = await vectorSearchKnowledge(
            workingEmbedding,
            params.limit,
            params.statuses,
            {
              projectIdentity: scope.projectIdentity,
              types: params.types,
              polarities: params.polarities,
              intentTags: params.intentTags,
              technologies: params.technologies,
              changeTypes: params.changeTypes,
              domains: params.domains,
              includeGeneral: params.includeGeneral ?? true,
            },
          );
        } catch {
          vectorFailed = true;
          appendDegradedReason(degradedReasons, "KNOWLEDGE_VECTOR_SEARCH_FAILED");
        }
      }
    }

    return {
      textHits,
      vectorHits,
      textFailed,
      vectorFailed,
    };
  };

  const searchResult = await runScopedSearch({ projectIdentity: params.projectIdentity });
  const merged = mergeKnowledgeHits(
    [...searchResult.textHits, ...searchResult.vectorHits],
    params.limit,
  );
  const repoScopeFallbackUsed = false;

  if (merged.length === 0 && !searchResult.textFailed && !searchResult.vectorFailed) {
    appendDegradedReason(degradedReasons, params.noMatchReason);
  }

  const evidenceById = buildCandidateEvidenceMap({
    textHits: searchResult.textHits,
    vectorHits: searchResult.vectorHits,
    merged,
  });

  const textTrace = buildRankedTraceEntries(searchResult.textHits);
  const vectorTrace = buildRankedTraceEntries(searchResult.vectorHits);
  const mergedTrace = buildRankedTraceEntries(merged);

  return {
    items: merged.map((item) => ({
      ...item,
      candidateEvidence: evidenceById.get(item.id),
    })),
    degradedReasons,
    trace: {
      text: textTrace,
      vector: vectorTrace,
      merged: mergedTrace,
    },
    stats: {
      textHitCount: textTrace.length,
      vectorHitCount: vectorTrace.length,
      mergedCount: mergedTrace.length,
      textFailed: searchResult.textFailed,
      vectorFailed: searchResult.vectorFailed,
      embeddingStatus,
      embeddingProvider,
      embeddingModel,
      embeddingDimensions,
      queryEmbedding:
        workingEmbedding && workingEmbedding.length > 0 ? [...workingEmbedding] : undefined,
      scopedSearch: params.scopedSearch,
      repoScopeFallbackUsed,
      queryText: params.queryText,
      searchedQueries: normalizedTextQueries,
    },
  };
}

export async function retrieveKnowledge(
  input: CompileInput,
  options: {
    retrievalMode: RetrievalMode;
    limit?: number;
    polarities?: Array<"positive" | "negative" | "neutral">;
    intentTags?: string[];
    facetFilters?: {
      changeTypes?: string[];
      technologies?: string[];
      domains?: string[];
    };
  },
): Promise<KnowledgeRetrievalResult> {
  const profile = getKnowledgeRetrievalProfile(options.retrievalMode);
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : profile.limit;
  const statuses = resolveKnowledgeSearchStatuses({
    retrievalMode: options.retrievalMode,
    includeDraft: input.includeDraft === true,
  });
  const identity = resolveCompileProjectIdentity({
    projectRef: input.projectRef,
    repoKey: input.repoKey,
    repoPath: input.repoPath,
  });
  const scopedSearch = identity.matchBasis !== "none";
  const retrievalInput: CompileInput = {
    ...input,
    technologies: options.facetFilters?.technologies ?? input.technologies,
    changeTypes: options.facetFilters?.changeTypes ?? input.changeTypes,
    domains: options.facetFilters?.domains ?? input.domains,
  };
  const rounds = buildRetrievalRounds(retrievalInput);
  const requiredLanes = new Set<RetrievalRoundName>(["intent"]);
  if (rounds.some((round) => round.name === "domain")) requiredLanes.add("domain");

  const roundResults: Array<
    KnowledgeRetrievalResult & { lane: RetrievalRoundName; newItemCount: number }
  > = [];
  const seenItemIds = new Set<string>();
  const laneCoverage = new Set<RetrievalRoundName>();

  for (const round of rounds) {
    const result = await executeKnowledgeSearch({
      primaryQuery: round.queries[0] ?? retrievalInput.goal.trim(),
      queryText: round.queries.join("\n"),
      textQueries: round.queries,
      limit,
      statuses,
      status: "active",
      includeDraft: input.includeDraft === true,
      types: profile.types,
      polarities: options.polarities,
      intentTags: options.intentTags,
      projectIdentity: identity,
      scopedSearch,
      generateEmbeddingIfMissing: true,
      noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
      technologies: retrievalInput.technologies,
      changeTypes: retrievalInput.changeTypes,
      domains: retrievalInput.domains,
      includeGeneral: true,
    });

    let newItemCount = 0;
    for (const item of result.items) {
      if (!seenItemIds.has(item.id)) {
        seenItemIds.add(item.id);
        newItemCount += 1;
      }
    }
    if (newItemCount >= round.minimumContribution) laneCoverage.add(round.name);
    roundResults.push({ ...result, lane: round.name, newItemCount });

    const requiredSatisfied = [...requiredLanes].every((lane) => laneCoverage.has(lane));
    if (requiredSatisfied) break;
  }

  if (roundResults.length === 0) {
    return executeKnowledgeSearch({
      primaryQuery: retrievalInput.goal.trim(),
      queryText: buildRetrievalQueryText(retrievalInput),
      limit,
      statuses,
      status: "active",
      includeDraft: input.includeDraft === true,
      types: profile.types,
      polarities: options.polarities,
      intentTags: options.intentTags,
      projectIdentity: identity,
      scopedSearch,
      generateEmbeddingIfMissing: true,
      noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
      technologies: retrievalInput.technologies,
      changeTypes: retrievalInput.changeTypes,
      domains: retrievalInput.domains,
      includeGeneral: true,
    });
  }

  const mergedItems = mergeRetrievalItems(roundResults.flatMap((result) => result.items));
  const selectedItems = selectItemsWithLaneQuota({
    mergedItems,
    roundResults,
    requiredLanes,
    limit,
  });
  const degradedReasons = [
    ...new Set(roundResults.flatMap((result) => result.degradedReasons)),
  ].filter((reason) => selectedItems.length === 0 || reason !== "NO_ACTIVE_KNOWLEDGE_MATCH");
  const textTrace = mergeRetrievalTraceEntries(roundResults.flatMap((result) => result.trace.text));
  const vectorTrace = mergeRetrievalTraceEntries(
    roundResults.flatMap((result) => result.trace.vector),
  );
  const mergedTrace = mergeRetrievalTraceEntries(
    roundResults.flatMap((result) => result.trace.merged),
  );
  const embeddingStatus = chooseEmbeddingStatus(
    roundResults.map((result) => result.stats.embeddingStatus),
  );
  const embeddingSource = roundResults.find(
    (result) => result.stats.embeddingStatus === embeddingStatus,
  );
  const searchedQueries = uniqueNonEmptyStrings(
    roundResults.flatMap((result) => result.stats.searchedQueries ?? []),
  );

  return {
    items: selectedItems,
    degradedReasons,
    trace: {
      text: textTrace,
      vector: vectorTrace,
      merged: mergedTrace,
    },
    stats: {
      textHitCount: textTrace.length,
      vectorHitCount: vectorTrace.length,
      mergedCount: mergedTrace.length,
      textFailed: roundResults.some((result) => result.stats.textFailed),
      vectorFailed: roundResults.some((result) => result.stats.vectorFailed),
      embeddingStatus,
      embeddingProvider: embeddingSource?.stats.embeddingProvider,
      embeddingModel: embeddingSource?.stats.embeddingModel,
      embeddingDimensions: embeddingSource?.stats.embeddingDimensions,
      queryEmbedding:
        roundResults.find(
          (result) => result.stats.queryEmbedding && result.stats.queryEmbedding.length > 0,
        )?.stats.queryEmbedding ?? undefined,
      scopedSearch,
      repoScopeFallbackUsed: roundResults.some((result) => result.stats.repoScopeFallbackUsed),
      queryText: buildRetrievalQueryText(retrievalInput),
      searchedQueries,
      roundsExecuted: roundResults.length,
      laneCoverage: [...laneCoverage],
    },
  };
}

export async function searchKnowledgeCandidates(
  rawInput: unknown,
): Promise<KnowledgeRetrievalResult> {
  const parsed = knowledgeSearchInputSchema.parse(rawInput);
  const statuses =
    parsed.statuses && parsed.statuses.length > 0
      ? parsed.statuses
      : parsed.includeDraft
        ? (["active", "draft"] as KnowledgeStatus[])
        : ([parsed.status] as KnowledgeStatus[]);
  const identity = resolveCompileProjectIdentity({
    projectRef: parsed.projectRef,
    repoKey: parsed.repoKey,
    repoPath: parsed.repoPath,
  });
  const primaryQuery = parsed.query.trim();
  return executeKnowledgeSearch({
    primaryQuery,
    queryText: buildRetrievalQueryText({
      goal: primaryQuery,
      changeTypes: parsed.changeTypes,
      technologies: parsed.technologies,
      domains: parsed.domains,
    }),
    limit: parsed.limit,
    statuses,
    status: parsed.status,
    polarities: parsed.polarities,
    intentTags: parsed.intentTags,
    includeDraft: parsed.includeDraft,
    types: parsed.types,
    projectIdentity: identity,
    scopedSearch: identity.matchBasis !== "none",
    generateEmbeddingIfMissing: true,
    noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
    technologies: parsed.technologies,
    changeTypes: parsed.changeTypes,
    domains: parsed.domains,
    includeGeneral: parsed.includeGeneral,
  });
}

export async function registerKnowledgeFromMarkdown(params: {
  sourceUri: string;
  title: string;
  body: string;
  type?: "rule" | "procedure";
  status?: KnowledgeStatus;
  scope?: "repo" | "global";
  polarity?: string;
  intentTags?: string[];
  confidence?: number;
  importance?: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  projectRef?: string;
  repoPath?: string;
  repoKey?: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}): Promise<string> {
  let embedding = params.embedding;
  if (!embedding) {
    embedding = await embedOne(`${params.title}\n${params.body}`, "passage");
  }
  return upsertKnowledgeFromSource({
    sourceUri: params.sourceUri,
    type: params.type ?? "rule",
    status: params.status ?? "draft",
    scope: params.scope ?? "repo",
    projectRef: params.projectRef,
    repoPath: params.repoPath,
    repoKey: params.repoKey,
    identityProducer: "knowledge.register-markdown",
    polarity: params.polarity,
    intentTags: params.intentTags,
    title: params.title,
    body: params.body,
    confidence: params.confidence,
    importance: params.importance,
    appliesTo: {
      ...(params.appliesTo ?? {}),
      ...(params.general !== undefined ? { general: params.general } : {}),
      ...(params.technologies ? { technologies: params.technologies } : {}),
      ...(params.changeTypes ? { changeTypes: params.changeTypes } : {}),
      ...(params.domains ? { domains: params.domains } : {}),
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.repoKey ? { repoKey: params.repoKey } : {}),
    },
    metadata: params.metadata,
    embedding,
  });
}
