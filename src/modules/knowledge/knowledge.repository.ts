import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceFragments, sources } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type {
  KnowledgeItem,
  KnowledgeSearchInput,
  KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import { computeDecayFactor } from "./knowledge-value.service.js";
import {
  type ApplicabilityQuery,
  type KnowledgeSearchOptions,
  type KnowledgeSearchQueryInput,
  type KnowledgeSearchResult,
  type UpsertKnowledgeFromSourceParams,
  asRecord,
  buildApplicabilityQuery,
  buildKnowledgeScopeMetadata,
  buildRepoScopedCondition,
  computeApplicability,
  fallbackSourceRefsFromMetadata,
  finiteOrZero,
  hasApplicabilityQuery,
  resolveKnowledgeActor,
} from "./knowledge.repository.shared.js";
import { linkKnowledgeFromMetadata } from "./source-linking.service.js";

export type { KnowledgeSearchOptions, KnowledgeSearchResult, UpsertKnowledgeFromSourceParams };

function normalizedImportanceExpr() {
  return sql<number>`
    CASE
      WHEN ${knowledgeItems.importance} >= 0 AND ${knowledgeItems.importance} <= 1
        THEN ${knowledgeItems.importance} * 100
      ELSE ${knowledgeItems.importance}
    END
  `;
}

async function listKnowledgeSourceRefs(knowledgeIds: string[]): Promise<Map<string, string[]>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      knowledgeId: knowledgeSourceLinks.knowledgeId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      confidence: knowledgeSourceLinks.confidence,
    })
    .from(knowledgeSourceLinks)
    .innerJoin(sourceFragments, eq(sourceFragments.id, knowledgeSourceLinks.sourceFragmentId))
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds))
    .orderBy(desc(knowledgeSourceLinks.confidence), desc(knowledgeSourceLinks.createdAt));

  const refsByKnowledgeId = new Map<string, string[]>();
  for (const row of rows) {
    const current = refsByKnowledgeId.get(row.knowledgeId) ?? [];
    const ref = `${row.sourceUri}#${row.locator}`;
    if (!current.includes(ref)) current.push(ref);
    refsByKnowledgeId.set(row.knowledgeId, current);
  }
  return refsByKnowledgeId;
}

type KnowledgeSearchRow = {
  id: string;
  type: string;
  status: string;
  scope: string;
  classificationStatus: string;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  polarity: string;
  intentTags: unknown;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo: unknown;
  metadata: unknown;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  score: number;
};

function mapKnowledgeRowsToResults(
  rows: KnowledgeSearchRow[],
  sourceRefsByKnowledgeId: Map<string, string[]>,
  applicabilityQuery: ApplicabilityQuery,
): KnowledgeSearchResult[] {
  return rows.map((row) => {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const dynamicScore = Math.max(0, finiteOrZero(row.dynamicScore));
    const compileSelectCount = Math.max(0, Math.floor(finiteOrZero(row.compileSelectCount)));
    const agenticAcceptCount = Math.max(0, Math.floor(finiteOrZero(row.agenticAcceptCount)));
    const explicitUpvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitUpvoteCount)));
    const explicitDownvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitDownvoteCount)));
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    const decayFactor = computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
    });
    const applicability = computeApplicability(appliesTo, applicabilityQuery);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      classificationStatus: row.classificationStatus,
      projectRef: row.projectRef,
      repoKey: row.repoKey,
      repoPath: row.repoPath,
      polarity: String(row.polarity ?? "positive"),
      intentTags: Array.isArray(row.intentTags) ? row.intentTags.map(String) : [],
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score) + applicability.score / 100,
      appliesTo,
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
      dynamicScore,
      compileSelectCount,
      agenticAcceptCount,
      explicitUpvoteCount,
      explicitDownvoteCount,
      lastCompiledAt: row.lastCompiledAt,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
      decayFactor,
      applicabilityScore: applicability.score,
      applicabilityMatches: applicability.matches,
    };
  });
}

