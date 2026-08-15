import { type SQL, and, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { sourceFragments, sources } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  assertAuditedStoredProjectScopedIdentityCompatible,
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import {
  type ResolvedCompileProjectIdentity,
  resolveCompileProjectIdentity,
} from "../context-compiler/compile-project-identity.js";
import { normalizeRepoPath } from "../context-compiler/query-context.js";
import { embedOne } from "../embedding/embedding.service.js";

export type SourceKind = "wiki";

export type UpsertSourceParams = {
  sourceKind: SourceKind;
  scope: "repo" | "global";
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  uri: string;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  actor?: "agent" | "user" | "system";
  identityProducer?: string;
};

export type SourceSearchResult = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  heading: string | null;
  content: string;
  score: number;
};

export type SourceSearchOptions = {
  projectIdentity?: ResolvedCompileProjectIdentity;
  projectRef?: string;
  repoPath?: string;
  repoKey?: string;
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function buildSourceRepoScopedCondition(options?: SourceSearchOptions): SQL {
  const identity =
    options?.projectIdentity ??
    resolveCompileProjectIdentity({
      projectRef: options?.projectRef,
      repoKey: options?.repoKey,
      repoPath: options?.repoPath,
    });
  const global = and(
    eq(sources.scope, "global"),
    isNull(sources.projectRef),
    isNull(sources.repoKey),
    isNull(sources.repoPath),
  ) as SQL;
  const matchValue = identity.matchValue;
  const repo =
    matchValue === null
      ? undefined
      : identity.matchBasis === "project_ref"
        ? and(eq(sources.scope, "repo"), eq(sources.projectRef, matchValue))
        : identity.matchBasis === "repo_key"
          ? and(eq(sources.scope, "repo"), eq(sources.repoKey, matchValue))
          : identity.matchBasis === "repo_path"
            ? and(eq(sources.scope, "repo"), eq(sources.repoPath, matchValue))
            : undefined;
  return and(
    eq(sources.classificationStatus, "classified"),
    repo ? or(global, repo) : global,
  ) as SQL;
}

async function tryEmbedSourceFragment(content: string): Promise<number[] | undefined> {
  try {
    return await embedOne(content, "passage");
  } catch {
    return undefined;
  }
}

function chunkSourceDocument(params: {
  title?: string | null;
  body: string;
  maxChars?: number;
}): Array<{ locator: string; heading: string | null; content: string }> {
  const maxChars = params.maxChars ?? 2500;
  const lines = params.body.split("\n");
  const chunks: Array<{
    locator: string;
    heading: string | null;
    content: string;
  }> = [];
  let heading = params.title ?? null;
  let buffer: string[] = [];
  let index = 1;

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    chunks.push({
      locator: `chunk:${String(index).padStart(4, "0")}`,
      heading,
      content,
    });
    index += 1;
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch && buffer.join("\n").trim().length > 0) {
      flush();
      heading = headingMatch[2]?.trim() || heading;
    }
    buffer.push(line);
    if (buffer.join("\n").length >= maxChars) {
      flush();
    }
  }
  flush();

  if (chunks.length === 0) {
    const content = params.body.trim();
    return content ? [{ locator: "full", heading: params.title ?? null, content }] : [];
  }
  return chunks;
}

