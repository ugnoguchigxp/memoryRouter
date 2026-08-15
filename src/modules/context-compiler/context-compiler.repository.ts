import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import {
  contextCompileCandidateTraces,
  contextCompileRuns,
  contextPackItems,
  episodeRetrievalFeedback,
  knowledgeItems,
  knowledgeUsageEvents,
  sources,
} from "../../db/schema.js";
import { getDefaultDbSession } from "../../db/session.js";
import {
  type CompileRunDetail,
  type CompileRunEpisodeFeedbackResult,
  type CompileRunRankingTrace,
  type CompileRunSelectedItem,
  type CompileRunSource,
  compileRunDetailSchema,
  compileRunRankingTraceSchema,
} from "../../shared/schemas/compile-run.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { contextPackSchema } from "../../shared/schemas/context-pack.schema.js";
import { asRecord, asStringArray, normalizeNullableString } from "../../shared/utils/normalize.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "./context-compile-eval.repository.js";
import {
  extractCompileRunSignals,
  extractOutputMarkdown,
  feedbackActorValues,
  knowledgeVerdictValues,
  normalizeCompileRunSource,
  normalizeDate,
  normalizeDuration,
  normalizeFeedbackActor,
  normalizeKnowledgeVerdict,
  normalizeRunStatus,
  normalizeStringArray,
} from "./context-compiler.repository.utils.js";

const db = getDefaultDbSession().db;

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function sqliteRepository() {
  return import("./context-compiler.repository.sqlite.js");
}

export async function insertCompileRun(params: {
  goal: string;
  intent: string;
  sessionId?: string;
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string;
  matchBasis?: "project_ref" | "repo_key" | "repo_path" | "none";
  identityContractVersion?: number;
  scopeMode?: "global_only" | "project";
  input: Record<string, unknown>;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  tokenBudget: number;
  durationMs: number;
  source?: CompileRunSource;
}): Promise<string> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.insertCompileRunSqlite(params);
  }
  const [inserted] = await db
    .insert(contextCompileRuns)
    .values({
      goal: params.goal,
      intent: params.intent,
      sessionId: params.sessionId ?? null,
      projectRef: params.projectRef ?? null,
      repoKey: params.repoKey ?? null,
      repoPath: params.repoPath ?? null,
      matchBasis: params.matchBasis ?? "none",
      identityContractVersion: params.identityContractVersion ?? 1,
      scopeMode: params.scopeMode ?? "global_only",
      input: params.input,
      retrievalMode: params.retrievalMode,
      status: params.status,
      degradedReasons: params.degradedReasons,
      tokenBudget: params.tokenBudget,
      durationMs: params.durationMs,
      source: params.source ?? "unknown",
    })
    .returning({ id: contextCompileRuns.id });

  return inserted.id;
}

export async function updateCompileRunSnapshot(runId: string, pack: ContextPack): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.updateCompileRunSnapshotSqlite(runId, pack);
  }
  await db
    .update(contextCompileRuns)
    .set({ packSnapshot: pack as unknown as Record<string, unknown> })
    .where(eq(contextCompileRuns.id, runId));
}

export async function updateCompileRunFailure(params: {
  runId: string;
  degradedReasons: string[];
  durationMs: number;
  pack: ContextPack;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.updateCompileRunFailureSqlite(params);
  }
  await db
    .update(contextCompileRuns)
    .set({
      status: "failed",
      degradedReasons: params.degradedReasons,
      durationMs: params.durationMs,
      packSnapshot: params.pack as unknown as Record<string, unknown>,
    })
    .where(eq(contextCompileRuns.id, params.runId));
}

export async function insertContextPackItems(
  runId: string,
  items: Array<{
    itemKind: string;
    itemId: string;
    section: "rules" | "procedures" | "code_context" | "warnings" | "guardrails";
    score: number;
    rankingReason: string;
    sourceRefs: string[];
  }>,
): Promise<void> {
  if (items.length === 0) return;
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.insertContextPackItemsSqlite(runId, items);
  }

  await db.insert(contextPackItems).values(
    items.map((item) => ({
      runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      section: item.section,
      score: item.score,
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
    })),
  );
}