function buildJsonbArrayAnyMatch(key: string, values: string[]): SQL | undefined {
  if (values.length === 0) return undefined;
  const quotedKey = sql.raw(`'${key}'`);
  return sql`(coalesce(${knowledgeItems.appliesTo} -> ${quotedKey}, '[]'::jsonb) ?| array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`,`,
  )}])`;
}

function buildApplicabilityFilterCondition(query: ApplicabilityQuery): SQL | undefined {
  const clauses: SQL[] = [];
  const technologies = buildJsonbArrayAnyMatch("technologies", query.technologies);
  if (technologies) clauses.push(technologies);
  const changeTypes = buildJsonbArrayAnyMatch("changeTypes", query.changeTypes);
  if (changeTypes) clauses.push(changeTypes);
  const domains = buildJsonbArrayAnyMatch("domains", query.domains);
  if (domains) clauses.push(domains);
  if (query.includeGeneral) {
    clauses.push(sql`(
      ${knowledgeItems.appliesTo} ->> 'general' = 'true'
      OR (
        NOT (${knowledgeItems.appliesTo} ? 'general')
        AND jsonb_array_length(coalesce(${knowledgeItems.appliesTo} -> 'technologies', '[]'::jsonb)) = 0
        AND jsonb_array_length(coalesce(${knowledgeItems.appliesTo} -> 'changeTypes', '[]'::jsonb)) = 0
        AND jsonb_array_length(coalesce(${knowledgeItems.appliesTo} -> 'domains', '[]'::jsonb)) = 0
      )
    )`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

export async function searchKnowledge(
  input: KnowledgeSearchQueryInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { searchKnowledgeSqlite } = await import("./knowledge.repository.sqlite.js");
    return searchKnowledgeSqlite(input, options);
  }

  const conditions: SQL[] = [];

  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  } else if (input.types && input.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, input.types));
  }

  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(knowledgeItems.status, input.statuses));
  } else {
    conditions.push(eq(knowledgeItems.status, input.status));
  }

  const repoScopedCondition = buildRepoScopedCondition({
    ...options,
    repoPath: options.repoPath ?? input.repoPath,
  });
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
  }

  const polarities = options.polarities ?? input.polarities;
  if (polarities && polarities.length > 0) {
    conditions.push(inArray(knowledgeItems.polarity, polarities));
  }

  const intentTags = options.intentTags ?? input.intentTags;
  if (intentTags && intentTags.length > 0) {
    conditions.push(
      sql`coalesce(${knowledgeItems.intentTags}, '[]'::jsonb) ?| array[${sql.join(
        intentTags.map((t) => sql`${t}`),
        sql`,`,
      )}]`,
    );
  }

  const query = input.query.trim();
  const importanceOrderExpr = normalizedImportanceExpr();
  const rankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body})),
      plainto_tsquery('simple', ${query})
    )
  `;
  const textMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body}))
    @@ plainto_tsquery('simple', ${query})
  `;
  const textSearchCondition =
    or(
      ilike(knowledgeItems.title, `%${query}%`),
      ilike(knowledgeItems.body, `%${query}%`),
      textMatchExpr,
    ) ?? textMatchExpr;
  const applicabilityQuery = buildApplicabilityQuery(input, options);
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const applicabilityCondition = facetRequested
    ? buildApplicabilityFilterCondition(applicabilityQuery)
    : undefined;
  if (applicabilityCondition) conditions.push(applicabilityCondition);
  const searchLimit = input.limit;

  const selectFields = {
    id: knowledgeItems.id,
    type: knowledgeItems.type,
    status: knowledgeItems.status,
    scope: knowledgeItems.scope,
    classificationStatus: knowledgeItems.classificationStatus,
    projectRef: knowledgeItems.projectRef,
    repoKey: knowledgeItems.repoKey,
    repoPath: knowledgeItems.repoPath,
    polarity: knowledgeItems.polarity,
    intentTags: knowledgeItems.intentTags,
    title: knowledgeItems.title,
    body: knowledgeItems.body,
    confidence: knowledgeItems.confidence,
    importance: knowledgeItems.importance,
    appliesTo: knowledgeItems.appliesTo,
    metadata: knowledgeItems.metadata,
    dynamicScore: knowledgeItems.dynamicScore,
    compileSelectCount: knowledgeItems.compileSelectCount,
    agenticAcceptCount: knowledgeItems.agenticAcceptCount,
    explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
    explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
    lastCompiledAt: knowledgeItems.lastCompiledAt,
    lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    updatedAt: knowledgeItems.updatedAt,
    score: rankExpr,
  } as const;

  const rankedRows = (await db
    .select(selectFields)
    .from(knowledgeItems)
    .where(and(...conditions, textSearchCondition))
    .orderBy(desc(rankExpr), desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
    .limit(searchLimit)) as KnowledgeSearchRow[];

  let rows: KnowledgeSearchRow[] = [...rankedRows];
  if (facetRequested) {
    if (applicabilityCondition) {
      const fallbackRows = (await db
        .select({
          ...selectFields,
          score: sql<number>`0`,
        })
        .from(knowledgeItems)
        .where(and(...conditions, applicabilityCondition))
        .orderBy(desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
        .limit(searchLimit)) as KnowledgeSearchRow[];
      const rowsById = new Map<string, KnowledgeSearchRow>();
      for (const row of rows) rowsById.set(row.id, row);
      for (const row of fallbackRows) rowsById.set(row.id, row);
      rows = [...rowsById.values()];
    }
  }

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(rows, sourceRefsByKnowledgeId, applicabilityQuery)
    .filter(
      (item) =>
        !facetRequested ||
        item.applicabilityScore > 0 ||
        (applicabilityQuery.includeGeneral && item.applicabilityMatches.general),
    )
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, input.limit);
}

