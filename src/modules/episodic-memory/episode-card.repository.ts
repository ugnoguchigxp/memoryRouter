import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { episodeCards, episodeRefs } from "../../db/schema.js";
import { db } from "../../db/index.js";
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

type EpisodeCardRow = typeof episodeCards.$inferSelect;
type EpisodeRefRow = typeof episodeRefs.$inferSelect;

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function sqliteRepository() {
  return import("./episode-card.repository.sqlite.js");
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

function mapEpisode(row: EpisodeCardRow, refs: EpisodeRefRow[], score?: number): EpisodeCard {
  return episodeCardSchema.parse({
    id: row.id,
    title: row.title,
    situation: row.situation,
    observations: row.observations,
    action: row.action,
    outcome: row.outcome,
    lesson: row.lesson,
    applicability: asRecord(row.applicability),
    antiApplicability: asRecord(row.antiApplicability),
    domains: asStringArray(row.domains),
    technologies: asStringArray(row.technologies),
    changeTypes: asStringArray(row.changeTypes),
    tools: asStringArray(row.tools),
    classificationStatus: row.classificationStatus ?? "unresolved",
    scope: row.scope ?? "repo",
    projectRef: row.projectRef,
    repoPath: row.repoPath,
    repoKey: row.repoKey,
    sourceKind: row.sourceKind,
    sourceKey: row.sourceKey,
    outcomeKind: row.outcomeKind,
    importance: row.importance,
    confidence: row.confidence,
    compileUseCount: row.compileUseCount,
    decisionUseCount: row.decisionUseCount,
    status: row.status,
    staleAt: row.staleAt,
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    score,
    refs: refs.map((ref) => ({
      id: ref.id,
      episodeCardId: ref.episodeCardId,
      refKind: ref.refKind,
      refValue: ref.refValue,
      locator: ref.locator,
      queryHint: ref.queryHint,
      metadata: asRecord(ref.metadata),
      createdAt: ref.createdAt,
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

// Admin browsing includes records that are intentionally ineligible for AI retrieval.
function matchesAdminListInput(
  episode: EpisodeCard,
  input: ReturnType<typeof normalizeSearchInput>,
) {
  const { matchBasis, matchValue } = input.projectIdentity;
  if (matchBasis === "project_ref" && episode.projectRef !== matchValue) return false;
  if (matchBasis === "repo_key" && episode.repoKey !== matchValue) return false;
  if (matchBasis === "repo_path" && episode.repoPath !== matchValue) return false;
  return (
    input.statuses.includes(episode.status) &&
    (input.outcomeKinds.length === 0 || input.outcomeKinds.includes(episode.outcomeKind)) &&
    intersects(input.domains, episode.domains) &&
    intersects(input.technologies, episode.technologies) &&
    intersects(input.changeTypes, episode.changeTypes) &&
    intersects(input.tools, episode.tools)
  );
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

async function refsByEpisodeIds(ids: string[]): Promise<Map<string, EpisodeRefRow[]>> {
  const refs = new Map<string, EpisodeRefRow[]>();
  if (ids.length === 0) return refs;
  const rows = await db.select().from(episodeRefs).where(inArray(episodeRefs.episodeCardId, ids));
  for (const row of rows) {
    const current = refs.get(row.episodeCardId) ?? [];
    current.push(row);
    refs.set(row.episodeCardId, current);
  }
  return refs;
}

export type CreateEpisodeCardOptions = {
  identityProducer?: string;
};

export async function createEpisodeCard(
  rawInput: EpisodeCardCreateInput,
  options: CreateEpisodeCardOptions = {},
): Promise<EpisodeCard> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.createEpisodeCardSqlite(rawInput, options);
  }

  const input = episodeCardCreateSchema.parse(rawInput);
  const identityProducer = options.identityProducer ?? `episode.${input.sourceKind}`;
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: input.scope,
      projectRef: input.projectRef,
      repoKey: input.repoKey,
      repoPath: input.repoPath,
    },
    {
      producer: identityProducer,
      entityKind: "episode",
    },
  );
  const now = new Date();
  const episode = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(episodeCards)
      .values({
        title: redactSecrets(input.title),
        situation: redactSecrets(input.situation),
        observations: redactSecrets(input.observations),
        action: redactSecrets(input.action),
        outcome: redactSecrets(input.outcome),
        lesson: redactSecrets(input.lesson),
        applicability: input.applicability,
        antiApplicability: input.antiApplicability,
        domains: uniqueFacets(input.domains),
        technologies: uniqueFacets(input.technologies),
        changeTypes: uniqueFacets(input.changeTypes),
        tools: uniqueFacets(input.tools),
        classificationStatus: identity.classificationStatus,
        scope: identity.scope,
        projectRef: identity.projectRef,
        repoPath: identity.repoPath,
        repoKey: identity.repoKey,
        sourceKind: input.sourceKind,
        sourceKey: input.sourceKey,
        outcomeKind: input.outcomeKind,
        importance: input.importance,
        confidence: input.confidence,
        compileUseCount: input.compileUseCount,
        decisionUseCount: input.decisionUseCount,
        status: input.status,
        staleAt: input.staleAt ?? null,
        metadata: redactSecretRecord(input.metadata),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const insertedRefs =
      input.refs.length > 0
        ? await tx
            .insert(episodeRefs)
            .values(
              input.refs.map((ref) => ({
                episodeCardId: inserted.id,
                refKind: ref.refKind,
                refValue: ref.refValue,
                locator: ref.locator ?? null,
                queryHint: ref.queryHint ?? null,
                metadata: redactSecretRecord(ref.metadata),
              })),
            )
            .returning()
        : [];

    return mapEpisode(inserted, insertedRefs);
  });

  await recordProjectScopedWritePersisted(identity, {
    producer: identityProducer,
    entityKind: "episode",
    entityId: episode.id,
  });

  return episode;
}

export async function getEpisodeCard(id: string): Promise<EpisodeCard | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getEpisodeCardSqlite(id);
  }
  const [row] = await db.select().from(episodeCards).where(eq(episodeCards.id, id)).limit(1);
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}

export async function getEpisodeCardBySource(params: {
  sourceKind: EpisodeCardCreateInput["sourceKind"];
  sourceKey: string;
}): Promise<EpisodeCard | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getEpisodeCardBySourceSqlite(params);
  }
  const [row] = await db
    .select()
    .from(episodeCards)
    .where(
      and(
        eq(episodeCards.sourceKind, params.sourceKind),
        eq(episodeCards.sourceKey, params.sourceKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}

export async function searchEpisodeCards(rawInput: EpisodeCardSearchInput): Promise<EpisodeCard[]> {
  return queryEpisodeCards(rawInput, "retrieval");
}

export async function listEpisodeCardsForAdmin(
  rawInput: EpisodeCardSearchInput,
): Promise<EpisodeCard[]> {
  return queryEpisodeCards(rawInput, "admin");
}

async function queryEpisodeCards(
  rawInput: EpisodeCardSearchInput,
  purpose: "retrieval" | "admin",
): Promise<EpisodeCard[]> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return purpose === "admin"
      ? sqlite.listEpisodeCardsForAdminSqlite(rawInput)
      : sqlite.searchEpisodeCardsSqlite(rawInput);
  }
  const input = normalizeSearchInput(rawInput);
  const globalCondition = and(
    eq(episodeCards.scope, "global"),
    isNull(episodeCards.projectRef),
    isNull(episodeCards.repoKey),
    isNull(episodeCards.repoPath),
  );
  const matchValue = input.projectIdentity.matchValue;
  const repoCondition =
    matchValue === null
      ? undefined
      : input.projectIdentity.matchBasis === "project_ref"
        ? and(eq(episodeCards.scope, "repo"), eq(episodeCards.projectRef, matchValue))
        : input.projectIdentity.matchBasis === "repo_key"
          ? and(eq(episodeCards.scope, "repo"), eq(episodeCards.repoKey, matchValue))
          : input.projectIdentity.matchBasis === "repo_path"
            ? and(eq(episodeCards.scope, "repo"), eq(episodeCards.repoPath, matchValue))
            : undefined;
  const conditions = [
    inArray(episodeCards.status, input.statuses),
    ...(purpose === "admin"
      ? []
      : [
          eq(episodeCards.classificationStatus, "classified"),
          repoCondition ? or(globalCondition, repoCondition) : globalCondition,
        ]),
  ];

  const rows = await db
    .select()
    .from(episodeCards)
    .where(and(...conditions))
    .orderBy(desc(episodeCards.createdAt));
  const refs = await refsByEpisodeIds(rows.map((row) => row.id));
  return rows
    .map((row) => mapEpisode(row, refs.get(row.id) ?? []))
    .filter((episode) =>
      purpose === "admin"
        ? matchesAdminListInput(episode, input)
        : matchesSearchInput(episode, input),
    )
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

export async function incrementEpisodeUsageCounts(params: {
  episodeIds: string[];
  usageKind: "compile" | "decision";
}): Promise<void> {
  const episodeIds = [...new Set(params.episodeIds.map((id) => id.trim()).filter(Boolean))];
  if (episodeIds.length === 0) return;
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    await sqlite.incrementEpisodeUsageCountsSqlite({ ...params, episodeIds });
    return;
  }
  const column =
    params.usageKind === "compile" ? episodeCards.compileUseCount : episodeCards.decisionUseCount;
  await db
    .update(episodeCards)
    .set({
      [params.usageKind === "compile" ? "compileUseCount" : "decisionUseCount"]: sql`${column} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(episodeCards.id, episodeIds));
}

export async function updateEpisodeCardStatus(params: {
  episodeId: string;
  status: EpisodeCardStatus;
}): Promise<EpisodeCard | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.updateEpisodeCardStatusSqlite(params);
  }
  const [row] = await db
    .update(episodeCards)
    .set({ status: params.status, updatedAt: new Date() })
    .where(eq(episodeCards.id, params.episodeId))
    .returning();
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}
