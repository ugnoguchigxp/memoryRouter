import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";

export type VibeMemorySeed = {
  sessionId: string;
  content: string;
  memoryType?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  scope: "repo" | "global";
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
};

export async function insertVibeMemory(seed: VibeMemorySeed) {
  const projectIdentity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: seed.scope,
      projectRef: seed.projectRef,
      repoKey: seed.repoKey,
      repoPath: seed.repoPath,
    },
    {
      producer: "vibe-memory.legacy-capture",
      entityKind: "vibe_memory",
      actor: "agent",
    },
  );
  const normalizedSeed = {
    ...seed,
    metadata: redactSecretRecord({ ...seed.metadata, projectIdentity }),
  };
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await import("./vibe-memory.repository.sqlite.js");
    const inserted = await sqlite.insertVibeMemorySqlite(normalizedSeed);
    await recordProjectScopedWritePersisted(projectIdentity, {
      producer: "vibe-memory.legacy-capture",
      entityKind: "vibe_memory",
      entityId: inserted.id,
      actor: "agent",
    });
    return inserted;
  }

  const [inserted] = await db
    .insert(vibeMemories)
    .values({
      sessionId: normalizedSeed.sessionId,
      content: redactSecrets(normalizedSeed.content),
      memoryType: normalizedSeed.memoryType ?? "chat",
      embedding: normalizedSeed.embedding,
      metadata: normalizedSeed.metadata,
    })
    .returning();
  await recordProjectScopedWritePersisted(projectIdentity, {
    producer: "vibe-memory.legacy-capture",
    entityKind: "vibe_memory",
    entityId: inserted.id,
    actor: "agent",
  });
  return inserted;
}

export async function searchVibeMemories(params: {
  query: string;
  limit: number;
  sessionId?: string;
}) {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await import("./vibe-memory.repository.sqlite.js");
    return sqlite.searchVibeMemoriesSqlite(params);
  }

  const query = params.query.trim();
  if (!query) {
    return [];
  }
  const filters = [];

  if (params.sessionId) {
    filters.push(eq(vibeMemories.sessionId, params.sessionId));
  }

  // Full-text search and LIKE search
  const searchFilters = [
    sql`to_tsvector('simple', ${vibeMemories.content}) @@ plainto_tsquery('simple', ${query})`,
    ilike(vibeMemories.content, `%${query}%`),
    sql`exists (
      select 1
      from ${agentDiffEntries}
      where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
        and (
          ${agentDiffEntries.filePath} ilike ${`%${query}%`}
          or ${agentDiffEntries.diffHunk} ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.symbolName}, '') ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.symbolKind}, '') ilike ${`%${query}%`}
          or coalesce(${agentDiffEntries.signature}, '') ilike ${`%${query}%`}
        )
    )`,
  ];

  const results = await db
    .select({
      id: vibeMemories.id,
      sessionId: vibeMemories.sessionId,
      content: vibeMemories.content,
      memoryType: vibeMemories.memoryType,
      metadata: vibeMemories.metadata,
      createdAt: vibeMemories.createdAt,
      score: sql<number>`ts_rank_cd(to_tsvector('simple', ${vibeMemories.content}), plainto_tsquery('simple', ${query}))`,
    })
    .from(vibeMemories)
    .where(and(...filters, or(...searchFilters)))
    .orderBy(
      desc(
        sql`ts_rank_cd(to_tsvector('simple', ${vibeMemories.content}), plainto_tsquery('simple', ${query}))`,
      ),
    )
    .limit(params.limit);

  return results;
}
