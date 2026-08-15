import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { resolveCompileProjectIdentity } from "../context-compiler/compile-project-identity.js";
import { buildRetrievalQueryText } from "../context-compiler/query-context.js";
import { embedOne } from "../embedding/embedding.service.js";
import {
  type SourceKind,
  type SourceSearchResult,
  searchSourceContent,
  vectorSearchSourceContent,
} from "./source.repository.js";

export type SourceRetrievalResult = {
  items: SourceSearchResult[];
  degradedReasons: string[];
  stats: {
    hitCount: number;
    textHitCount: number;
    vectorHitCount: number;
    searchFailed: boolean;
    embeddingStatus: "generated" | "unavailable" | "disabled" | "provided";
    scopedSearch: boolean;
    repoScopeFallbackUsed: boolean;
    queryText: string;
  };
};

function getSourceRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  sourceKinds?: SourceKind[];
} {
  switch (retrievalMode) {
    case "review_context":
      return { limit: 10 };
    case "debug_context":
      return { limit: 12 };
    case "architecture_context":
      return { limit: 10 };
    case "procedure_context":
      return { limit: 10 };
    case "learning_context":
      return { limit: 10 };
    default:
      return { limit: 8 };
  }
}

function mergeSourceHits(
  primary: SourceSearchResult[],
  secondary: SourceSearchResult[],
  limit: number,
): SourceSearchResult[] {
  const byId = new Map<string, SourceSearchResult>();
  for (const item of [...primary, ...secondary]) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function retrieveSources(
  input: CompileInput,
  options: { retrievalMode: RetrievalMode },
): Promise<SourceRetrievalResult> {
  const profile = getSourceRetrievalProfile(options.retrievalMode);
  const primaryQuery = input.goal.trim();
  const queryText = buildRetrievalQueryText(input);
  const degradedReasons: string[] = [];
  const identity = resolveCompileProjectIdentity({
    projectRef: input.projectRef,
    repoKey: input.repoKey,
    repoPath: input.repoPath,
  });
  const searchOptions = { projectIdentity: identity } as const;

  const runSearch = async (): Promise<{
    items: SourceSearchResult[];
    textHits: SourceSearchResult[];
    vectorHits: SourceSearchResult[];
    searchFailed: boolean;
    embeddingStatus: SourceRetrievalResult["stats"]["embeddingStatus"];
  }> => {
    let items: SourceSearchResult[] = [];
    let textHits: SourceSearchResult[] = [];
    let vectorHits: SourceSearchResult[] = [];
    let searchFailed = false;
    let embeddingStatus: SourceRetrievalResult["stats"]["embeddingStatus"] = "disabled";

    try {
      const baseHits = await searchSourceContent(
        primaryQuery,
        profile.limit,
        profile.sourceKinds,
        searchOptions,
      );
      const enrichedHits =
        queryText !== primaryQuery
          ? await searchSourceContent(
              queryText,
              Math.max(3, Math.floor(profile.limit / 2)),
              profile.sourceKinds,
              searchOptions,
            )
          : [];
      const mergedBaseHits = mergeSourceHits(baseHits, enrichedHits, profile.limit);
      textHits = mergedBaseHits;

      if (
        groupedConfig.compile.enableVectorSearch &&
        resolveDatabaseBackendConfig().kind === "sqlite"
      ) {
        embeddingStatus = "disabled";
        degradedReasons.push("SOURCE_VECTOR_SCOPE_PREFILTER_UNAVAILABLE");
      } else if (groupedConfig.compile.enableVectorSearch) {
        try {
          const queryEmbedding = await embedOne(primaryQuery, "query");
          embeddingStatus = "generated";
          vectorHits = await vectorSearchSourceContent(
            queryEmbedding,
            profile.limit,
            profile.sourceKinds,
            searchOptions,
          );
        } catch {
          embeddingStatus = "unavailable";
          degradedReasons.push("SOURCE_QUERY_EMBEDDING_UNAVAILABLE");
        }
      }
      items = mergeSourceHits(textHits, vectorHits, profile.limit);
    } catch {
      searchFailed = true;
      degradedReasons.push("SOURCE_SEARCH_FAILED");
    }
    return { items, textHits, vectorHits, searchFailed, embeddingStatus };
  };

  const result = await runSearch();

  if (!result.searchFailed && result.items.length === 0) {
    degradedReasons.push("NO_SOURCE_MATCH");
  }

  return {
    items: result.items,
    degradedReasons,
    stats: {
      hitCount: result.items.length,
      textHitCount: result.textHits.length,
      vectorHitCount: result.vectorHits.length,
      searchFailed: result.searchFailed,
      embeddingStatus: result.embeddingStatus,
      scopedSearch: identity.matchBasis !== "none",
      repoScopeFallbackUsed: false,
      queryText,
    },
  };
}