export async function insertContextCompileCandidateTraces(
  runId: string,
  items: Array<{
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
  }>,
): Promise<void> {
  if (items.length === 0) return;
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.insertContextCompileCandidateTracesSqlite(runId, items);
  }

  await db.insert(contextCompileCandidateTraces).values(
    items.map((item) => ({
      runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      textRank: item.textRank,
      textScore: item.textScore,
      vectorRank: item.vectorRank,
      vectorScore: item.vectorScore,
      mergedRank: item.mergedRank,
      mergedScore: item.mergedScore,
      finalRank: item.finalRank,
      finalScore: item.finalScore,
      selected: item.selected,
      suppressed: item.suppressed,
      suppressionReason: item.suppressionReason,
      agenticDecision: item.agenticDecision,
      rankingReason: item.rankingReason,
      communityKey: item.communityKey,
      evidence: item.evidence,
    })),
  );
}

export type CompileRunSummary = {
  id: string;
  goal: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  durationMs: number;
  source: CompileRunSource;
  evalSummary: {
    count: number;
    latestAvg: number | null;
    averageAvg: number | null;
    latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
    latestEvaluatedAt: string | null;
  };
  selectedItemCount: number;
  outputMarkdownKind: "narrative" | "no-content" | null;
  createdAt: Date;
};

export type CompileFreshnessMarkers = {
  knowledgeActiveUpdatedAt: string | null;
  knowledgeDraftUpdatedAt: string | null;
  sourceCorpusUpdatedAt: string | null;
};

export type CompileRunSnapshot = {
  run: CompileRunSummary;
  items: CompileRunSelectedItem[];
};

function normalizeKnowledgeStatus(value: string): "active" | "draft" | "deprecated" {
  if (value === "active" || value === "draft" || value === "deprecated") {
    return value;
  }
  return "active";
}

function isEpisodePackItemKind(itemKind: string): boolean {
  return itemKind === "episode_card" || itemKind === "episode";
}

function normalizeEpisodeVerdict(value: string): "used" | "not_used" | "wrong" | null {
  if (value === "used") return "used";
  if (value === "not_used" || value === "not_relevant") return "not_used";
  if (value === "wrong") return "wrong";
  return null;
}

function episodeStorageVerdict(
  value: "used" | "not_used" | "wrong",
): "used" | "not_relevant" | "wrong" {
  if (value === "not_used") return "not_relevant";
  return value;
}

export async function listRecentCompileRuns(limit = 20): Promise<CompileRunSummary[]> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.listRecentCompileRunsSqlite(limit);
  }
  const normalizedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
      packSnapshot: contextCompileRuns.packSnapshot,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(normalizedLimit);

  return Promise.all(
    rows.map(async (row) => {
      const signals = extractCompileRunSignals(row.packSnapshot);
      const evalSummary = await getCompileEvalSummaryByRunId(row.id);
      return {
        id: row.id,
        goal: row.goal,
        retrievalMode: row.retrievalMode,
        status: normalizeRunStatus(row.status),
        degradedReasons: normalizeStringArray(row.degradedReasons),
        durationMs: normalizeDuration(row.durationMs),
        source: normalizeCompileRunSource(row.source),
        evalSummary,
        selectedItemCount: signals.selectedItemCount,
        outputMarkdownKind: signals.outputMarkdownKind,
        createdAt: normalizeDate(row.createdAt),
      };
    }),
  );
}

export async function getCompileRunSnapshot(runId: string): Promise<CompileRunSnapshot | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileRunSnapshotSqlite(runId);
  }
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
      packSnapshot: contextCompileRuns.packSnapshot,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);

  if (!run) return null;

  const itemRows = await db
    .select({
      itemKind: contextPackItems.itemKind,
      itemId: contextPackItems.itemId,
      section: contextPackItems.section,
      score: contextPackItems.score,
      rankingReason: contextPackItems.rankingReason,
      sourceRefs: contextPackItems.sourceRefs,
    })
    .from(contextPackItems)
    .where(eq(contextPackItems.runId, runId))
    .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt));

  const signals = extractCompileRunSignals(run.packSnapshot);
  return {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      evalSummary: await getCompileEvalSummaryByRunId(run.id),
      selectedItemCount: signals.selectedItemCount,
      outputMarkdownKind: signals.outputMarkdownKind,
      createdAt: normalizeDate(run.createdAt),
    },
    items: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      sourceRefs: normalizeStringArray(row.sourceRefs),
    })),
  };
}

