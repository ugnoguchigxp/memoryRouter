import { randomUUID } from "node:crypto";
import {
  type CompileRunDetail,
  type CompileRunEpisodeFeedbackResult,
  type CompileRunRankingTrace,
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
import type { ContextCompileTaskTrace } from "./context-compile-task-trace.repository.js";
import type { CompileRunSnapshot, CompileRunSummary } from "./context-compiler.repository.js";
import {
  extractCompileRunSignals,
  extractOutputMarkdown,
  normalizeCompileRunSource,
  normalizeDate,
  normalizeDuration,
  normalizeFeedbackActor,
  normalizeKnowledgeVerdict,
  normalizeRunStatus,
  normalizeStringArray,
} from "./context-compiler.repository.utils.js";

type SqliteRunRow = {
  id: string;
  goal: string;
  intent: string;
  session_id: string | null;
  repo_path: string | null;
  input: string;
  retrieval_mode: string;
  status: string;
  degraded_reasons: string;
  token_budget: number;
  duration_ms: number;
  source: string;
  pack_snapshot: string | null;
  created_at: string;
};

type SqlitePackItemRow = {
  item_kind: string;
  item_id: string;
  section: string;
  score: number;
  ranking_reason: string;
  source_refs: string;
  created_at: string;
};

type SqliteCandidateTraceRow = {
  item_kind: string;
  item_id: string;
  text_rank: number | null;
  text_score: number | null;
  vector_rank: number | null;
  vector_score: number | null;
  merged_rank: number | null;
  merged_score: number | null;
  final_rank: number | null;
  final_score: number | null;
  selected: number;
  suppressed: number;
  suppression_reason: string | null;
  agentic_decision: string;
  ranking_reason: string | null;
  community_key: string | null;
};

type SqliteKnowledgeTraceRow = {
  id: string;
  title: string;
  status: string;
  applies_to?: string;
};

type SqliteKnowledgeUsageEventRow = {
  id?: string;
  run_id?: string;
  knowledge_id: string;
  verdict: string;
  actor: string;
  reason: string | null;
  metadata?: string;
  updated_at: string | null;
  created_at: string;
};

type SqliteEpisodeRetrievalFeedbackRow = {
  episode_card_id: string;
  verdict: string;
  reason: string | null;
  metadata?: string;
  created_at: string;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRustNativePackSnapshot(raw: unknown, run: SqliteRunRow): ContextPack | null {
  const record = asRecord(raw);
  const outputMarkdown = asString(record.outputMarkdown);
  const rawDiagnostics = asRecord(record.diagnostics);
  const degradedReasons = normalizeStringArray(rawDiagnostics.degradedReasons).length
    ? normalizeStringArray(rawDiagnostics.degradedReasons)
    : normalizeStringArray(parseJson(run.degraded_reasons));

  const toKnowledgeItem = (value: unknown, fallbackKind: "rule" | "procedure") => {
    const item = asRecord(value);
    const itemId = asString(item.id);
    if (!itemId) return null;
    const itemKind =
      item.type === "procedure" ? "procedure" : item.type === "rule" ? "rule" : fallbackKind;
    const section: "rules" | "procedures" = itemKind === "procedure" ? "procedures" : "rules";
    return {
      id: `${itemKind}:${itemId}`,
      itemKind,
      itemId,
      section,
      title: asString(item.title, `Knowledge ${itemId.slice(0, 8)}`),
      content: asString(item.body),
      score: asNumber(item.score),
      rankingReason: "rust_native_text_score",
      sourceRefs: normalizeStringArray(item.sourceRefs),
    };
  };

  const rules: ContextPack["rules"] = [];
  for (const value of Array.isArray(record.rules) ? record.rules : []) {
    const item = toKnowledgeItem(value, "rule");
    if (item) rules.push(item);
  }

  const procedures: ContextPack["procedures"] = [];
  for (const value of Array.isArray(record.procedures) ? record.procedures : []) {
    const item = toKnowledgeItem(value, "procedure");
    if (item) procedures.push(item);
  }
  for (const value of Array.isArray(record.episodes) ? record.episodes : []) {
    const item = asRecord(value);
    const itemId = asString(item.id);
    if (!itemId) continue;
    procedures.push({
      id: `episode_card:${itemId}`,
      itemKind: "episode_card",
      itemId,
      section: "procedures",
      title: asString(item.title, `Episode ${itemId.slice(0, 8)}`),
      content: asString(item.lesson, asString(item.situation)),
      score: asNumber(item.score),
      rankingReason: "rust_native_text_score",
      sourceRefs: [],
    });
  }

  if (!outputMarkdown && rules.length === 0 && procedures.length === 0) return null;

  const parsed = contextPackSchema.safeParse({
    runId: asString(record.runId, run.id),
    goal: asString(record.goal, run.goal),
    retrievalMode: run.retrieval_mode,
    status: normalizeRunStatus(run.status),
    minimalTasks: [],
    rules,
    procedures,
    guardrails: [],
    warnings: [],
    sourceRefs: [...new Set([...rules, ...procedures].flatMap((item) => item.sourceRefs))],
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        engine: asString(rawDiagnostics.engine, "rust-native"),
        selectedKnowledge: rawDiagnostics.selectedKnowledge ?? rules.length,
        selectedEpisodes: rawDiagnostics.selectedEpisodes ?? 0,
        responseComposer: {
          markdownKind:
            outputMarkdown && outputMarkdown !== "No Content" ? "narrative" : "no-content",
          ...(outputMarkdown ? { outputMarkdown } : {}),
        },
      },
    },
  });
  return parsed.success ? parsed.data : null;
}

