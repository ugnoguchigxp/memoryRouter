import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";
import { deprecateRunEpisodeForRepository } from "../api/modules/context-compiler/context-compiler.repository.js";
import {
  fetchOverviewDashboardForApi,
  fetchOverviewDomainForApi,
} from "../api/modules/overview/overview.repository.js";
import {
  fetchActiveTasks,
  fetchQueueDashboardStats,
  listQueueItems,
} from "../api/modules/queue/queue.repository.js";
import { repairEpisodeCardQuality } from "../src/cli/repair-episode-card-quality.js";
import { resetLowQualityEpisodeCards } from "../src/cli/reset-low-quality-episode-cards.js";
import { groupedConfig } from "../src/config.js";
import { openSqliteCoreDatabase } from "../src/db/sqlite/client.js";
import { resetRuntimeSqliteCoreDatabaseForTests } from "../src/db/sqlite/runtime.js";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import {
  cleanupExpiredAuditLogs,
  listAuditLogs,
  recordAuditLog,
} from "../src/modules/audit/audit-log.service.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "../src/modules/context-compiler/context-compile-eval.repository.js";
import { recordCompileEval } from "../src/modules/context-compiler/context-compile-eval.service.js";
import {
  findContextCompileTaskTraceByRunId,
  upsertContextCompileTaskTrace,
} from "../src/modules/context-compiler/context-compile-task-trace.repository.js";
import {
  getCompileRunDetail,
  getCompileRunRankingTrace,
  insertCompileRun,
  listRecentCompileRuns,
  saveRunEpisodeFeedback,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  getContextDecisionDetail,
  getContextDecisionMetrics,
  insertContextDecisionCoverageRows,
  insertContextDecisionEvidenceRows,
  insertContextDecisionRun,
  listContextDecisionRuns,
  saveHumanDecisionFeedback,
} from "../src/modules/context-decision/context-decision.repository.js";
import { inspectDatabase } from "../src/modules/doctor/inspectors/database.inspector.js";
import {
  enqueueEpisodeDistillerJob,
  requeueEpisodeDistillerRepairCandidates,
} from "../src/modules/episodeDistiller/repository.js";
import { setEpisodeDistillerTestHooksForTests } from "../src/modules/episodeDistiller/worker.js";
import {
  createEpisode,
  fetchEpisode,
  searchEpisodes,
} from "../src/modules/episodic-memory/episode-card.service.js";
import { recordCompileRunKnowledgeFeedback } from "../src/modules/knowledge/knowledge-feedback.service.js";
import { readVibeMemoryByTokenWindow } from "../src/modules/memoryReader/reader.service.js";
import {
  claimNextJobWithProviderLease,
  releaseProviderLease,
} from "../src/modules/queue/core/provider-lease.js";
import {
  enabledProviderPoolsForQueues,
  priorityQueuesForProviderPool,
} from "../src/modules/queue/core/scheduler.js";
import { retryQueueJob } from "../src/modules/queue/core/state.js";
import {
  enqueueFindingJob,
  runQueueWorkerOnce,
  setQueueWorkerTestHooksForTests,
} from "../src/modules/queue/core/worker.js";
import {
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "../src/modules/settings/settings.repository.js";
import {
  getRuntimeSettingsSnapshot,
  saveRuntimeSettings,
} from "../src/modules/settings/settings.service.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";

let tempDir = "";
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("sqlite runtime support repositories", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-runtime-"));
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(tempDir, "context-still-core.sqlite");
    groupedConfig.distillation.internalChunkedDistillationEnabled = false;
    resetRuntimeSqliteCoreDatabaseForTests();
  });

  afterEach(async () => {
    setEpisodeDistillerTestHooksForTests({});
    setQueueWorkerTestHooksForTests({});
    groupedConfig.distillation.internalChunkedDistillationEnabled = false;
    restoreEnv("CONTEXT_STILL_DB_BACKEND", originalBackend);
    restoreEnv("CONTEXT_STILL_SQLITE_CORE_PATH", originalSqlitePath);
    restoreEnv("DATABASE_URL", originalDatabaseUrl);
    resetRuntimeSqliteCoreDatabaseForTests();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("persists settings rows in sqlite", async () => {
    const saved = await upsertSettingsRow({
      namespace: "runtime",
      key: "sqlite-test",
      value: { enabled: true },
      schemaVersion: 1,
      updatedBy: "sqlite-test",
    });

    expect(saved.value).toEqual({ enabled: true });
    expect(await findSettingsRow("runtime", "sqlite-test")).toMatchObject({
      namespace: "runtime",
      key: "sqlite-test",
      value: { enabled: true },
      updatedBy: "sqlite-test",
    });
    expect((await listSettingsRows("runtime")).map((row) => row.key)).toContain("sqlite-test");

    await deleteSettingsRow("runtime", "sqlite-test");
    expect(await findSettingsRow("runtime", "sqlite-test")).toBeNull();
  });

  test("preserves legacy sqlite episode cards while adding current score columns", async () => {
    const sqliteModule = await import("bun:sqlite");
    const dbPath = path.join(tempDir, "legacy-episode-cards.sqlite");
    const legacyDb = new sqliteModule.Database(dbPath, { create: true });
    legacyDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE episode_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        situation TEXT NOT NULL,
        observations TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        lesson TEXT NOT NULL DEFAULT '',
        applicability TEXT NOT NULL DEFAULT '{}',
        anti_applicability TEXT NOT NULL DEFAULT '{}',
        domains TEXT NOT NULL DEFAULT '[]',
        technologies TEXT NOT NULL DEFAULT '[]',
        change_types TEXT NOT NULL DEFAULT '[]',
        tools TEXT NOT NULL DEFAULT '[]',
        repo_path TEXT,
        repo_key TEXT,
        source_kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        outcome_kind TEXT NOT NULL DEFAULT 'unknown',
        confidence INTEGER NOT NULL DEFAULT 50,
        evidence_status TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        stale_at TEXT,
        embedding TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE UNIQUE INDEX episode_cards_source_unique_idx
        ON episode_cards(source_kind, source_key);
      CREATE VIRTUAL TABLE episode_cards_fts USING fts5(
        id UNINDEXED,
        title,
        situation,
        observations,
        action,
        outcome,
        lesson
      );
      CREATE TABLE episode_refs (
        id TEXT PRIMARY KEY,
        episode_card_id TEXT NOT NULL,
        ref_kind TEXT NOT NULL,
        ref_value TEXT NOT NULL,
        locator TEXT,
        query_hint TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (episode_card_id) REFERENCES episode_cards(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE episode_retrieval_feedback (
        id TEXT PRIMARY KEY,
        episode_card_id TEXT NOT NULL,
        run_kind TEXT NOT NULL,
        run_id TEXT NOT NULL,
        used_for TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (episode_card_id) REFERENCES episode_cards(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO episode_cards (
        id, title, situation, source_kind, source_key, outcome_kind, confidence, status, evidence_status
      ) VALUES (
        'legacy-episode', 'Legacy episode', 'Created before score columns',
        'vibe_memory', 'legacy-source', 'success', 77, 'draft', 'verified'
      );
      INSERT INTO episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
      VALUES (1, 'legacy-episode', 'Legacy episode', 'Created before score columns', '', '', '', '');
      INSERT INTO episode_refs (id, episode_card_id, ref_kind, ref_value)
      VALUES ('legacy-ref', 'legacy-episode', 'vibe_memory', 'legacy-source');
    `);
    legacyDb.close();

    const opened = await openSqliteCoreDatabase({
      path: dbPath,
      loadVectorExtension: false,
    });
    try {
      const row = opened.db
        .query<
          {
            id: string;
            status: string;
            importance: number;
            compile_use_count: number;
            decision_use_count: number;
          },
          []
        >(
          "select id, status, importance, compile_use_count, decision_use_count from episode_cards where id = 'legacy-episode'",
        )
        .get();
      expect(row).toEqual({
        id: "legacy-episode",
        status: "active",
        importance: 50,
        compile_use_count: 0,
        decision_use_count: 0,
      });
      expect(
        opened.db
          .query<{ has_evidence_status: number }, []>(
            "select count(*) as has_evidence_status from pragma_table_info('episode_cards') where name = 'evidence_status'",
          )
          .get()?.has_evidence_status,
      ).toBe(0);
      expect(
        opened.db
          .query<{ ref_count: number }, []>("select count(*) as ref_count from episode_refs")
          .get()?.ref_count,
      ).toBe(1);
    } finally {
      opened.db.close();
    }
  });

  test("persists and searches episode cards in sqlite", async () => {
    const episode = await createEpisode({
      scope: "repo",
      repoPath: "/repo/contextStill",
      title: "SQLite episode recovery",
      situation: "A SQLite migration failed while compiling context.",
      action: "Ran the sqlite runtime support test and fixed schema bootstrap.",
      outcome: "The runtime repository could read the new tables.",
      lesson: "Add SQLite schema changes to core bootstrap before wiring MCP tools.",
      sourceKind: "manual",
      sourceKey: "sqlite-runtime-support-episode",
      outcomeKind: "success",
      confidence: 90,
      domains: ["episodic-memory"],
      technologies: ["sqlite", "typescript"],
      changeTypes: ["schema"],
      refs: [{ refKind: "file", refValue: "src/db/sqlite/core-schema.ts" }],
    });

    expect(episode.refs[0]?.refKind).toBe("file");
    expect((await fetchEpisode(episode.id))?.title).toBe("SQLite episode recovery");

    const hits = await searchEpisodes({
      query: "schema bootstrap",
      repoPath: "/repo/contextStill",
      technologies: ["sqlite"],
      limit: 5,
    });
    expect(hits[0]?.id).toBe(episode.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test("persists and cleans audit logs in sqlite", async () => {
    await recordAuditLog({
      eventType: "SQLITE_RUNTIME_TEST",
      actor: "system",
      payload: { apiKey: "secret-value", ok: true },
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await recordAuditLog({
      eventType: "SQLITE_RUNTIME_TEST",
      actor: "agent",
      payload: { ok: true },
    });

    const listed = await listAuditLogs({
      eventType: "SQLITE_RUNTIME_TEST",
      limit: 10,
    });
    expect(listed.total).toBe(2);
    expect(listed.availableEventTypes).toContain("SQLITE_RUNTIME_TEST");
    expect(listed.items.some((item) => item.actor === "agent")).toBe(true);
    expect(JSON.stringify(listed.items)).not.toContain("secret-value");

    const cleanup = await cleanupExpiredAuditLogs({
      retentionDays: 7,
      trigger: "sqlite-test",
    });
    expect(cleanup.deletedCount).toBe(1);
    const remaining = await listAuditLogs({
      eventType: "SQLITE_RUNTIME_TEST",
      limit: 10,
    });
    expect(remaining.total).toBe(1);
  });

  test("persists compile evals and resolves latest session run in sqlite", async () => {
    const runId = await insertCompileRun({
      goal: "sqlite compile eval",
      intent: "implementation",
      sessionId: "sqlite-session",
      repoPath: "/repo/contextStill",
      input: { goal: "sqlite compile eval" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "mcp",
    });

    const explicit = await recordCompileEval({
      input: {
        runId,
        outcome: "useful",
        body: "explicit eval",
        relevance: 90,
        actionability: 80,
        coverage: 70,
        clarity: 60,
        specificity: 50,
      },
      requestMeta: { sessionId: "sqlite-session" },
      source: "mcp",
    });
    expect(explicit.evaluation.runId).toBe(runId);
    expect(explicit.evaluation.avg).toBe(70);

    const resolved = await recordCompileEval({
      input: {
        outcome: "partial",
        body: "resolved eval",
        relevance: 80,
        actionability: 80,
        coverage: 80,
        clarity: 80,
        specificity: 80,
      },
      requestMeta: { sessionId: "sqlite-session" },
      source: "mcp",
    });
    expect(resolved.resolvedFrom).toBe("latest_session_run");
    expect(resolved.evaluation.runId).toBe(runId);

    const summary = await getCompileEvalSummaryByRunId(runId);
    expect(summary.count).toBe(2);
    expect(summary.latestOutcome).toBe("partial");
    expect((await listCompileEvalsByRunId(runId)).map((row) => row.body)).toEqual([
      "resolved eval",
      "explicit eval",
    ]);
    expect((await listRecentCompileRuns(1))[0]?.evalSummary.count).toBe(2);
  });

  test("persists normalized compile project identity in sqlite run and task trace", async () => {
    const runId = await insertCompileRun({
      goal: "sqlite project identity",
      intent: "implementation",
      projectRef: "project-A",
      repoKey: "org/repo-a",
      repoPath: "/work/repo-a",
      matchBasis: "project_ref",
      identityContractVersion: 1,
      scopeMode: "project",
      input: { goal: "sqlite project identity" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "mcp",
    });
    await upsertContextCompileTaskTrace({
      runId,
      retrievalMode: "task_context",
      projectRef: "project-A",
      repoKey: "org/repo-a",
      repoPath: "/work/repo-a",
      matchBasis: "project_ref",
      identityContractVersion: 1,
      scopeMode: "project",
      identityFingerprint: "a".repeat(64),
      identityTrust: "request_hint",
      bindingStatus: "verified",
      technologies: ["sqlite"],
      changeTypes: ["implementation"],
      domains: ["context-compiler"],
      embeddingStatus: "facets_only",
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embedding: null,
      goalHash: "goal-hash",
    });

    const trace = await findContextCompileTaskTraceByRunId(runId);
    expect(trace).toMatchObject({
      projectRef: "project-A",
      repoKey: "org/repo-a",
      repoPath: "/work/repo-a",
      matchBasis: "project_ref",
      identityContractVersion: 1,
      scopeMode: "project",
      identityFingerprint: "a".repeat(64),
      identityTrust: "request_hint",
      bindingStatus: "verified",
    });
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const run = sqlite.db
      .query<
        {
          project_ref: string;
          repo_key: string;
          repo_path: string;
          match_basis: string;
          identity_contract_version: number;
          scope_mode: string;
        },
        [string]
      >(
        "SELECT project_ref, repo_key, repo_path, match_basis, identity_contract_version, scope_mode FROM context_compile_runs WHERE id = ?",
      )
      .get(runId);
    expect(run).toEqual({
      project_ref: "project-A",
      repo_key: "org/repo-a",
      repo_path: "/work/repo-a",
      match_basis: "project_ref",
      identity_contract_version: 1,
      scope_mode: "project",
    });
  });

  test("persists compile run knowledge feedback and reflects it in sqlite run detail", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    const knowledgeId = "550e8400-e29b-41d4-a716-446655440001";

    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        knowledgeId,
        "rule",
        "active",
        "repo",
        "positive",
        "[]",
        "SQLite feedback rule",
        "Use when SQLite feedback needs to be reflected.",
        "{}",
        80,
        80,
        "{}",
        now,
        now,
      );

    const runId = await insertCompileRun({
      goal: "sqlite feedback detail",
      intent: "implementation",
      input: { goal: "sqlite feedback detail" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "ui",
    });

    const pack = {
      runId,
      goal: "sqlite feedback detail",
      retrievalMode: "task_context",
      status: "ok",
      minimalTasks: [],
      rules: [
        {
          id: "rule-1",
          itemKind: "rule",
          itemId: knowledgeId,
          section: "rules",
          title: "SQLite feedback rule",
          content: "Use when SQLite feedback needs to be reflected.",
          score: 0.9,
          rankingReason: "selected",
          sourceRefs: [],
        },
      ],
      procedures: [],
      guardrails: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: {
        degradedReasons: [],
        retrievalStats: {},
      },
    };

    sqlite.db
      .query("update context_compile_runs set pack_snapshot = ? where id = ?")
      .run(JSON.stringify(pack), runId);
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", knowledgeId, "rules", 0.9, "selected", "[]", now);
    sqlite.db
      .query(
        `
        insert into context_compile_candidate_traces (
          run_id, item_kind, item_id, final_rank, final_score, selected, agentic_decision,
          ranking_reason, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", knowledgeId, 1, 0.9, 1, "accepted", "selected", now);

    const result = await recordCompileRunKnowledgeFeedback({
      runId,
      actor: "user",
      items: [{ knowledgeId, verdict: "used" }],
    });
    expect(result.savedCount).toBe(1);

    const detail = await getCompileRunDetail(runId);
    expect(detail?.knowledgeFeedback).toHaveLength(1);
    expect(detail?.knowledgeSignals[0]?.effectiveVerdict).toBe("used");
    expect(detail?.knowledgeSignals[0]?.effectiveActor).toBe("user");

    const trace = await getCompileRunRankingTrace(runId);
    expect(trace?.items[0]?.feedback.verdict).toBe("used");
    expect(trace?.feedbackSummary.used).toBe(1);
    expect(trace?.feedbackSummary.noSignal).toBe(0);
  });

  test("reads rust-native sqlite_text compile run detail and ranking trace", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:10:00.000Z").toISOString();
    const runCreatedAt = "unix-ms:1782133114211";
    const expectedRunCreatedAt = new Date(1782133114211).toISOString();
    const knowledgeId = "550e8400-e29b-41d4-a716-446655440011";
    const episodeId = "550e8400-e29b-41d4-a716-446655440013";

    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        knowledgeId,
        "rule",
        "active",
        "repo",
        "positive",
        "[]",
        "Rust native compile rule",
        "Use when reading Rust-native compile history.",
        "{}",
        80,
        80,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into episode_cards (
          id, title, situation, source_kind, source_key, outcome_kind, status,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        episodeId,
        "Rust native episode",
        "Rust-native compile wrote an episode precedent.",
        "manual",
        "rust-native-episode",
        "success",
        "active",
        now,
        now,
      );

    const runId = await insertCompileRun({
      goal: "rust native sqlite_text detail",
      intent: "mcp_context_compile",
      input: { goal: "rust native sqlite_text detail" },
      retrievalMode: "sqlite_text",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 0,
      durationMs: 12,
      source: "mcp",
    });

    const pack = {
      runId,
      goal: "rust native sqlite_text detail",
      rules: [
        {
          id: knowledgeId,
          type: "rule",
          title: "Rust native compile rule",
          body: "Use when reading Rust-native compile history.",
          polarity: "positive",
          score: 0.9,
          sourceRefs: [],
        },
      ],
      procedures: [],
      episodes: [
        {
          id: episodeId,
          title: "Rust native episode",
          situation: "Rust-native compile wrote an episode precedent.",
          lesson: "Normalize Rust-native pack snapshots before rendering detail.",
          score: 8,
        },
      ],
      outputMarkdown: "# Context Pack\n\nRust-native compile output.",
      diagnostics: {
        engine: "rust-native",
        degradedReasons: [],
        selectedKnowledge: 1,
        selectedEpisodes: 1,
      },
    };

    sqlite.db
      .query(
        "update context_compile_runs set pack_snapshot = ?, created_at = ?, source = ? where id = ?",
      )
      .run(JSON.stringify(pack), runCreatedAt, "mcp-rust", runId);
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "knowledge", knowledgeId, "rules", 0.9, "rust_native_text_score", "[]", now);
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "episode", episodeId, "episodes", 0.8, "rust_native_episode_score", "[]", now);
    sqlite.db
      .query(
        `
        insert into knowledge_usage_events (
          id, run_id, knowledge_id, verdict, actor, reason, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "550e8400-e29b-41d4-a716-446655440014",
        runId,
        knowledgeId,
        "used",
        "agent",
        "Composer used this rule.",
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into episode_retrieval_feedback (
          id, episode_card_id, run_kind, run_id, used_for, verdict, reason, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "550e8400-e29b-41d4-a716-446655440015",
        episodeId,
        "compile",
        runId,
        "compile",
        "not_relevant",
        "Episode was selected but not used.",
        JSON.stringify({ actor: "user" }),
        now,
      );
    sqlite.db
      .query(
        `
        insert into context_compile_candidate_traces (
          run_id, item_kind, item_id, final_rank, final_score, selected, agentic_decision,
          ranking_reason, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", knowledgeId, 1, 0.9, 1, "accepted", "selected", now);
    sqlite.db
      .query(
        `
        insert into context_compile_evals (
          id, run_id, session_id, score, outcome, title, body, source, metadata,
          relevance, actionability, coverage, clarity, specificity, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "550e8400-e29b-41d4-a716-446655440012",
        runId,
        null,
        88,
        "useful",
        "rust eval",
        "eval body",
        "mcp",
        "{}",
        88,
        88,
        88,
        88,
        88,
        runCreatedAt,
        runCreatedAt,
      );

    const detail = await getCompileRunDetail(runId);
    expect(detail?.run.retrievalMode).toBe("sqlite_text");
    expect(detail?.run.source).toBe("mcp");
    expect(detail?.run.createdAt).toBe(expectedRunCreatedAt);
    expect(detail?.run.evalSummary.latestEvaluatedAt).toBe(expectedRunCreatedAt);
    expect(detail?.pack?.retrievalMode).toBe("sqlite_text");
    expect(detail?.pack?.rules[0]?.itemKind).toBe("rule");
    expect(detail?.pack?.procedures[0]?.itemKind).toBe("episode_card");
    expect(detail?.outputMarkdown).toContain("Rust-native compile output");
    expect(detail?.snapshotAvailable).toBe(true);
    expect(detail?.evaluations[0]?.createdAt).toBe(expectedRunCreatedAt);
    expect(detail?.knowledgeSignals[0]).toMatchObject({
      knowledgeId,
      itemKind: "rule",
      effectiveVerdict: "used",
      effectiveActor: "agent",
    });
    expect(detail?.episodeSignals[0]).toMatchObject({
      episodeId,
      effectiveVerdict: "not_used",
      effectiveActor: "user",
      effectiveReason: "Episode was selected but not used.",
    });
    const episodeFeedback = await saveRunEpisodeFeedback({
      runId,
      items: [
        {
          episodeId,
          verdict: "wrong",
          reason: "Wrong precedent for this run.",
        },
      ],
    });
    expect(episodeFeedback.savedCount).toBe(1);
    const detailAfterEpisodeFeedback = await getCompileRunDetail(runId);
    expect(detailAfterEpisodeFeedback?.episodeSignals[0]).toMatchObject({
      episodeId,
      effectiveVerdict: "wrong",
      effectiveActor: "user",
      effectiveReason: "Wrong precedent for this run.",
    });
    await deprecateRunEpisodeForRepository({ runId, episodeId });
    expect(
      sqlite.db
        .query<{ status: string }, [string]>("select status from episode_cards where id = ?")
        .get(episodeId)?.status,
    ).toBe("deprecated");
    sqlite.db
      .query(
        `
        insert into episode_cards (
          id, title, situation, source_kind, source_key, outcome_kind, status,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "550e8400-e29b-41d4-a716-446655440016",
        "Unselected episode",
        "This episode is not selected by the run.",
        "manual",
        "unselected-rust-native-episode",
        "unknown",
        "active",
        now,
        now,
      );
    await expect(
      deprecateRunEpisodeForRepository({
        runId,
        episodeId: "550e8400-e29b-41d4-a716-446655440016",
      }),
    ).rejects.toThrow("Episode ID is not in selected items for this run");

    const trace = await getCompileRunRankingTrace(runId);
    expect(trace?.run.retrievalMode).toBe("sqlite_text");
    expect(trace?.run.createdAt).toBe(expectedRunCreatedAt);
    expect(trace?.items[0]?.itemId).toBe(knowledgeId);
    expect(trace?.items[0]?.packed).toBe(true);
    expect(trace?.items[0]?.feedback.verdict).toBe("used");

    sqlite.db.query("delete from context_compile_candidate_traces where run_id = ?").run(runId);
    const fallbackTrace = await getCompileRunRankingTrace(runId);
    expect(fallbackTrace?.items[0]).toMatchObject({
      itemId: knowledgeId,
      textRank: 1,
      mergedRank: 1,
      finalRank: 1,
      selected: true,
      packed: true,
      rankingReason: "rust_native_text_score",
    });
    expect(fallbackTrace?.feedbackSummary.used).toBe(1);
  });

  test("inspects sqlite core database without requiring postgres-only tables", async () => {
    const inspection = await inspectDatabase({
      freshnessThresholdMinutes: 720,
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    });

    expect(inspection.reachable).toBe(true);
    expect(inspection.expectedTables).toContain("knowledge_items");
    expect(inspection.expectedTables).toContain("context_compile_runs");
    expect(inspection.expectedTables).toContain("finding_candidate_queue");
    expect(inspection.expectedTables).toContain("vibe_memories");
    expect(inspection.expectedTables).toContain("context_decision_runs");
    expect(inspection.missingTables).not.toContain("finding_candidate_queue");
    expect(inspection.reasons).not.toContain("SQLITE_PENDING_MIGRATION_DOMAINS");
  });

  test("persists vibe memories and diff entries in sqlite", async () => {
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "sqlite-vibe-session",
      content: "SQLite ingest memory about queue migration.",
      memoryType: "chat",
      diff: "diff --git a/src/sqlite.ts b/src/sqlite.ts\n+queue migration marker",
      agentDiffs: [
        {
          filePath: "src/sqlite.ts",
          diffHunk: "+sqlite memory marker",
          changeType: "modify",
          language: "typescript",
          symbolName: "sqliteMemory",
        },
      ],
      metadata: { apiKey: "secret-value" },
    });

    expect(recorded.memory.id).toBeTruthy();
    expect(recorded.diffEntries.length).toBeGreaterThan(0);

    const memories = await retrieveVibeMemoryContext({
      query: "queue migration marker",
      sessionId: "sqlite-vibe-session",
      limit: 5,
    });
    expect(memories.map((memory: { id: string }) => memory.id)).toContain(recorded.memory.id);
    expect(JSON.stringify(memories)).not.toContain("secret-value");

    const read = await readVibeMemoryByTokenWindow({
      vibeMemoryId: recorded.memory.id,
      readTokens: 200,
      mode: "original",
    });
    expect(read.content).toContain("SQLite ingest memory");
    expect(read.content).toContain("sqlite memory marker");
  });

  test("persists context decision runs, evidence, and feedback in sqlite", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const decisionId = await insertContextDecisionRun({
      input: {
        decisionPoint: "Should SQLite context decision run?",
        sessionId: "sqlite-decision-session",
        retrievalHints: {
          technologies: ["sqlite"],
          changeTypes: ["migration"],
          domains: [],
        },
        metadata: { branch: "sqlite-test" },
      },
      decision: "execute",
      selectedAction: "implement sqlite branch",
      rejectedActions: ["wait"],
      mandate: "Implement the SQLite branch.",
      agentMessage: "Proceed with SQLite context decision.",
      confidence: 82,
      confidenceTrace: { evidence: 1 },
      guardrails: { commit: false },
      unsupportedAlternatives: [],
      status: "completed",
    });
    const createdAtUnixMs = 1782175198000;
    const expectedCreatedAt = new Date(createdAtUnixMs).toISOString();
    sqlite.db
      .query("update context_decision_runs set created_at = ?, updated_at = ? where id = ?")
      .run(`unix-ms:${createdAtUnixMs}`, `unix-ms:${createdAtUnixMs}`, decisionId);
    await insertContextDecisionEvidenceRows(decisionId, [
      {
        knowledgeId: null,
        role: "selected_support",
        weightAtDecision: 80,
        dynamicScoreAtDecision: null,
        applicabilityScore: 70,
        temporalRelevance: null,
        summary: "SQLite evidence",
        sourceRefs: ["sqlite://evidence"],
        metadata: { ok: true },
      },
    ]);
    await insertContextDecisionCoverageRows(decisionId, [
      {
        query: "sqlite migration",
        queryRole: "support",
        scope: { repo: "contextStill" },
        hitCount: 1,
        maxSimilarity: null,
        selectedKnowledgeIds: [],
        rejectedKnowledgeIds: [],
        reason: "covered",
      },
    ]);
    await saveHumanDecisionFeedback({
      decisionId,
      value: "good",
      affectedKnowledgeIds: [],
    });

    const detail = await getContextDecisionDetail(decisionId);
    expect(detail?.run.decision).toBe("execute");
    expect(detail?.run.createdAt).toBe(expectedCreatedAt);
    expect(detail?.evidence[0]?.summary).toBe("SQLite evidence");
    expect(detail?.coverage[0]?.query).toBe("sqlite migration");
    expect(detail?.run.humanFeedback).toBe("good");
    const runs = await listContextDecisionRuns({ limit: 10 });
    expect(runs.find((run) => run.id === decisionId)?.createdAt).toBe(expectedCreatedAt);

    const metrics = await getContextDecisionMetrics();
    expect(metrics.totalDecisions).toBe(1);
    expect(metrics.goodFeedbackCount).toBe(1);
  });

  test("returns idle queue worker result from empty sqlite queues", async () => {
    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "sqlite-worker",
    });

    expect(result.ok).toBe(true);
    expect(result.idle).toBe(true);
    expect(result.message).toBe("no runnable job");
  });

  test("distills vibe memory episodes from sqlite episodeDistiller queue idempotently", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "repo",
      repoPath: "/repo/contextStill",
      sessionId: "episode-distiller-session",
      content:
        "The implementation separated Episode generation from findCandidate and kept source refs for later review.",
      memoryType: "chat",
      metadata: {
        projectName: "legacy-wrong-project",
        cwd: "/legacy/wrong-root",
      },
      agentDiffs: [
        {
          filePath: "src/modules/episodeDistiller/worker.ts",
          diffHunk: "@@ added worker @@\n+processEpisodeDistillerJob()",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });

    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "test" },
    });
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [
        {
          title: "Episode distiller queue split",
          context: "Episode generation moved out of findCandidate.",
          intent: "Keep candidate extraction and task memory creation independent.",
          keyDecisions: ["Use a separate episodeDistiller queue."],
          actionTaken: "Implemented episodeDistiller queue persistence and source-span refs.",
          outcome: "Episode generation was split from findCandidate and saved with source refs.",
          failedApproach: "Creating one EpisodeCard directly from findCandidate.",
          reusableLesson: "Keep EpisodeCard creation idempotent with source span based keys.",
          usefulFutureTriggers: ["episode queue", "source refs"],
          openLoops: ["Review quality scores after real LLM runs."],
          generationKind: "task_episode",
          outcomeKind: "success",
          domains: ["episodic-memory"],
          technologies: ["sqlite", "typescript"],
          changeTypes: ["queue"],
          tools: ["vitest"],
          scores: {
            importance: 88,
            confidence: 82,
            reusability: 0.85,
            decision_density: 80,
            failure_value: 70,
            causal_clarity: 90,
            project_specificity: 50,
            evidence_quality: 85,
            compression_quality: 80,
            staleness_risk: 20,
          },
        },
      ],
    });

    const firstRun = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-worker",
    });

    expect(firstRun.ok).toBe(true);
    expect(firstRun.completedJobId).toBe(job.id);
    const completedJob = sqlite.db
      .query<{ status: string; last_outcome_kind: string }, [string]>(
        "select status, last_outcome_kind from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    expect(completedJob).toEqual({
      status: "completed",
      last_outcome_kind: "episodes_distilled",
    });

    const episodes = await searchEpisodes({
      query: "queue split",
      repoPath: "/repo/contextStill",
      technologies: ["sqlite"],
      limit: 10,
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.refs[0]).toMatchObject({
      refKind: "vibe_memory",
      refValue: recorded.memory.id,
    });
    expect(episodes[0]?.metadata).toMatchObject({
      source: "episodeDistiller",
      episodeDistillation: expect.objectContaining({
        generatingQueueName: "episodeDistiller",
        parentVibeMemoryId: recorded.memory.id,
        scores: expect.objectContaining({
          importance: 88,
          confidence: 80,
          reusability: 85,
        }),
        valueReview: expect.objectContaining({
          publish: true,
          reasons: [],
        }),
      }),
    });
    const episodeRow = sqlite.db
      .query<
        {
          status: string;
          situation: string;
          action: string;
          outcome: string;
          anti_applicability: string;
          classification_status: string;
          scope: string;
          repo_path: string | null;
          repo_key: string | null;
        },
        [string]
      >(
        "select status, situation, action, outcome, anti_applicability, classification_status, scope, repo_path, repo_key from episode_cards where id = ?",
      )
      .get(episodes[0]?.id ?? "");
    expect(episodeRow?.status).toBe("active");
    expect(episodeRow?.situation).toBe("Episode generation moved out of findCandidate.");
    expect(episodeRow?.situation).not.toContain("Intent:");
    expect(episodeRow?.situation).not.toContain("意図:");
    expect(episodeRow?.action).toContain("Implemented episodeDistiller queue persistence");
    expect(episodeRow?.action).toContain("失敗した、または避けたアプローチ:");
    expect(episodeRow?.action).not.toContain("source 時点の未解決事項:");
    expect(episodeRow?.action).not.toContain("Failed approach:");
    expect(episodeRow?.action).not.toContain("Open loops:");
    expect(episodeRow?.outcome).toBe(
      "Episode generation was split from findCandidate and saved with source refs.",
    );
    expect(episodeRow).toMatchObject({
      classification_status: "classified",
      scope: "repo",
      repo_path: "/repo/contextStill",
      repo_key: null,
    });
    const persistedEpisodeWrite = sqlite.db
      .query<{ payload: string }, [string]>(
        `select payload
           from audit_logs
          where event_type = 'PROJECT_IDENTITY_PRODUCER_PERSISTED'
            and json_extract(payload, '$.entityId') = ?
          limit 1`,
      )
      .get(episodes[0]?.id ?? "");
    expect(JSON.parse(persistedEpisodeWrite?.payload ?? "{}")).toMatchObject({
      producer: "episode-distiller.typescript",
      entityKind: "episode",
      entityId: episodes[0]?.id,
      matchBasis: "repo_path",
    });
    expect(JSON.parse(episodeRow?.anti_applicability ?? "{}")).toMatchObject({
      openLoops: ["Review quality scores after real LLM runs."],
    });
    const completedMetadataRow = sqlite.db
      .query<{ metadata: string }, [string]>(
        "select metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    const completedMetadata = JSON.parse(completedMetadataRow?.metadata ?? "{}");
    expect(completedMetadata.episodeDistiller).toMatchObject({
      generated: 1,
      valueSkipped: 0,
      acceptedCandidateCount: 1,
    });

    sqlite.db
      .query("delete from episode_refs where episode_card_id = ?")
      .run(episodes[0]?.id ?? "");
    sqlite.db.query("delete from episode_cards_fts where id = ?").run(episodes[0]?.id ?? "");
    sqlite.db.query("delete from episode_cards where id = ?").run(episodes[0]?.id ?? "");
    const repairDryRun = await requeueEpisodeDistillerRepairCandidates({
      limit: 10,
    });
    expect(repairDryRun.write).toBe(false);
    expect(repairDryRun.items.map((item) => item.id)).toContain(job.id);
    expect(repairDryRun.items.find((item) => item.id === job.id)?.reason).toBe(
      "missing_episode_cards",
    );

    const repairWrite = await requeueEpisodeDistillerRepairCandidates({
      limit: 10,
      write: true,
    });
    expect(repairWrite.requeued).toBeGreaterThanOrEqual(1);
    expect(
      sqlite.db
        .query<{ status: string; last_outcome_kind: string }, [string]>(
          "select status, last_outcome_kind from episode_distiller_queue where id = ?",
        )
        .get(job.id),
    ).toEqual({
      status: "pending",
      last_outcome_kind: "episode_repair_requeued",
    });

    const repairRun = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-repair-worker",
    });
    expect(repairRun.ok).toBe(true);
    expect(repairRun.completedJobId).toBe(job.id);
    expect(
      await searchEpisodes({
        query: "queue split",
        repoPath: "/repo/contextStill",
        technologies: ["sqlite"],
        limit: 10,
      }),
    ).toHaveLength(1);

    await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "test-rerun" },
    });
    const secondRun = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-worker",
    });
    expect(secondRun.ok).toBe(true);
    expect(
      await searchEpisodes({
        query: "queue split",
        repoPath: "/repo/contextStill",
        technologies: ["sqlite"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  test("uses semantic chunks inside episodeDistiller queue jobs when enabled", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-chunked-session",
      content:
        "The queue investigation found a stale worker lease. Restarting the owner process restored episode processing.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ inspected lease recovery @@\n+verify owner pid",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "test" },
    });

    setEpisodeDistillerTestHooksForTests({
      semanticChunks: async ({ windows }) => [
        {
          chunkIndex: 0,
          sourceStartOffset: windows[0]?.sourceStartOffset ?? 0,
          sourceEndOffset: windows[0]?.sourceEndOffset ?? 1,
          eventIds: windows[0]?.eventIds ?? [],
          taskBoundaryKind: "failure_resolution",
          title: "Queue stale worker recovery",
          boundaryReason: "The source contains the failed state, cause, and recovery.",
          expectedOutputs: ["episode"],
          openBoundary: false,
        },
      ],
      distillSegment: async () => [
        {
          title: "Queue stale worker recovery",
          context: "Episode queue processing was blocked by stale worker ownership.",
          intent: "Restore queue progress using live runtime truth.",
          keyDecisions: ["Verify the worker owner and lease before trusting queue counts."],
          actionTaken: "Inspected the stale lease and restarted the owner process.",
          outcome: "Episode queue processing resumed after ownership was corrected.",
          failedApproach: "Treating queue counts alone as proof of progress.",
          reusableLesson: "Use live worker ownership and lease state when queue progress stalls.",
          usefulFutureTriggers: ["episode queue stall", "stale lease"],
          openLoops: [],
          generationKind: "failure_episode",
          outcomeKind: "success",
          domains: ["queue"],
          technologies: ["sqlite", "typescript"],
          changeTypes: ["debugging"],
          tools: ["bun"],
          scores: {
            importance: 90,
            confidence: 80,
            reusability: 85,
            decision_density: 80,
            failure_value: 85,
            causal_clarity: 90,
            project_specificity: 75,
            evidence_quality: 80,
            compression_quality: 80,
            staleness_risk: 20,
          },
        },
      ],
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-chunked-worker",
    });

    expect(run.ok).toBe(true);
    const completedMetadataRow = sqlite.db
      .query<{ metadata: string }, [string]>(
        "select metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    const metadata = JSON.parse(completedMetadataRow?.metadata ?? "{}");
    expect(metadata.episodeDistiller).toMatchObject({
      pipelineVersion: "internal-chunked-v1",
      sourceWindowCount: 1,
      semanticChunkCount: 1,
      generated: 1,
      acceptedCandidateCount: 1,
    });
  });

  test("uses LLM review to skip near-duplicate EpisodeCards before insert", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-near-duplicate-session",
      content: "A normalize.ts utility module was added and later summarized again.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/shared/utils/normalize.ts",
          diffHunk:
            "@@ add normalize helpers @@\n+export function asStringArray(value: unknown): string[] { return []; }",
          changeType: "add",
          language: "typescript",
          symbolName: "asStringArray",
        },
        {
          filePath: "src/shared/utils/normalize.ts",
          diffHunk:
            "@@ add normalize facet helper @@\n+export function normalizeFacetArray(value: unknown): string[] { return asStringArray(value); }",
          changeType: "add",
          language: "typescript",
          symbolName: "normalizeFacetArray",
        },
      ],
    });
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "near-duplicate-test" },
    });
    let distillCall = 0;
    setEpisodeDistillerTestHooksForTests({
      semanticChunks: async ({ document }) =>
        document.events
          .filter((event) => event.filePath?.endsWith("normalize.ts"))
          .map((event, index) => ({
            chunkIndex: index,
            sourceStartOffset: event.startOffset,
            sourceEndOffset: event.endOffset,
            eventIds: [event.id],
            taskBoundaryKind: "implementation",
            title: `normalize chunk ${index}`,
            boundaryReason: "Each diff entry is a separate source block for the same file.",
            expectedOutputs: ["episode"],
            openBoundary: false,
          })),
      distillSegment: async () => {
        distillCall += 1;
        return [
          {
            title:
              distillCall === 1
                ? "normalize.ts ユーティリティモジュールの作成"
                : "normalize.ts 共有ユーティリティモジュールの追加",
            context: "contextStill で normalize.ts の共有正規化ヘルパーを追加した。",
            intent: "型不安定な入力の正規化処理を共有化する。",
            keyDecisions: ["asStringArray と normalizeFacetArray を共有ユーティリティとして扱う。"],
            actionTaken:
              "src/shared/utils/normalize.ts に文字列配列とfacet正規化のヘルパーを追加した。",
            outcome: "normalize.ts に共有正規化ユーティリティが追加された。",
            failedApproach: "",
            reusableLesson:
              "型変換と正規化の境界処理は共有ユーティリティに分けると再利用しやすい。",
            usefulFutureTriggers: ["normalize.ts", "共有ユーティリティ", "facet正規化"],
            openLoops: [],
            generationKind: "task_episode",
            outcomeKind: "success",
            domains: ["データ正規化", "ユーティリティ関数"],
            technologies: ["TypeScript"],
            changeTypes: ["add"],
            tools: ["bun"],
            scores: {
              importance: 72,
              confidence: 80,
              reusability: 80,
              decision_density: 55,
              failure_value: 0,
              causal_clarity: 85,
              project_specificity: 65,
              evidence_quality: 80,
              compression_quality: 75,
              staleness_risk: 15,
            },
          },
        ];
      },
      reviewNearDuplicate: async ({ candidates }) => ({
        publish: false,
        duplicateOfEpisodeId: candidates[0]?.id ?? null,
        confidence: 92,
        reason: "同じ親ログの同じ normalize.ts 追加作業を別segmentが再要約しているため。",
      }),
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-near-duplicate-worker",
    });

    expect(run.ok).toBe(true);
    expect(run.completedJobId).toBe(job.id);
    const episodes = await searchEpisodes({
      query: "normalize.ts",
      technologies: ["TypeScript"],
      limit: 10,
    });
    expect(episodes).toHaveLength(1);
    const completedMetadataRow = sqlite.db
      .query<{ metadata: string }, [string]>(
        "select metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    const metadata = JSON.parse(completedMetadataRow?.metadata ?? "{}");
    expect(metadata.episodeDistiller).toMatchObject({
      generated: 1,
      skipped: 1,
      nearDuplicateSkipped: 1,
      acceptedCandidateCount: 2,
    });
    expect(metadata.episodeDistiller.nearDuplicateReviews).toContainEqual(
      expect.objectContaining({
        publish: false,
        candidateCount: 1,
        confidence: 92,
      }),
    );
  });

  test("does not generate EpisodeCards from candidate-only semantic chunks", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-candidate-only-session",
      content:
        "The source only contains a reusable rule candidate and should not become an EpisodeCard.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
    });
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "test" },
    });

    setEpisodeDistillerTestHooksForTests({
      semanticChunks: async ({ windows }) => [
        {
          chunkIndex: 0,
          sourceStartOffset: windows[0]?.sourceStartOffset ?? 0,
          sourceEndOffset: windows[0]?.sourceEndOffset ?? 1,
          eventIds: windows[0]?.eventIds ?? [],
          taskBoundaryKind: "decision_turn",
          title: "Candidate-only rule",
          boundaryReason: "The source is useful as a candidate but not as a task episode.",
          expectedOutputs: ["candidate"],
          openBoundary: false,
        },
      ],
      distillSegment: async () => {
        throw new Error("candidate-only chunks must not be distilled as episodes");
      },
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-candidate-only-worker",
    });

    expect(run.ok).toBe(true);
    const completedJob = sqlite.db
      .query<{ status: string; last_outcome_kind: string; metadata: string }, [string]>(
        "select status, last_outcome_kind, metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    expect(completedJob).toMatchObject({
      status: "skipped",
      last_outcome_kind: "no_episode",
    });
    const metadata = JSON.parse(completedJob?.metadata ?? "{}");
    expect(metadata.episodeDistiller).toMatchObject({
      pipelineVersion: "internal-chunked-v1",
      semanticChunkCount: 1,
      segmentCount: 0,
      generated: 0,
      acceptedCandidateCount: 0,
    });
    expect(
      await searchEpisodes({
        query: "Candidate-only rule",
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  test("skips low-value episodeDistiller candidates without creating EpisodeCards", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-low-value-session",
      content:
        "A short source fragment only repeated that work happened without decisions, evidence, or reusable lessons.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/modules/episodeDistiller/worker.ts",
          diffHunk: "@@ low value @@\n+no reusable detail",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });

    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "low-value-test" },
    });
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [
        {
          title: "Low value generated episode",
          context: "The source only says that work happened.",
          intent: "Avoid publishing a generic memory.",
          keyDecisions: [],
          actionTaken: "Only generic work was observed.",
          outcome: "No reusable task memory was confirmed from the source.",
          failedApproach: "",
          reusableLesson: "Remember that some work happened.",
          usefulFutureTriggers: ["generic work"],
          openLoops: [],
          generationKind: "task_episode",
          outcomeKind: "unknown",
          domains: ["episodic-memory"],
          technologies: ["sqlite"],
          changeTypes: ["queue"],
          tools: [],
          scores: {
            importance: 35,
            confidence: 45,
            reusability: 20,
            decision_density: 15,
            failure_value: 10,
            causal_clarity: 25,
            project_specificity: 20,
            evidence_quality: 35,
            compression_quality: 40,
            staleness_risk: 20,
          },
        },
      ],
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-low-value-worker",
    });

    expect(run.ok).toBe(true);
    expect(
      sqlite.db
        .query<{ status: string; last_outcome_kind: string; metadata: string }, [string]>(
          "select status, last_outcome_kind, metadata from episode_distiller_queue where id = ?",
        )
        .get(job.id),
    ).toMatchObject({
      status: "skipped",
      last_outcome_kind: "low_value_skipped",
    });
    const row = sqlite.db
      .query<{ metadata: string }, [string]>(
        "select metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    const metadata = JSON.parse(row?.metadata ?? "{}");
    expect(metadata.episodeDistiller).toMatchObject({
      generated: 0,
      valueSkipped: 1,
      acceptedCandidateCount: 0,
      skippedValueReviews: [
        expect.objectContaining({
          title: "Low value generated episode",
          valueReview: expect.objectContaining({
            publish: false,
            reasons: expect.arrayContaining([
              "value_score_below_60",
              "importance_below_55",
              "confidence_below_55",
            ]),
          }),
        }),
      ],
    });
    expect(
      await searchEpisodes({
        query: "Low value generated episode",
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  test("repairs legacy episodeDistiller card quality fields idempotently", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const episode = await createEpisode({
      title: "Legacy quality repair episode",
      situation: "Legacy context.\n\nIntent:\nKeep intent out of situation.",
      observations: "- Keep refs",
      action:
        "失敗した、または避けたアプローチ:\nLegacy failed approach.\n\nsource 時点の未解決事項:\n- Verify later.",
      outcome:
        "vibe memory segment vibe_memory:legacy:episode:task:episode-distiller-v1 から蒸留された Episode。",
      lesson: "Keep persisted card fields task-readable.",
      applicability: {},
      antiApplicability: { requiresRawEvidenceCheck: true, stalenessRisk: 20 },
      domains: ["episodic-memory"],
      technologies: ["sqlite"],
      changeTypes: ["repair"],
      tools: [],
      repoPath: "/repo/contextStill",
      repoKey: "contextStill",
      sourceKind: "vibe_memory",
      sourceKey: "vibe_memory:legacy-quality-repair:episode:task:episode-distiller-v1",
      outcomeKind: "success",
      importance: 75,
      confidence: 80,
      status: "active",
      metadata: {
        source: "episodeDistiller",
        episodeDistillation: {
          version: "episode-distiller-v1",
          canonical: {
            title: "Legacy quality repair episode",
            context: "Legacy context.",
            intent: "Keep intent out of situation.",
            keyDecisions: ["Keep refs"],
            failedApproach: "Legacy failed approach.",
            reusableLesson: "Keep persisted card fields task-readable.",
            usefulFutureTriggers: ["episode repair"],
            openLoops: ["Verify later."],
            generationKind: "task_episode",
            outcomeKind: "success",
            domains: ["episodic-memory"],
            technologies: ["sqlite"],
            changeTypes: ["repair"],
            tools: [],
            scores: {
              importance: 75,
              confidence: 80,
              reusability: 70,
              decision_density: 70,
              failure_value: 0,
              causal_clarity: 80,
              project_specificity: 80,
              evidence_quality: 80,
              compression_quality: 80,
              staleness_risk: 20,
            },
          },
        },
      },
      refs: [],
    });

    const dryRun = await repairEpisodeCardQuality({
      write: false,
      backup: false,
      limit: 100,
      json: true,
    });
    expect(dryRun.items.map((item) => item.id)).toContain(episode.id);

    const write = await repairEpisodeCardQuality({
      write: true,
      backup: false,
      limit: 100,
      json: true,
    });
    expect(write.items.map((item) => item.id)).toContain(episode.id);

    const row = sqlite.db
      .query<
        {
          situation: string;
          action: string;
          outcome: string;
          anti_applicability: string;
          metadata: string;
        },
        [string]
      >(
        "select situation, action, outcome, anti_applicability, metadata from episode_cards where id = ?",
      )
      .get(episode.id);
    expect(row?.situation).toBe("Legacy context.");
    expect(row?.action).toBe("Legacy failed approach.");
    expect(row?.outcome).toContain("追加確認事項が残った");
    expect(JSON.parse(row?.anti_applicability ?? "{}")).toMatchObject({
      openLoops: ["Verify later."],
    });
    expect(JSON.parse(row?.metadata ?? "{}").episodeDistillation.canonical).toMatchObject({
      actionTaken: "Legacy failed approach.",
      outcome: expect.stringContaining("追加確認事項が残った"),
    });

    const secondDryRun = await repairEpisodeCardQuality({
      write: false,
      backup: false,
      limit: 100,
      json: true,
    });
    expect(secondDryRun.items.map((item) => item.id)).not.toContain(episode.id);
  });

  test("resets low-quality episodeDistiller cards and requeues their source jobs", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: "low-quality-reset-memory",
      priority: 10,
      metadata: { episodeDistiller: { episodeIds: [] } },
    });
    sqlite.db
      .query(
        `
        update episode_distiller_queue
        set status = 'completed',
            completed_at = CURRENT_TIMESTAMP,
            last_outcome_kind = 'episodes_distilled'
        where id = ?
      `,
      )
      .run(job.id);
    const episode = await createEpisode({
      title: "Low quality reset episode",
      situation: "The legacy card was structurally repaired but still lacks an action.",
      observations: "- The job has source refs",
      action: "主要な実施内容は source metadata からは特定できません。",
      outcome:
        "Low quality reset episode は source 時点で主要な判断や修正が進んだが、追加確認事項が残った。",
      lesson: "Low quality generated cards should be re-distilled from source refs.",
      applicability: {},
      antiApplicability: { requiresRawEvidenceCheck: true },
      domains: ["episodic-memory"],
      technologies: ["sqlite"],
      changeTypes: ["repair"],
      tools: [],
      repoPath: "/repo/contextStill",
      repoKey: "contextStill",
      sourceKind: "vibe_memory",
      sourceKey: "vibe_memory:low-quality-reset-memory:episode:test:episode-distiller-v1",
      outcomeKind: "mixed",
      importance: 75,
      confidence: 80,
      status: "active",
      metadata: {
        source: "episodeDistiller",
        episodeDistillation: {
          version: "episode-distiller-v1",
        },
      },
      refs: [
        {
          refKind: "vibe_memory",
          refValue: "low-quality-reset-memory",
          locator: "bytes:0-100",
          queryHint: "Low quality reset episode",
        },
      ],
    });

    const dryRun = await resetLowQualityEpisodeCards({
      write: false,
      backup: false,
      limit: 100,
      json: true,
      reason: "test reset",
    });
    expect(dryRun.items.map((item) => item.id)).toContain(episode.id);
    expect(dryRun.jobs.map((item) => item.id)).toContain(job.id);

    const write = await resetLowQualityEpisodeCards({
      write: true,
      backup: false,
      limit: 100,
      json: true,
      reason: "test reset",
    });
    expect(write.deletedEpisodes).toBe(1);
    expect(write.requeuedJobs).toBe(1);

    expect(await fetchEpisode(episode.id)).toBeNull();
    expect(
      sqlite.db
        .query<{ count: number }, [string]>(
          "select count(*) as count from episode_cards_fts where id = ?",
        )
        .get(episode.id)?.count,
    ).toBe(0);
    const jobRow = sqlite.db
      .query<
        {
          status: string;
          priority: number;
          last_outcome_kind: string;
          metadata: string;
        },
        [string]
      >(
        "select status, priority, last_outcome_kind, metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    expect(jobRow?.status).toBe("pending");
    expect(jobRow?.priority).toBe(95);
    expect(jobRow?.last_outcome_kind).toBe("episode_quality_reset_requeued");
    expect(JSON.parse(jobRow?.metadata ?? "{}")).toMatchObject({
      episodeDistillerQualityReset: {
        reason: "test reset",
        previousStatus: "completed",
        deletedEpisodeIds: [episode.id],
        targetQualityScore: 85,
      },
    });

    const secondDryRun = await resetLowQualityEpisodeCards({
      write: false,
      backup: false,
      limit: 100,
      json: true,
      reason: "test reset",
    });
    expect(secondDryRun.items.map((item) => item.id)).not.toContain(episode.id);
  });

  test("skips duplicate episodeDistiller generation kinds within one source segment", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-duplicate-kind-session",
      content:
        "The worker received two task episode candidates for the same source span and should keep deterministic source keys.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/modules/episodeDistiller/worker.ts",
          diffHunk: "@@ duplicate generation kind @@\n+generationKind",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });

    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "duplicate-kind-test" },
    });
    const canonical = (title: string, reusableLesson: string) => ({
      title,
      context: "Two canonical episodes used the same source key inputs.",
      intent: "Avoid silently overwriting or deduping distinct generated content.",
      keyDecisions: ["Treat generationKind as unique per segment."],
      actionTaken: "Recorded only the first generated task episode for the source span.",
      outcome: "One duplicate generation kind was saved and the second was skipped.",
      failedApproach: "Saving both candidates with the same source fragment key.",
      reusableLesson,
      usefulFutureTriggers: ["episode distiller duplicate kind"],
      openLoops: [],
      generationKind: "task_episode",
      outcomeKind: "mixed",
      domains: ["episodic-memory"],
      technologies: ["sqlite", "typescript"],
      changeTypes: ["queue"],
      tools: ["vitest"],
      scores: {
        importance: 82,
        confidence: 78,
        reusability: 80,
        decision_density: 70,
        failure_value: 75,
        causal_clarity: 80,
        project_specificity: 55,
        evidence_quality: 80,
        compression_quality: 75,
        staleness_risk: 20,
      },
    });
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [
        canonical("Duplicate kind kept", "Keep one episode per generation kind and segment."),
        canonical("Duplicate kind skipped", "Record skipped duplicates in queue metadata."),
      ],
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-duplicate-worker",
    });

    expect(run.ok).toBe(true);
    expect(run.completedJobId).toBe(job.id);
    const row = sqlite.db
      .query<{ metadata: string }, [string]>(
        "select metadata from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    const metadata = JSON.parse(row?.metadata ?? "{}");
    expect(metadata.episodeDistiller).toMatchObject({
      generated: 1,
      skipped: 1,
      duplicateGenerationKindSkipped: 1,
      skippedDuplicateGenerationKinds: [{ segment: 0, generationKind: "task_episode" }],
    });
    expect(
      await searchEpisodes({
        query: "Duplicate kind",
        technologies: ["sqlite"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  test("keeps episodeDistiller jobs retryable when all segments fail", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-all-failed-session",
      content: "The local LLM route rejected the configured model before any episode was saved.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/modules/episodeDistiller/worker.ts",
          diffHunk: "@@ provider error @@\n+local-llm HTTP 404",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "all-failed-test" },
    });
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => {
        throw new Error('local-llm HTTP 404: {"detail":"Unsupported model: missing-model"}');
      },
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-unavailable-worker",
    });

    expect(run.ok).toBe(false);
    expect(run.message).toContain("worker_unavailable:");
    const row = sqlite.db
      .query<
        {
          status: string;
          last_outcome_kind: string;
          last_error: string;
          next_run_at: string;
        },
        [string]
      >(
        "select status, last_outcome_kind, last_error, next_run_at from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    expect(row).toMatchObject({
      status: "pending",
      last_outcome_kind: "worker_unavailable",
    });
    expect(row?.last_error).toContain("Unsupported model");
    expect(row?.next_run_at).toBeTruthy();
  });

  test("returns episodeDistiller loading-model 503 failures to the queue", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-loading-model-session",
      content: "The local LLM route is loading the configured model before any episode is saved.",
      memoryType: "chat",
      metadata: {
        projectName: "contextStill",
        cwd: "/repo/contextStill",
      },
      agentDiffs: [
        {
          filePath: "src/modules/episodeDistiller/worker.ts",
          diffHunk: "@@ provider loading @@\n+local-llm HTTP 503",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    const job = await enqueueEpisodeDistillerJob({
      sourceKey: recorded.memory.id,
      metadata: { sourceType: "loading-model-test" },
    });
    const createdAtBefore = sqlite.db
      .query<{ created_at: string }, [string]>(
        "select created_at from episode_distiller_queue where id = ?",
      )
      .get(job.id)?.created_at;
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => {
        throw new Error(
          'local-llm HTTP 503: {"error":{"message":"Loading model","type":"unavailable_error","code":503}}',
        );
      },
    });

    const run = await runQueueWorkerOnce({
      queueName: "episodeDistiller",
      workerId: "sqlite-episode-loading-model-worker",
    });

    expect(run.ok).toBe(false);
    expect(run.message).toContain("provider_unavailable_retry:");
    const row = sqlite.db
      .query<
        {
          status: string;
          last_outcome_kind: string;
          last_error: string;
          next_run_at: string;
          created_at: string;
        },
        [string]
      >(
        "select status, last_outcome_kind, last_error, next_run_at, created_at from episode_distiller_queue where id = ?",
      )
      .get(job.id);
    expect(row).toMatchObject({
      status: "pending",
      last_outcome_kind: "provider_unavailable_retry",
    });
    expect(row?.last_error).toContain("Loading model");
    expect(row?.next_run_at).toBeTruthy();
    expect(row?.created_at).toBe(createdAtBefore);
  });

  test("does not immediately stale-recover fresh provider leases", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const first = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-provider-lease-session-1",
      content: "First provider lease candidate.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ first @@\n+lease",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    const second = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-provider-lease-session-2",
      content: "Second provider lease candidate.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ second @@\n+lease",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    await enqueueEpisodeDistillerJob({ sourceKey: first.memory.id });
    await enqueueEpisodeDistillerJob({ sourceKey: second.memory.id });
    const pool = {
      id: "local-llm-default",
      label: "Local LLM",
      enabled: true,
      maxConcurrent: 1,
      staleLeaseSeconds: 120,
      lowPriorityAgingSeconds: 1800,
      targets: [{ provider: "local-llm" as const, localLlmModelId: "local-a" }],
    };

    const claimed = await claimNextJobWithProviderLease({
      pool,
      priorityQueues: ["episodeDistiller"],
      workerId: "sqlite-provider-lease-worker-1",
    });
    const blocked = await claimNextJobWithProviderLease({
      pool,
      priorityQueues: ["episodeDistiller"],
      workerId: "sqlite-provider-lease-worker-2",
    });

    expect(claimed?.queueName).toBe("episodeDistiller");
    expect(blocked).toBeNull();
    const leaseCounts = sqlite.db
      .query<{ status: string; count: number }, []>(
        "select status, count(*) as count from llm_provider_leases group by status",
      )
      .all();
    expect(leaseCounts).toEqual([{ status: "active", count: 1 }]);
  });

  test("uses provider-pool targets instead of stale route local LLM targets", async () => {
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const poolTarget = {
      id: "local-pool-target",
      name: "Pool local model",
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "pool-model",
    };
    const staleRouteTarget = {
      id: "local-stale-route-target",
      name: "Stale route local model",
      apiBaseUrl: "http://127.0.0.1:44449",
      apiPath: "/v1/chat/completions",
      model: "stale-route-model",
    };
    const staleRouteTargetValue = JSON.stringify({
      apiBaseUrl: staleRouteTarget.apiBaseUrl,
      apiPath: staleRouteTarget.apiPath,
      model: staleRouteTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: poolTarget.apiBaseUrl,
      apiPath: poolTarget.apiPath,
      model: poolTarget.model,
      models: [poolTarget, staleRouteTarget],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [{ provider: "local-llm", localLlmModelId: poolTarget.id }],
      },
    ];
    settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      model: staleRouteTargetValue,
      localLlmModel: staleRouteTargetValue,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    const recorded = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-provider-target-session",
      content: "Provider lease should match the episodeDistiller route target.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ target preference @@\n+preferredTargetIds",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    await enqueueEpisodeDistillerJob({ sourceKey: recorded.memory.id });

    const claimed = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["episodeDistiller"],
      workerId: "sqlite-provider-target-worker",
    });

    expect(claimed?.providerLease.targetId).toBe(poolTarget.id);
  });

  test("keeps provider-pool queue order ahead of older higher-priority episode jobs", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const sharedTarget = {
      id: "local-shared-priority",
      name: "Shared priority local model",
      apiBaseUrl: "http://127.0.0.1:44450",
      apiPath: "/v1/chat/completions",
      model: "shared-priority-model",
    };
    const routeTarget = JSON.stringify({
      apiBaseUrl: sharedTarget.apiBaseUrl,
      apiPath: sharedTarget.apiPath,
      model: sharedTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: sharedTarget.apiBaseUrl,
      apiPath: sharedTarget.apiPath,
      model: sharedTarget.model,
      models: [sharedTarget],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 60,
        targets: [{ provider: "local-llm", localLlmModelId: sharedTarget.id }],
      },
    ];
    settings.taskRouting.findCandidate.source = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.findCandidate.vibe = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, created_at, updated_at
        ) values (
          'finding-queue-order', 'source_target', 'wiki_file', 'finding-queue-order',
          'file://finding-queue-order', 'v-test', 'pending', 50, '{}', '{}',
          datetime(CURRENT_TIMESTAMP, '-1 hour'), datetime(CURRENT_TIMESTAMP, '-1 hour')
        );
        insert into episode_distiller_queue (
          id, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, provider_policy, created_at, updated_at
        ) values (
          'episode-queue-order', 'vibe_memory', 'episode-queue-order',
          'vibe://episode-queue-order', 'v-test', 'pending', 95, '{}', '{}', 'default',
          datetime(CURRENT_TIMESTAMP, '-24 hours'), datetime(CURRENT_TIMESTAMP, '-24 hours')
        );
      `,
      )
      .run();

    const claimed = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["findingCandidate", "episodeDistiller"],
      workerId: "sqlite-provider-queue-order-worker",
    });

    expect(claimed?.queueName).toBe("findingCandidate");
    expect(claimed?.id).toBe("finding-queue-order");
  });

  test("prioritizes finding and covering in a two-target pool before lower queues", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const qwenA = {
      id: "local-qwen-a",
      name: "Qwen A",
      apiBaseUrl: "http://127.0.0.1:50041/v1",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const qwenB = {
      id: "local-qwen-b",
      name: "Qwen B",
      apiBaseUrl: "http://127.0.0.1:50042/v1",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const staleOrnith = {
      id: "local-stale-ornith",
      name: "Stale Ornith",
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "ornith-1.0-9b-4bit",
    };
    const staleRouteTarget = JSON.stringify({
      apiBaseUrl: staleOrnith.apiBaseUrl,
      apiPath: staleOrnith.apiPath,
      model: staleOrnith.model,
    });
    const pooledRoute = () => ({
      provider: "local-llm" as const,
      model: staleRouteTarget,
      localLlmModel: staleRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: qwenA.apiBaseUrl,
      apiPath: qwenA.apiPath,
      model: qwenA.model,
      models: [staleOrnith, qwenA, qwenB],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Qwen x2",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm", localLlmModelId: qwenA.id },
          { provider: "local-llm", localLlmModelId: qwenB.id },
        ],
      },
    ];
    settings.taskRouting.findCandidate.source = pooledRoute();
    settings.taskRouting.findCandidate.vibe = pooledRoute();
    settings.taskRouting.coverEvidence.sourceSupport = pooledRoute();
    settings.taskRouting.coverEvidence.externalEvidence = pooledRoute();
    settings.taskRouting.coverEvidence.mcpEvidence = pooledRoute();
    settings.taskRouting.deadZoneMergeReview = pooledRoute();
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, created_at, updated_at
        ) values (
          'finding-pool-priority', 'source_target', 'wiki_file', 'finding-pool-priority',
          'file://finding-pool-priority', 'v-test', 'pending', 10, '{}', '{}',
          '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        )
      `,
      )
      .run();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, payload, metadata, next_run_at, created_at, updated_at
        ) values (
          'covering-pool-priority', 'candidate-pool-priority', 'pending', 10, '{}', '{}',
          '2026-06-22 01:00:00', '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        )
      `,
      )
      .run();
    sqlite.db
      .query(
        `
        insert into dead_zone_merge_review_queue (
          id, status, priority, payload, metadata, created_at, updated_at
        ) values (
          'deadzone-pool-priority', 'pending', 99, '{}', '{}',
          '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        )
      `,
      )
      .run();

    const priorityQueues = ["findingCandidate", "coveringEvidence", "deadZoneMergeReview"] as const;
    const firstClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: [...priorityQueues],
      workerId: "sqlite-provider-pool-priority-worker-1",
    });
    const secondClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: [...priorityQueues],
      workerId: "sqlite-provider-pool-priority-worker-2",
    });
    const blockedClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: [...priorityQueues],
      workerId: "sqlite-provider-pool-priority-worker-3",
    });

    expect(firstClaim?.queueName).toBe("findingCandidate");
    expect(secondClaim?.queueName).toBe("coveringEvidence");
    expect(blockedClaim).toBeNull();

    if (!firstClaim) throw new Error("Expected finding claim to be available");
    await releaseProviderLease(firstClaim.providerLease.id, "test_finished");
    sqlite.db
      .query("update finding_candidate_queue set status = 'completed' where id = ?")
      .run(firstClaim.id);

    const thirdClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: [...priorityQueues],
      workerId: "sqlite-provider-pool-priority-worker-4",
    });

    expect(thirdClaim?.queueName).toBe("deadZoneMergeReview");
    expect(thirdClaim?.id).toBe("deadzone-pool-priority");
  });

  test("keeps direct endpoint jobs on their selected local LLM target", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const fallbackTarget = {
      id: "local-fallback",
      name: "Fallback local model",
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "fallback-model",
    };
    const preferredTarget = {
      id: "local-preferred",
      name: "Preferred local model",
      apiBaseUrl: "http://127.0.0.1:44449",
      apiPath: "/v1/chat/completions",
      model: "preferred-model",
    };
    const preferredRouteTarget = JSON.stringify({
      apiBaseUrl: preferredTarget.apiBaseUrl,
      apiPath: preferredTarget.apiPath,
      model: preferredTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: fallbackTarget.apiBaseUrl,
      apiPath: fallbackTarget.apiPath,
      model: fallbackTarget.model,
      models: [fallbackTarget, preferredTarget],
    };
    settings.providerPools = [];
    settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      model: preferredRouteTarget,
      localLlmModel: preferredRouteTarget,
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    const directPools = enabledProviderPoolsForQueues(["episodeDistiller"]);
    expect(directPools).toHaveLength(1);
    expect(directPools[0]).toMatchObject({
      id: "task-routing:local-llm",
      targets: [{ provider: "local-llm", localLlmModelId: preferredTarget.id }],
      maxConcurrent: 1,
    });
    const priorityQueues = priorityQueuesForProviderPool({
      poolId: directPools[0].id,
      allowedQueues: ["episodeDistiller"],
    });

    const firstMemory = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-wait-preferred-session-1",
      content: "First preferred target claim.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ wait preferred first @@\n+claim",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    const secondMemory = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "episode-distiller-wait-preferred-session-2",
      content: "Second preferred target claim should wait.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [
        {
          filePath: "src/modules/queue/core/provider-lease.ts",
          diffHunk: "@@ wait preferred second @@\n+wait",
          changeType: "modify",
          language: "typescript",
        },
      ],
    });
    await enqueueEpisodeDistillerJob({ sourceKey: firstMemory.memory.id });
    await enqueueEpisodeDistillerJob({ sourceKey: secondMemory.memory.id });

    const firstClaim = await claimNextJobWithProviderLease({
      pool: directPools[0],
      priorityQueues,
      workerId: "sqlite-provider-preferred-worker-1",
    });
    const blockedClaim = await claimNextJobWithProviderLease({
      pool: directPools[0],
      priorityQueues,
      workerId: "sqlite-provider-preferred-worker-2",
    });

    expect(firstClaim?.providerLease.targetId).toBe(preferredTarget.id);
    expect(blockedClaim).toBeNull();
    const fallbackLeaseCount = sqlite.db
      .query<{ count: number }, [string]>(
        "select count(*) as count from llm_provider_leases where target_id = ? and status = 'active'",
      )
      .get(fallbackTarget.id);
    expect(fallbackLeaseCount?.count ?? 0).toBe(0);

    if (!firstClaim) {
      throw new Error("Expected first claim to be available");
    }
    await releaseProviderLease(firstClaim.providerLease.id, "test_finished");
    sqlite.db
      .query(
        `
        update episode_distiller_queue
        set status = 'completed',
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        where id = ?
      `,
      )
      .run(firstClaim.id);

    const secondClaim = await claimNextJobWithProviderLease({
      pool: directPools[0],
      priorityQueues,
      workerId: "sqlite-provider-preferred-worker-3",
    });

    expect(secondClaim?.providerLease.targetId).toBe(preferredTarget.id);
  });

  test("claims another findingCandidate route while the same queue is already running", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const sourceTarget = {
      id: "local-source-route",
      name: "Source route local model",
      apiBaseUrl: "http://127.0.0.1:44450",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const vibeTarget = {
      id: "local-vibe-route",
      name: "Vibe route local model",
      apiBaseUrl: "http://127.0.0.1:44451",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const sourceRouteTarget = JSON.stringify({
      apiBaseUrl: sourceTarget.apiBaseUrl,
      apiPath: sourceTarget.apiPath,
      model: sourceTarget.model,
    });
    const vibeRouteTarget = JSON.stringify({
      apiBaseUrl: vibeTarget.apiBaseUrl,
      apiPath: vibeTarget.apiPath,
      model: vibeTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: sourceTarget.apiBaseUrl,
      apiPath: sourceTarget.apiPath,
      model: sourceTarget.model,
      models: [sourceTarget, vibeTarget],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm", localLlmModelId: sourceTarget.id },
          { provider: "local-llm", localLlmModelId: vibeTarget.id },
        ],
      },
    ];
    settings.taskRouting.findCandidate.source = {
      provider: "local-llm",
      model: sourceRouteTarget,
      localLlmModel: sourceRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.findCandidate.vibe = {
      provider: "local-llm",
      model: vibeRouteTarget,
      localLlmModel: vibeRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, created_at, updated_at
        ) values
          ('finding-source-route', 'source_target', 'wiki_file', 'source-route', 'file://source-route', 'v-test',
            'pending', 50, '{}', '{}', ?, ?),
          ('finding-vibe-route', 'source_target', 'vibe_memory', 'vibe-route', 'vibe://vibe-route', 'v-test',
            'pending', 50, '{}', '{}', datetime(?, '+1 second'), datetime(?, '+1 second'))
      `,
      )
      .run(now, now, now, now);

    const firstClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["findingCandidate"],
      workerId: "sqlite-provider-route-worker-1",
    });
    const secondClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["findingCandidate"],
      workerId: "sqlite-provider-route-worker-2",
    });

    expect(firstClaim?.id).toBe("finding-source-route");
    expect(firstClaim?.providerLease.targetId).toBe(sourceTarget.id);
    expect(secondClaim?.id).toBe("finding-vibe-route");
    expect(secondClaim?.providerLease.targetId).toBe(vibeTarget.id);
  });

  test("claims different queues concurrently from a shared provider pool", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const episodeTarget = {
      id: "local-episode-route",
      name: "Episode route local model",
      apiBaseUrl: "http://127.0.0.1:44454",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const coveringTarget = {
      id: "local-covering-route",
      name: "Covering route local model",
      apiBaseUrl: "http://127.0.0.1:44455",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const episodeRouteTarget = JSON.stringify({
      apiBaseUrl: episodeTarget.apiBaseUrl,
      apiPath: episodeTarget.apiPath,
      model: episodeTarget.model,
    });
    const coveringRouteTarget = JSON.stringify({
      apiBaseUrl: coveringTarget.apiBaseUrl,
      apiPath: coveringTarget.apiPath,
      model: coveringTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: episodeTarget.apiBaseUrl,
      apiPath: episodeTarget.apiPath,
      model: episodeTarget.model,
      models: [episodeTarget, coveringTarget],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm", localLlmModelId: episodeTarget.id },
          { provider: "local-llm", localLlmModelId: coveringTarget.id },
        ],
      },
    ];
    settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      model: episodeRouteTarget,
      localLlmModel: episodeRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.sourceSupport = {
      provider: "local-llm",
      model: coveringRouteTarget,
      localLlmModel: coveringRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.externalEvidence = {
      provider: "local-llm",
      model: coveringRouteTarget,
      localLlmModel: coveringRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.mcpEvidence = {
      provider: "local-llm",
      model: coveringRouteTarget,
      localLlmModel: coveringRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });

    const isoReadyAt = new Date(Date.now() - 60_000).toISOString();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, payload, metadata, next_run_at, created_at, updated_at
        ) values (
          'covering-different-provider', 'candidate-different-provider', 'pending', 50, '{}', '{}', ?,
          '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        );
        `,
      )
      .run(isoReadyAt);
    sqlite.db
      .query(
        `
        insert into episode_distiller_queue (
          id, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, created_at, updated_at
        ) values (
          'episode-different-provider', 'vibe_memory', 'episode-source-different-provider',
          'vibe-memory://episode-source-different-provider', 'v-test',
          'pending', 50, '{}', '{}', '2026-06-22 01:00:01', '2026-06-22 01:00:01'
        );
        `,
      )
      .run();

    const firstClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["coveringEvidence", "episodeDistiller"],
      workerId: "sqlite-provider-different-queue-worker-1",
    });
    const secondClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["coveringEvidence", "episodeDistiller"],
      workerId: "sqlite-provider-different-queue-worker-2",
    });

    expect(firstClaim?.id).toBe("covering-different-provider");
    expect(firstClaim?.providerLease.targetId).toBe(episodeTarget.id);
    expect(secondClaim?.id).toBe("episode-different-provider");
    expect(secondClaim?.providerLease.targetId).toBe(coveringTarget.id);
    const activeLeases = sqlite.db
      .query<{ target_id: string }, []>(
        "select target_id from llm_provider_leases where status = 'active' order by target_id",
      )
      .all()
      .map((row) => row.target_id);
    expect(activeLeases).toEqual([coveringTarget.id, episodeTarget.id].sort());
  });

  test("prevents the same provider target from being leased through different pools", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const sharedTarget = {
      id: "local-shared-global-lease",
      name: "Shared global lease model",
      apiBaseUrl: "http://127.0.0.1:44456",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const routeTarget = JSON.stringify({
      apiBaseUrl: sharedTarget.apiBaseUrl,
      apiPath: sharedTarget.apiPath,
      model: sharedTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: sharedTarget.apiBaseUrl,
      apiPath: sharedTarget.apiPath,
      model: sharedTarget.model,
      models: [sharedTarget],
    };
    settings.providerPools = [
      {
        id: "episode-pool",
        label: "Episode Pool",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [{ provider: "local-llm", localLlmModelId: sharedTarget.id }],
      },
      {
        id: "covering-pool",
        label: "Covering Pool",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [{ provider: "local-llm", localLlmModelId: sharedTarget.id }],
      },
    ];
    settings.taskRouting.episodeDistiller = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "episode-pool",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.sourceSupport = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "covering-pool",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.externalEvidence = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "covering-pool",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.mcpEvidence = {
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      providerPoolId: "covering-pool",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });

    sqlite.db
      .query(
        `
        insert into episode_distiller_queue (
          id, source_kind, source_key, source_uri, distillation_version,
          status, priority, payload, metadata, created_at, updated_at
        ) values (
          'episode-global-lease', 'vibe_memory', 'episode-global-lease-source',
          'vibe-memory://episode-global-lease-source', 'v-test',
          'pending', 50, '{}', '{}', '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        );
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, payload, metadata, next_run_at, created_at, updated_at
        ) values (
          'covering-global-lease', 'candidate-global-lease', 'pending', 50, '{}', '{}',
          '2026-06-22 01:00:00', '2026-06-22 01:00:00', '2026-06-22 01:00:00'
        );
        `,
      )
      .run();

    const episodeClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["episodeDistiller"],
      workerId: "sqlite-global-lease-worker-1",
    });
    const blockedCoveringClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[1],
      priorityQueues: ["coveringEvidence"],
      workerId: "sqlite-global-lease-worker-2",
    });

    expect(episodeClaim?.providerLease.targetId).toBe(sharedTarget.id);
    expect(blockedCoveringClaim).toBeNull();
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from llm_provider_leases where target_id = 'local-shared-global-lease' and status = 'active'",
        )
        .get()?.count ?? 0,
    ).toBe(1);
  });

  test("uses another pool target for same-route findingCandidate work when one target is busy", async () => {
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const preferredTarget = {
      id: "local-preferred-route",
      name: "Preferred route local model",
      apiBaseUrl: "http://127.0.0.1:44452",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const standbyTarget = {
      id: "local-standby-route",
      name: "Standby route local model",
      apiBaseUrl: "http://127.0.0.1:44453",
      apiPath: "/v1/chat/completions",
      model: "qwen-test",
    };
    const preferredRouteTarget = JSON.stringify({
      apiBaseUrl: preferredTarget.apiBaseUrl,
      apiPath: preferredTarget.apiPath,
      model: preferredTarget.model,
    });
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: preferredTarget.apiBaseUrl,
      apiPath: preferredTarget.apiPath,
      model: preferredTarget.model,
      models: [preferredTarget, standbyTarget],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm", localLlmModelId: preferredTarget.id },
          { provider: "local-llm", localLlmModelId: standbyTarget.id },
        ],
      },
    ];
    settings.taskRouting.findCandidate.source = {
      provider: "local-llm",
      model: preferredRouteTarget,
      localLlmModel: preferredRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.findCandidate.vibe = {
      provider: "local-llm",
      model: preferredRouteTarget,
      localLlmModel: preferredRouteTarget,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });
    const queued = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "finding-same-route-wait-session-1",
      content: "First same-route finding candidate.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [],
    });
    const waiting = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "finding-same-route-wait-session-2",
      content: "Second same-route finding candidate.",
      memoryType: "chat",
      metadata: { projectName: "contextStill", cwd: "/repo/contextStill" },
      agentDiffs: [],
    });
    const firstJob = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: queued.memory.id,
      sourceUri: `vibe-memory://${queued.memory.id}`,
      priority: 50,
    });
    await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: waiting.memory.id,
      sourceUri: `vibe-memory://${waiting.memory.id}`,
      priority: 50,
    });

    const firstClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["findingCandidate"],
      workerId: "sqlite-provider-same-route-worker-1",
    });
    const blockedClaim = await claimNextJobWithProviderLease({
      pool: settings.providerPools[0],
      priorityQueues: ["findingCandidate"],
      workerId: "sqlite-provider-same-route-worker-2",
    });

    expect(firstJob).not.toBeNull();
    expect(firstClaim?.id).toBeTruthy();
    expect(firstClaim?.providerLease.targetId).toBe(preferredTarget.id);
    expect(blockedClaim?.providerLease.targetId).toBe(standbyTarget.id);
  });

  test("persists covering retry options in sqlite", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy,
          payload, completed_at, locked_by, locked_at, heartbeat_at, last_error,
          created_at, updated_at
        ) values (?, ?, 'failed', 50, 2, 'default', ?, ?, 'worker-old', ?, ?, 'old error', ?, ?)
      `,
      )
      .run(
        "covering-retry",
        "candidate-retry",
        JSON.stringify({ forceRefreshEvidence: false }),
        now,
        now,
        now,
        now,
        now,
      );

    const result = await retryQueueJob({
      queueName: "coveringEvidence",
      id: "covering-retry",
      mode: "cloud_api",
      forceRefreshEvidence: true,
      reason: "manual retry",
    });

    expect(result).toEqual({ id: "covering-retry", status: "pending" });
    const row = sqlite.db
      .query<
        {
          status: string;
          attempt_count: number;
          provider_policy: string;
          payload: string;
        },
        []
      >(
        `
        select status, attempt_count, provider_policy, payload
        from covering_evidence_queue
        where id = 'covering-retry'
      `,
      )
      .get();
    const payload = JSON.parse(row?.payload ?? "{}");
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 0,
      provider_policy: "cloud_api",
    });
    expect(payload.forceRefreshEvidence).toBe(true);
    expect(payload.retryMode).toBe("cloud_api");
    expect(payload.retryReason).toBe("manual retry");
    expect(typeof payload.retryRequestedAt).toBe("string");
  });

  test("does not delete legacy duplicate covering rows during sqlite bootstrap", async () => {
    resetRuntimeSqliteCoreDatabaseForTests();
    const sqliteModule = await import("bun:sqlite");
    const legacyDb = new sqliteModule.Database(process.env.CONTEXT_STILL_SQLITE_CORE_PATH, {
      create: true,
    });
    legacyDb.exec(`
      CREATE TABLE covering_evidence_queue (
        id TEXT PRIMARY KEY,
        found_candidate_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE evidence_coverage_results (
        id TEXT PRIMARY KEY,
        found_candidate_id TEXT NOT NULL,
        producer_queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'insufficient',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO covering_evidence_queue (id, found_candidate_id, status, priority)
      VALUES ('legacy-cover-1', 'legacy-candidate', 'completed', 10);
      INSERT INTO covering_evidence_queue (id, found_candidate_id, status, priority)
      VALUES ('legacy-cover-2', 'legacy-candidate', 'failed', 20);
      INSERT INTO evidence_coverage_results (id, found_candidate_id, producer_queue, status)
      VALUES ('legacy-evidence-1', 'legacy-candidate', 'coveringEvidence', 'insufficient');
      INSERT INTO evidence_coverage_results (id, found_candidate_id, producer_queue, status)
      VALUES ('legacy-evidence-2', 'legacy-candidate', 'coveringEvidence', 'provider_failed');
    `);
    legacyDb.close();

    const sqlite = await getRuntimeSqliteCoreDatabase();

    const coveringCount = sqlite.db
      .query<{ count: number }, []>(
        "select count(*) as count from covering_evidence_queue where found_candidate_id = 'legacy-candidate'",
      )
      .get();
    const evidenceCount = sqlite.db
      .query<{ count: number }, []>(
        "select count(*) as count from evidence_coverage_results where found_candidate_id = 'legacy-candidate' and producer_queue = 'coveringEvidence'",
      )
      .get();
    expect(coveringCount?.count).toBe(2);
    expect(evidenceCount?.count).toBe(2);
  });

  test("enforces sqlite covering queue and evidence result uniqueness", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy
        ) values (?, ?, 'pending', 50, 0, 'default')
      `,
      )
      .run("covering-unique-1", "candidate-unique");

    expect(() => {
      sqlite.db
        .query(
          `
          insert into covering_evidence_queue (
            id, found_candidate_id, status, priority, attempt_count, provider_policy
          ) values (?, ?, 'pending', 50, 0, 'default')
        `,
        )
        .run("covering-unique-2", "candidate-unique");
    }).toThrow();

    sqlite.db
      .query(
        `
        insert into evidence_coverage_results (
          id, found_candidate_id, producer_queue, producer_job_id, distillation_version,
          status, stage
        ) values (?, ?, 'coveringEvidence', ?, 'v1', 'insufficient', 'source_support')
      `,
      )
      .run("evidence-unique-1", "candidate-unique", "covering-unique-1");

    expect(() => {
      sqlite.db
        .query(
          `
          insert into evidence_coverage_results (
            id, found_candidate_id, producer_queue, producer_job_id, distillation_version,
            status, stage
          ) values (?, ?, 'coveringEvidence', ?, 'v1', 'insufficient', 'source_support')
        `,
        )
        .run("evidence-unique-2", "candidate-unique", "covering-unique-1");
    }).toThrow();
  });

  test("processes insufficient covering jobs through sqlite worker persistence", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, attempt_count, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, 'provided_candidate', 'knowledge_candidate', ?, ?, 'v-test',
          'completed', 80, 1, 'default', '{}', '{}', ?, ?)
      `,
      )
      .run("finding-covering-insufficient", "candidate://short", "candidate://short", now, now);
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, type, title, content, origin, metadata,
          created_at, updated_at
        ) values (?, ?, 0, 'rule', ?, ?, '{}', '{}', ?, ?)
      `,
      )
      .run(
        "candidate-covering-insufficient",
        "finding-covering-insufficient",
        "Tiny candidate",
        "Too short",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, distillation_version, status, priority, attempt_count,
          max_attempts, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, ?, 'v-test', 'pending', 70, 0, 2, 'default', '{}', '{}', ?, ?)
      `,
      )
      .run("covering-insufficient", "candidate-covering-insufficient", now, now);

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "sqlite-covering-worker",
    });

    expect(result).toMatchObject({
      ok: true,
      idle: false,
      claimedJobId: "covering-insufficient",
      completedJobId: "covering-insufficient",
    });
    const job = sqlite.db
      .query<{ status: string; attempt_count: number; last_outcome_kind: string }, []>(
        `
        select status, attempt_count, last_outcome_kind
        from covering_evidence_queue
        where id = 'covering-insufficient'
      `,
      )
      .get();
    expect(job).toEqual({
      status: "completed",
      attempt_count: 1,
      last_outcome_kind: "insufficient",
    });

    const evidence = sqlite.db
      .query<{ status: string; stage: string; producer_job_id: string }, []>(
        `
        select status, stage, producer_job_id
        from evidence_coverage_results
        where found_candidate_id = 'candidate-covering-insufficient'
          and producer_queue = 'coveringEvidence'
      `,
      )
      .get();
    expect(evidence).toEqual({
      status: "insufficient",
      stage: "source_support",
      producer_job_id: "covering-insufficient",
    });
  });

  test("processes negative finding to cover to finalize through sqlite worker persistence", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    const appliesTo = {
      technologies: ["sqlite"],
      changeTypes: ["testing"],
      domains: ["knowledge"],
    };

    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, distillation_version,
          status, priority, attempt_count, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, 'provided_candidate', 'knowledge_candidate', ?, ?, 'v-test',
          'completed', 90, 1, 'default', '{}', ?, ?, ?)
      `,
      )
      .run(
        "finding-negative-e2e",
        "review://negative-e2e",
        "review://negative-e2e",
        JSON.stringify({ sourceKind: "knowledge_candidate", appliesTo }),
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, type, title, content,
          source_summary, origin, metadata, created_at, updated_at
        ) values (?, ?, 0, 'rule', ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "candidate-negative-e2e",
        "finding-negative-e2e",
        "SQLite negative review correction",
        "Failure: The worker can drop negative evidence before finalize. Fix: keep appliesTo and polarity across cover/finalize.",
        "Negative evidence says SQLite cover/finalize must preserve polarity and applicability.",
        JSON.stringify({
          sourceKind: "knowledge_candidate",
          sourceKey: "review://negative-e2e",
          sourceUri: "review://negative-e2e",
          sourceSummary:
            "Negative evidence says SQLite cover/finalize must preserve polarity and applicability.",
          appliesTo,
        }),
        JSON.stringify({ sourceKind: "knowledge_candidate", appliesTo }),
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, distillation_version, status, priority, attempt_count,
          max_attempts, provider_policy, payload, metadata, created_at, updated_at
        ) values (?, ?, 'v-test', 'pending', 80, 0, 2, 'default', '{}', '{}', ?, ?)
      `,
      )
      .run("covering-negative-e2e", "candidate-negative-e2e", now, now);

    setQueueWorkerTestHooksForTests({
      runCoverEvidence: async (input) => {
        expect(input.id).toBe("candidate-negative-e2e");
        expect(input.candidate?.id).toBe("candidate-negative-e2e");
        return {
          id: input.id,
          result: {
            schemaVersion: 1,
            status: "knowledge_ready",
            stage: "final",
            candidate: {
              type: "rule",
              title: "Preserve negative evidence through SQLite finalize",
              body: "Failure: SQLite queue processing can lose negative review evidence before finalize.\nFix: preserve polarity, intent tags, and applicability from cover to finalize.\nVerification: Run the SQLite runtime queue integration test.",
              importance: 85,
              confidence: 88,
              technologies: ["sqlite"],
              changeTypes: ["testing"],
              domains: ["knowledge"],
            },
            references: [
              {
                kind: "source",
                uri: "review://negative-e2e",
                locator: "candidate:content",
                note: "negative review correction",
                evidenceRole: "supports_candidate",
              },
            ],
            duplicateRefs: [],
            toolEvents: [
              {
                name: "negative_coverage",
                ok: true,
                metadata: {
                  polarity: "negative",
                  intentTags: ["review-correction"],
                },
              },
            ],
            reason: null,
          },
        };
      },
      runFinalizeDistille: async (input) => {
        const candidate = input.resultOverride?.candidate;
        const negativeEvent = input.resultOverride?.toolEvents.find(
          (event) => event.name === "negative_coverage" && event.ok,
        );
        const negativeMetadata =
          negativeEvent?.metadata &&
          typeof negativeEvent.metadata === "object" &&
          !Array.isArray(negativeEvent.metadata)
            ? negativeEvent.metadata
            : {};
        const polarity = negativeMetadata.polarity;
        const intentTags = Array.isArray(negativeMetadata.intentTags)
          ? negativeMetadata.intentTags
          : [];
        expect(input.coverEvidenceResultId).toBeTruthy();
        expect(candidate?.technologies).toEqual(["sqlite"]);
        expect(candidate?.changeTypes).toEqual(["testing"]);
        expect(candidate?.domains).toEqual(["knowledge"]);
        expect(polarity).toBe("negative");
        expect(intentTags).toEqual(["review-correction"]);
        sqlite.db
          .query(
            `
            insert into knowledge_items (
              id, type, status, scope, polarity, intent_tags, title, body, applies_to,
              confidence, importance, metadata, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            "knowledge-negative-e2e",
            candidate?.type ?? "rule",
            "draft",
            "repo",
            String(polarity),
            JSON.stringify(intentTags),
            candidate?.title ?? "Negative SQLite knowledge",
            candidate?.body ?? "Negative SQLite knowledge body",
            JSON.stringify(appliesTo),
            candidate?.confidence ?? 80,
            candidate?.importance ?? 80,
            JSON.stringify({
              coverEvidenceResultId: input.coverEvidenceResultId,
              references: input.resultOverride?.references ?? [],
            }),
            now,
            now,
          );
        return {
          coverEvidenceResultId: input.coverEvidenceResultId,
          knowledgeId: "knowledge-negative-e2e",
          status: "stored",
          embeddingStatus: "stored",
          sourceReferenceCount: input.resultOverride?.references.length ?? 0,
          sourceLinkCount: 0,
          reason: null,
          finalizeSummary: {
            decision: "stored",
            reason: "sqlite runtime test stored deterministic negative knowledge",
            anonymization: {
              applied: false,
              version: 1,
              replacementKinds: [],
              replacementCounts: {},
              removedApplicabilityScopes: [],
            },
            qualityGates: ["applicability", "sqlite-runtime"],
            llmAssist: { enabled: false, applied: false },
          },
        };
      },
    });

    const coverResult = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "sqlite-negative-cover-worker",
    });
    expect(coverResult).toMatchObject({
      ok: true,
      idle: false,
      claimedJobId: "covering-negative-e2e",
      completedJobId: "covering-negative-e2e",
    });

    const evidence = sqlite.db
      .query<
        {
          id: string;
          status: string;
          stage: string;
          applies_to: string;
          tool_events: string;
        },
        []
      >(
        `
        select id, status, stage, applies_to, tool_events
        from evidence_coverage_results
        where found_candidate_id = 'candidate-negative-e2e'
          and producer_queue = 'coveringEvidence'
      `,
      )
      .get();
    expect(evidence?.status).toBe("knowledge_ready");
    expect(JSON.parse(evidence?.applies_to ?? "{}")).toEqual(appliesTo);
    expect(JSON.stringify(JSON.parse(evidence?.tool_events ?? "[]"))).toContain(
      "negative_coverage",
    );

    expect(evidence?.id).toBeTruthy();
    const finalizeJob = sqlite.db
      .query<{ id: string; status: string; evidence_result_id: string }, [string]>(
        `
        select id, status, evidence_result_id
        from finalize_distille_queue
        where evidence_result_id = ?
      `,
      )
      .get(evidence?.id ?? "");
    expect(finalizeJob?.status).toBe("pending");

    const finalizeResult = await runQueueWorkerOnce({
      queueName: "finalizeDistille",
      workerId: "sqlite-negative-finalize-worker",
    });
    expect(finalizeResult).toMatchObject({
      ok: true,
      idle: false,
      claimedJobId: finalizeJob?.id,
      completedJobId: finalizeJob?.id,
    });

    expect(finalizeJob?.id).toBeTruthy();
    const finalized = sqlite.db
      .query<{ status: string; knowledge_id: string; last_outcome_kind: string }, [string]>(
        `
        select status, knowledge_id, last_outcome_kind
        from finalize_distille_queue
        where id = ?
      `,
      )
      .get(finalizeJob?.id ?? "");
    expect(finalized).toEqual({
      status: "completed",
      knowledge_id: "knowledge-negative-e2e",
      last_outcome_kind: "stored",
    });

    const knowledge = sqlite.db
      .query<{ polarity: string; intent_tags: string; applies_to: string }, []>(
        `
        select polarity, intent_tags, applies_to
        from knowledge_items
        where id = 'knowledge-negative-e2e'
      `,
      )
      .get();
    expect(knowledge?.polarity).toBe("negative");
    expect(JSON.parse(knowledge?.intent_tags ?? "[]")).toEqual(["review-correction"]);
    expect(JSON.parse(knowledge?.applies_to ?? "{}")).toEqual(appliesTo);
  });

  test("serves candidate list from sqlite when postgres is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/context_still_dead";
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    sqlite.db
      .query(
        `
        insert into distillation_target_states (
          id, target_kind, target_key, source_uri, distillation_version, status, phase,
          priority_group, sort_key, candidate_count, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "target-1",
        "knowledge_candidate",
        "candidate-target-1",
        "agent://candidate/target-1",
        "v1",
        "completed",
        "selected",
        "normal",
        "candidate-target-1",
        1,
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into find_candidate_results (
          id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "candidate-result-1",
        "target-1",
        0,
        "SQLite candidate title",
        "SQLite candidate body",
        "{}",
        "selected",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into cover_evidence_results (
          id, status, stage, type, title, body, importance, confidence, reason, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "candidate-result-1",
        "knowledge_ready",
        "covered",
        "rule",
        "Covered title",
        "Covered body",
        80,
        75,
        "covered",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "knowledge-from-candidate-1",
        "rule",
        "draft",
        "repo",
        "positive",
        "[]",
        "Stored candidate knowledge",
        "Stored candidate body",
        "{}",
        75,
        80,
        JSON.stringify({ coverEvidenceResultId: "candidate-result-1" }),
        now,
        now,
      );
    const result = await listCandidateItems({
      page: 1,
      limit: 50,
      targetKind: "all",
      outcome: "all",
      hasKnowledge: "all",
      includeStored: true,
      sortBy: "latestUpdatedAt",
      sortDir: "desc",
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("candidate-result-1");
    expect(result.items[0]?.outcome).toBe("stored");
    expect(result.items[0]?.knowledge?.id).toBe("knowledge-from-candidate-1");
  });

  test("serves queue dashboard reads from sqlite without postgres SQL", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date("2026-06-20T00:00:00.000Z").toISOString();
    const settings = structuredClone(getRuntimeSettingsSnapshot());
    const ornith = {
      id: "local-ornith",
      name: "Ornith",
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "ornith-1.0-9b-4bit",
    };
    const qwopus = {
      id: "local-qwopus",
      name: "Qwopus",
      apiBaseUrl: "http://127.0.0.1:50041/v1",
      apiPath: "/v1/chat/completions",
      model: "qwopus-test",
    };
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: ornith.apiBaseUrl,
      apiPath: ornith.apiPath,
      model: ornith.model,
      models: [ornith, qwopus],
    };
    settings.providerPools = [
      {
        id: "local-llm-default",
        label: "Qwopus Pool",
        enabled: true,
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [{ provider: "local-llm", localLlmModelId: qwopus.id }],
      },
    ];
    settings.taskRouting.findCandidate.source = {
      provider: "local-llm",
      model: ornith.model,
      localLlmModel: ornith.model,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.externalEvidence = {
      provider: "local-llm",
      model: ornith.model,
      localLlmModel: ornith.model,
      providerPoolId: "local-llm-default",
      fallback: [],
    };
    settings.taskRouting.coverEvidence.sourceSupport = {
      ...settings.taskRouting.coverEvidence.externalEvidence,
    };
    settings.taskRouting.coverEvidence.mcpEvidence = {
      ...settings.taskRouting.coverEvidence.externalEvidence,
    };
    await saveRuntimeSettings({ settings, updatedBy: "sqlite-runtime-test" });

    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, status, priority,
          attempt_count, created_at, updated_at, locked_by, locked_at, heartbeat_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "finding-running",
        "source_target",
        "wiki_file",
        "SQLite Queue Source",
        "file:///sqlite-queue.md",
        "running",
        90,
        1,
        now,
        now,
        "worker-1",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into llm_provider_leases (
          id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
          locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lease-qwopus",
        "local-llm-default",
        qwopus.id,
        "findingCandidate",
        "finding-running",
        "lease-worker-qwopus",
        "active",
        now,
        now,
        now,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into finding_candidate_queue (
          id, input_kind, source_kind, source_key, source_uri, status, priority,
          attempt_count, created_at, updated_at, locked_by, locked_at, heartbeat_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "finding-missing-target",
        "source_target",
        "wiki_file",
        "Missing Target Source",
        "file:///missing-target.md",
        "running",
        80,
        1,
        now,
        now,
        "worker-stale",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into llm_provider_leases (
          id, pool_id, target_id, queue_name, queue_job_id, worker_id, status,
          locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "lease-missing-target",
        "local-llm-default",
        "local-missing-target",
        "findingCandidate",
        "finding-missing-target",
        "lease-worker-missing-target",
        "active",
        now,
        now,
        now,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into found_candidates (
          id, finding_job_id, candidate_index, title, content, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("candidate-1", "finding-running", 0, "SQLite Candidate", "Candidate body", now, now);
    sqlite.db
      .query(
        `
        insert into covering_evidence_queue (
          id, found_candidate_id, status, priority, attempt_count, provider_policy,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("covering-pending", "candidate-1", "pending", 50, 0, "default", now, now);

    const activeTasks = await fetchActiveTasks();
    expect(activeTasks.map((task) => task.id)).toContain("finding-running");
    const activeFindingTask = activeTasks.find((task) => task.id === "finding-running");
    expect(activeFindingTask?.subjectTitle).toBe("SQLite Queue Source");
    expect(activeFindingTask?.lockedBy).toBe("lease-worker-qwopus");
    expect(activeFindingTask?.provider).toBe("local-llm");
    expect(activeFindingTask?.model).toBe("qwopus-test");
    expect(activeFindingTask?.activeProviderPoolId).toBe("local-llm-default");
    expect(activeFindingTask?.activeProviderTargetId).toBe(qwopus.id);
    const missingTargetTask = activeTasks.find((task) => task.id === "finding-missing-target");
    expect(missingTargetTask?.lockedBy).toBe("lease-worker-missing-target");
    expect(missingTargetTask?.model).toBe("local-missing-target");
    expect(missingTargetTask?.model).not.toContain("ornith");

    const listed = await listQueueItems({
      queue: "findingCandidate",
      status: "running",
      query: "sqlite queue",
      page: 1,
      limit: 20,
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.id).toBe("finding-running");
    expect(listed.items[0]?.model).toBe("qwopus-test");
    expect(listed.items[0]?.activeProviderTargetId).toBe(qwopus.id);

    const coveringListed = await listQueueItems({
      queue: "coveringEvidence",
      status: "pending",
      query: "sqlite candidate",
      page: 1,
      limit: 20,
    });
    expect(coveringListed.items[0]?.id).toBe("covering-pending");
    expect(coveringListed.items[0]?.provider).toBe("local-llm");
    expect(coveringListed.items[0]?.model).toContain("qwopus-test");
    expect(coveringListed.items[0]?.model).not.toContain("ornith");

    const stats = await fetchQueueDashboardStats();
    expect(stats.queues.findingCandidate.counters.running).toBe(2);
    expect(stats.queues.coveringEvidence.counters.pending).toBe(1);
  });

  test("serves overview dashboard and domain reads from sqlite without postgres SQL", async () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/context_still_dead";
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, dynamic_score, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-knowledge-1",
        "rule",
        "active",
        "repo",
        "positive",
        "[]",
        "Overview knowledge",
        "Overview body",
        "{}",
        75,
        80,
        3,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items (
          id, type, status, scope, polarity, intent_tags, title, body, applies_to,
          confidence, importance, dynamic_score, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-knowledge-2",
        "procedure",
        "active",
        "repo",
        "positive",
        "[]",
        "Overview related knowledge",
        "Overview related body",
        "{}",
        70,
        70,
        8,
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_items_vec_fallback (
          knowledge_id, embedding_json, embedding_dimension, content_hash, updated_at
        ) values (?, ?, ?, ?, ?)
      `,
      )
      .run("overview-knowledge-1", "[0.1,0.2]", 2, "overview-vector-hash", now);
    sqlite.db
      .query(
        `
        insert into sources (id, source_kind, uri, title, body, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-1",
        "wiki",
        "file:///overview-source.md",
        "Overview source",
        "Overview source body",
        "{}",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into source_fragments (id, source_id, locator, heading, content, metadata, created_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-fragment-1",
        "overview-source-1",
        "L1-L2",
        "Overview",
        "Overview fragment body",
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_source_links (
          id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-link-1",
        "overview-knowledge-1",
        "overview-fragment-1",
        "derived_from",
        0.9,
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into knowledge_source_links (
          id, knowledge_id, source_fragment_id, link_type, confidence, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-source-link-2",
        "overview-knowledge-2",
        "overview-fragment-1",
        "derived_from",
        0.9,
        "{}",
        now,
      );
    sqlite.db
      .query(
        `
        insert into vibe_memories (id, session_id, content, memory_type, metadata, created_at)
        values (?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-vibe-1", "overview-session", "Overview vibe memory", "chat", "{}", now);
    sqlite.db
      .query(
        `
        insert into agent_diff_entries (
          id, vibe_memory_id, file_path, diff_hunk, metadata, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-diff-1", "overview-vibe-1", "src/overview.ts", "+overview", "{}", now, now);
    const runId = await insertCompileRun({
      goal: "sqlite overview compile run",
      intent: "implementation",
      repoPath: "/repo/contextStill",
      matchBasis: "repo_path",
      identityContractVersion: 1,
      scopeMode: "project",
      input: {
        goal: "sqlite overview compile run",
        repoPath: "/repo/contextStill",
        projectIdentity: {
          contractVersion: 1,
          matchBasis: "repo_path",
          matchValue: "/repo/contextStill",
          scopeMode: "project",
          projectRef: null,
          repoKey: null,
          repoPath: "/repo/contextStill",
        },
      },
      retrievalMode: "implementation_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 12,
      source: "mcp",
    });
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", "overview-knowledge-1", "knowledge", 0.9, "selected", "[]", now);
    sqlite.db
      .query(
        `
        insert into context_compile_candidate_traces (
          run_id, item_kind, item_id, selected, created_at
        ) values (?, ?, ?, ?, ?)
      `,
      )
      .run(runId, "rule", "overview-knowledge-1", 1, now);
    const replayRunId = await insertCompileRun({
      goal: "sqlite overview related compile run",
      intent: "implementation",
      repoPath: "/repo/contextStill",
      matchBasis: "repo_path",
      identityContractVersion: 1,
      scopeMode: "project",
      input: {
        goal: "sqlite overview related compile run",
        repoPath: "/repo/contextStill",
        projectIdentity: {
          contractVersion: 1,
          matchBasis: "repo_path",
          matchValue: "/repo/contextStill",
          scopeMode: "project",
          projectRef: null,
          repoKey: null,
          repoPath: "/repo/contextStill",
        },
      },
      retrievalMode: "implementation_context",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 14,
      source: "mcp",
    });
    sqlite.db
      .query(
        `
        insert into context_pack_items (
          run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        replayRunId,
        "procedure",
        "overview-knowledge-2",
        "knowledge",
        0.8,
        "selected",
        "[]",
        now,
      );
    sqlite.db
      .query(
        `
        insert into context_compile_evals (
          id, run_id, score, outcome, body, relevance, actionability, coverage, clarity,
          specificity, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overview-eval-1", runId, 80, "useful", "overview eval", 80, 82, 78, 81, 79, now, now);
    sqlite.db
      .query(
        `
        insert into context_decision_runs (
          id, decision_point, options, retrieval_hints, decision, rejected_actions,
          mandate, agent_message, confidence, confidence_trace, guardrails,
          unsupported_alternatives, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-decision-1",
        "Use SQLite overview?",
        "[]",
        "{}",
        "execute",
        "[]",
        "Use SQLite overview.",
        "Proceed.",
        90,
        "{}",
        "{}",
        "[]",
        "completed",
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into context_decision_human_feedback (id, decision_run_id, value, created_at)
        values (?, ?, ?, ?)
      `,
      )
      .run("overview-human-feedback-1", "overview-decision-1", "good", now);
    sqlite.db
      .query(
        `
        insert into llm_usage_logs (
          id, provider, model, prompt_tokens, completion_tokens, total_tokens,
          reasoning_tokens, cost_jpy, usage_mode, source, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-llm-local-1",
        "local-llm",
        "local-model",
        10,
        20,
        30,
        1,
        0,
        "measured",
        "context_compile",
        now,
      );
    sqlite.db
      .query(
        `
        insert into llm_usage_logs (
          id, provider, model, prompt_tokens, completion_tokens, total_tokens,
          reasoning_tokens, cost_jpy, usage_mode, source, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-llm-cloud-1",
        "azure-openai",
        "gpt-test",
        12,
        18,
        30,
        2,
        0.12,
        "estimated",
        "context_compile",
        now,
      );
    sqlite.db
      .query(
        `
        insert into landscape_snapshots (
          id, snapshot_type, status, params_hash, params, payload, generated_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-landscape-snapshot-1",
        "landscape_snapshot",
        "ready",
        "overview-landscape",
        "{}",
        JSON.stringify({
          stats: {
            totalCommunities: 2,
            strongAttractorCount: 1,
            usefulAttractorCount: 1,
            negativeCandidateCount: 0,
            overSelectedNotUsedCount: 0,
            deadZoneReachabilityCount: 1,
            deadZoneStaleCount: 0,
            insufficientFeedbackCommunities: 1,
          },
          risks: [{ id: "risk-1" }],
        }),
        now,
        now,
        now,
      );
    sqlite.db
      .query(
        `
        insert into landscape_snapshots (
          id, snapshot_type, status, params_hash, params, payload, generated_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overview-landscape-replay-1",
        "landscape_replay_comparison",
        "ready",
        "overview-replay",
        "{}",
        JSON.stringify({
          generatedAt: now,
          comparedRunCount: 3,
          averageOverlapRate: 0.75,
          retainedItemCount: 4,
          missingFromCurrentItemCount: 1,
          newlyRetrievedItemCount: 2,
          usedBaselineLostItemCount: 1,
          currentNoMatchRunCount: 0,
          scoreTuning: { highChurnRunCount: 1 },
          promotionGateSummary: { gateMode: "review_required" },
        }),
        now,
        now,
        now,
      );

    const dashboard = await fetchOverviewDashboardForApi();
    expect(dashboard.kpis.knowledgeTotal).toBe(2);
    expect(dashboard.kpis.compileRuns).toBe(2);
    expect(dashboard.kpis.sourceLinks).toBe(2);
    expect(dashboard.kpis.vibeRecords).toBe(1);
    expect(dashboard.kpis.graphEdges).toBeGreaterThan(0);
    expect(dashboard.kpis.graphEmbedded).toBe(1);
    expect(dashboard.kpis.sourceCommunities).toBe(1);
    expect(dashboard.kpis.sourceCoveredCommunities).toBe(1);
    expect(dashboard.llmUsage.kpis.totalCalls30d).toBe(2);
    expect(dashboard.llmUsage.kpis.localTokensTotal30d).toBe(30);
    expect(dashboard.llmUsage.kpis.cloudTokensTotal30d).toBe(30);
    expect(dashboard.compileEvalStats.evaluationCount).toBe(1);
    expect(dashboard.productValueStats.evidence.reusedCompileRunCount).toBe(2);
    expect(dashboard.landscape.status).toBe("ok");

    const knowledge = await fetchOverviewDomainForApi("knowledge-assets");
    const landscape = await fetchOverviewDomainForApi("landscape-health");
    const system = await fetchOverviewDomainForApi("system-quality");
    const llm = await fetchOverviewDomainForApi("llm-resources");

    expect(knowledge.checkedAt).toBeTruthy();
    expect(landscape.checkedAt).toBeTruthy();
    expect(system.checkedAt).toBeTruthy();
    expect(llm.checkedAt).toBeTruthy();
    expect((knowledge as { kpis: { knowledgeTotal: number } }).kpis.knowledgeTotal).toBe(2);
    expect((knowledge as { kpis: { graphEdges: number } }).kpis.graphEdges).toBeGreaterThan(0);
    expect((knowledge as { kpis: { graphEmbedded: number } }).kpis.graphEmbedded).toBe(1);
    expect((system as { kpis: { compileRuns: number } }).kpis.compileRuns).toBe(2);
    expect(
      (system as { compileEvalStats: { evaluationCount: number } }).compileEvalStats
        .evaluationCount,
    ).toBe(1);
    expect(
      (llm as { llmUsage: { kpis: { totalCalls30d: number } } }).llmUsage.kpis.totalCalls30d,
    ).toBe(2);
    expect((landscape as { landscape: { status: string } }).landscape.status).toBe("ok");

    sqlite.db.query("delete from landscape_snapshots").run();
    const fallbackLandscape = (await fetchOverviewDomainForApi("landscape-health")) as {
      landscape: {
        status: string;
        snapshot?: { totalCommunities: number };
        replay?: { comparedRunCount: number };
      };
    };
    expect(fallbackLandscape.landscape.status).toBe("ok");
    expect(fallbackLandscape.landscape.snapshot?.totalCommunities).toBeGreaterThan(0);
    expect(fallbackLandscape.landscape.replay?.comparedRunCount).toBeGreaterThan(0);
  }, 15_000);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}