export async function getLatestCompileRunForSession(params: {
  sessionId: string;
  createdBefore?: Date;
}): Promise<{ id: string; createdAt: Date } | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getLatestCompileRunForSessionSqlite(params);
  }
  const [row] = await db
    .select({
      id: contextCompileRuns.id,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(
      and(
        eq(contextCompileRuns.sessionId, params.sessionId),
        params.createdBefore ? lte(contextCompileRuns.createdAt, params.createdBefore) : undefined,
      ),
    )
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(1);
  if (!row) return null;
  return { id: row.id, createdAt: normalizeDate(row.createdAt) };
}

function resolveOutputMarkdownFromPackSnapshot(packSnapshot: unknown): string | null {
  const parsed = contextPackSchema.safeParse(packSnapshot);
  if (!parsed.success) return null;
  return extractOutputMarkdown(parsed.data);
}

export async function getCompileRunById(runId: string): Promise<{
  id: string;
  sessionId: string | null;
  createdAt: Date;
  outputMarkdown: string | null;
} | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileRunByIdSqlite(runId);
  }
  const [row] = await db
    .select({
      id: contextCompileRuns.id,
      sessionId: contextCompileRuns.sessionId,
      createdAt: contextCompileRuns.createdAt,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: normalizeNullableString(row.sessionId),
    createdAt: normalizeDate(row.createdAt),
    outputMarkdown: resolveOutputMarkdownFromPackSnapshot(row.packSnapshot),
  };
}

export async function listCompileRunOutputsByIds(runIds: string[]): Promise<
  Map<
    string,
    {
      createdAt: Date;
      goal: string;
      outputMarkdown: string | null;
    }
  >
> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.listCompileRunOutputsByIdsSqlite(runIds);
  }
  const normalizedIds = [...new Set(runIds.map((item) => item.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: contextCompileRuns.id,
      createdAt: contextCompileRuns.createdAt,
      goal: contextCompileRuns.goal,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(inArray(contextCompileRuns.id, normalizedIds));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        createdAt: normalizeDate(row.createdAt),
        goal: row.goal,
        outputMarkdown: resolveOutputMarkdownFromPackSnapshot(row.packSnapshot),
      },
    ]),
  );
}