async function replaceSourceFragments(params: {
  sourceId: string;
  title?: string | null;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  await db.delete(sourceFragments).where(eq(sourceFragments.sourceId, params.sourceId));

  const chunks = chunkSourceDocument({
    title: params.title,
    body: params.body,
  });
  if (chunks.length === 0) return 0;

  await db.insert(sourceFragments).values(
    await Promise.all(
      chunks.map(async (chunk) => ({
        sourceId: params.sourceId,
        locator: chunk.locator,
        heading: chunk.heading,
        content: chunk.content,
        metadata: params.metadata ?? {},
        embedding: await tryEmbedSourceFragment(chunk.content),
      })),
    ),
  );
  return chunks.length;
}

export async function upsertSourceDocument(params: UpsertSourceParams): Promise<string> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { upsertSourceDocumentSqlite } = await import("./source.repository.sqlite.js");
    return upsertSourceDocumentSqlite(params);
  }

  const actor = params.actor ?? "system";
  const redactedUri = redactSecrets(params.uri);
  const redactedTitle = params.title ? redactSecrets(params.title) : params.title;
  const redactedBody = redactSecrets(params.body);
  const redactedMetadata = redactSecretRecord(params.metadata ?? {});
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: params.scope,
      projectRef:
        params.projectRef ??
        (typeof redactedMetadata.projectRef === "string" ? redactedMetadata.projectRef : undefined),
      repoKey:
        params.repoKey ??
        (typeof redactedMetadata.repoKey === "string" ? redactedMetadata.repoKey : undefined),
      repoPath:
        params.repoPath ??
        (typeof redactedMetadata.repoPath === "string" ? redactedMetadata.repoPath : undefined),
    },
    {
      producer: params.identityProducer ?? "source.upsert-document",
      entityKind: "source",
      actor,
    },
  );
  const existing = await db.query.sources.findFirst({
    where: eq(sources.uri, redactedUri),
    columns: {
      id: true,
      classificationStatus: true,
      scope: true,
      projectRef: true,
      repoKey: true,
      repoPath: true,
    },
  });
  if (existing) {
    await assertAuditedStoredProjectScopedIdentityCompatible(
      existing,
      identity,
      `source URI ${redactedUri}`,
      {
        producer: params.identityProducer ?? "source.upsert-document",
        entityKind: "source",
        actor: params.actor,
      },
    );
  }

  if (existing) {
    await db
      .update(sources)
      .set({
        sourceKind: params.sourceKind,
        classificationStatus: identity.classificationStatus,
        scope: identity.scope,
        projectRef: identity.projectRef,
        repoKey: identity.repoKey,
        repoPath: identity.repoPath,
        uri: redactedUri,
        title: redactedTitle ?? null,
        body: redactedBody,
        metadata: redactedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, existing.id));
    const fragmentCount = await replaceSourceFragments({
      sourceId: existing.id,
      title: redactedTitle,
      body: redactedBody,
      metadata: redactedMetadata,
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.sourceUpdated,
      actor,
      payload: {
        sourceId: existing.id,
        sourceKind: params.sourceKind,
        uri: redactedUri,
        title: redactedTitle ?? null,
        fragmentCount,
      },
    });
    await recordProjectScopedWritePersisted(identity, {
      producer: params.identityProducer ?? "source.upsert-document",
      entityKind: "source",
      entityId: existing.id,
      actor,
    });
    return existing.id;
  }

  const [inserted] = await db
    .insert(sources)
    .values({
      sourceKind: params.sourceKind,
      classificationStatus: identity.classificationStatus,
      scope: identity.scope,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      uri: redactedUri,
      title: redactedTitle ?? null,
      body: redactedBody,
      metadata: redactedMetadata,
    })
    .returning({ id: sources.id });
  const fragmentCount = await replaceSourceFragments({
    sourceId: inserted.id,
    title: redactedTitle,
    body: redactedBody,
    metadata: redactedMetadata,
  });
  await recordAuditLogSafe({
    eventType: auditEventTypes.sourceImported,
    actor,
    payload: {
      sourceId: inserted.id,
      sourceKind: params.sourceKind,
      uri: redactedUri,
      title: redactedTitle ?? null,
      fragmentCount,
    },
  });
  await recordProjectScopedWritePersisted(identity, {
    producer: params.identityProducer ?? "source.upsert-document",
    entityKind: "source",
    entityId: inserted.id,
    actor,
  });
  return inserted.id;
}

export async function deleteStaleSourcesForRoot(params: {
  rootPath: string;
  keepUris: string[];
}): Promise<number> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { deleteStaleSourcesForRootSqlite } = await import("./source.repository.sqlite.js");
    return deleteStaleSourcesForRootSqlite(params);
  }

  const normalizedRootPath = normalizeRepoPath(params.rootPath) ?? params.rootPath;
  const normalizedKeepUris = [...new Set(params.keepUris.map((uri) => uri.trim()).filter(Boolean))];
  const fileUriKeepUris = normalizedKeepUris.map(
    (uri) => `file://${uri.startsWith("/") ? "" : "/"}${uri}`,
  );
  const keepSet = [...new Set([...normalizedKeepUris, ...fileUriKeepUris])];

  const conditions: SQL[] = [sql`${sources.metadata} ->> 'sourceRootPath' = ${normalizedRootPath}`];
  if (keepSet.length > 0) {
    conditions.push(notInArray(sources.uri, keepSet));
  }
  const deleted = await db
    .delete(sources)
    .where(and(...conditions))
    .returning({ id: sources.id });
  if (deleted.length > 0) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.sourceDeleted,
      actor: "system",
      payload: {
        rootPath: normalizedRootPath,
        deletedSourceIds: deleted.map((row) => row.id),
        deletedCount: deleted.length,
      },
    });
  }
  return deleted.length;
}

