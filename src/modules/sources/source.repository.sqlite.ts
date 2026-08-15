import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { SqliteCoreRepository } from "../../db/sqlite/core-repository.js";
import { sqliteSourceFragments, sqliteSources } from "../../db/sqlite/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import { resolveCompileProjectIdentity } from "../context-compiler/compile-project-identity.js";
import { normalizeRepoPath } from "../context-compiler/query-context.js";
import { embedOne } from "../embedding/embedding.service.js";
import type {
  SourceKind,
  SourceSearchOptions,
  SourceSearchResult,
  UpsertSourceParams,
} from "./source.repository.js";

type SourceRow = typeof sqliteSources.$inferSelect;

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  const chunks: Array<{ locator: string; heading: string | null; content: string }> = [];
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
    if (buffer.join("\n").length >= maxChars) flush();
  }
  flush();

  if (chunks.length === 0) {
    const content = params.body.trim();
    return content ? [{ locator: "full", heading: params.title ?? null, content }] : [];
  }
  return chunks;
}

function matchesSourceKind(row: SourceRow, sourceKinds?: SourceKind[]): boolean {
  return (
    !sourceKinds || sourceKinds.length === 0 || sourceKinds.includes(row.sourceKind as SourceKind)
  );
}

function matchesRepoScope(row: SourceRow, options?: SourceSearchOptions): boolean {
  const identity =
    options?.projectIdentity ??
    resolveCompileProjectIdentity({
      projectRef: options?.projectRef,
      repoKey: options?.repoKey,
      repoPath: options?.repoPath,
    });
  if (row.classificationStatus !== "classified") return false;
  if (row.scope === "global") return !row.projectRef && !row.repoKey && !row.repoPath;
  if (row.scope !== "repo" || identity.matchValue === null) return false;
  if (identity.matchBasis === "project_ref") return row.projectRef === identity.matchValue;
  if (identity.matchBasis === "repo_key") return row.repoKey === identity.matchValue;
  if (identity.matchBasis === "repo_path") return row.repoPath === identity.matchValue;
  return false;
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,，、。;；:：()（）[\]{}「」『』/|]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 16);
}

function scoreText(text: string, query: string): number {
  const lower = text.toLowerCase();
  const normalized = query.toLowerCase();
  let score = lower.includes(normalized) ? 4 : 0;
  for (const token of tokenize(query)) {
    if (lower.includes(token)) score += 1;
  }
  return score;
}

export async function upsertSourceDocumentSqlite(params: UpsertSourceParams): Promise<string> {
  const sqlite = await getSqliteCoreDatabase();
  const repo = new SqliteCoreRepository(sqlite);
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
      actor: params.actor,
    },
  );
  const existing = sqlite.orm
    .select({ id: sqliteSources.id })
    .from(sqliteSources)
    .where(eq(sqliteSources.uri, redactedUri))
    .get();
  const sourceId = existing?.id ?? randomUUID();
  repo.upsertSource({
    id: sourceId,
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
    updatedAt: nowIso(),
  });

  sqlite.orm
    .delete(sqliteSourceFragments)
    .where(eq(sqliteSourceFragments.sourceId, sourceId))
    .run();
  for (const chunk of chunkSourceDocument({ title: redactedTitle, body: redactedBody })) {
    repo.upsertSourceFragment({
      id: randomUUID(),
      sourceId,
      locator: chunk.locator,
      heading: chunk.heading,
      content: chunk.content,
      metadata: redactedMetadata,
      embedding: await tryEmbedSourceFragment(chunk.content),
    });
  }
  await recordProjectScopedWritePersisted(identity, {
    producer: params.identityProducer ?? "source.upsert-document",
    entityKind: "source",
    entityId: sourceId,
    actor: params.actor,
  });
  return sourceId;
}

export async function deleteStaleSourcesForRootSqlite(params: {
  rootPath: string;
  keepUris: string[];
}): Promise<number> {
  const sqlite = await getSqliteCoreDatabase();
  const normalizedRootPath = normalizeRepoPath(params.rootPath) ?? params.rootPath;
  const keepSet = new Set([
    ...params.keepUris.map((uri) => uri.trim()).filter(Boolean),
    ...params.keepUris
      .map((uri) => uri.trim())
      .filter(Boolean)
      .map((uri) => `file://${uri.startsWith("/") ? "" : "/"}${uri}`),
  ]);
  const rows = sqlite.orm.select().from(sqliteSources).all();
  let deleted = 0;
  for (const row of rows) {
    if (keepSet.has(row.uri)) continue;
    if (String(asRecord(row.metadata).sourceRootPath ?? "") !== normalizedRootPath) continue;
    sqlite.orm.delete(sqliteSources).where(eq(sqliteSources.id, row.id)).run();
    deleted += 1;
  }
  return deleted;
}

export async function searchSourceContentSqlite(
  query: string,
  limit: number,
  sourceKinds?: SourceKind[],
  options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const sqlite = await getSqliteCoreDatabase();
  const rows = sqlite.orm
    .select({
      fragment: sqliteSourceFragments,
      source: sqliteSources,
    })
    .from(sqliteSourceFragments)
    .innerJoin(sqliteSources, eq(sqliteSources.id, sqliteSourceFragments.sourceId))
    .where(
      sourceKinds && sourceKinds.length > 0
        ? and(inArray(sqliteSources.sourceKind, sourceKinds))
        : undefined,
    )
    .orderBy(desc(sqliteSourceFragments.createdAt))
    .all();

  const fragmentHits = rows
    .filter((row) => matchesSourceKind(row.source, sourceKinds))
    .filter((row) => matchesRepoScope(row.source, options))
    .map((row) => ({
      id: row.fragment.id,
      sourceId: row.source.id,
      sourceUri: row.source.uri,
      locator: row.fragment.locator,
      heading: row.fragment.heading,
      content: row.fragment.content,
      score: scoreText(
        `${row.fragment.heading ?? ""}\n${row.fragment.content}\n${JSON.stringify(row.fragment.metadata)}`,
        trimmedQuery,
      ),
    }))
    .filter((row) => row.score > 0);

  const sourceHits = sqlite.orm
    .select()
    .from(sqliteSources)
    .all()
    .filter((row) => matchesSourceKind(row, sourceKinds))
    .filter((row) => matchesRepoScope(row, options))
    .map((row) => ({
      id: `source:${row.id}:full`,
      sourceId: row.id,
      sourceUri: row.uri,
      locator: "full",
      heading: row.title,
      content: row.body,
      score: scoreText(
        `${row.title ?? ""}\n${row.uri}\n${row.body}\n${JSON.stringify(row.metadata)}`,
        trimmedQuery,
      ),
    }))
    .filter((row) => row.score > 0);

  const byKey = new Map<string, SourceSearchResult>();
  for (const row of [...fragmentHits, ...sourceHits]) {
    const key = `${row.sourceId}:${row.locator}`;
    const current = byKey.get(key);
    if (!current || row.score > current.score) byKey.set(key, row);
  }
  return [...byKey.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.trunc(limit)));
}

export async function vectorSearchSourceContentSqlite(
  _embedding: number[],
  _limit: number,
  _sourceKinds?: SourceKind[],
  _options?: SourceSearchOptions,
): Promise<SourceSearchResult[]> {
  // sqlite-vec cannot apply source scope predicates before top-K selection.
  return [];
}
