import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SqliteCoreDatabase } from "./client.js";
import {
  sqliteCoreVectorMetadata,
  sqliteKnowledgeItems,
  sqliteKnowledgeItemsVecFallback,
  sqliteKnowledgeItemsVecMap,
  sqliteSourceFragments,
  sqliteSourceFragmentsVecFallback,
  sqliteSourceFragmentsVecMap,
  sqliteSources,
} from "./schema.js";

export type SqliteKnowledgeItemInput = {
  id: string;
  type: string;
  status: string;
  scope?: string;
  classificationStatus?: string;
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  polarity?: string;
  intentTags?: unknown[];
  title: string;
  body: string;
  appliesTo?: unknown;
  confidence?: number;
  importance?: number;
  metadata?: unknown;
  embedding?: number[] | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SqliteSourceInput = {
  id: string;
  sourceKind: string;
  classificationStatus?: string;
  scope?: string;
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  uri: string;
  title?: string | null;
  body: string;
  metadata?: unknown;
  createdAt?: string;
  updatedAt?: string;
  lastIndexedAt?: string | null;
};

export type SqliteSourceFragmentInput = {
  id: string;
  sourceId: string;
  locator: string;
  heading?: string | null;
  content: string;
  metadata?: unknown;
  embedding?: number[] | null;
  createdAt?: string;
};

export type SqliteKnowledgeVectorHit = {
  id: string;
  title: string;
  body: string;
  score: number;
};

export type SqliteSourceVectorHit = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  heading: string | null;
  content: string;
  score: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function contentHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function normalizeVector(vector: number[] | null | undefined): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values = vector.map((entry) => Number(entry));
  return values.every(Number.isFinite) ? values : null;
}

