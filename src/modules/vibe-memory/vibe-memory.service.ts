import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import {
  type RecordVibeMemoryInput,
  recordVibeMemoryInputSchema,
} from "../../shared/schemas/vibe-memory.schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import {
  extractAgentDiffContentFromText,
  normalizeAgentDiffEntries,
  stripAgentDiffContentFromText,
} from "./agent-diff-ingestion.service.js";
import {
  type VibeMemorySeed,
  insertVibeMemory,
  searchVibeMemories,
} from "./vibe-memory.repository.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export type RecordedVibeMemory = {
  memory: typeof vibeMemories.$inferSelect;
  diffEntries: (typeof agentDiffEntries.$inferSelect)[];
};

// Legacy support
export async function recordVibeMemory(memory: VibeMemorySeed) {
  return insertVibeMemory(memory);
}

// Legacy support
export async function recordVibeMemoryWithDiffEntries(
  input: RecordVibeMemoryInput,
): Promise<RecordedVibeMemory> {
  const parsed = recordVibeMemoryInputSchema.parse(input);
  const projectIdentity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: parsed.scope,
      projectRef: parsed.projectRef,
      repoKey: parsed.repoKey,
      repoPath: parsed.repoPath,
    },
    {
      producer: "vibe-memory.capture",
      entityKind: "vibe_memory",
      actor: "agent",
    },
  );
  const memoryMetadata = redactSecretRecord({
    ...parsed.metadata,
    projectIdentity,
  });
  const redactedContent = redactSecrets(parsed.content);
  const embeddedDiff = extractAgentDiffContentFromText(redactedContent);
  const normalizedEntries = normalizeAgentDiffEntries({
    diff: [parsed.diff ? redactSecrets(parsed.diff) : undefined, embeddedDiff]
      .filter((diff): diff is string => Boolean(diff?.trim()))
      .join("\n\n"),
    agentDiffs: parsed.agentDiffs.map((entry) => ({
      ...entry,
      diffHunk: redactSecrets(entry.diffHunk ?? ""),
      metadata: redactSecretRecord(entry.metadata ?? {}),
    })),
  });
  const content =
    redactSecrets(stripAgentDiffContentFromText(redactedContent)) ||
    (normalizedEntries.length > 0 ? "Agent diff recorded." : redactedContent.trim());

  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const memoryId = crypto.randomUUID();
    sqlite.db.query("BEGIN IMMEDIATE").run();
    try {
      sqlite.db
        .query(
          `
          insert into vibe_memories (
            id, session_id, content, memory_type, metadata, created_at
          ) values (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          memoryId,
          parsed.sessionId,
          content,
          parsed.memoryType,
          JSON.stringify(memoryMetadata),
          now,
        );
      sqlite.db
        .query("insert into vibe_memories_fts(rowid, id, content) values (?, ?, ?)")
        .run(
          sqlite.db.query<{ rowid: number }, []>("select last_insert_rowid() as rowid").get()
            ?.rowid ?? 0,
          memoryId,
          content,
        );

      const diffEntries = normalizedEntries.map((entry) => {
        const id = crypto.randomUUID();
        sqlite.db
          .query(
            `
            insert into agent_diff_entries (
              id, vibe_memory_id, file_path, diff_hunk, change_type, language,
              symbol_name, symbol_kind, signature, start_line, end_line,
              metadata, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            id,
            memoryId,
            entry.filePath,
            entry.diffHunk,
            entry.changeType ?? null,
            entry.language ?? null,
            entry.symbolName ?? null,
            entry.symbolKind ?? null,
            entry.signature ?? null,
            entry.startLine ?? null,
            entry.endLine ?? null,
            JSON.stringify(redactSecretRecord(entry.metadata)),
            now,
            now,
          );
        return {
          id,
          vibeMemoryId: memoryId,
          filePath: entry.filePath,
          diffHunk: entry.diffHunk,
          changeType: entry.changeType ?? null,
          language: entry.language ?? null,
          symbolName: entry.symbolName ?? null,
          symbolKind: entry.symbolKind ?? null,
          signature: entry.signature ?? null,
          startLine: entry.startLine ?? null,
          endLine: entry.endLine ?? null,
          metadata: redactSecretRecord(entry.metadata),
          createdAt: new Date(now),
          updatedAt: new Date(now),
        };
      });
      sqlite.db.query("COMMIT").run();
      const recorded = {
        memory: {
          id: memoryId,
          sessionId: parsed.sessionId,
          content,
          memoryType: parsed.memoryType,
          dedupeKey: null,
          embedding: null,
          metadata: memoryMetadata,
          createdAt: new Date(now),
          goalId: null,
          parentId: null,
          subject: null,
          intent: null,
          wants: [],
          refs: [],
          confidence: null,
          evidenceStatus: null,
          actorId: null,
          ttlAt: null,
        },
        diffEntries,
      } as RecordedVibeMemory;
      await recordProjectScopedWritePersisted(projectIdentity, {
        producer: "vibe-memory.capture",
        entityKind: "vibe_memory",
        entityId: memoryId,
        actor: "agent",
      });
      return recorded;
    } catch (error) {
      sqlite.db.query("ROLLBACK").run();
      throw error;
    }
  }

  const recorded = await db.transaction(async (tx) => {
    const [memory] = await tx
      .insert(vibeMemories)
      .values({
        sessionId: parsed.sessionId,
        content,
        memoryType: parsed.memoryType,
        metadata: memoryMetadata,
      })
      .returning();

    const diffEntries =
      normalizedEntries.length > 0
        ? await tx
            .insert(agentDiffEntries)
            .values(
              normalizedEntries.map((entry) => ({
                vibeMemoryId: memory.id,
                filePath: entry.filePath,
                diffHunk: entry.diffHunk,
                changeType: entry.changeType ?? null,
                language: entry.language ?? null,
                symbolName: entry.symbolName ?? null,
                symbolKind: entry.symbolKind ?? null,
                signature: entry.signature ?? null,
                startLine: entry.startLine ?? null,
                endLine: entry.endLine ?? null,
                metadata: redactSecretRecord(entry.metadata),
              })),
            )
            .returning()
        : [];

    return { memory, diffEntries };
  });
  await recordProjectScopedWritePersisted(projectIdentity, {
    producer: "vibe-memory.capture",
    entityKind: "vibe_memory",
    entityId: recorded.memory.id,
    actor: "agent",
  });
  return recorded;
}

/**
 * Retrieve raw Vibe Memory context.
 */
export async function retrieveVibeMemoryContext(params: {
  query?: string;
  sessionId?: string;
  limit?: number;
}): Promise<any> {
  if (params.query) {
    const limit = params.limit ?? 10;
    const memories = await searchVibeMemories({
      query: params.query,
      sessionId: params.sessionId,
      limit,
    });

    return memories.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      content: m.content,
      memoryType: m.memoryType,
      createdAt: m.createdAt,
      score: m.score,
    }));
  }

  return [];
}