export async function upsertKnowledgeFromSource(
  params: UpsertKnowledgeFromSourceParams,
): Promise<string> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { upsertKnowledgeFromSourceSqlite } = await import("./knowledge.repository.sqlite.js");
    return upsertKnowledgeFromSourceSqlite(params);
  }

  const existing = await db.query.knowledgeItems.findFirst({
    where: sql`${knowledgeItems.metadata} ->> 'sourceUri' = ${params.sourceUri}`,
  });

  const scoped = buildKnowledgeScopeMetadata(params.sourceUri, params.metadata, params.appliesTo);
  const metadata = scoped.metadata;
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: params.scope,
      projectRef:
        params.projectRef ??
        (typeof metadata.projectRef === "string" ? metadata.projectRef : undefined),
      repoKey:
        params.repoKey ??
        (typeof scoped.appliesTo.repoKey === "string" ? scoped.appliesTo.repoKey : undefined),
      repoPath:
        params.repoPath ??
        (typeof scoped.appliesTo.repoPath === "string" ? scoped.appliesTo.repoPath : undefined),
    },
    {
      producer: params.identityProducer ?? "knowledge.upsert-from-source",
      entityKind: "knowledge",
      actor: resolveKnowledgeActor(params.sourceUri),
    },
  );

  if (existing) {
    const now = new Date();
    await db
      .update(knowledgeItems)
      .set({
        type: params.type,
        status: params.status,
        scope: identity.scope,
        classificationStatus: identity.classificationStatus,
        projectRef: identity.projectRef,
        repoKey: identity.repoKey,
        repoPath: identity.repoPath,
        polarity: params.polarity ?? existing.polarity ?? "positive",
        intentTags: params.intentTags ?? existing.intentTags ?? [],
        title: params.title,
        body: params.body,
        confidence: normalizeKnowledgeScore(params.confidence, 70),
        importance: normalizeKnowledgeScore(params.importance, 70),
        appliesTo: scoped.appliesTo,
        metadata,
        embedding: params.embedding,
        updatedAt: now,
        lastVerifiedAt: now,
      })
      .where(eq(knowledgeItems.id, existing.id));
    const actor = resolveKnowledgeActor(params.sourceUri);
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeUpdated,
      actor,
      payload: {
        knowledgeId: existing.id,
        sourceUri: params.sourceUri,
        type: params.type,
        status: params.status,
        scope: params.scope,
        title: params.title,
        previousStatus: existing.status,
      },
    });
    if (existing.status !== params.status) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.knowledgeStatusChanged,
        actor,
        payload: {
          knowledgeId: existing.id,
          sourceUri: params.sourceUri,
          fromStatus: existing.status,
          toStatus: params.status,
        },
      });
    }
    await linkKnowledgeFromMetadata({
      knowledgeId: existing.id,
      metadata,
      confidence: params.confidence,
      linkMetadataSource: "upsertKnowledgeFromSource",
    });
    await recordProjectScopedWritePersisted(identity, {
      producer: params.identityProducer ?? "knowledge.upsert-from-source",
      entityKind: "knowledge",
      entityId: existing.id,
      actor,
    });
    return existing.id;
  }

  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: params.type,
      status: params.status,
      scope: identity.scope,
      classificationStatus: identity.classificationStatus,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: params.polarity ?? "positive",
      intentTags: params.intentTags ?? [],
      title: params.title,
      body: params.body,
      confidence: normalizeKnowledgeScore(params.confidence, 70),
      importance: normalizeKnowledgeScore(params.importance, 70),
      appliesTo: scoped.appliesTo,
      metadata,
      embedding: params.embedding,
      lastVerifiedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeCreated,
    actor: resolveKnowledgeActor(params.sourceUri),
    payload: {
      knowledgeId: inserted.id,
      sourceUri: params.sourceUri,
      type: params.type,
      status: params.status,
      scope: params.scope,
      title: params.title,
    },
  });
  await linkKnowledgeFromMetadata({
    knowledgeId: inserted.id,
    metadata,
    confidence: params.confidence,
    linkMetadataSource: "upsertKnowledgeFromSource",
  });
  await recordProjectScopedWritePersisted(identity, {
    producer: params.identityProducer ?? "knowledge.upsert-from-source",
    entityKind: "knowledge",
    entityId: inserted.id,
    actor: resolveKnowledgeActor(params.sourceUri),
  });

  return inserted.id;
}

