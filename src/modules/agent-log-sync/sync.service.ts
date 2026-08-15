import { eq, like } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { APP_CONSTANTS } from "../../constants.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/client.js";
import {
  agentDiffEntries,
  episodeDistillerQueue,
  syncStates,
  vibeMemories,
} from "../../db/schema.js";
import { readProjectEnv } from "../../project-identity.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  auditEventTypes,
  cleanupExpiredAuditLogsSafe,
  recordAuditLogSafe,
} from "../audit/audit-log.service.js";
import {
  ProjectScopedWriteError,
  type ResolvedProjectScopedWriteIdentity,
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import { appendQueueEvent } from "../queue/core/events.js";
import { normalizeAgentDiffEntries } from "../vibe-memory/agent-diff-ingestion.service.js";
import {
  type ChatMessage,
  type IngestCursor,
  ingestAntigravityLogs,
  ingestClaudeLogs,
  ingestCodexLogs,
  normalizeIngestCursor,
} from "./ingest.service.js";
import {
  buildDedupeKey,
  buildMemorySessionId,
  buildReadableTranscript,
  buildTranscript,
  chunkMessages,
  extractAgentDiffsFromToolCalls,
  extractUnifiedDiffsFromText,
  filterDistillableAgentLogMessages,
  getCheckpointDate,
  hasTargetedNightWorkersRuntimeContract,
  isCodexInternalProviderPromptMessage,
  isExcludedAgentLogMetadata,
  isNonDistillableAgentTaskLogMessage,
  isToolCallMessage,
  mergeMessageMetadata,
  sanitizeNightWorkersRuntimeContractChunk,
} from "./sync.service.helpers.js";

type AgentLogSource = {
  id: "codex_logs" | "antigravity_logs" | "claude_logs";
  label: "Codex" | "Antigravity" | "Claude";
  ingest: (
    since?: Date,
    cursor?: IngestCursor,
  ) => Promise<{
    ok: boolean;
    errors: string[];
    warnings: string[];
    messages: ChatMessage[];
    cursor: IngestCursor;
    maxObservedMtimeMs: number;
    checkedFiles: number;
    skipped?: boolean;
  }>;
};

type AgentLogSourceSyncSummary = {
  id: AgentLogSource["id"];
  label: AgentLogSource["label"];
  ok: boolean;
  skipped: boolean;
  checkedFiles: number;
  messages: number;
  insertedMemories: number;
  insertedDiffs: number;
  warnings: string[];
  errors: string[];
  lastSyncedAt: string | null;
};

export type AgentLogSyncSummary = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  imported: number;
  insertedDiffs: number;
  sources: AgentLogSourceSyncSummary[];
};

const sources: AgentLogSource[] = [
  { id: "codex_logs", label: "Codex", ingest: ingestCodexLogs },
  {
    id: "antigravity_logs",
    label: "Antigravity",
    ingest: ingestAntigravityLogs,
  },
  { id: "claude_logs", label: "Claude", ingest: ingestClaudeLogs },
];

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function shouldDeleteLegacyAntigravityVibeMemories(): boolean {
  return readProjectEnv("DELETE_LEGACY_ANTIGRAVITY_VIBE_MEMORIES") === "1";
}

function isBelowMinDistillableChars(readableContent: string): boolean {
  const threshold = groupedConfig.agentLogSync.minDistillableChars;
  if (threshold <= 0) return false;
  return readableContent.trim().length <= threshold;
}

export {
  buildDedupeKey,
  buildReadableTranscript,
  chunkMessages,
  extractUnifiedDiffsFromText,
  filterDistillableAgentLogMessages,
  isCodexInternalProviderPromptMessage,
  isExcludedAgentLogMetadata,
  isNonDistillableAgentTaskLogMessage,
  shouldDeleteLegacyAntigravityVibeMemories,
};

