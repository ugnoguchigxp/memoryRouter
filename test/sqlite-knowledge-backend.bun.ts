import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetchGraphNodeDetail,
  upsertGraphCommunityLabel,
} from "../api/modules/graph/graph.repository.js";
import {
  bulkUpdateKnowledgeStatus,
  createKnowledgeItem,
  deleteKnowledgeItem,
  recordKnowledgeFeedback,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import { groupedConfig } from "../src/config.js";
import {
  getRuntimeSqliteCoreDatabase,
  resetRuntimeSqliteCoreDatabaseForTests,
} from "../src/db/sqlite/runtime.js";
import {
  getCompileRunSnapshot,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "../src/modules/knowledge/knowledge.repository.js";
import { registerCandidate } from "../src/modules/registerCandidate/register-candidate.service.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
} from "../src/modules/settings/settings.service.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";

let tempDir = "";
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;
const originalVectorSearch = process.env.CONTEXT_STILL_COMPILE_ENABLE_VECTOR_SEARCH;
const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
const originalCompileVectorSearchEnabled = groupedConfig.compile.enableVectorSearch;
let originalRuntimeAgenticCompileEnabled = false;

describe("sqlite knowledge backend", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-knowledge-"));
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(tempDir, "context-still-core.sqlite");
    process.env.CONTEXT_STILL_COMPILE_ENABLE_VECTOR_SEARCH = "1";
    await ensureRuntimeSettingsLoaded();
    const runtimeSettings = getRuntimeSettingsSnapshot();
    originalRuntimeAgenticCompileEnabled = runtimeSettings.taskRouting.agenticCompile.enabled;
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.compile.enableVectorSearch = false;
    runtimeSettings.taskRouting.agenticCompile.enabled = false;
    resetRuntimeSqliteCoreDatabaseForTests();
  });

  afterEach(async () => {
    restoreEnv("CONTEXT_STILL_DB_BACKEND", originalBackend);
    restoreEnv("CONTEXT_STILL_SQLITE_CORE_PATH", originalSqlitePath);
    restoreEnv("CONTEXT_STILL_COMPILE_ENABLE_VECTOR_SEARCH", originalVectorSearch);
    const runtimeSettings = getRuntimeSettingsSnapshot();
    groupedConfig.agenticCompile.enabled = originalAgenticCompileEnabled;
    groupedConfig.compile.enableVectorSearch = originalCompileVectorSearchEnabled;
    runtimeSettings.taskRouting.agenticCompile.enabled = originalRuntimeAgenticCompileEnabled;
    resetRuntimeSqliteCoreDatabaseForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("registers candidates in the sqlite pipeline without activating knowledge", async () => {
    const result = await registerCandidate({
      title: "Prefer Drizzle SQLite",
      body: "Use Drizzle for ordinary SQLite tables and raw SQL for FTS or vec0 virtual tables.",
      type: "rule",
      technologies: ["sqlite", "drizzle"],
      changeTypes: ["migration"],
      repoPath: "/repo/contextStill",
      confidence: 88,
      importance: 91,
    });

    expect(result.status).toBe("candidate_registered");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from knowledge_items where status = 'active'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from covering_evidence_queue where status = 'pending'",
        )
        .get()?.count,
    ).toBe(1);
    const hits = await searchKnowledge({
      query: "Drizzle SQLite virtual tables",
      status: "active",
      limit: 5,
      includeGeneral: true,
      includeDraft: false,
      technologies: ["sqlite"],
      changeTypes: ["migration"],
      repoPath: "/repo/contextStill",
    });

    expect(hits).toEqual([]);
  });

  test("does not return unrelated sqlite knowledge when query has no text or applicability match", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "agent://candidate/sqlite-only-rule",
      title: "SQLite only rule",
      body: "This row should not match an unrelated random query.",
      type: "rule",
      status: "active",
      scope: "repo",
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["migration"],
        repoPath: "/repo/contextStill",
      },
    });

    const hits = await searchKnowledge({
      query: "zzabsentunrelatedtoken",
      status: "active",
      limit: 5,
      includeGeneral: true,
      includeDraft: false,
      repoPath: "/repo/contextStill",
    });

    expect(hits).toEqual([]);
  });

  test("disables sqlite vector search when scope cannot be prefiltered", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "agent://candidate/vector-target",
      type: "rule",
      status: "active",
      scope: "repo",
      repoPath: "/repo/contextStill",
      title: "Vector target",
      body: "SQLite vector fallback should find this row.",
      confidence: 80,
      importance: 80,
      embedding: [1, 0, 0],
    });
    await upsertKnowledgeFromSource({
      sourceUri: "agent://candidate/vector-other",
      type: "rule",
      status: "active",
      scope: "repo",
      repoPath: "/repo/contextStill",
      title: "Vector other",
      body: "Different vector.",
      confidence: 80,
      importance: 80,
      embedding: [0, 1, 0],
    });

    const hits = await vectorSearchKnowledge([1, 0, 0], 1, ["active"], {
      repoPath: "/repo/contextStill",
    });
    expect(hits).toEqual([]);
  });

  test("knowledge API repository writes use sqlite backend", async () => {
    const created = await createKnowledgeItem({
      type: "rule",
      status: "draft",
      scope: "repo",
      repoPath: "/repo/contextStill",
      polarity: "positive",
      intentTags: ["sqlite-api"],
      title: "SQLite API draft",
      body: "Knowledge API writes should not require PostgreSQL.",
      confidence: 82,
      importance: 84,
      technologies: ["sqlite"],
      changeTypes: ["backend"],
      metadata: { sourceUri: "agent://sqlite-api/draft" },
    });

    const updated = await updateKnowledgeItem(created.id, {
      status: "active",
      body: "Knowledge API activation should stay on SQLite.",
    });
    expect(updated?.id).toBe(created.id);

    const feedback = await recordKnowledgeFeedback({
      id: created.id,
      direction: "up",
      reason: "verified",
    });
    expect(feedback).toMatchObject({
      id: created.id,
      direction: "up",
      explicitUpvoteCount: 1,
    });
    expect(feedback?.lastVerifiedAt).toBeInstanceOf(Date);

    const second = await createKnowledgeItem({
      type: "procedure",
      status: "draft",
      scope: "repo",
      repoPath: "/repo/contextStill",
      title: "SQLite API bulk target",
      body: "Bulk status updates should use SQLite selection rows.",
      confidence: 70,
      importance: 70,
      metadata: {},
    });
    const bulk = await bulkUpdateKnowledgeStatus({
      ids: [second.id],
      status: "active",
    });
    expect(bulk.updatedIds).toEqual([second.id]);

    const label = await upsertGraphCommunityLabel({
      communityKey: "a".repeat(64),
      label: "SQLite community",
      note: "stored locally",
    });
    expect(label).toMatchObject({
      communityKey: "a".repeat(64),
      label: "SQLite community",
      note: "stored locally",
    });

    const detail = await fetchGraphNodeDetail(second.id);
    expect(detail).toMatchObject({
      id: `knowledge:${second.id}`,
      label: "SQLite API bulk target",
      kind: "knowledge",
      status: "active",
    });

    const deleted = await deleteKnowledgeItem(created.id);
    expect(deleted?.id).toBe(created.id);
    const missingFeedback = await recordKnowledgeFeedback({ id: created.id, direction: "down" });
    expect(missingFeedback).toBeNull();
  });

  test("compiles context and stores run snapshots in sqlite", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "agent://candidate/sqlite-compile-rule",
      title: "SQLite compile rule",
      body: "SQLite backend mode must return context without requiring PostgreSQL persistence.",
      type: "rule",
      status: "active",
      scope: "repo",
      confidence: 90,
      importance: 90,
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["migration"],
        repoPath: "/repo/contextStill",
      },
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "repo",
      uri: "file:///repo/contextStill/docs/sqlite.md",
      title: "SQLite backend notes",
      body: "SQLite backend mode stores compile run snapshots and source fragments locally.",
      metadata: { repoPath: "/repo/contextStill", repoKey: "contextstill" },
    });

    const { pack, markdown } = await compileContextPack(
      {
        goal: "SQLite backend mode migration",
        technologies: ["sqlite"],
        changeTypes: ["migration"],
        repoPath: "/repo/contextStill",
      },
      { source: "cli" },
    );

    expect(pack.runId).toBeTruthy();
    expect(markdown.length).toBeGreaterThan(0);
    expect(pack.rules.map((item) => item.title)).toContain("SQLite compile rule");

    const recentRuns = await listRecentCompileRuns(5);
    expect(recentRuns.map((run) => run.id)).toContain(pack.runId);
    const snapshot = await getCompileRunSnapshot(pack.runId);
    expect(snapshot?.run.id).toBe(pack.runId);
    expect(snapshot?.items.some((item) => item.itemId === pack.rules[0]?.itemId)).toBe(true);
  }, 15_000);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