export async function getCompileRunDetail(runId: string): Promise<CompileRunDetail | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileRunDetailSqlite(runId);
  }
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
      createdAt: contextCompileRuns.createdAt,
      tokenBudget: contextCompileRuns.tokenBudget,
      input: contextCompileRuns.input,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);

  if (!run) return null;

  const itemRows = await db
    .select({
      itemKind: contextPackItems.itemKind,
      itemId: contextPackItems.itemId,
      section: contextPackItems.section,
      score: contextPackItems.score,
      rankingReason: contextPackItems.rankingReason,
      sourceRefs: contextPackItems.sourceRefs,
    })
    .from(contextPackItems)
    .where(eq(contextPackItems.runId, runId))
    .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt));

  const feedbackRows = await db
    .select({
      id: knowledgeUsageEvents.id,
      runId: knowledgeUsageEvents.runId,
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      verdict: knowledgeUsageEvents.verdict,
      actor: knowledgeUsageEvents.actor,
      reason: knowledgeUsageEvents.reason,
      metadata: knowledgeUsageEvents.metadata,
      createdAt: knowledgeUsageEvents.createdAt,
      updatedAt: knowledgeUsageEvents.updatedAt,
    })
    .from(knowledgeUsageEvents)
    .where(eq(knowledgeUsageEvents.runId, runId))
    .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt));
  const episodeFeedbackRows = await db
    .select({
      episodeCardId: episodeRetrievalFeedback.episodeCardId,
      verdict: episodeRetrievalFeedback.verdict,
      reason: episodeRetrievalFeedback.reason,
      metadata: episodeRetrievalFeedback.metadata,
      createdAt: episodeRetrievalFeedback.createdAt,
    })
    .from(episodeRetrievalFeedback)
    .where(
      and(
        eq(episodeRetrievalFeedback.runId, runId),
        eq(episodeRetrievalFeedback.runKind, "compile"),
      ),
    )
    .orderBy(desc(episodeRetrievalFeedback.createdAt));
  const evalRows = await listCompileEvalsByRunId(runId);

  const parsedPackSnapshot = contextPackSchema.safeParse(run.packSnapshot);
  const packSnapshot =
    parsedPackSnapshot.success && parsedPackSnapshot.data.runId === run.id
      ? parsedPackSnapshot.data
      : null;

  if (packSnapshot) {
    const knowledgePackItems = [
      ...(packSnapshot.rules ?? []),
      ...(packSnapshot.procedures ?? []),
      ...(packSnapshot.guardrails ?? []),
    ].filter((item) => item.itemKind === "rule" || item.itemKind === "procedure");
    const allItemIds = [...new Set(knowledgePackItems.map((item) => item.itemId).filter(Boolean))];

    const knowledgeRows =
      allItemIds.length > 0
        ? await db
            .select({
              id: knowledgeItems.id,
              appliesTo: knowledgeItems.appliesTo,
            })
            .from(knowledgeItems)
            .where(inArray(knowledgeItems.id, allItemIds))
        : [];

    const appliesToByItemId = new Map<
      string,
      { changeTypes: string[]; technologies: string[]; domains: string[] }
    >();
    for (const row of knowledgeRows) {
      const appliesTo = asRecord(row.appliesTo);
      appliesToByItemId.set(row.id, {
        changeTypes: asStringArray(appliesTo.changeTypes),
        technologies: asStringArray(appliesTo.technologies),
        domains: asStringArray(appliesTo.domains),
      });
    }

    for (const item of knowledgePackItems) {
      const applies = appliesToByItemId.get(item.itemId);
      item.changeTypes = item.changeTypes?.length ? item.changeTypes : (applies?.changeTypes ?? []);
      item.technologies = item.technologies?.length
        ? item.technologies
        : (applies?.technologies ?? []);
      item.domains = item.domains?.length ? item.domains : (applies?.domains ?? []);
    }
  }

  const outputMarkdown = extractOutputMarkdown(packSnapshot);

  const selectedKnowledgeRowsMap = new Map<
    string,
    {
      knowledgeId: string;
      itemKind: "rule" | "procedure";
      section: "rules" | "procedures" | "guardrails";
      score: number;
      rankingReason: string;
    }
  >();
  for (const row of itemRows) {
    if (row.itemKind !== "rule" && row.itemKind !== "procedure") continue;
    if (selectedKnowledgeRowsMap.has(row.itemId)) continue;
    selectedKnowledgeRowsMap.set(row.itemId, {
      knowledgeId: row.itemId,
      itemKind: row.itemKind,
      section:
        row.section === "guardrails"
          ? "guardrails"
          : row.section === "procedures"
            ? "procedures"
            : "rules",
      score: row.score,
      rankingReason: row.rankingReason,
    });
  }
  const selectedKnowledgeRows = [...selectedKnowledgeRowsMap.values()];

  const packTitleById = new Map<string, string>();
  const packTitleByKey = new Map<string, string>();
  for (const item of [
    ...(packSnapshot?.rules ?? []),
    ...(packSnapshot?.procedures ?? []),
    ...(packSnapshot?.guardrails ?? []),
  ]) {
    packTitleByKey.set(`${item.itemKind}:${item.itemId}`, item.title);
    if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
    packTitleById.set(item.itemId, item.title);
  }

  const latestFeedbackByKnowledgeId = new Map<
    string,
    {
      verdict: "used" | "not_used" | "off_topic" | "wrong";
      actor: "agent" | "user" | "system";
      reason: string | null;
      metadata: Record<string, unknown>;
      updatedAt: string | null;
    }
  >();
  for (const row of feedbackRows) {
    if (latestFeedbackByKnowledgeId.has(row.knowledgeId)) continue;
    latestFeedbackByKnowledgeId.set(row.knowledgeId, {
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      metadata: asRecord(row.metadata),
      updatedAt: row.updatedAt ? normalizeDate(row.updatedAt).toISOString() : null,
    });
  }
  const latestEpisodeFeedbackById = new Map<
    string,
    {
      verdict: "used" | "not_used" | "wrong";
      actor: "agent" | "user" | "system";
      reason: string | null;
      updatedAt: string;
    }
  >();
  for (const row of episodeFeedbackRows) {
    if (latestEpisodeFeedbackById.has(row.episodeCardId)) continue;
    const verdict = normalizeEpisodeVerdict(row.verdict);
    if (!verdict) continue;
    const metadata = asRecord(row.metadata);
    latestEpisodeFeedbackById.set(row.episodeCardId, {
      verdict,
      actor: normalizeFeedbackActor(metadata.actor),
      reason: normalizeNullableString(row.reason),
      updatedAt: normalizeDate(row.createdAt).toISOString(),
    });
  }

  const detail = {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      evalSummary: await getCompileEvalSummaryByRunId(run.id),
      createdAt: normalizeDate(run.createdAt).toISOString(),
      tokenBudget: normalizeDuration(run.tokenBudget),
      input:
        typeof run.input === "object" && run.input !== null
          ? (run.input as Record<string, unknown>)
          : {},
    },
    pack: packSnapshot,
    outputMarkdown,
    selectedItems: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      sourceRefs: normalizeStringArray(row.sourceRefs),
    })),
    episodeSignals: itemRows
      .filter((row) => isEpisodePackItemKind(row.itemKind))
      .map((row) => {
        const feedback = latestEpisodeFeedbackById.get(row.itemId);
        return {
          episodeId: row.itemId,
          title:
            packTitleByKey.get(`episode_card:${row.itemId}`) ??
            packTitleByKey.get(`${row.itemKind}:${row.itemId}`) ??
            `Episode ${row.itemId.slice(0, 8)}`,
          section: "procedures" as const,
          sourceRefs: normalizeStringArray(row.sourceRefs),
          effectiveVerdict: feedback?.verdict ?? null,
          effectiveActor: feedback?.actor ?? null,
          effectiveReason: feedback?.reason ?? null,
          updatedAt: feedback?.updatedAt ?? null,
        };
      }),
    knowledgeFeedback: feedbackRows.map((row) => ({
      id: row.id,
      runId: row.runId,
      knowledgeId: row.knowledgeId,
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      createdAt: normalizeDate(row.createdAt).toISOString(),
      updatedAt: normalizeDate(row.updatedAt).toISOString(),
    })),
    knowledgeSignals: selectedKnowledgeRows.map((row) => {
      const latestFeedback = latestFeedbackByKnowledgeId.get(row.knowledgeId);
      const metadata = asRecord(latestFeedback?.metadata);
      const autoVerdict = normalizeKnowledgeVerdict(metadata.autoVerdict);
      const autoVerdictPresent = knowledgeVerdictValues.has(String(metadata.autoVerdict));
      const autoActor = normalizeFeedbackActor(metadata.autoActor);
      const autoActorPresent = feedbackActorValues.has(String(metadata.autoActor));

      if (!latestFeedback) {
        return {
          knowledgeId: row.knowledgeId,
          rawId: row.knowledgeId,
          itemKind: row.itemKind,
          section: row.section,
          title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
          score: row.score,
          rankingReason: row.rankingReason,
          autoVerdict: null,
          autoActor: null,
          autoReason: null,
          effectiveVerdict: null,
          effectiveActor: null,
          effectiveReason: null,
          hasUserOverride: false,
          updatedAt: null,
        };
      }

      const effectiveVerdict = latestFeedback.verdict;
      const effectiveActor = latestFeedback.actor;
      const effectiveReason = latestFeedback.reason;

      if (effectiveActor === "user") {
        const resolvedAutoVerdict = autoVerdictPresent ? autoVerdict : null;
        const resolvedAutoActor = autoActorPresent ? autoActor : null;
        const resolvedAutoReason = normalizeNullableString(metadata.autoReason);
        const hasUserOverride =
          resolvedAutoVerdict !== null && resolvedAutoVerdict !== effectiveVerdict;
        return {
          knowledgeId: row.knowledgeId,
          rawId: row.knowledgeId,
          itemKind: row.itemKind,
          section: row.section,
          title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
          score: row.score,
          rankingReason: row.rankingReason,
          autoVerdict: resolvedAutoVerdict,
          autoActor: resolvedAutoActor,
          autoReason: resolvedAutoReason,
          effectiveVerdict,
          effectiveActor,
          effectiveReason,
          hasUserOverride,
          updatedAt: latestFeedback.updatedAt,
        };
      }

      return {
        knowledgeId: row.knowledgeId,
        rawId: row.knowledgeId,
        itemKind: row.itemKind,
        section: row.section,
        title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
        score: row.score,
        rankingReason: row.rankingReason,
        autoVerdict: effectiveVerdict,
        autoActor: effectiveActor,
        autoReason: effectiveReason,
        effectiveVerdict,
        effectiveActor,
        effectiveReason,
        hasUserOverride: false,
        updatedAt: latestFeedback.updatedAt,
      };
    }),
    evaluations: evalRows.map((row) => ({
      id: row.id,
      runId: row.runId,
      sessionId: row.sessionId,
      avg: row.avg,
      outcome: row.outcome,
      title: row.title,
      body: row.body,
      source: row.source,
      relevance: row.relevance,
      actionability: row.actionability,
      coverage: row.coverage,
      clarity: row.clarity,
      specificity: row.specificity,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    snapshotAvailable: packSnapshot !== null,
  };

  return compileRunDetailSchema.parse(detail);
}

export async function getCompileRunRankingTrace(
  runId: string,
): Promise<CompileRunRankingTrace | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileRunRankingTraceSqlite(runId);
  }
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      repoPath: contextCompileRuns.repoPath,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      input: contextCompileRuns.input,
      createdAt: contextCompileRuns.createdAt,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const traceRows = await db
    .select({
      itemKind: contextCompileCandidateTraces.itemKind,
      itemId: contextCompileCandidateTraces.itemId,
      textRank: contextCompileCandidateTraces.textRank,
      textScore: contextCompileCandidateTraces.textScore,
      vectorRank: contextCompileCandidateTraces.vectorRank,
      vectorScore: contextCompileCandidateTraces.vectorScore,
      mergedRank: contextCompileCandidateTraces.mergedRank,
      mergedScore: contextCompileCandidateTraces.mergedScore,
      finalRank: contextCompileCandidateTraces.finalRank,
      finalScore: contextCompileCandidateTraces.finalScore,
      selected: contextCompileCandidateTraces.selected,
      suppressed: contextCompileCandidateTraces.suppressed,
      suppressionReason: contextCompileCandidateTraces.suppressionReason,
      agenticDecision: contextCompileCandidateTraces.agenticDecision,
      rankingReason: contextCompileCandidateTraces.rankingReason,
      communityKey: contextCompileCandidateTraces.communityKey,
    })
    .from(contextCompileCandidateTraces)
    .where(eq(contextCompileCandidateTraces.runId, runId));

  const knowledgeIds = [...new Set(traceRows.map((row) => row.itemId))];
  const knowledgeRows =
    knowledgeIds.length > 0
      ? await db
          .select({
            id: knowledgeItems.id,
            title: knowledgeItems.title,
            status: knowledgeItems.status,
          })
          .from(knowledgeItems)
          .where(inArray(knowledgeItems.id, knowledgeIds))
      : [];
  const knowledgeById = new Map(
    knowledgeRows.map((row) => [row.id, { title: row.title, status: row.status }]),
  );

  const packRows = await db
    .select({
      itemKind: contextPackItems.itemKind,
      itemId: contextPackItems.itemId,
      sourceRefs: contextPackItems.sourceRefs,
      createdAt: contextPackItems.createdAt,
    })
    .from(contextPackItems)
    .where(eq(contextPackItems.runId, runId))
    .orderBy(contextPackItems.createdAt);
  const packByKey = new Map(
    packRows.map((row) => [
      `${row.itemKind}:${row.itemId}`,
      { sourceRefs: normalizeStringArray(row.sourceRefs) },
    ]),
  );

  const packPositionByKey = new Map<string, number>();
  const parsedPack = contextPackSchema.safeParse(run.packSnapshot);
  if (parsedPack.success) {
    let packPosition = 1;
    for (const item of [
      ...parsedPack.data.rules,
      ...parsedPack.data.procedures,
      ...parsedPack.data.guardrails,
    ]) {
      if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
      packPositionByKey.set(`${item.itemKind}:${item.itemId}`, packPosition);
      packPosition += 1;
    }
  } else {
    for (const [index, row] of packRows.entries()) {
      if (row.itemKind !== "rule" && row.itemKind !== "procedure") continue;
      packPositionByKey.set(`${row.itemKind}:${row.itemId}`, index + 1);
    }
  }

  const feedbackRows = await db
    .select({
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      verdict: knowledgeUsageEvents.verdict,
      actor: knowledgeUsageEvents.actor,
      reason: knowledgeUsageEvents.reason,
      updatedAt: knowledgeUsageEvents.updatedAt,
      createdAt: knowledgeUsageEvents.createdAt,
    })
    .from(knowledgeUsageEvents)
    .where(eq(knowledgeUsageEvents.runId, runId))
    .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt));
  const latestFeedbackByKnowledgeId = new Map<
    string,
    {
      verdict: "used" | "not_used" | "off_topic" | "wrong";
      actor: "agent" | "user" | "system";
      reason: string | null;
      updatedAt: string;
    }
  >();
  for (const row of feedbackRows) {
    if (latestFeedbackByKnowledgeId.has(row.knowledgeId)) continue;
    const verdict = normalizeKnowledgeVerdict(row.verdict);
    const actor = normalizeFeedbackActor(row.actor);
    if (!verdict || !actor) continue;
    latestFeedbackByKnowledgeId.set(row.knowledgeId, {
      verdict,
      actor,
      reason: normalizeNullableString(row.reason),
      updatedAt: normalizeDate(row.updatedAt ?? row.createdAt).toISOString(),
    });
  }

  const evalSummary = await getCompileEvalSummaryByRunId(run.id);
  const items = traceRows.map((row) => {
    const key = `${row.itemKind}:${row.itemId}`;
    const knowledge = knowledgeById.get(row.itemId);
    const feedback = latestFeedbackByKnowledgeId.get(row.itemId);
    return {
      itemKind: row.itemKind,
      itemId: row.itemId,
      title: knowledge?.title ?? `Knowledge ${row.itemId.slice(0, 8)}`,
      status: normalizeKnowledgeStatus(knowledge?.status ?? "active"),
      textRank: row.textRank,
      textScore: row.textScore,
      vectorRank: row.vectorRank,
      vectorScore: row.vectorScore,
      mergedRank: row.mergedRank,
      mergedScore: row.mergedScore,
      finalRank: row.finalRank,
      finalScore: row.finalScore,
      selected: row.selected,
      packed: packByKey.has(key),
      packPosition: packPositionByKey.get(key) ?? null,
      suppressed: row.suppressed,
      suppressionReason: normalizeNullableString(row.suppressionReason),
      agenticDecision: row.agenticDecision,
      rankingReason: normalizeNullableString(row.rankingReason),
      communityKey: normalizeNullableString(row.communityKey),
      feedback: {
        verdict: feedback?.verdict ?? null,
        actor: feedback?.actor ?? null,
        reason: feedback?.reason ?? null,
        updatedAt: feedback?.updatedAt ?? null,
      },
      sourceRefs: packByKey.get(key)?.sourceRefs ?? [],
    };
  });
  const sortedItems = [...items].sort((left, right) => {
    const leftSelected = left.selected ? 0 : 1;
    const rightSelected = right.selected ? 0 : 1;
    if (leftSelected !== rightSelected) return leftSelected - rightSelected;

    const leftPack = left.packPosition ?? Number.MAX_SAFE_INTEGER;
    const rightPack = right.packPosition ?? Number.MAX_SAFE_INTEGER;
    if (leftPack !== rightPack) return leftPack - rightPack;

    const leftFinal = left.finalRank ?? Number.MAX_SAFE_INTEGER;
    const rightFinal = right.finalRank ?? Number.MAX_SAFE_INTEGER;
    if (leftFinal !== rightFinal) return leftFinal - rightFinal;

    const leftMerged = left.mergedRank ?? Number.MAX_SAFE_INTEGER;
    const rightMerged = right.mergedRank ?? Number.MAX_SAFE_INTEGER;
    if (leftMerged !== rightMerged) return leftMerged - rightMerged;

    const leftText = left.textRank ?? Number.MAX_SAFE_INTEGER;
    const rightText = right.textRank ?? Number.MAX_SAFE_INTEGER;
    if (leftText !== rightText) return leftText - rightText;

    const leftVector = left.vectorRank ?? Number.MAX_SAFE_INTEGER;
    const rightVector = right.vectorRank ?? Number.MAX_SAFE_INTEGER;
    if (leftVector !== rightVector) return leftVector - rightVector;

    return left.itemId.localeCompare(right.itemId);
  });

  const feedbackSummary = {
    used: 0,
    notUsed: 0,
    offTopic: 0,
    wrong: 0,
    noSignal: 0,
  };
  for (const item of sortedItems) {
    if (item.feedback.verdict === "used") feedbackSummary.used += 1;
    else if (item.feedback.verdict === "not_used") feedbackSummary.notUsed += 1;
    else if (item.feedback.verdict === "off_topic") feedbackSummary.offTopic += 1;
    else if (item.feedback.verdict === "wrong") feedbackSummary.wrong += 1;
    else feedbackSummary.noSignal += 1;
  }

  return compileRunRankingTraceSchema.parse({
    run: {
      id: run.id,
      goal: run.goal,
      repoPath: normalizeNullableString(run.repoPath),
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      input: asRecord(run.input),
      createdAt: normalizeDate(run.createdAt).toISOString(),
    },
    evalSummary: {
      count: evalSummary.count,
      latestAvg: evalSummary.latestAvg,
      latestOutcome: evalSummary.latestOutcome,
    },
    feedbackSummary,
    funnel: {
      textHitCount: sortedItems.filter((item) => item.textRank !== null).length,
      vectorHitCount: sortedItems.filter((item) => item.vectorRank !== null).length,
      mergedCount: sortedItems.filter((item) => item.mergedRank !== null).length,
      finalCount: sortedItems.filter((item) => item.finalRank !== null).length,
      packedCount: sortedItems.filter((item) => item.packed).length,
      selectedCount: sortedItems.filter((item) => item.selected).length,
      suppressedCount: sortedItems.filter((item) => item.suppressed).length,
    },
    items: sortedItems,
  });
}