type SqliteSyncStateRow = {
  id: string;
  last_synced_at: string;
  cursor: string;
  metadata: string;
  updated_at: string;
};

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function agentLogSyncWarnings(
  warnings: string[],
  runtimeContractLeakSkipped: number,
  identityRejected: number,
): string[] {
  return [
    ...warnings,
    ...(runtimeContractLeakSkipped > 0
      ? [`Skipped ${runtimeContractLeakSkipped} NightWorkers Runtime Contract leak chunk(s).`]
      : []),
    ...(identityRejected > 0
      ? [`Rejected ${identityRejected} repo-scoped VibeMemory write(s) without valid identity.`]
      : []),
  ];
}

async function attachAgentLogProjectIdentity(
  metadata: Record<string, unknown>,
): Promise<ResolvedProjectScopedWriteIdentity | null> {
  try {
    const identity = await resolveAuditedProjectScopedWriteIdentity(
      {
        scope: "repo",
        repoPath: typeof metadata.projectRoot === "string" ? metadata.projectRoot : undefined,
      },
      { producer: "agent-log-sync.typescript", entityKind: "vibe_memory" },
    );
    metadata.projectIdentity = identity;
    return identity;
  } catch (error) {
    if (error instanceof ProjectScopedWriteError) return null;
    throw error;
  }
}

