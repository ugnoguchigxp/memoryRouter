import { asc, eq } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { sliceTextByTokenWindow } from "../readFile/token-window.service.js";
import { type MemoryReaderMode, prepareMemoryReaderContent } from "./domain.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export type MemoryReaderReadInput = {
  vibeMemoryId: string;
  fromToken?: number;
  readTokens?: number;
  mode?: MemoryReaderMode;
};

export type MemoryReaderReadResult = {
  content: string;
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
};

function dedupeSegments(segments: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const segment of segments) {
    const key = segment.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(segment);
  }
  return result;
}

export async function readVibeMemoryByTokenWindow(
  input: MemoryReaderReadInput,
): Promise<MemoryReaderReadResult> {
  const vibeMemoryId = input.vibeMemoryId.trim();
  if (!vibeMemoryId) {
    throw new Error("vibeMemoryId must be a non-empty string");
  }

  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const memory = sqlite.db
      .query<{ content: string }, [string]>(
        "select content from vibe_memories where id = ? limit 1",
      )
      .get(vibeMemoryId);
    if (!memory) {
      throw new Error(`vibe memory not found: ${vibeMemoryId}`);
    }

    const mode = input.mode ?? "compressed";
    const fromToken = Math.max(0, Math.floor(input.fromToken ?? 0));
    const maxTokens = Math.max(1, groupedConfig.readFile.maxTokens);
    const requestedTokens = Math.max(
      1,
      Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens),
    );
    const readTokens = Math.min(requestedTokens, maxTokens);

    const diffs = sqlite.db
      .query<{ diff_hunk: string }, [string]>(
        `
        select diff_hunk
        from agent_diff_entries
        where vibe_memory_id = ?
        order by created_at asc, file_path asc, id asc
      `,
      )
      .all(vibeMemoryId);

    const segments = [
      prepareMemoryReaderContent({
        text: memory.content,
        mode,
        contentKind: "memory",
      }),
      ...diffs.map((entry) =>
        prepareMemoryReaderContent({
          text: entry.diff_hunk,
          mode,
          contentKind: "diff",
        }),
      ),
    ];
    const normalizedSegments = mode === "compressed" ? dedupeSegments(segments) : segments;
    const merged = normalizedSegments.filter((segment) => segment.trim()).join("\n");
    const window = sliceTextByTokenWindow({
      text: merged,
      fromToken,
      readTokens,
    });
    return {
      content: window.content,
      totalTokens: window.totalTokens,
      from: window.tokenRange.from,
      toExclusive: window.tokenRange.toExclusive,
      returnedTokens: window.returnedTokens,
    };
  }

  const [memory] = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.id, vibeMemoryId))
    .limit(1);
  if (!memory) {
    throw new Error(`vibe memory not found: ${vibeMemoryId}`);
  }

  const mode = input.mode ?? "compressed";
  const fromToken = Math.max(0, Math.floor(input.fromToken ?? 0));
  const maxTokens = Math.max(1, groupedConfig.readFile.maxTokens);
  const requestedTokens = Math.max(
    1,
    Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens),
  );
  const readTokens = Math.min(requestedTokens, maxTokens);

  const diffs = await db
    .select()
    .from(agentDiffEntries)
    .where(eq(agentDiffEntries.vibeMemoryId, vibeMemoryId))
    .orderBy(
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );

  const segments = [
    prepareMemoryReaderContent({
      text: memory.content,
      mode,
      contentKind: "memory",
    }),
    ...diffs.map((entry) =>
      prepareMemoryReaderContent({
        text: entry.diffHunk,
        mode,
        contentKind: "diff",
      }),
    ),
  ];

  const normalizedSegments = mode === "compressed" ? dedupeSegments(segments) : segments;
  const merged = normalizedSegments.filter((segment) => segment.trim()).join("\n");
  const window = sliceTextByTokenWindow({
    text: merged,
    fromToken,
    readTokens,
  });

  return {
    content: window.content,
    totalTokens: window.totalTokens,
    from: window.tokenRange.from,
    toExclusive: window.tokenRange.toExclusive,
    returnedTokens: window.returnedTokens,
  };
}
