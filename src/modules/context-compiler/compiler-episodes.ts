import { mcpResourceUri } from "../../project-identity.js";
import type { CompileInput } from "../../shared/schemas/compile.schema.js";
import type { ContextPackItem } from "../../shared/schemas/context-pack.schema.js";
import type {
  EpisodeCard,
  EpisodeCardSearchInput,
} from "../../shared/schemas/episode-card.schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import { searchEpisodes } from "../episodic-memory/episode-card.service.js";
import type { resolveCompileProjectIdentity } from "./compile-project-identity.js";
import { CONTEXT_COMPILE_LIMITS } from "./compiler-contracts.js";
import { buildRepositorySelectionScopeSnapshot } from "./repository-scope.js";

export type EpisodePrecedentRetrievalResult = {
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

export function buildEpisodeRefValue(ref: EpisodeCard["refs"][number]): string {
  const value = ref.refValue.trim();
  const locator = ref.locator?.trim();
  if (!value) return "";
  if (locator) return `${value}#${locator}`;
  return `${ref.refKind}:${value}`;
}

export function episodeSourceRefs(episode: EpisodeCard): string[] {
  return [
    mcpResourceUri(`episodes/${episode.id}`),
    ...episode.refs.map(buildEpisodeRefValue).filter(Boolean),
  ].slice(0, 5);
}

export function normalizeEpisodeScore(episode: EpisodeCard, index: number): number {
  const searchScore = Math.max(0, Number(episode.score ?? 0));
  const confidenceScore = Math.min(1, Math.max(0, episode.confidence / 100));
  const importanceScore = Math.min(1, Math.max(0, episode.importance / 100));
  const qualityBoost = importanceScore * 0.09 + confidenceScore * 0.05;
  return Math.min(0.75, 0.35 + Math.min(0.18, searchScore / 100) + qualityBoost - index * 0.03);
}

export function compactEpisodeText(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
}

export function episodeToPackItem(
  episode: EpisodeCard,
  index: number,
  projectIdentity: ReturnType<typeof resolveCompileProjectIdentity>,
  facets: { technologies: string[]; changeTypes: string[]; domains: string[] },
): ContextPackItem {
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
  const applicability = asRecord(episode.applicability);
  const general =
    applicability.general === true ||
    (episode.technologies.length === 0 &&
      episode.changeTypes.length === 0 &&
      episode.domains.length === 0);
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
    scopeSnapshot: buildRepositorySelectionScopeSnapshot(
      {
        id: episode.id,
        entityKind: "episode",
        status: episode.status,
        classificationStatus: episode.classificationStatus,
        scope: episode.scope,
        projectRef: episode.projectRef ?? null,
        repoKey: episode.repoKey ?? null,
        repoPath: episode.repoPath ?? null,
        general,
        facets: {
          technologies: episode.technologies,
          changeTypes: episode.changeTypes,
          domains: episode.domains,
        },
        producer: episode.sourceKind,
      },
      projectIdentity,
      facets,
    ),
  };
}

export async function retrieveEpisodePrecedents(params: {
  input: CompileInput;
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
      projectRef: params.input.projectRef,
      repoKey: params.input.repoKey,
      repoPath: params.input.repoPath,
    };
    const items = await searchEpisodes(baseSearch);
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
        scopedHitCount: items.filter((item) => item.scope === "repo").length,
        globalHitCount: items.filter((item) => item.scope === "global").length,
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