export async function saveRunEpisodeFeedback(params: {
  runId: string;
  items: Array<{ episodeId: string; verdict: "used" | "not_used" | "wrong"; reason?: string }>;
}): Promise<CompileRunEpisodeFeedbackResult> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.saveRunEpisodeFeedbackSqlite(params);
  }

  const [run] = await db
    .select({ id: contextCompileRuns.id })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, params.runId))
    .limit(1);
  if (!run) {
    throw Object.assign(new Error("Compile run not found."), { statusCode: 404 });
  }

  const selectableRows = await db
    .select({ itemId: contextPackItems.itemId })
    .from(contextPackItems)
    .where(
      and(
        eq(contextPackItems.runId, params.runId),
        inArray(contextPackItems.itemKind, ["episode_card", "episode"]),
      ),
    );
  const selectableEpisodeIds = new Set(selectableRows.map((row) => row.itemId));
  const seen = new Set<string>();
  const normalizedItems = params.items.map((item) => {
    const episodeId = item.episodeId.trim();
    if (seen.has(episodeId)) {
      throw Object.assign(new Error(`Duplicate episodeId in request: ${episodeId}`), {
        statusCode: 400,
      });
    }
    seen.add(episodeId);
    if (!selectableEpisodeIds.has(episodeId)) {
      throw Object.assign(
        new Error(`Episode IDs are not in selected items for this run: ${episodeId}`),
        { statusCode: 400 },
      );
    }
    return {
      episodeId,
      verdict: item.verdict,
      reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : null,
    };
  });

  const now = new Date();
  if (normalizedItems.length > 0) {
    await db.insert(episodeRetrievalFeedback).values(
      normalizedItems.map((item) => ({
        id: randomUUID(),
        episodeCardId: item.episodeId,
        runKind: "compile",
        runId: params.runId,
        usedFor: "compile",
        verdict: episodeStorageVerdict(item.verdict),
        reason: item.reason,
        metadata: { actor: "user" },
        createdAt: now,
      })),
    );
  }

  return {
    savedCount: normalizedItems.length,
    affectedEpisodeIds: normalizedItems.map((item) => item.episodeId),
  };
}

