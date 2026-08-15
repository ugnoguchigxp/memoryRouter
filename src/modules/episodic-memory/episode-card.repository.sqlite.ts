import {
  type EpisodeCard,
  type EpisodeCardCreateInput,
  type EpisodeCardSearchInput,
  type EpisodeCardStatus,
  episodeCardCreateSchema,
  episodeCardSchema,
  episodeCardSearchInputSchema,
} from "../../shared/schemas/episode-card.schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import { resolveCompileProjectIdentity } from "../context-compiler/compile-project-identity.js";
import { evaluateRepositoryScope } from "../context-compiler/repository-scope.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

type SqliteEpisodeCardRow = {
  id: string;
  title: string;
  situation: string;
  observations: string;
  action: string;
  outcome: string;
  lesson: string;
  applicability: string;
  anti_applicability: string;
  domains: string;
  technologies: string;
  change_types: string;
  tools: string;
  classification_status: string;
  scope: string;
  project_ref: string | null;
  repo_path: string | null;
  repo_key: string | null;
  source_kind: string;
  source_key: string;
  outcome_kind: string;
  importance: number;
  confidence: number;
  compile_use_count: number;
  decision_use_count: number;
  status: string;
  stale_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type SqliteEpisodeRefRow = {
  id: string;
  episode_card_id: string;
  ref_kind: string;
  ref_value: string;
  locator: string | null;
  query_hint: string | null;
  metadata: string;
  created_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFacet(value: string): string {
  return normalizeText(value)
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}./+#-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueFacets(values: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeFacet(value);
    if (normalized) set.add(normalized);
  }
  return [...set];
}