function vectorJson(vector: number[]): string {
  return JSON.stringify(vector);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

export class SqliteCoreRepository {
  constructor(private readonly database: SqliteCoreDatabase) {}

  upsertKnowledgeItem(input: SqliteKnowledgeItemInput): void {
    const updatedAt = input.updatedAt ?? nowIso();
    const values = {
      id: input.id,
      type: input.type,
      status: input.status,
      scope: input.scope ?? "repo",
      classificationStatus: input.classificationStatus ?? "unresolved",
      projectRef: input.projectRef ?? null,
      repoKey: input.repoKey ?? null,
      repoPath: input.repoPath ?? null,
      polarity: input.polarity ?? "positive",
      intentTags: Array.isArray(input.intentTags) ? input.intentTags : [],
      title: input.title,
      body: input.body,
      appliesTo: input.appliesTo ?? {},
      confidence: input.confidence ?? 70,
      importance: input.importance ?? 70,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? updatedAt,
      updatedAt,
    };
    this.database.orm
      .insert(sqliteKnowledgeItems)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteKnowledgeItems.id,
        set: {
          type: values.type,
          status: values.status,
          scope: values.scope,
          classificationStatus: values.classificationStatus,
          projectRef: values.projectRef,
          repoKey: values.repoKey,
          repoPath: values.repoPath,
          polarity: values.polarity,
          intentTags: values.intentTags,
          title: values.title,
          body: values.body,
          appliesTo: values.appliesTo,
          confidence: values.confidence,
          importance: values.importance,
          metadata: values.metadata,
          updatedAt: values.updatedAt,
        },
      })
      .run();

    this.refreshKnowledgeItemFts(input.id);

    const vector = normalizeVector(input.embedding);
    if (vector) this.upsertKnowledgeVector(input.id, vector, contentHash(input.title, input.body));
  }

  upsertSource(input: SqliteSourceInput): void {
    const updatedAt = input.updatedAt ?? nowIso();
    const values = {
      id: input.id,
      sourceKind: input.sourceKind,
      classificationStatus: input.classificationStatus ?? "unresolved",
      scope: input.scope ?? "repo",
      projectRef: input.projectRef ?? null,
      repoKey: input.repoKey ?? null,
      repoPath: input.repoPath ?? null,
      uri: input.uri,
      title: input.title ?? null,
      body: input.body,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? updatedAt,
      updatedAt,
      lastIndexedAt: input.lastIndexedAt ?? null,
    };
    this.database.orm
      .insert(sqliteSources)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteSources.id,
        set: {
          sourceKind: values.sourceKind,
          classificationStatus: values.classificationStatus,
          scope: values.scope,
          projectRef: values.projectRef,
          repoKey: values.repoKey,
          repoPath: values.repoPath,
          uri: values.uri,
          title: values.title,
          body: values.body,
          metadata: values.metadata,
          updatedAt: values.updatedAt,
          lastIndexedAt: values.lastIndexedAt,
        },
      })
      .run();
    this.refreshSourceFts(input.id);
  }

  upsertSourceFragment(input: SqliteSourceFragmentInput): void {
    const createdAt = input.createdAt ?? nowIso();
    const values = {
      id: input.id,
      sourceId: input.sourceId,
      locator: input.locator,
      heading: input.heading ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt,
    };
    this.database.orm
      .insert(sqliteSourceFragments)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteSourceFragments.id,
        set: {
          sourceId: values.sourceId,
          locator: values.locator,
          heading: values.heading,
          content: values.content,
          metadata: values.metadata,
        },
      })
      .run();
    this.refreshSourceFragmentFts(input.id);

    const vector = normalizeVector(input.embedding);
    if (vector) this.upsertSourceFragmentVector(input.id, vector, contentHash(input.content));
  }

  rebuildKnowledgeVectors(
    rows: Array<{ id: string; title: string; body: string; embedding: number[] | null }>,
  ): number {
    let count = 0;
    let dimension = 0;
    const tx = this.database.db.query("BEGIN IMMEDIATE;");
    tx.run();
    try {
      this.database.orm.delete(sqliteKnowledgeItemsVecFallback).run();
      if (this.database.vector.available) {
        this.database.db.query("DELETE FROM knowledge_items_vec;").run();
        this.database.orm.delete(sqliteKnowledgeItemsVecMap).run();
      }
      for (const row of rows) {
        const vector = normalizeVector(row.embedding);
        if (!vector) continue;
        dimension ||= vector.length;
        this.upsertKnowledgeVector(row.id, vector, contentHash(row.title, row.body));
        count += 1;
      }
      this.updateVectorMetadata("knowledge_items", count, dimension);
      this.database.db.query("COMMIT;").run();
      return count;
    } catch (error) {
      this.database.db.query("ROLLBACK;").run();
      throw error;
    }
  }

  rebuildSourceFragmentVectors(
    rows: Array<{ id: string; content: string; embedding: number[] | null }>,
  ): number {
    let count = 0;
    let dimension = 0;
    this.database.db.query("BEGIN IMMEDIATE;").run();
    try {
      this.database.orm.delete(sqliteSourceFragmentsVecFallback).run();
      if (this.database.vector.available) {
        this.database.db.query("DELETE FROM source_fragments_vec;").run();
        this.database.orm.delete(sqliteSourceFragmentsVecMap).run();
      }
      for (const row of rows) {
        const vector = normalizeVector(row.embedding);
        if (!vector) continue;
        dimension ||= vector.length;
        this.upsertSourceFragmentVector(row.id, vector, contentHash(row.content));
        count += 1;
      }
      this.updateVectorMetadata("source_fragments", count, dimension);
      this.database.db.query("COMMIT;").run();
      return count;
    } catch (error) {
      this.database.db.query("ROLLBACK;").run();
      throw error;
    }
  }

  vectorSearchKnowledge(embedding: number[], limit: number): SqliteKnowledgeVectorHit[] {
    const queryVector = normalizeVector(embedding);
    if (!queryVector) return [];
    if (this.database.vector.available) {
      const hits = this.vectorSearchKnowledgeWithSqliteVec(queryVector, limit);
      if (hits.length > 0) return hits;
    }
    const rows = this.database.db
      .query<{
        knowledge_id: string;
        embedding_json: string;
        title: string;
        body: string;
      }>(`
SELECT v.knowledge_id, v.embedding_json, k.title, k.body
FROM knowledge_items_vec_fallback v
JOIN knowledge_items k ON k.id = v.knowledge_id
WHERE k.status = 'active';
`)
      .all();

    return rows
      .map((row) => ({
        id: row.knowledge_id,
        title: row.title,
        body: row.body,
        score: cosineSimilarity(JSON.parse(row.embedding_json) as number[], queryVector),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.trunc(limit)));
  }

  vectorSearchSourceFragments(embedding: number[], limit: number): SqliteSourceVectorHit[] {
    const queryVector = normalizeVector(embedding);
    if (!queryVector) return [];
    if (this.database.vector.available) {
      const hits = this.vectorSearchSourceFragmentsWithSqliteVec(queryVector, limit);
      if (hits.length > 0) return hits;
    }
    const rows = this.database.db
      .query<{
        source_fragment_id: string;
        embedding_json: string;
        source_id: string;
        source_uri: string;
        locator: string;
        heading: string | null;
        content: string;
      }>(`
SELECT
  v.source_fragment_id,
  v.embedding_json,
  f.source_id,
  s.uri AS source_uri,
  f.locator,
  f.heading,
  f.content
FROM source_fragments_vec_fallback v
JOIN source_fragments f ON f.id = v.source_fragment_id
JOIN sources s ON s.id = f.source_id;
`)
      .all();

    return rows
      .map((row) => ({
        id: row.source_fragment_id,
        sourceId: row.source_id,
        sourceUri: row.source_uri,
        locator: row.locator,
        heading: row.heading,
        content: row.content,
        score: cosineSimilarity(JSON.parse(row.embedding_json) as number[], queryVector),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.trunc(limit)));
  }

  close(): void {
    this.database.db.close();
  }

  private upsertKnowledgeVector(knowledgeId: string, embedding: number[], hash: string): void {
    const values = {
      knowledgeId,
      embeddingJson: JSON.stringify(embedding),
      embeddingDimension: embedding.length,
      contentHash: hash,
      updatedAt: nowIso(),
    };
    this.database.orm
      .insert(sqliteKnowledgeItemsVecFallback)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteKnowledgeItemsVecFallback.knowledgeId,
        set: {
          embeddingJson: values.embeddingJson,
          embeddingDimension: values.embeddingDimension,
          contentHash: values.contentHash,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    if (this.database.vector.available) {
      this.upsertKnowledgeVectorIndex(knowledgeId, embedding);
    }
  }

  private upsertSourceFragmentVector(
    sourceFragmentId: string,
    embedding: number[],
    hash: string,
  ): void {
    const values = {
      sourceFragmentId,
      embeddingJson: JSON.stringify(embedding),
      embeddingDimension: embedding.length,
      contentHash: hash,
      updatedAt: nowIso(),
    };
    this.database.orm
      .insert(sqliteSourceFragmentsVecFallback)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteSourceFragmentsVecFallback.sourceFragmentId,
        set: {
          embeddingJson: values.embeddingJson,
          embeddingDimension: values.embeddingDimension,
          contentHash: values.contentHash,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    if (this.database.vector.available) {
      this.upsertSourceFragmentVectorIndex(sourceFragmentId, embedding);
    }
  }

  private upsertKnowledgeVectorIndex(knowledgeId: string, embedding: number[]): void {
    this.database.orm
      .insert(sqliteKnowledgeItemsVecMap)
      .values({ knowledgeId })
      .onConflictDoNothing({ target: sqliteKnowledgeItemsVecMap.knowledgeId })
      .run();
    const row = this.database.orm
      .select({ vecRowid: sqliteKnowledgeItemsVecMap.vecRowid })
      .from(sqliteKnowledgeItemsVecMap)
      .where(eq(sqliteKnowledgeItemsVecMap.knowledgeId, knowledgeId))
      .get();
    if (!row) return;
    this.database.db.query("DELETE FROM knowledge_items_vec WHERE rowid = ?;").run(row.vecRowid);
    this.database.db
      .query("INSERT INTO knowledge_items_vec(rowid, embedding) VALUES (?, ?);")
      .run(row.vecRowid, vectorJson(embedding));
  }

  private upsertSourceFragmentVectorIndex(sourceFragmentId: string, embedding: number[]): void {
    this.database.orm
      .insert(sqliteSourceFragmentsVecMap)
      .values({ sourceFragmentId })
      .onConflictDoNothing({ target: sqliteSourceFragmentsVecMap.sourceFragmentId })
      .run();
    const row = this.database.orm
      .select({ vecRowid: sqliteSourceFragmentsVecMap.vecRowid })
      .from(sqliteSourceFragmentsVecMap)
      .where(eq(sqliteSourceFragmentsVecMap.sourceFragmentId, sourceFragmentId))
      .get();
    if (!row) return;
    this.database.db.query("DELETE FROM source_fragments_vec WHERE rowid = ?;").run(row.vecRowid);
    this.database.db
      .query("INSERT INTO source_fragments_vec(rowid, embedding) VALUES (?, ?);")
      .run(row.vecRowid, vectorJson(embedding));
  }

  private vectorSearchKnowledgeWithSqliteVec(
    embedding: number[],
    limit: number,
  ): SqliteKnowledgeVectorHit[] {
    try {
      const rows = this.database.db
        .query<
          {
            id: string;
            title: string;
            body: string;
            distance: number;
          },
          [string, number]
        >(`
SELECT ki.id, ki.title, ki.body, v.distance
FROM knowledge_items_vec v
JOIN knowledge_items_vec_map m ON m.vec_rowid = v.rowid
JOIN knowledge_items ki ON ki.id = m.knowledge_id
WHERE v.embedding MATCH ?
  AND v.k = ?
  AND ki.status = 'active'
ORDER BY v.distance;
`)
        .all(vectorJson(embedding), Math.max(1, Math.trunc(limit)));
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        score: 1 / (1 + row.distance),
      }));
    } catch {
      return [];
    }
  }

  private vectorSearchSourceFragmentsWithSqliteVec(
    embedding: number[],
    limit: number,
  ): SqliteSourceVectorHit[] {
    try {
      const rows = this.database.db
        .query<
          {
            id: string;
            source_id: string;
            source_uri: string;
            locator: string;
            heading: string | null;
            content: string;
            distance: number;
          },
          [string, number]
        >(`
SELECT
  f.id,
  f.source_id,
  s.uri AS source_uri,
  f.locator,
  f.heading,
  f.content,
  v.distance
FROM source_fragments_vec v
JOIN source_fragments_vec_map m ON m.vec_rowid = v.rowid
JOIN source_fragments f ON f.id = m.source_fragment_id
JOIN sources s ON s.id = f.source_id
WHERE v.embedding MATCH ?
  AND v.k = ?
ORDER BY v.distance;
`)
        .all(vectorJson(embedding), Math.max(1, Math.trunc(limit)));
      return rows.map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        sourceUri: row.source_uri,
        locator: row.locator,
        heading: row.heading,
        content: row.content,
        score: 1 / (1 + row.distance),
      }));
    } catch {
      return [];
    }
  }

  private refreshKnowledgeItemFts(id: string): void {
    this.database.db.query("DELETE FROM knowledge_items_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO knowledge_items_fts(id, title, body) SELECT id, title, body FROM knowledge_items WHERE id = ?;",
      )
      .run(id);
  }

  private refreshSourceFts(id: string): void {
    this.database.db.query("DELETE FROM sources_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO sources_fts(id, title, uri, body) SELECT id, title, uri, body FROM sources WHERE id = ?;",
      )
      .run(id);
  }

  private refreshSourceFragmentFts(id: string): void {
    this.database.db.query("DELETE FROM source_fragments_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO source_fragments_fts(id, heading, content) SELECT id, heading, content FROM source_fragments WHERE id = ?;",
      )
      .run(id);
  }

  private updateVectorMetadata(name: string, rowCount: number, dimension: number): void {
    const values = {
      name,
      dimension,
      rebuiltAt: nowIso(),
      rowCount,
      usesSqliteVec: this.database.vector.available,
    };
    this.database.orm
      .insert(sqliteCoreVectorMetadata)
      .values(values)
      .onConflictDoUpdate({
        target: sqliteCoreVectorMetadata.name,
        set: {
          dimension: values.dimension,
          rebuiltAt: values.rebuiltAt,
          rowCount: values.rowCount,
          usesSqliteVec: values.usesSqliteVec,
        },
      })
      .run();
  }
}