export async function vectorSearchKnowledge(
  embedding: number[],
  limit: number,
  statuses: KnowledgeStatus[] = ["active"],
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { vectorSearchKnowledgeSqlite } = await import("./knowledge.repository.sqlite.js");
    return vectorSearchKnowledgeSqlite(embedding, limit, statuses, options);
  }

  const applicabilityQuery = buildApplicabilityQuery(
    {
      includeGeneral: options.includeGeneral ?? true,
    },
    options,
  );
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const searchLimit = limit;
  const embeddingStr = JSON.stringify(embedding);
  const importanceOrderExpr = normalizedImportanceExpr();
  const similarity = sql<number>`1 - (${knowledgeItems.embedding} <=> ${embeddingStr}::vector)`;
  const conditions: SQL[] = [
    inArray(knowledgeItems.status, statuses),
    sql`${knowledgeItems.embedding} IS NOT NULL`,
  ];
  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  }
  const repoScopedCondition = buildRepoScopedCondition(options);
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
  }

  if (options.polarities && options.polarities.length > 0) {
    conditions.push(inArray(knowledgeItems.polarity, options.polarities));
  }
  if (options.intentTags && options.intentTags.length > 0) {
    conditions.push(
      sql`coalesce(${knowledgeItems.intentTags}, '[]'::jsonb) ?| array[${sql.join(
        options.intentTags.map((t) => sql`${t}`),
        sql`,`,
      )}]`,
    );
  }
  if (facetRequested) {
    const applicabilityCondition = buildApplicabilityFilterCondition(applicabilityQuery);
    if (applicabilityCondition) conditions.push(applicabilityCondition);
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      classificationStatus: knowledgeItems.classificationStatus,
      projectRef: knowledgeItems.projectRef,
      repoKey: knowledgeItems.repoKey,
      repoPath: knowledgeItems.repoPath,
      polarity: knowledgeItems.polarity,
      intentTags: knowledgeItems.intentTags,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
      updatedAt: knowledgeItems.updatedAt,
      score: similarity,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(importanceOrderExpr))
    .limit(searchLimit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(
    rows as KnowledgeSearchRow[],
    sourceRefsByKnowledgeId,
    applicabilityQuery,
  )
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}