export async function getLatestCompileRunSnapshot(): Promise<CompileRunSnapshot | null> {
  const rows = await listRecentCompileRuns(1);
  const latest = rows[0];
  if (!latest) return null;
  return getCompileRunSnapshot(latest.id);
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

export async function getCompileFreshnessMarkers(params?: {
  repoPath?: string;
  repoKey?: string;
}): Promise<CompileFreshnessMarkers> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getCompileFreshnessMarkersSqlite();
  }
  const repoPath = params?.repoPath?.trim() ? params.repoPath.trim() : undefined;
  const repoKey = params?.repoKey?.trim() ? params.repoKey.trim().toLowerCase() : undefined;

  const knowledgeResult =
    repoPath || repoKey
      ? await db.execute(sql`
          select
            max(case when ${knowledgeItems.status} = 'active' then ${knowledgeItems.updatedAt} end) as active_updated_at,
            max(case when ${knowledgeItems.status} = 'draft' then ${knowledgeItems.updatedAt} end) as draft_updated_at
          from ${knowledgeItems}
          where ${knowledgeItems.status} in ('active', 'draft')
            and (
              ${knowledgeItems.scope} = 'global'
              ${repoKey ? sql`or ${knowledgeItems.appliesTo} ->> 'repoKey' = ${repoKey}` : sql``}
              ${repoPath ? sql`or ${knowledgeItems.appliesTo} ->> 'repoPath' = ${repoPath}` : sql``}
            )
        `)
      : await db.execute(sql`
          select
            max(case when ${knowledgeItems.status} = 'active' then ${knowledgeItems.updatedAt} end) as active_updated_at,
            max(case when ${knowledgeItems.status} = 'draft' then ${knowledgeItems.updatedAt} end) as draft_updated_at
          from ${knowledgeItems}
          where ${knowledgeItems.status} in ('active', 'draft')
        `);

  const sourceResult = await db.execute(sql`
    select max(${sources.updatedAt}) as source_updated_at
    from ${sources}
  `);

  const knowledgeRow = (knowledgeResult.rows as Array<Record<string, unknown>>)[0] ?? {};
  const sourceRow = (sourceResult.rows as Array<Record<string, unknown>>)[0] ?? {};

  return {
    knowledgeActiveUpdatedAt: toIsoTimestamp(knowledgeRow.active_updated_at),
    knowledgeDraftUpdatedAt: toIsoTimestamp(knowledgeRow.draft_updated_at),
    sourceCorpusUpdatedAt: toIsoTimestamp(sourceRow.source_updated_at),
  };
}