function parsePackSnapshot(value: string | null, run?: SqliteRunRow): ContextPack | null {
  const raw = parseJson(value);
  const parsed = contextPackSchema.safeParse(raw);
  if (!run) return null;
  return parsed.success ? parsed.data : normalizeRustNativePackSnapshot(raw, run);
}

async function mapRunSummary(row: SqliteRunRow): Promise<CompileRunSummary> {
  const signals = extractCompileRunSignals(parseJson(row.pack_snapshot));
  return {
    id: row.id,
    goal: row.goal,
    retrievalMode: row.retrieval_mode,
    status: normalizeRunStatus(row.status),
    degradedReasons: normalizeStringArray(parseJson(row.degraded_reasons)),
    durationMs: normalizeDuration(row.duration_ms),
    source: normalizeCompileRunSource(row.source),
    evalSummary: await getCompileEvalSummaryByRunId(row.id),
    selectedItemCount: signals.selectedItemCount,
    outputMarkdownKind: signals.outputMarkdownKind,
    createdAt: normalizeDate(row.created_at),
  };
}

function mapPackItem(row: SqlitePackItemRow) {
  return {
    itemKind: row.item_kind,
    itemId: row.item_id,
    section:
      row.section === "procedures"
        ? "procedures"
        : row.section === "guardrails"
          ? "guardrails"
          : row.section === "code_context"
            ? "code_context"
            : row.section === "warnings"
              ? "warnings"
              : "rules",
    score: Number(row.score) || 0,
    rankingReason: row.ranking_reason,
    sourceRefs: normalizeStringArray(parseJson(row.source_refs)),
  };
}

function normalizePackKnowledgeItemKind(
  itemKind: string,
  section: string,
): "rule" | "procedure" | null {
  if (itemKind === "rule" || itemKind === "procedure") return itemKind;
  if (itemKind !== "knowledge") return null;
  return section === "procedures" ? "procedure" : "rule";
}

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