function queryTokens(query: string): string[] {
  return [
    ...new Set(
      normalizeText(query)
        .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f./+#-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 16);
}

function scoreText(text: string, query: string | undefined): number {
  const normalizedQuery = normalizeText(query ?? "");
  if (!normalizedQuery) return 0;
  const normalizedText = normalizeText(text);
  let score = normalizedText.includes(normalizedQuery) ? 8 : 0;
  for (const token of queryTokens(normalizedQuery)) {
    if (normalizedText.includes(token)) score += 1;
  }
  return score;
}

function intersects(queryValues: string[] | undefined, sourceValues: string[]): boolean {
  const query = uniqueFacets(queryValues);
  if (query.length === 0) return true;
  const source = new Set(sourceValues.map(normalizeFacet));
  return query.some((value) => source.has(value));
}

function overlapCount(queryValues: string[] | undefined, sourceValues: string[]): number {
  const query = uniqueFacets(queryValues);
  if (query.length === 0) return 0;
  const source = new Set(sourceValues.map(normalizeFacet));
  return query.filter((value) => source.has(value)).length;
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const unixMillis = trimmed.startsWith("unix-ms:")
    ? Number(trimmed.slice("unix-ms:".length))
    : Number.NaN;
  if (Number.isFinite(unixMillis)) {
    const date = new Date(unixMillis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapEpisode(
  row: SqliteEpisodeCardRow,
  refs: SqliteEpisodeRefRow[],
  score?: number,
): EpisodeCard {
  return episodeCardSchema.parse({
    id: row.id,
    title: row.title,
    situation: row.situation,
    observations: row.observations,
    action: row.action,
    outcome: row.outcome,
    lesson: row.lesson,
    applicability: asRecord(parseJson(row.applicability)),
    antiApplicability: asRecord(parseJson(row.anti_applicability)),
    domains: asStringArray(parseJson(row.domains)),
    technologies: asStringArray(parseJson(row.technologies)),
    changeTypes: asStringArray(parseJson(row.change_types)),
    tools: asStringArray(parseJson(row.tools)),
    classificationStatus: row.classification_status ?? "unresolved",
    scope: row.scope ?? "repo",
    projectRef: row.project_ref ?? null,
    repoPath: row.repo_path ?? null,
    repoKey: row.repo_key ?? null,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    outcomeKind: row.outcome_kind,
    importance: row.importance,
    confidence: row.confidence,
    compileUseCount: row.compile_use_count,
    decisionUseCount: row.decision_use_count,
    status: row.status,
    staleAt: toDate(row.stale_at),
    metadata: asRecord(parseJson(row.metadata)),
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
    score,
    refs: refs.map((ref) => ({
      id: ref.id,
      episodeCardId: ref.episode_card_id,
      refKind: ref.ref_kind,
      refValue: ref.ref_value,
      locator: ref.locator,
      queryHint: ref.query_hint,
      metadata: asRecord(parseJson(ref.metadata)),
      createdAt: toDate(ref.created_at) ?? new Date(0),
    })),
  });
}

function searchableText(episode: EpisodeCard): string {
  return [
    episode.title,
    episode.situation,
    episode.observations,
    episode.action,
    episode.outcome,
    episode.lesson,
    episode.domains.join(" "),
    episode.technologies.join(" "),
    episode.changeTypes.join(" "),
    episode.tools.join(" "),
    episode.refs.map((ref) => `${ref.refKind} ${ref.refValue} ${ref.queryHint ?? ""}`).join(" "),
  ].join("\n");
}

function normalizeSearchInput(rawInput: EpisodeCardSearchInput) {
  const input = episodeCardSearchInputSchema.parse(rawInput);
  const statuses =
    input.statuses && input.statuses.length > 0
      ? input.statuses
      : input.status
        ? [input.status]
        : ["active"];
  return {
    ...input,
    projectIdentity: resolveCompileProjectIdentity({
      projectRef: input.projectRef,
      repoKey: input.repoKey,
      repoPath: input.repoPath,
    }),
    query: input.query?.trim(),
    statuses,
    domains: uniqueFacets(input.domains),
    technologies: uniqueFacets(input.technologies),
    changeTypes: uniqueFacets(input.changeTypes),
    tools: uniqueFacets(input.tools),
    outcomeKinds: input.outcomeKinds ?? [],
  };
}

function matchesSearchInput(episode: EpisodeCard, input: ReturnType<typeof normalizeSearchInput>) {
  if (!input.statuses.includes(episode.status)) return false;
  if (
    !evaluateRepositoryScope(
      {
        id: episode.id,
        entityKind: "episode",
        status: episode.status,
        classificationStatus: episode.classificationStatus,
        scope: episode.scope,
        projectRef: episode.projectRef ?? null,
        repoKey: episode.repoKey ?? null,
        repoPath: episode.repoPath ?? null,
        general:
          asRecord(episode.applicability).general === true ||
          (episode.technologies.length === 0 &&
            episode.changeTypes.length === 0 &&
            episode.domains.length === 0),
        facets: {
          technologies: episode.technologies,
          changeTypes: episode.changeTypes,
          domains: episode.domains,
        },
        producer: episode.sourceKind,
      },
      input.projectIdentity,
      {
        technologies: input.technologies,
        changeTypes: input.changeTypes,
        domains: input.domains,
      },
    ).allowed
  ) {
    return false;
  }
  if (input.outcomeKinds.length > 0 && !input.outcomeKinds.includes(episode.outcomeKind)) {
    return false;
  }
  if (!intersects(input.tools, episode.tools)) return false;
  return true;
}

function scoreEpisode(
  episode: EpisodeCard,
  input: ReturnType<typeof normalizeSearchInput>,
): number {
  const queryScore = scoreText(searchableText(episode), input.query);
  if (input.query && queryScore <= 0) return 0;
  const facetScore =
    overlapCount(input.domains, episode.domains) * 3 +
    overlapCount(input.technologies, episode.technologies) * 3 +
    overlapCount(input.changeTypes, episode.changeTypes) * 3 +
    overlapCount(input.tools, episode.tools) * 2;
  const qualityBoost = (episode.importance * 0.6 + episode.confidence * 0.4) / 100;
  const outcomeBoost = episode.outcomeKind === "unknown" ? 0 : 1;
  return queryScore + facetScore + qualityBoost + outcomeBoost;
}

function hasRankingCriteria(input: ReturnType<typeof normalizeSearchInput>): boolean {
  return Boolean(
    input.query ||
      input.projectIdentity.matchBasis !== "none" ||
      input.outcomeKinds.length > 0 ||
      input.domains.length > 0 ||
      input.technologies.length > 0 ||
      input.changeTypes.length > 0 ||
      input.tools.length > 0,
  );
}

async function refsByEpisodeIds(ids: string[]): Promise<Map<string, SqliteEpisodeRefRow[]>> {
  const sqlite = await getSqliteCoreDatabase();
  const refs = new Map<string, SqliteEpisodeRefRow[]>();
  if (ids.length === 0) return refs;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = sqlite.db
    .query<SqliteEpisodeRefRow, string[]>(
      `select * from episode_refs where episode_card_id in (${placeholders})`,
    )
    .all(...ids);
  for (const row of rows) {
    const current = refs.get(row.episode_card_id) ?? [];
    current.push(row);
    refs.set(row.episode_card_id, current);
  }
  return refs;
}

export async function createEpisodeCardSqlite(
  rawInput: EpisodeCardCreateInput,
): Promise<EpisodeCard> {
  const input = episodeCardCreateSchema.parse(rawInput);
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: input.scope,
      projectRef: input.projectRef,
      repoKey: input.repoKey,
      repoPath: input.repoPath,
    },
    {
      producer: `episode.${input.sourceKind}`,
      entityKind: "episode",
    },
  );
  const sqlite = await getSqliteCoreDatabase();
  const id = crypto.randomUUID();
  const now = nowIso();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    sqlite.db
      .query(
        `
        insert into episode_cards (
          id, title, situation, observations, action, outcome, lesson,
          applicability, anti_applicability, domains, technologies, change_types, tools,
          classification_status, scope, project_ref, repo_path, repo_key,
          source_kind, source_key, outcome_kind, importance, confidence,
          compile_use_count, decision_use_count, status, stale_at, metadata,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        redactSecrets(input.title),
        redactSecrets(input.situation),
        redactSecrets(input.observations),
        redactSecrets(input.action),
        redactSecrets(input.outcome),
        redactSecrets(input.lesson),
        json(input.applicability),
        json(input.antiApplicability),
        json(uniqueFacets(input.domains)),
        json(uniqueFacets(input.technologies)),
        json(uniqueFacets(input.changeTypes)),
        json(uniqueFacets(input.tools)),
        identity.classificationStatus,
        identity.scope,
        identity.projectRef,
        identity.repoPath,
        identity.repoKey,
        input.sourceKind,
        input.sourceKey,
        input.outcomeKind,
        input.importance,
        input.confidence,
        input.compileUseCount,
        input.decisionUseCount,
        input.status,
        input.staleAt ? new Date(input.staleAt).toISOString() : null,
        json(redactSecretRecord(input.metadata)),
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        sqlite.db.query<{ rowid: number }, []>("select last_insert_rowid() as rowid").get()
          ?.rowid ?? 0,
        id,
        redactSecrets(input.title),
        redactSecrets(input.situation),
        redactSecrets(input.observations),
        redactSecrets(input.action),
        redactSecrets(input.outcome),
        redactSecrets(input.lesson),
      );
    const refs: SqliteEpisodeRefRow[] = [];
    for (const ref of input.refs) {
      const refId = crypto.randomUUID();
      sqlite.db
        .query(
          `
          insert into episode_refs (
            id, episode_card_id, ref_kind, ref_value, locator, query_hint, metadata, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          refId,
          id,
          ref.refKind,
          ref.refValue,
          ref.locator ?? null,
          ref.queryHint ?? null,
          json(redactSecretRecord(ref.metadata)),
          now,
        );
      refs.push({
        id: refId,
        episode_card_id: id,
        ref_kind: ref.refKind,
        ref_value: ref.refValue,
        locator: ref.locator ?? null,
        query_hint: ref.queryHint ?? null,
        metadata: json(redactSecretRecord(ref.metadata)),
        created_at: now,
      });
    }
    sqlite.db.query("COMMIT").run();
    const row = await getEpisodeCardRow(id);
    if (!row) throw new Error("EpisodeCard insert did not return a row");
    const episode = mapEpisode(row, refs);
    await recordProjectScopedWritePersisted(identity, {
      producer: `episode.${input.sourceKind}`,
      entityKind: "episode",
      entityId: id,
    });
    return episode;
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

async function getEpisodeCardRow(id: string): Promise<SqliteEpisodeCardRow | null> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.db
    .query<SqliteEpisodeCardRow, [string]>("select * from episode_cards where id = ? limit 1")
    .get(id);
}

export async function getEpisodeCardSqlite(id: string): Promise<EpisodeCard | null> {
  const row = await getEpisodeCardRow(id);
  if (!row) return null;
  const refs = await refsByEpisodeIds([id]);
  return mapEpisode(row, refs.get(id) ?? []);
}

export async function getEpisodeCardBySourceSqlite(params: {
  sourceKind: EpisodeCardCreateInput["sourceKind"];
  sourceKey: string;
}): Promise<EpisodeCard | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteEpisodeCardRow, [string, string]>(
      "select * from episode_cards where source_kind = ? and source_key = ? limit 1",
    )
    .get(params.sourceKind, params.sourceKey);
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}

export async function searchEpisodeCardsSqlite(
  rawInput: EpisodeCardSearchInput,
): Promise<EpisodeCard[]> {
  const input = normalizeSearchInput(rawInput);
  const sqlite = await getSqliteCoreDatabase();
  const statusPlaceholders = input.statuses.map(() => "?").join(", ");
  const matchColumn =
    input.projectIdentity.matchBasis === "project_ref"
      ? "project_ref"
      : input.projectIdentity.matchBasis === "repo_key"
        ? "repo_key"
        : input.projectIdentity.matchBasis === "repo_path"
          ? "repo_path"
          : null;
  const repoClause = matchColumn ? ` OR (scope = 'repo' AND ${matchColumn} = ?)` : "";
  const bindings: string[] = [...input.statuses];
  if (matchColumn && input.projectIdentity.matchValue) {
    bindings.push(input.projectIdentity.matchValue);
  }
  const rows = sqlite.db
    .query<SqliteEpisodeCardRow, string[]>(
      `
      select *
      from episode_cards
      where status in (${statusPlaceholders})
        and classification_status = 'classified'
        and ((scope = 'global' and project_ref is null and repo_key is null and repo_path is null)${repoClause})
      order by created_at desc
    `,
    )
    .all(...bindings);
  const refs = await refsByEpisodeIds(rows.map((row) => row.id));
  return rows
    .map((row) => mapEpisode(row, refs.get(row.id) ?? []))
    .filter((episode) => matchesSearchInput(episode, input))
    .map((episode) => ({ episode, score: scoreEpisode(episode, input) }))
    .filter(({ score }) => !input.query || score > 0)
    .sort((left, right) => {
      const recency = right.episode.createdAt.getTime() - left.episode.createdAt.getTime();
      if (!hasRankingCriteria(input)) return recency || right.score - left.score;
      return right.score - left.score || recency;
    })
    .slice(0, input.limit)
    .map(({ episode, score }) => ({ ...episode, score }));
}

export async function incrementEpisodeUsageCountsSqlite(params: {
  episodeIds: string[];
  usageKind: "compile" | "decision";
}): Promise<void> {
  const episodeIds = [...new Set(params.episodeIds.map((id) => id.trim()).filter(Boolean))];
  if (episodeIds.length === 0) return;
  const sqlite = await getSqliteCoreDatabase();
  const column = params.usageKind === "compile" ? "compile_use_count" : "decision_use_count";
  const placeholders = episodeIds.map(() => "?").join(", ");
  sqlite.db
    .query(
      `update episode_cards set ${column} = ${column} + 1, updated_at = ? where id in (${placeholders})`,
    )
    .run(nowIso(), ...episodeIds);
}

export async function updateEpisodeCardStatusSqlite(params: {
  episodeId: string;
  status: EpisodeCardStatus;
}): Promise<EpisodeCard | null> {
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query("update episode_cards set status = ?, updated_at = ? where id = ?")
    .run(params.status, nowIso(), params.episodeId);
  return getEpisodeCardSqlite(params.episodeId);
}