async function syncAllAgentLogsSqlite(params: {
  summary: AgentLogSyncSummary;
  enabledBySourceId: Record<string, boolean>;
}): Promise<AgentLogSyncSummary> {
  const sqlite = await getSqliteCoreDatabase();

  for (const source of sources) {
    const state = sqlite.db
      .query<SqliteSyncStateRow, [string]>("select * from sync_states where id = ?")
      .get(source.id);
    const enabled = params.enabledBySourceId[source.id] ?? true;
    if (!enabled) {
      params.summary.sources.push({
        id: source.id,
        label: source.label,
        ok: true,
        skipped: true,
        checkedFiles: 0,
        messages: 0,
        insertedMemories: 0,
        insertedDiffs: 0,
        warnings: [],
        errors: [],
        lastSyncedAt: state?.last_synced_at ? new Date(state.last_synced_at).toISOString() : null,
      });
      continue;
    }

    const stateMetadata = parseRecord(state?.metadata);
    const isFirst20Sync =
      source.id === "antigravity_logs" && (!state || stateMetadata.formatVersion !== "2.0");
    const since = isFirst20Sync ? undefined : parseDate(state?.last_synced_at);
    const cursor = isFirst20Sync ? {} : normalizeIngestCursor(parseRecord(state?.cursor));
    const ingestResult = await source.ingest(since, cursor);
    if (!ingestResult.ok) {
      params.summary.ok = false;
      params.summary.sources.push({
        id: source.id,
        label: source.label,
        ok: false,
        skipped: Boolean(ingestResult.skipped),
        checkedFiles: ingestResult.checkedFiles,
        messages: 0,
        insertedMemories: 0,
        insertedDiffs: 0,
        warnings: ingestResult.warnings,
        errors: ingestResult.errors,
        lastSyncedAt: since?.toISOString() ?? null,
      });
      continue;
    }

    const messages = filterDistillableAgentLogMessages(ingestResult.messages);
    const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);
    const sourceMetadata = redactSecretRecord({
      checkedFiles: ingestResult.checkedFiles,
      warnings: ingestResult.warnings,
      skipped: Boolean(ingestResult.skipped),
      messageCount: messages.length,
      syncedAt: new Date().toISOString(),
      formatVersion: "2.0",
    });

    if (ingestResult.skipped) {
      params.summary.sources.push({
        id: source.id,
        label: source.label,
        ok: true,
        skipped: true,
        checkedFiles: ingestResult.checkedFiles,
        messages: 0,
        insertedMemories: 0,
        insertedDiffs: 0,
        warnings: ingestResult.warnings,
        errors: [],
        lastSyncedAt: since?.toISOString() ?? null,
      });
      continue;
    }

    const messagesBySession = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const memorySessionId = buildMemorySessionId(source.id, message);
      const bucket = messagesBySession.get(memorySessionId);
      if (bucket) bucket.push(message);
      else messagesBySession.set(memorySessionId, [message]);
    }

    let insertedMemories = 0;
    let insertedDiffs = 0;
    let runtimeContractLeakSkipped = 0;
    let identityRejected = 0;
    const enqueuedEpisodeJobs: Array<{ id: string; sourceKey: string }> = [];
    const persistedIdentityWrites: Array<{
      entityId: string;
      identity: ResolvedProjectScopedWriteIdentity;
    }> = [];

    sqlite.db.query("BEGIN IMMEDIATE").run();
    try {
      if (isFirst20Sync && shouldDeleteLegacyAntigravityVibeMemories()) {
        sqlite.db
          .query("delete from vibe_memories where session_id like 'antigravity_logs:%'")
          .run();
      }

      for (const [memorySessionId, sessionMessages] of messagesBySession.entries()) {
        const chunks = chunkMessages(sessionMessages);
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const sanitizedChunk = sanitizeNightWorkersRuntimeContractChunk(chunk);
          if (sanitizedChunk.length === 0) continue;
          const rawContent = buildTranscript(sanitizedChunk);
          const readableContent = buildReadableTranscript(sanitizedChunk);
          const diff = extractUnifiedDiffsFromText(rawContent);
          const toolCallDiffs = extractAgentDiffsFromToolCalls(sanitizedChunk);
          const diffEntries = normalizeAgentDiffEntries({
            diff,
            agentDiffs: toolCallDiffs,
          });
          const hiddenToolCallCount = sanitizedChunk.filter((message) =>
            isToolCallMessage(message),
          ).length;
          if (!readableContent.trim() && diffEntries.length === 0 && hiddenToolCallCount === 0) {
            continue;
          }
          const content =
            readableContent.trim() ||
            (diffEntries.length > 0 ? "Agent diff recorded." : "Tool usage recorded.");
          if (isBelowMinDistillableChars(readableContent)) continue;
          const redactedContent = redactSecrets(content);
          if (hasTargetedNightWorkersRuntimeContract(redactedContent)) {
            runtimeContractLeakSkipped += 1;
            continue;
          }
          const dedupeKey = buildDedupeKey({
            sourceId: source.id,
            memorySessionId,
            chunkIndex,
          });
          const memoryMetadata = redactSecretRecord({
            ...mergeMessageMetadata(source, sanitizedChunk, {
              rawMessageCount: chunk.length,
            }),
            chunkIndex,
            dedupeKey,
            hiddenToolCallCount,
            agentDiffCount: diffEntries.length,
          });
          if (isExcludedAgentLogMetadata(memoryMetadata)) continue;
          const writeIdentity = await attachAgentLogProjectIdentity(memoryMetadata);
          if (!writeIdentity) {
            identityRejected += 1;
            continue;
          }

          const existing = sqlite.db
            .query<{ id: string }, [string, string]>(
              "select id from vibe_memories where session_id = ? and dedupe_key = ? limit 1",
            )
            .get(memorySessionId, dedupeKey);
          if (existing) continue;

          const memoryId = crypto.randomUUID();
          const now = new Date().toISOString();
          sqlite.db
            .query(
              `
              insert into vibe_memories (
                id, session_id, content, memory_type, dedupe_key, metadata, created_at
              ) values (?, ?, ?, ?, ?, ?, ?)
            `,
            )
            .run(
              memoryId,
              memorySessionId,
              redactedContent,
              "chat",
              dedupeKey,
              JSON.stringify(memoryMetadata),
              now,
            );
          insertedMemories += 1;
          persistedIdentityWrites.push({ entityId: memoryId, identity: writeIdentity });

          const episodeJobId = crypto.randomUUID();
          sqlite.db
            .query(
              `
              insert into episode_distiller_queue (
                id, source_kind, source_key, source_uri,
                distillation_version, payload, metadata, priority, provider_policy,
                status, created_at, updated_at
              ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              on conflict(source_kind, source_key, distillation_version) do nothing
            `,
            )
            .run(
              episodeJobId,
              "vibe_memory",
              memoryId,
              `vibe_memory:${memoryId}`,
              APP_CONSTANTS.distillationTargetVersion,
              JSON.stringify({
                sourceType: "agent_log_sync",
                sourceId: source.id,
                memorySessionId,
                chunkIndex,
                dedupeKey,
              }),
              JSON.stringify({
                sourceType: "agent_log_sync",
                sourceId: source.id,
                memorySessionId,
                chunkIndex,
                dedupeKey,
                sessionTitle:
                  typeof memoryMetadata.sessionTitle === "string"
                    ? memoryMetadata.sessionTitle
                    : undefined,
                projectName:
                  typeof memoryMetadata.projectName === "string"
                    ? memoryMetadata.projectName
                    : undefined,
              }),
              50,
              "default",
              "pending",
              now,
              now,
            );
          const episodeJob = sqlite.db
            .query<{ id: string }, [string, string, string]>(
              `
              select id
              from episode_distiller_queue
              where source_kind = ?
                and source_key = ?
                and distillation_version = ?
              limit 1
            `,
            )
            .get("vibe_memory", memoryId, APP_CONSTANTS.distillationTargetVersion);
          if (episodeJob?.id === episodeJobId) {
            enqueuedEpisodeJobs.push({ id: episodeJobId, sourceKey: memoryId });
          }

          for (const entry of diffEntries) {
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
                crypto.randomUUID(),
                memoryId,
                entry.filePath,
                redactSecrets(entry.diffHunk),
                entry.changeType ?? null,
                entry.language ?? null,
                entry.symbolName ?? null,
                entry.symbolKind ?? null,
                entry.signature ?? null,
                entry.startLine ?? null,
                entry.endLine ?? null,
                JSON.stringify(
                  redactSecretRecord({
                    ...entry.metadata,
                    extractedFrom: "agent_log_sync",
                    dedupeKey,
                    sourceId: source.id,
                  }),
                ),
                now,
                now,
              );
            insertedDiffs += 1;
          }
        }
      }

      const now = new Date().toISOString();
      sqlite.db
        .query(
          `
          insert into sync_states (id, last_synced_at, cursor, metadata, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            last_synced_at = excluded.last_synced_at,
            cursor = excluded.cursor,
            metadata = excluded.metadata,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          source.id,
          checkpointDate.toISOString(),
          JSON.stringify(ingestResult.cursor),
          JSON.stringify(sourceMetadata),
          now,
          now,
        );
      sqlite.db.query("COMMIT").run();
    } catch (error) {
      sqlite.db.query("ROLLBACK").run();
      throw error;
    }

    params.summary.imported += insertedMemories;
    params.summary.insertedDiffs += insertedDiffs;
    for (const persisted of persistedIdentityWrites) {
      await recordProjectScopedWritePersisted(persisted.identity, {
        producer: "agent-log-sync.typescript",
        entityKind: "vibe_memory",
        entityId: persisted.entityId,
      });
    }
    for (const job of enqueuedEpisodeJobs) {
      await appendQueueEvent({
        queueName: "episodeDistiller",
        queueJobId: job.id,
        eventType: "enqueued",
        message: "episode distiller enqueued from agent log sync",
        metadata: {
          sourceKind: "vibe_memory",
          sourceKey: job.sourceKey,
        },
      });
    }
    params.summary.sources.push({
      id: source.id,
      label: source.label,
      ok: true,
      skipped: false,
      checkedFiles: ingestResult.checkedFiles,
      messages: messages.length,
      insertedMemories,
      insertedDiffs,
      warnings: agentLogSyncWarnings(
        ingestResult.warnings,
        runtimeContractLeakSkipped,
        identityRejected,
      ),
      errors: [],
      lastSyncedAt: checkpointDate.toISOString(),
    });
  }

  params.summary.finishedAt = new Date().toISOString();
  return params.summary;
}

export async function syncAllAgentLogs(): Promise<AgentLogSyncSummary> {
  const startedAt = new Date();
  const summary: AgentLogSyncSummary = {
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    imported: 0,
    insertedDiffs: 0,
    sources: [],
  };
  await recordAuditLogSafe({
    eventType: auditEventTypes.syncRunStarted,
    actor: "system",
    payload: {
      sourceIds: sources.map((source) => source.id),
    },
  });

  try {
    const { getRuntimeSettings } = await import("../settings/runtime-settings.js");
    const settings = await getRuntimeSettings();
    const enabledBySourceId: Record<string, boolean> = {
      codex_logs: settings.advanced.codexLogSyncEnabled,
      antigravity_logs: settings.advanced.antigravityLogSyncEnabled,
      claude_logs: settings.advanced.claudeLogSyncEnabled,
    };
    if (resolveDatabaseBackendConfig().kind === "sqlite") {
      const sqliteSummary = await syncAllAgentLogsSqlite({
        summary,
        enabledBySourceId,
      });
      const cleanup = await cleanupExpiredAuditLogsSafe({ trigger: "sync" });
      await recordAuditLogSafe({
        eventType: auditEventTypes.syncRunFinished,
        actor: "system",
        payload: {
          ...sqliteSummary,
          cleanup: cleanup ?? null,
        },
      });
      return sqliteSummary;
    }

    for (const source of sources) {
      const [state] = await db.select().from(syncStates).where(eq(syncStates.id, source.id));

      const enabled = enabledBySourceId[source.id] ?? true;
      if (!enabled) {
        summary.sources.push({
          id: source.id,
          label: source.label,
          ok: true,
          skipped: true,
          checkedFiles: 0,
          messages: 0,
          insertedMemories: 0,
          insertedDiffs: 0,
          warnings: [],
          errors: [],
          lastSyncedAt: state?.lastSyncedAt?.toISOString() ?? null,
        });
        continue;
      }

      // Antigravity ログの 2.0 移行自動クリーンアップ判定
      const isFirst20Sync =
        source.id === "antigravity_logs" &&
        (!state ||
          (state.metadata as Record<string, unknown> | undefined)?.formatVersion !== "2.0");

      const since = isFirst20Sync ? undefined : (state?.lastSyncedAt ?? undefined);
      const cursor = isFirst20Sync ? {} : normalizeIngestCursor(state?.cursor);
      const ingestResult = await source.ingest(since, cursor);

      if (!ingestResult.ok) {
        summary.ok = false;
        summary.sources.push({
          id: source.id,
          label: source.label,
          ok: false,
          skipped: Boolean(ingestResult.skipped),
          checkedFiles: ingestResult.checkedFiles,
          messages: 0,
          insertedMemories: 0,
          insertedDiffs: 0,
          warnings: ingestResult.warnings,
          errors: ingestResult.errors,
          lastSyncedAt: since?.toISOString() ?? null,
        });
        continue;
      }

      const messages = filterDistillableAgentLogMessages(ingestResult.messages);
      const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);
      const sourceMetadata = {
        checkedFiles: ingestResult.checkedFiles,
        warnings: ingestResult.warnings,
        skipped: Boolean(ingestResult.skipped),
        messageCount: messages.length,
        syncedAt: new Date().toISOString(),
        formatVersion: "2.0", // 2.0 移行の識別子
      };
      const redactedSourceMetadata = redactSecretRecord(sourceMetadata);

      if (ingestResult.skipped) {
        summary.sources.push({
          id: source.id,
          label: source.label,
          ok: true,
          skipped: true,
          checkedFiles: ingestResult.checkedFiles,
          messages: 0,
          insertedMemories: 0,
          insertedDiffs: 0,
          warnings: ingestResult.warnings,
          errors: [],
          lastSyncedAt: since?.toISOString() ?? null,
        });
        continue;
      }

      const messagesBySession = new Map<string, ChatMessage[]>();
      for (const message of messages) {
        const memorySessionId = buildMemorySessionId(source.id, message);
        const bucket = messagesBySession.get(memorySessionId);
        if (bucket) {
          bucket.push(message);
        } else {
          messagesBySession.set(memorySessionId, [message]);
        }
      }

      let insertedMemories = 0;
      let insertedDiffs = 0;
      let runtimeContractLeakSkipped = 0;
      let identityRejected = 0;
      const enqueuedEpisodeJobs: Array<{ id: string; sourceKey: string }> = [];
      const persistedIdentityWrites: Array<{
        entityId: string;
        identity: ResolvedProjectScopedWriteIdentity;
      }> = [];

      await db.transaction(async (tx) => {
        if (isFirst20Sync && shouldDeleteLegacyAntigravityVibeMemories()) {
          // 旧 Antigravity 会話ログに関連するメモリデータを DB から全削除
          if (typeof tx.delete === "function") {
            await tx.delete(vibeMemories).where(like(vibeMemories.sessionId, "antigravity_logs:%"));
            console.log("[Cleanup] Deleted legacy Antigravity vibe memories from DB successfully.");
          }
        }

        for (const [memorySessionId, sessionMessages] of messagesBySession.entries()) {
          const chunks = chunkMessages(sessionMessages);

          for (const [chunkIndex, chunk] of chunks.entries()) {
            const sanitizedChunk = sanitizeNightWorkersRuntimeContractChunk(chunk);
            if (sanitizedChunk.length === 0) continue;
            const rawContent = buildTranscript(sanitizedChunk);
            const readableContent = buildReadableTranscript(sanitizedChunk);
            const diff = extractUnifiedDiffsFromText(rawContent);
            const toolCallDiffs = extractAgentDiffsFromToolCalls(sanitizedChunk);
            const diffEntries = normalizeAgentDiffEntries({
              diff,
              agentDiffs: toolCallDiffs,
            });

            const hiddenToolCallCount = sanitizedChunk.filter((message) =>
              isToolCallMessage(message),
            ).length;
            if (!readableContent.trim() && diffEntries.length === 0 && hiddenToolCallCount === 0) {
              continue;
            }
            const content =
              readableContent.trim() ||
              (diffEntries.length > 0 ? "Agent diff recorded." : "Tool usage recorded.");
            if (isBelowMinDistillableChars(readableContent)) {
              continue;
            }
            const redactedContent = redactSecrets(content);
            if (hasTargetedNightWorkersRuntimeContract(redactedContent)) {
              runtimeContractLeakSkipped += 1;
              continue;
            }
            const dedupeKey = buildDedupeKey({
              sourceId: source.id,
              memorySessionId,
              chunkIndex,
            });
            const memoryMetadata = redactSecretRecord({
              ...mergeMessageMetadata(source, sanitizedChunk, {
                rawMessageCount: chunk.length,
              }),
              chunkIndex,
              dedupeKey,
              hiddenToolCallCount,
              agentDiffCount: diffEntries.length,
            });
            if (isExcludedAgentLogMetadata(memoryMetadata)) {
              continue;
            }
            const writeIdentity = await attachAgentLogProjectIdentity(memoryMetadata);
            if (!writeIdentity) {
              identityRejected += 1;
              continue;
            }
            const [inserted] = await tx
              .insert(vibeMemories)
              .values({
                sessionId: memorySessionId,
                content: redactedContent,
                memoryType: "chat",
                dedupeKey,
                metadata: memoryMetadata,
              })
              .onConflictDoNothing({
                target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
              })
              .returning({ id: vibeMemories.id });

            if (!inserted) {
              continue;
            }

            insertedMemories += 1;
            persistedIdentityWrites.push({ entityId: inserted.id, identity: writeIdentity });

            const [episodeJob] = await tx
              .insert(episodeDistillerQueue)
              .values({
                sourceKind: "vibe_memory",
                sourceKey: inserted.id,
                sourceUri: `vibe_memory:${inserted.id}`,
                distillationVersion: APP_CONSTANTS.distillationTargetVersion,
                payload: {
                  sourceType: "agent_log_sync",
                  sourceId: source.id,
                  memorySessionId,
                  chunkIndex,
                  dedupeKey,
                },
                metadata: {
                  sourceType: "agent_log_sync",
                  sourceId: source.id,
                  memorySessionId,
                  chunkIndex,
                  dedupeKey,
                  sessionTitle:
                    typeof memoryMetadata.sessionTitle === "string"
                      ? memoryMetadata.sessionTitle
                      : undefined,
                  projectName:
                    typeof memoryMetadata.projectName === "string"
                      ? memoryMetadata.projectName
                      : undefined,
                },
                priority: 50,
                providerPolicy: "default",
                status: "pending",
                updatedAt: new Date(),
              })
              .onConflictDoNothing({
                target: [
                  episodeDistillerQueue.sourceKind,
                  episodeDistillerQueue.sourceKey,
                  episodeDistillerQueue.distillationVersion,
                ],
              })
              .returning({ id: episodeDistillerQueue.id });
            if (episodeJob) {
              enqueuedEpisodeJobs.push({
                id: episodeJob.id,
                sourceKey: inserted.id,
              });
            }

            if (diffEntries.length === 0) continue;

            const insertedEntries = await tx
              .insert(agentDiffEntries)
              .values(
                diffEntries.map((entry) => ({
                  vibeMemoryId: inserted.id,
                  filePath: entry.filePath,
                  diffHunk: redactSecrets(entry.diffHunk),
                  changeType: entry.changeType ?? null,
                  language: entry.language ?? null,
                  symbolName: entry.symbolName ?? null,
                  symbolKind: entry.symbolKind ?? null,
                  signature: entry.signature ?? null,
                  startLine: entry.startLine ?? null,
                  endLine: entry.endLine ?? null,
                  metadata: redactSecretRecord({
                    ...entry.metadata,
                    extractedFrom: "agent_log_sync",
                    dedupeKey,
                    sourceId: source.id,
                  }),
                })),
              )
              .returning({ id: agentDiffEntries.id });
            insertedDiffs += insertedEntries.length;
          }
        }

        const now = new Date();
        await tx
          .insert(syncStates)
          .values({
            id: source.id,
            lastSyncedAt: checkpointDate,
            cursor: ingestResult.cursor,
            metadata: redactedSourceMetadata,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: syncStates.id,
            set: {
              lastSyncedAt: checkpointDate,
              cursor: ingestResult.cursor,
              metadata: redactedSourceMetadata,
              updatedAt: now,
            },
          });
      });

      summary.imported += insertedMemories;
      summary.insertedDiffs += insertedDiffs;
      for (const persisted of persistedIdentityWrites) {
        await recordProjectScopedWritePersisted(persisted.identity, {
          producer: "agent-log-sync.typescript",
          entityKind: "vibe_memory",
          entityId: persisted.entityId,
        });
      }
      for (const job of enqueuedEpisodeJobs) {
        await appendQueueEvent({
          queueName: "episodeDistiller",
          queueJobId: job.id,
          eventType: "enqueued",
          message: "episode distiller enqueued from agent log sync",
          metadata: {
            sourceKind: "vibe_memory",
            sourceKey: job.sourceKey,
          },
        });
      }
      summary.sources.push({
        id: source.id,
        label: source.label,
        ok: true,
        skipped: false,
        checkedFiles: ingestResult.checkedFiles,
        messages: messages.length,
        insertedMemories,
        insertedDiffs,
        warnings: agentLogSyncWarnings(
          ingestResult.warnings,
          runtimeContractLeakSkipped,
          identityRejected,
        ),
        errors: [],
        lastSyncedAt: checkpointDate.toISOString(),
      });
    }

    summary.finishedAt = new Date().toISOString();
    const cleanup = await cleanupExpiredAuditLogsSafe({ trigger: "sync" });
    await recordAuditLogSafe({
      eventType: auditEventTypes.syncRunFinished,
      actor: "system",
      payload: {
        ...summary,
        cleanup: cleanup ?? null,
      },
    });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.ok = false;
    summary.finishedAt = new Date().toISOString();
    await recordAuditLogSafe({
      eventType: auditEventTypes.syncRunFinished,
      actor: "system",
      payload: {
        ...summary,
        error: message,
      },
    });
    throw error;
  }
}