export async function insertCompileRunSqlite(params: {
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
  source?: string;
}): Promise<string> {
  const sqlite = await getSqliteCoreDatabase();
  const id = randomUUID();
  sqlite.db
    .query(
      `INSERT INTO context_compile_runs (
        id, goal, intent, session_id, project_ref, repo_key, repo_path, match_basis,
        identity_contract_version, scope_mode, input, retrieval_mode, status,
        degraded_reasons, token_budget, duration_ms, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.goal,
      params.intent,
      params.sessionId ?? null,
      params.projectRef ?? null,
      params.repoKey ?? null,
      params.repoPath ?? null,
      params.matchBasis ?? "none",
      params.identityContractVersion ?? 1,
      params.scopeMode ?? "global_only",
      json(params.input),
      params.retrievalMode,
      params.status,
      json(params.degradedReasons),
      Math.max(0, Math.trunc(params.tokenBudget)),
      Math.max(0, Math.trunc(params.durationMs)),
      params.source ?? "unknown",
      new Date().toISOString(),
    );
  return id;
}

export async function updateCompileRunSnapshotSqlite(
  runId: string,
  pack: ContextPack,
): Promise<void> {
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query("UPDATE context_compile_runs SET pack_snapshot = ? WHERE id = ?")
    .run(json(pack), runId);
}

export async function updateCompileRunFailureSqlite(params: {
  runId: string;
  degradedReasons: string[];
  durationMs: number;
  pack: ContextPack;
}): Promise<void> {
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `UPDATE context_compile_runs
       SET status = 'failed', degraded_reasons = ?, duration_ms = ?, pack_snapshot = ?
       WHERE id = ?`,
    )
    .run(
      json(params.degradedReasons),
      Math.max(0, Math.trunc(params.durationMs)),
      json(params.pack),
      params.runId,
    );
}

export async function insertContextPackItemsSqlite(
  runId: string,
  items: Array<{
    itemKind: string;
    itemId: string;
    section: "rules" | "procedures" | "code_context" | "warnings" | "guardrails";
    score: number;
    rankingReason: string;
    sourceRefs: string[];
    scopeSnapshot?: Record<string, unknown>;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  const sqlite = await getSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `INSERT INTO context_pack_items (
      run_id, item_kind, item_id, section, score, ranking_reason, source_refs, scope_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        runId,
        item.itemKind,
        item.itemId,
        item.section,
        Number.isFinite(item.score) ? item.score : 0,
        item.rankingReason,
        json(item.sourceRefs),
        json(item.scopeSnapshot ?? {}),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function insertContextCompileCandidateTracesSqlite(
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
  const sqlite = await getSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `INSERT INTO context_compile_candidate_traces (
      run_id, item_kind, item_id, text_rank, text_score, vector_rank, vector_score,
      merged_rank, merged_score, final_rank, final_score, selected, suppressed,
      suppression_reason, agentic_decision, ranking_reason, community_key, evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        runId,
        item.itemKind,
        item.itemId,
        item.textRank,
        item.textScore,
        item.vectorRank,
        item.vectorScore,
        item.mergedRank,
        item.mergedScore,
        item.finalRank,
        item.finalScore,
        item.selected ? 1 : 0,
        item.suppressed ? 1 : 0,
        item.suppressionReason,
        item.agenticDecision,
        item.rankingReason,
        item.communityKey,
        json(item.evidence),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function listRecentCompileRunsSqlite(limit = 20): Promise<CompileRunSummary[]> {
  const sqlite = await getSqliteCoreDatabase();
  const rows = sqlite.db
    .query<SqliteRunRow, [number]>(
      "SELECT * FROM context_compile_runs ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(Math.min(100, Math.max(1, Math.floor(limit))));
  return Promise.all(rows.map(mapRunSummary));
}

export async function getCompileRunSnapshotSqlite(
  runId: string,
): Promise<CompileRunSnapshot | null> {
  const sqlite = await getSqliteCoreDatabase();
  const run = sqlite.db
    .query<SqliteRunRow, [string]>("SELECT * FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!run) return null;
  const itemRows = sqlite.db
    .query<SqlitePackItemRow, [string]>(
      `SELECT item_kind, item_id, section, score, ranking_reason, source_refs, created_at
       FROM context_pack_items
       WHERE run_id = ?
       ORDER BY score DESC, created_at DESC`,
    )
    .all(runId);
  return {
    run: await mapRunSummary(run),
    items: itemRows.map(mapPackItem),
  };
}

export async function getCompileRunDetailSqlite(runId: string): Promise<CompileRunDetail | null> {
  const sqlite = await getSqliteCoreDatabase();
  const run = sqlite.db
    .query<SqliteRunRow, [string]>("SELECT * FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!run) return null;

  const itemRows = sqlite.db
    .query<SqlitePackItemRow, [string]>(
      `SELECT item_kind, item_id, section, score, ranking_reason, source_refs, created_at
       FROM context_pack_items
       WHERE run_id = ?
       ORDER BY score DESC, created_at DESC`,
    )
    .all(runId);

  const feedbackRows = sqlite.db
    .query<SqliteKnowledgeUsageEventRow, [string]>(
      `SELECT id, run_id, knowledge_id, verdict, actor, reason, metadata, created_at, updated_at
       FROM knowledge_usage_events
       WHERE run_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(runId);
  const episodeFeedbackRows = sqlite.db
    .query<SqliteEpisodeRetrievalFeedbackRow, [string]>(
      `SELECT episode_card_id, verdict, reason, metadata, created_at
       FROM episode_retrieval_feedback
       WHERE run_id = ? AND run_kind = 'compile'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(runId);
  const evalRows = await listCompileEvalsByRunId(runId);

  const packSnapshot = parsePackSnapshot(run.pack_snapshot, run);
  if (packSnapshot && packSnapshot.runId === run.id) {
    const knowledgePackItems = [
      ...(packSnapshot.rules ?? []),
      ...(packSnapshot.procedures ?? []),
      ...(packSnapshot.guardrails ?? []),
    ].filter((item) => item.itemKind === "rule" || item.itemKind === "procedure");
    const allItemIds = [...new Set(knowledgePackItems.map((item) => item.itemId).filter(Boolean))];

    const knowledgeRows =
      allItemIds.length > 0
        ? sqlite.db
            .query<SqliteKnowledgeTraceRow, string[]>(
              `SELECT id, title, status, applies_to
               FROM knowledge_items
               WHERE id IN (${allItemIds.map(() => "?").join(", ")})`,
            )
            .all(...allItemIds)
        : [];

    const appliesToByItemId = new Map<
      string,
      { changeTypes: string[]; technologies: string[]; domains: string[] }
    >();
    for (const row of knowledgeRows) {
      const appliesTo = asRecord(parseJson(row.applies_to));
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
    const itemKind = normalizePackKnowledgeItemKind(row.item_kind, row.section);
    if (!itemKind) continue;
    if (selectedKnowledgeRowsMap.has(row.item_id)) continue;
    selectedKnowledgeRowsMap.set(row.item_id, {
      knowledgeId: row.item_id,
      itemKind,
      section:
        row.section === "guardrails"
          ? "guardrails"
          : row.section === "procedures"
            ? "procedures"
            : "rules",
      score: row.score,
      rankingReason: row.ranking_reason,
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
    if (latestFeedbackByKnowledgeId.has(row.knowledge_id)) continue;
    latestFeedbackByKnowledgeId.set(row.knowledge_id, {
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      metadata: asRecord(parseJson(row.metadata)),
      updatedAt: row.updated_at ? normalizeDate(row.updated_at).toISOString() : null,
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
    if (latestEpisodeFeedbackById.has(row.episode_card_id)) continue;
    const verdict = normalizeEpisodeVerdict(row.verdict);
    if (!verdict) continue;
    const metadata = asRecord(parseJson(row.metadata));
    latestEpisodeFeedbackById.set(row.episode_card_id, {
      verdict,
      actor: normalizeFeedbackActor(metadata.actor),
      reason: normalizeNullableString(row.reason),
      updatedAt: normalizeDate(row.created_at).toISOString(),
    });
  }

  const detail = {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrieval_mode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(parseJson(run.degraded_reasons)),
      durationMs: normalizeDuration(run.duration_ms),
      source: normalizeCompileRunSource(run.source),
      evalSummary: await getCompileEvalSummaryByRunId(run.id),
      createdAt: normalizeDate(run.created_at).toISOString(),
      tokenBudget: normalizeDuration(run.token_budget),
      input: asRecord(parseJson(run.input)),
    },
    pack: packSnapshot,
    outputMarkdown,
    selectedItems: itemRows.map((row) => ({
      itemKind: row.item_kind,
      itemId: row.item_id,
      section: row.section,
      score: row.score,
      rankingReason: row.ranking_reason,
      sourceRefs: normalizeStringArray(parseJson(row.source_refs)),
    })),
    episodeSignals: itemRows
      .filter((row) => isEpisodePackItemKind(row.item_kind))
      .map((row) => {
        const feedback = latestEpisodeFeedbackById.get(row.item_id);
        return {
          episodeId: row.item_id,
          title:
            packTitleByKey.get(`episode_card:${row.item_id}`) ??
            packTitleByKey.get(`${row.item_kind}:${row.item_id}`) ??
            `Episode ${row.item_id.slice(0, 8)}`,
          section: "procedures" as const,
          sourceRefs: normalizeStringArray(parseJson(row.source_refs)),
          effectiveVerdict: feedback?.verdict ?? null,
          effectiveActor: feedback?.actor ?? null,
          effectiveReason: feedback?.reason ?? null,
          updatedAt: feedback?.updatedAt ?? null,
        };
      }),
    knowledgeFeedback: feedbackRows.map((row) => ({
      id: row.id ?? "",
      runId: row.run_id ?? runId,
      knowledgeId: row.knowledge_id,
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      createdAt: normalizeDate(row.created_at).toISOString(),
      updatedAt: normalizeDate(row.updated_at).toISOString(),
    })),
    knowledgeSignals: selectedKnowledgeRows.map((row) => {
      const latestFeedback = latestFeedbackByKnowledgeId.get(row.knowledgeId);
      const metadata = asRecord(latestFeedback?.metadata);
      const autoVerdict = normalizeKnowledgeVerdict(metadata.autoVerdict);
      const autoVerdictPresent = metadata.autoVerdict
        ? ["used", "not_used", "off_topic", "wrong"].includes(String(metadata.autoVerdict))
        : false;
      const autoActor = normalizeFeedbackActor(metadata.autoActor);
      const autoActorPresent = metadata.autoActor
        ? ["agent", "user", "system"].includes(String(metadata.autoActor))
        : false;

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

export async function getCompileRunRankingTraceSqlite(
  runId: string,
): Promise<CompileRunRankingTrace | null> {
  const sqlite = await getSqliteCoreDatabase();
  const run = sqlite.db
    .query<SqliteRunRow, [string]>("SELECT * FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!run) return null;

  const traceRows = sqlite.db
    .query<SqliteCandidateTraceRow, [string]>(
      `SELECT
        item_kind, item_id, text_rank, text_score, vector_rank, vector_score,
        merged_rank, merged_score, final_rank, final_score, selected, suppressed,
        suppression_reason, agentic_decision, ranking_reason, community_key
       FROM context_compile_candidate_traces
       WHERE run_id = ?`,
    )
    .all(runId);

  const knowledgeIds = [...new Set(traceRows.map((row) => row.item_id).filter(Boolean))];
  const knowledgeRows =
    knowledgeIds.length > 0
      ? sqlite.db
          .query<SqliteKnowledgeTraceRow, string[]>(
            `SELECT id, title, status
             FROM knowledge_items
             WHERE id IN (${knowledgeIds.map(() => "?").join(", ")})`,
          )
          .all(...knowledgeIds)
      : [];
  const knowledgeById = new Map(
    knowledgeRows.map((row) => [row.id, { title: row.title, status: row.status }]),
  );

  const packRows = sqlite.db
    .query<SqlitePackItemRow, [string]>(
      `SELECT item_kind, item_id, section, score, ranking_reason, source_refs, created_at
       FROM context_pack_items
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId);
  const packByKey = new Map(
    packRows.map((row) => [
      `${normalizePackKnowledgeItemKind(row.item_kind, row.section) ?? row.item_kind}:${row.item_id}`,
      { sourceRefs: normalizeStringArray(parseJson(row.source_refs)) },
    ]),
  );
  const effectiveTraceRows =
    traceRows.length > 0
      ? traceRows
      : packRows
          .map((row, index): SqliteCandidateTraceRow | null => {
            const itemKind = normalizePackKnowledgeItemKind(row.item_kind, row.section);
            if (!itemKind) return null;
            const rank = index + 1;
            return {
              item_kind: itemKind,
              item_id: row.item_id,
              text_rank: rank,
              text_score: row.score,
              vector_rank: null,
              vector_score: null,
              merged_rank: rank,
              merged_score: row.score,
              final_rank: rank,
              final_score: row.score,
              selected: 1,
              suppressed: 0,
              suppression_reason: null,
              agentic_decision: "accepted",
              ranking_reason: row.ranking_reason || "packed_without_candidate_trace",
              community_key: null,
            };
          })
          .filter((row): row is SqliteCandidateTraceRow => row !== null);

  const packPositionByKey = new Map<string, number>();
  const parsedPack = parsePackSnapshot(run.pack_snapshot, run);
  if (parsedPack) {
    let packPosition = 1;
    for (const item of [...parsedPack.rules, ...parsedPack.procedures, ...parsedPack.guardrails]) {
      if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
      packPositionByKey.set(`${item.itemKind}:${item.itemId}`, packPosition);
      packPosition += 1;
    }
  } else {
    for (const [index, row] of packRows.entries()) {
      const itemKind = normalizePackKnowledgeItemKind(row.item_kind, row.section);
      if (!itemKind) continue;
      packPositionByKey.set(`${itemKind}:${row.item_id}`, index + 1);
    }
  }

  const feedbackRows = sqlite.db
    .query<SqliteKnowledgeUsageEventRow, [string]>(
      `SELECT knowledge_id, verdict, actor, reason, updated_at, created_at
       FROM knowledge_usage_events
       WHERE run_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(runId);
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
    if (latestFeedbackByKnowledgeId.has(row.knowledge_id)) continue;
    const verdict = normalizeKnowledgeVerdict(row.verdict);
    const actor = normalizeFeedbackActor(row.actor);
    if (!verdict || !actor) continue;
    latestFeedbackByKnowledgeId.set(row.knowledge_id, {
      verdict,
      actor,
      reason: normalizeNullableString(row.reason),
      updatedAt: normalizeDate(row.updated_at ?? row.created_at).toISOString(),
    });
  }

  const evalSummary = await getCompileEvalSummaryByRunId(run.id);
  const items = effectiveTraceRows
    .filter((row) => row.item_kind === "rule" || row.item_kind === "procedure")
    .map((row) => {
      const key = `${row.item_kind}:${row.item_id}`;
      const knowledge = knowledgeById.get(row.item_id);
      const feedback = latestFeedbackByKnowledgeId.get(row.item_id);
      const agenticDecision =
        row.agentic_decision === "accepted" ||
        row.agentic_decision === "rejected" ||
        row.agentic_decision === "skipped"
          ? row.agentic_decision
          : "not_evaluated";
      return {
        itemKind: row.item_kind,
        itemId: row.item_id,
        title: knowledge?.title ?? `Knowledge ${row.item_id.slice(0, 8)}`,
        status: normalizeKnowledgeStatus(knowledge?.status ?? "active"),
        textRank: row.text_rank,
        textScore: row.text_score,
        vectorRank: row.vector_rank,
        vectorScore: row.vector_score,
        mergedRank: row.merged_rank,
        mergedScore: row.merged_score,
        finalRank: row.final_rank,
        finalScore: row.final_score,
        selected: row.selected === 1,
        packed: packByKey.has(key),
        packPosition: packPositionByKey.get(key) ?? null,
        suppressed: row.suppressed === 1,
        suppressionReason: normalizeNullableString(row.suppression_reason),
        agenticDecision,
        rankingReason: normalizeNullableString(row.ranking_reason),
        communityKey: normalizeNullableString(row.community_key),
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
      repoPath: normalizeNullableString(run.repo_path),
      retrievalMode: run.retrieval_mode,
      status: normalizeRunStatus(run.status),
      input: asRecord(parseJson(run.input)),
      createdAt: normalizeDate(run.created_at).toISOString(),
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

export async function saveRunEpisodeFeedbackSqlite(params: {
  runId: string;
  items: Array<{ episodeId: string; verdict: "used" | "not_used" | "wrong"; reason?: string }>;
}): Promise<CompileRunEpisodeFeedbackResult> {
  const sqlite = await getSqliteCoreDatabase();
  const run = sqlite.db
    .query<{ id: string }, [string]>("SELECT id FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(params.runId);
  if (!run) {
    throw Object.assign(new Error("Compile run not found."), { statusCode: 404 });
  }

  const selectableRows = sqlite.db
    .query<{ item_id: string }, [string]>(
      `SELECT item_id
       FROM context_pack_items
       WHERE run_id = ? AND item_kind IN ('episode_card', 'episode')`,
    )
    .all(params.runId);
  const selectableEpisodeIds = new Set(selectableRows.map((row) => row.item_id));
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
        {
          statusCode: 400,
        },
      );
    }
    return {
      episodeId,
      verdict: item.verdict,
      reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : null,
    };
  });

  const nowIso = new Date().toISOString();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of normalizedItems) {
      sqlite.db
        .query(
          `INSERT INTO episode_retrieval_feedback (
            id, episode_card_id, run_kind, run_id, used_for, verdict, reason, metadata, created_at
          ) VALUES (?, ?, 'compile', ?, 'compile', ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          item.episodeId,
          params.runId,
          episodeStorageVerdict(item.verdict),
          item.reason,
          JSON.stringify({ actor: "user" }),
          nowIso,
        );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }

  return {
    savedCount: normalizedItems.length,
    affectedEpisodeIds: normalizedItems.map((item) => item.episodeId),
  };
}

export async function upsertContextCompileTaskTraceSqlite(input: {
  runId: string;
  retrievalMode: string;
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
  embeddingStatus: string;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
  goalHash: string;
}): Promise<void> {
  const sqlite = await getSqliteCoreDatabase();
  const now = new Date().toISOString();
  sqlite.db
    .query(
      `INSERT INTO context_compile_task_traces (
        run_id, retrieval_mode, project_ref, repo_path, repo_key, match_basis,
        identity_contract_version, scope_mode, identity_fingerprint, identity_trust,
        binding_status, technologies, change_types, domains, embedding_status,
        embedding_provider, embedding_model, embedding_dimensions, embedding, goal_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        retrieval_mode = excluded.retrieval_mode,
        project_ref = excluded.project_ref,
        repo_path = excluded.repo_path,
        repo_key = excluded.repo_key,
        match_basis = excluded.match_basis,
        identity_contract_version = excluded.identity_contract_version,
        scope_mode = excluded.scope_mode,
        identity_fingerprint = excluded.identity_fingerprint,
        identity_trust = excluded.identity_trust,
        binding_status = excluded.binding_status,
        technologies = excluded.technologies,
        change_types = excluded.change_types,
        domains = excluded.domains,
        embedding_status = excluded.embedding_status,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding = excluded.embedding,
        goal_hash = excluded.goal_hash,
        updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.retrievalMode,
      input.projectRef,
      input.repoPath,
      input.repoKey,
      input.matchBasis,
      input.identityContractVersion,
      input.scopeMode,
      input.identityFingerprint,
      input.identityTrust,
      input.bindingStatus,
      json(input.technologies),
      json(input.changeTypes),
      json(input.domains),
      input.embeddingStatus,
      input.embeddingProvider,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embedding ? json(input.embedding) : null,
      input.goalHash,
      now,
      now,
    );
}

type SqliteTaskTraceRow = {
  run_id: string;
  retrieval_mode: string;
  project_ref: string | null;
  repo_path: string | null;
  repo_key: string | null;
  match_basis: string;
  identity_contract_version: number;
  scope_mode: string;
  identity_fingerprint: string | null;
  identity_trust: string;
  binding_status: string;
  technologies: string;
  change_types: string;
  domains: string;
  embedding_status: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding: string | null;
  goal_hash: string;
  created_at: string;
  updated_at: string;
};

function mapTaskTraceRow(row: SqliteTaskTraceRow): ContextCompileTaskTrace {
  const embeddingStatus =
    row.embedding_status === "embedding_available" ||
    row.embedding_status === "embedding_unavailable" ||
    row.embedding_status === "facets_only"
      ? row.embedding_status
      : "facets_only";
  const embedding = parseJson(row.embedding);
  return {
    runId: row.run_id,
    retrievalMode: row.retrieval_mode,
    projectRef: row.project_ref,
    repoPath: row.repo_path,
    repoKey: row.repo_key,
    matchBasis:
      row.match_basis === "project_ref" ||
      row.match_basis === "repo_key" ||
      row.match_basis === "repo_path"
        ? row.match_basis
        : "none",
    identityContractVersion: Math.max(1, Math.trunc(row.identity_contract_version)),
    scopeMode: row.scope_mode === "project" ? "project" : "global_only",
    identityFingerprint: row.identity_fingerprint,
    identityTrust: row.identity_trust === "trusted_adapter" ? "trusted_adapter" : "request_hint",
    bindingStatus:
      row.binding_status === "verified" || row.binding_status === "unverified"
        ? row.binding_status
        : "not_applicable",
    technologies: normalizeStringArray(parseJson(row.technologies)),
    changeTypes: normalizeStringArray(parseJson(row.change_types)),
    domains: normalizeStringArray(parseJson(row.domains)),
    embeddingStatus,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    embedding: Array.isArray(embedding) ? embedding.map(Number).filter(Number.isFinite) : null,
    goalHash: row.goal_hash,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

export async function findContextCompileTaskTraceByRunIdSqlite(
  runId: string,
): Promise<ContextCompileTaskTrace | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteTaskTraceRow, [string]>(
      "SELECT * FROM context_compile_task_traces WHERE run_id = ? LIMIT 1",
    )
    .get(runId);
  return row ? mapTaskTraceRow(row) : null;
}

export async function listRecentContextCompileTaskTracesSqlite(input: {
  limit: number;
  excludeRunId?: string;
}): Promise<ContextCompileTaskTrace[]> {
  const sqlite = await getSqliteCoreDatabase();
  const limit = Math.max(1, Math.min(400, Math.trunc(input.limit)));
  const rows = input.excludeRunId
    ? sqlite.db
        .query<SqliteTaskTraceRow, [string, number]>(
          `SELECT * FROM context_compile_task_traces
           WHERE run_id != ?
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?`,
        )
        .all(input.excludeRunId, limit)
    : sqlite.db
        .query<SqliteTaskTraceRow, [number]>(
          `SELECT * FROM context_compile_task_traces
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?`,
        )
        .all(limit);
  return rows.map(mapTaskTraceRow);
}

function normalizeIsoString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const unixMs = trimmed.match(/^unix-ms:(\d+)$/);
  if (unixMs) {
    const parsedMillis = Number(unixMs[1]);
    if (Number.isSafeInteger(parsedMillis)) {
      const parsedUnix = new Date(parsedMillis);
      return Number.isNaN(parsedUnix.getTime()) ? null : parsedUnix.toISOString();
    }
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseSqliteRunInput(row: SqliteRunRow): Record<string, unknown> {
  return asRecord(parseJson(row.input));
}