export async function vectorSearchSourceContent(
  embedding: number[],
  limit: number,
  sourceKinds?: SourceKind[],
  options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { vectorSearchSourceContentSqlite } = await import("./source.repository.sqlite.js");
    return vectorSearchSourceContentSqlite(embedding, limit, sourceKinds, options);
  }

  const embeddingStr = JSON.stringify(embedding);
  const similarity = sql<number>`1 - (${sourceFragments.embedding} <=> ${embeddingStr}::vector)`;
  const conditions: SQL[] = [sql`${sourceFragments.embedding} IS NOT NULL`];
  if (sourceKinds && sourceKinds.length > 0) {
    conditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  const repoScopedCondition = buildSourceRepoScopedCondition(options);
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
  }

  const rows = await db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      score: similarity,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(sourceFragments.createdAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, score: finiteOrZero(row.score) }));
}

export async function searchSourceContent(
  query: string,
  limit: number,
  sourceKinds?: SourceKind[],
  options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { searchSourceContentSqlite } = await import("./source.repository.sqlite.js");
    return searchSourceContentSqlite(query, limit, sourceKinds, options);
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const fragmentRankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text)),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const fragmentTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sourceFragments.heading}, ${sourceFragments.content}, ${sourceFragments.metadata}::text))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const fragmentConditions = [
    or(
      ilike(sourceFragments.content, `%${trimmedQuery}%`),
      ilike(sourceFragments.heading, `%${trimmedQuery}%`),
      sql`${sourceFragments.metadata}::text ilike ${`%${trimmedQuery}%`}`,
      fragmentTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    fragmentConditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  const repoScopedCondition = buildSourceRepoScopedCondition(options);
  fragmentConditions.push(repoScopedCondition);

  const fragmentRows = await db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      score: fragmentRankExpr,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(and(...fragmentConditions))
    .orderBy(desc(fragmentRankExpr), desc(sourceFragments.createdAt))
    .limit(limit);

  const sourceRankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body}, ${sources.metadata}::text)),
      plainto_tsquery('simple', ${trimmedQuery})
    )
  `;
  const sourceTextMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${sources.title}, ${sources.uri}, ${sources.body}, ${sources.metadata}::text))
    @@ plainto_tsquery('simple', ${trimmedQuery})
  `;
  const sourceConditions = [
    or(
      ilike(sources.title, `%${trimmedQuery}%`),
      ilike(sources.uri, `%${trimmedQuery}%`),
      ilike(sources.body, `%${trimmedQuery}%`),
      sql`${sources.metadata}::text ilike ${`%${trimmedQuery}%`}`,
      sourceTextMatchExpr,
    ),
  ];
  if (sourceKinds && sourceKinds.length > 0) {
    sourceConditions.push(inArray(sources.sourceKind, sourceKinds));
  }
  sourceConditions.push(repoScopedCondition);

  const sourceRows = await db
    .select({
      id: sources.id,
      sourceUri: sources.uri,
      title: sources.title,
      body: sources.body,
      score: sourceRankExpr,
    })
    .from(sources)
    .where(and(...sourceConditions))
    .orderBy(desc(sourceRankExpr), desc(sources.updatedAt))
    .limit(limit);

  const rows = [
    ...fragmentRows.map((row) => ({
      ...row,
      score: finiteOrZero(row.score),
    })),
    ...sourceRows.map((row) => ({
      id: `source:${row.id}:full`,
      sourceId: row.id,
      sourceUri: row.sourceUri,
      locator: "full",
      heading: row.title,
      content: row.body,
      score: finiteOrZero(row.score),
    })),
  ];

  const byKey = new Map<string, SourceSearchResult>();
  for (const row of rows) {
    const key = `${row.sourceId}:${row.locator}`;
    const current = byKey.get(key);
    if (!current || row.score > current.score) {
      byKey.set(key, row);
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
