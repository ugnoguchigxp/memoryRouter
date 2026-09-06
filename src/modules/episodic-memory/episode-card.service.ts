import type { CompileRunDetail } from "../../shared/schemas/compile-run.schema.js";
import {
  type EpisodeCard,
  type EpisodeCardCreateInput,
  type EpisodeCardSearchInput,
  type EpisodeRetrievalFeedbackInput,
  episodeRetrievalFeedbackInputSchema,
} from "../../shared/schemas/episode-card.schema.js";
import { asRecord, asStringArray } from "../../shared/utils/normalize.js";
import { getCompileRunDetail } from "../context-compiler/context-compiler.repository.js";
import {
  PROJECT_IDENTITY_REQUIRED,
  ProjectScopedWriteError,
  resolveProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import {
  createEpisodeCard,
  getEpisodeCard,
  getEpisodeCardBySource,
  incrementEpisodeUsageCounts,
  listEpisodeCardsForAdmin,
  searchEpisodeCards,
} from "./episode-card.repository.js";

export type BackfillEpisodeFromCompileRunResult =
  | {
      status: "dry_run";
      runId: string;
      episodeInput: EpisodeCardCreateInput;
    }
  | {
      status: "created";
      runId: string;
      episode: EpisodeCard;
    }
  | {
      status: "skipped_existing";
      runId: string;
      episode: EpisodeCard;
    }
  | {
      status: "not_found";
      runId: string;
      reason: string;
    };

export async function createEpisode(input: EpisodeCardCreateInput) {
  return createEpisodeCard(input);
}

export async function registerEpisode(input: EpisodeCardCreateInput) {
  return createEpisodeCard(input);
}

export async function fetchEpisode(id: string) {
  return getEpisodeCard(id);
}

export async function listEpisodesForAdmin(input: EpisodeCardSearchInput) {
  return listEpisodeCardsForAdmin(input);
}

export async function searchEpisodes(input: EpisodeCardSearchInput) {
  return searchEpisodeCards(input);
}

export async function recordEpisodeUsage(input: {
  episodeIds: string[];
  usageKind: "compile" | "decision";
}) {
  return incrementEpisodeUsageCounts(input);
}

export function parseEpisodeRetrievalFeedback(input: EpisodeRetrievalFeedbackInput) {
  return episodeRetrievalFeedbackInputSchema.parse(input);
}

function compactText(value: string, maxLength = 1200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function readInputList(input: Record<string, unknown>, key: string): string[] {
  return asStringArray(input[key]);
}

function inferOutcomeKind(detail: CompileRunDetail): EpisodeCardCreateInput["outcomeKind"] {
  const latestOutcome = detail.run.evalSummary.latestOutcome;
  if (latestOutcome === "useful") return detail.run.status === "ok" ? "success" : "mixed";
  if (latestOutcome === "partial") return "mixed";
  if (latestOutcome === "misleading" || latestOutcome === "unused") return "failure";
  if (detail.run.status === "ok") return "success";
  if (detail.run.status === "degraded") return "mixed";
  if (detail.run.status === "failed") return "failure";
  return "unknown";
}

function inferConfidence(detail: CompileRunDetail): number {
  const latestAvg = detail.run.evalSummary.latestAvg;
  if (typeof latestAvg === "number") return Math.min(100, Math.max(0, Math.round(latestAvg)));
  if (detail.run.status === "ok") return 70;
  if (detail.run.status === "degraded") return 55;
  return 35;
}

function inferImportance(detail: CompileRunDetail): number {
  const selectedCount = detail.selectedItems.length;
  const latestOutcome = detail.run.evalSummary.latestOutcome;
  const base =
    latestOutcome === "useful"
      ? 80
      : latestOutcome === "partial"
        ? 65
        : detail.run.status === "ok"
          ? 60
          : 45;
  return Math.min(95, base + Math.min(10, selectedCount * 2));
}

function selectedItemSummary(detail: CompileRunDetail): string {
  const items = [
    ...(detail.pack?.rules ?? []),
    ...(detail.pack?.procedures ?? []),
    ...(detail.pack?.guardrails ?? []),
  ];
  const titles = items
    .filter((item) => item.itemKind !== "episode_card")
    .slice(0, 6)
    .map((item) => `${item.section}:${item.title}`);
  return titles.length > 0 ? titles.join(" | ") : "No selected knowledge items recorded.";
}

function collectFacets(detail: CompileRunDetail, key: "technologies" | "changeTypes" | "domains") {
  const input = detail.run.input;
  const fromInput = readInputList(input, key);
  const fromPack = [
    ...(detail.pack?.rules ?? []),
    ...(detail.pack?.procedures ?? []),
    ...(detail.pack?.guardrails ?? []),
  ].flatMap((item) => item[key] ?? []);
  return uniqueStrings([...fromInput, ...fromPack]);
}

function classifyRefKind(ref: string): "compile_run" | "file" {
  if (/\.(?:[cm]?[jt]sx?|mdx?|json|sql|ya?ml|toml|css|html)(?:#|$)/i.test(ref)) {
    return "file";
  }
  return "compile_run";
}

function collectCompileSourceRefs(detail: CompileRunDetail): EpisodeCardCreateInput["refs"] {
  const refs = uniqueStrings([
    `context-still://packs/run/${detail.run.id}#full`,
    ...(detail.pack?.sourceRefs ?? []),
    ...detail.selectedItems.flatMap((item) => item.sourceRefs),
  ]);
  return refs.slice(0, 12).map((ref) => ({
    refKind:
      ref === `context-still://packs/run/${detail.run.id}#full`
        ? "compile_run"
        : classifyRefKind(ref),
    refValue: ref,
    queryHint: detail.run.goal,
  }));
}

function compileRunProjectIdentity(input: Record<string, unknown>) {
  const snapshot = asRecord(input.projectIdentity);
  if (snapshot.contractVersion !== 1) {
    throw new ProjectScopedWriteError(
      PROJECT_IDENTITY_REQUIRED,
      "compile-run EpisodeCards require a normalized request identity snapshot",
    );
  }
  const scope = snapshot.scopeMode === "global_only" ? "global" : "repo";
  return resolveProjectScopedWriteIdentity({
    scope,
    projectRef: typeof snapshot.projectRef === "string" ? snapshot.projectRef : undefined,
    repoKey: typeof snapshot.repoKey === "string" ? snapshot.repoKey : undefined,
    repoPath: typeof snapshot.repoPath === "string" ? snapshot.repoPath : undefined,
  });
}

function compileRunToEpisodeInput(detail: CompileRunDetail): EpisodeCardCreateInput {
  const input = asRecord(detail.run.input);
  const identity = compileRunProjectIdentity(input);
  const output =
    detail.outputMarkdown && detail.outputMarkdown !== "No Content" ? detail.outputMarkdown : "";
  const degradedReasons = detail.run.degradedReasons.length
    ? detail.run.degradedReasons.join(", ")
    : "none";
  return {
    title: `Compile run: ${compactText(detail.run.goal, 90)}`,
    situation: compactText(
      `context_compile handled goal "${detail.run.goal}" in ${detail.run.retrievalMode} mode with status ${detail.run.status}. Degraded reasons: ${degradedReasons}.`,
    ),
    observations: compactText(
      `Selected context: ${selectedItemSummary(detail)}. Output kind: ${
        output ? "narrative" : "no-content"
      }.`,
    ),
    action: compactText(output || selectedItemSummary(detail)),
    outcome: compactText(
      `Compile status=${detail.run.status}; latest eval=${
        detail.run.evalSummary.latestOutcome ?? "none"
      }; latest avg=${detail.run.evalSummary.latestAvg ?? "none"}.`,
    ),
    lesson: compactText(
      output ||
        "Use this compile run as a precedent only after checking the referenced pack and selected sourceRefs.",
    ),
    applicability: {
      retrievalMode: detail.run.retrievalMode,
      status: detail.run.status,
    },
    antiApplicability: {
      decisionSource: false,
      requiresRawEvidenceCheck: true,
    },
    domains: collectFacets(detail, "domains"),
    technologies: collectFacets(detail, "technologies"),
    changeTypes: collectFacets(detail, "changeTypes"),
    tools: ["context_compile"],
    scope: identity.scope,
    projectRef: identity.projectRef,
    repoPath: identity.repoPath,
    repoKey: identity.repoKey,
    sourceKind: "compile_run",
    sourceKey: detail.run.id,
    outcomeKind: inferOutcomeKind(detail),
    importance: inferImportance(detail),
    confidence: inferConfidence(detail),
    status: "active",
    metadata: {
      source: "compile_run_backfill",
      retrievalMode: detail.run.retrievalMode,
      runStatus: detail.run.status,
      degradedReasons: detail.run.degradedReasons,
      evalSummary: detail.run.evalSummary,
      createdAt: detail.run.createdAt,
    },
    refs: collectCompileSourceRefs(detail),
  };
}

export async function buildEpisodeInputFromCompileRun(
  runId: string,
): Promise<EpisodeCardCreateInput | null> {
  const detail = await getCompileRunDetail(runId);
  if (!detail) return null;
  return compileRunToEpisodeInput(detail);
}

export async function backfillEpisodeFromCompileRun(params: {
  runId: string;
  write?: boolean;
}): Promise<BackfillEpisodeFromCompileRunResult> {
  const detail = await getCompileRunDetail(params.runId);
  if (!detail) {
    return { status: "not_found", runId: params.runId, reason: "compile run not found" };
  }
  const episodeInput = compileRunToEpisodeInput(detail);
  if (!params.write) {
    return { status: "dry_run", runId: params.runId, episodeInput };
  }
  const existing = await getEpisodeCardBySource({
    sourceKind: "compile_run",
    sourceKey: detail.run.id,
  });
  if (existing) {
    return { status: "skipped_existing", runId: params.runId, episode: existing };
  }
  const episode = await createEpisodeCard(episodeInput);
  return { status: "created", runId: params.runId, episode };
}
