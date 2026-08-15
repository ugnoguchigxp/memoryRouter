import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { groupedConfig } from "../src/config.js";
import { getDb } from "../src/db/index.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import {
  getRuntimeSettingsSnapshot,
  saveRuntimeSettings,
} from "../src/modules/settings/settings.service.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("context compiler integration", () => {
  const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
  let originalRuntimeSettings: ReturnType<typeof getRuntimeSettingsSnapshot> | null = null;

  beforeAll(async () => {
    await ensureDbIntegrationReady();
    originalRuntimeSettings = structuredClone(getRuntimeSettingsSnapshot());
    const settings = structuredClone(originalRuntimeSettings);
    settings.taskRouting.agenticCompile.enabled = false;
    await saveRuntimeSettings({
      settings,
      updatedBy: "integration-test",
    });
  });

  beforeEach(async () => {
    groupedConfig.agenticCompile.enabled = false;
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    groupedConfig.agenticCompile.enabled = originalAgenticCompileEnabled;
    if (originalRuntimeSettings) {
      await saveRuntimeSettings({
        settings: originalRuntimeSettings,
        updatedBy: "integration-test-restore",
      });
    }
    await closeIntegrationDb();
  });

  test("applies section token budget and keeps source refs on selected items", async () => {
    const fixtureTerms = [
      "Alpha rollout checklist",
      "Bravo migration checklist",
      "Charlie observability checklist",
      "Delta fallback checklist",
      "Echo documentation checklist",
      "Foxtrot release checklist",
    ];
    for (let i = 0; i < 6; i += 1) {
      await upsertKnowledgeFromSource({
        sourceUri: `file:///knowledge/rule-${i}.md`,
        type: "rule",
        status: "active",
        scope: "global",
        title: fixtureTerms[i] ?? `Budget fixture ${i}`,
        body: [
          `budget scenario integration source linkage ${(fixtureTerms[i] ?? "").toLowerCase()}`,
          `unique operational detail ${(fixtureTerms[i] ?? "").toLowerCase()} ${"x".repeat(360)}`,
        ].join(" "),
      });
    }

    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///sources/budget.md",
      title: "Budget Source",
      body: "budget scenario integration source linkage proof",
    });

    const { pack } = await compileContextPack({
      goal: "budget scenario integration",
      intent: "edit",
      tokenBudget: 256,
    });

    expect(pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
    expect(pack.rules.length).toBeGreaterThan(0);
    expect(pack.rules.length).toBeLessThan(6);
    expect(pack.rules.some((item) => item.sourceRefs.length > 0)).toBe(true);
  });

  test("distinguishes no-match degraded reasons from retrieval failures", async () => {
    const noMatch = await compileContextPack({
      goal: "utterly-unmatched-goal-string",
      intent: "edit",
      queryEmbedding: new Array(384).fill(0),
    });
    expect(noMatch.pack.diagnostics.degradedReasons).toContain("NO_ACTIVE_KNOWLEDGE_MATCH");
    expect(noMatch.pack.diagnostics.degradedReasons).toContain("NO_SOURCE_MATCH");
    expect(
      noMatch.pack.diagnostics.degradedReasons.some((reason) => reason.endsWith("_FAILED")),
    ).toBe(false);
    expect(noMatch.pack.sourceRefs.length).toBeGreaterThan(0);
    expect(noMatch.pack.sourceRefs[0]?.startsWith("context-still://packs/run/")).toBe(true);

    const db = getDb();
    await db.execute(sql`alter table source_fragments rename to source_fragments_tmp`);
    try {
      const failure = await compileContextPack({
        goal: "still-unmatched-goal",
        intent: "edit",
        queryEmbedding: new Array(384).fill(0),
      });
      expect(failure.pack.diagnostics.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
      expect(failure.pack.diagnostics.degradedReasons).not.toContain("NO_SOURCE_MATCH");
    } finally {
      await db.execute(sql`alter table source_fragments_tmp rename to source_fragments`);
    }
  });

  test("procedure_context prioritizes procedure knowledge types", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/procedure.md",
      type: "procedure",
      status: "active",
      scope: "global",
      title: "Deploy runbook",
      body: "runbook procedure context command sequence",
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/rule.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Deploy rule",
      body: "runbook procedure context command sequence",
    });

    const { pack } = await compileContextPack({
      goal: "runbook procedure context command",
      intent: "edit",
      retrievalMode: "procedure_context",
      tokenBudget: 4000,
    });

    expect(pack.retrievalMode).toBe("procedure_context");
    expect(pack.procedures.length).toBeGreaterThan(0);
    expect(pack.rules.length).toBe(0);
  });

  test("includeDraft includes draft procedures when requested", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/draft-proc.md",
      type: "procedure",
      status: "draft",
      scope: "global",
      title: "Draft Procedure",
      body: "draft-mode command sequence",
    });

    const withoutDraft = await compileContextPack({
      goal: "draft-mode command sequence",
      retrievalMode: "procedure_context",
      includeDraft: false,
    });
    expect(withoutDraft.pack.procedures.some((item) => item.title === "Draft Procedure")).toBe(
      false,
    );

    const withDraft = await compileContextPack({
      goal: "draft-mode command sequence",
      retrievalMode: "procedure_context",
      includeDraft: true,
    });
    expect(withDraft.pack.procedures.some((item) => item.title === "Draft Procedure")).toBe(true);
  });

  test("returns pack without code_context section", async () => {
    const { pack } = await compileContextPack({
      goal: "adjust compile behavior",
      intent: "edit",
      files: ["src/modules/context-compiler/context-compiler.service.ts"],
    });
    expect(Array.isArray(pack.rules)).toBe(true);
    expect(Array.isArray(pack.procedures)).toBe(true);
  });

  test("repoPath scopes knowledge retrieval to same repo and global", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-a/rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo A Rule",
      body: "scoped compile token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-b/rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo B Rule",
      body: "scoped compile token",
      metadata: {
        repoPath: "/workspace/repo-b",
        repoKey: "/workspace/repo-b",
      },
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-a-archive/rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo A Archive Rule",
      body: "scoped compile token",
      metadata: {
        repoPath: "/workspace/repo-a-archive",
        repoKey: "/workspace/repo-a-archive",
      },
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///global/rule.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Global Rule",
      body: "scoped compile token",
    });

    const { pack } = await compileContextPack({
      goal: "scoped compile token",
      intent: "edit",
      repoPath: "/workspace/repo-a",
      tokenBudget: 4000,
    });

    const titles = pack.rules.map((item) => item.title);
    expect(titles).toContain("Repo A Rule");
    expect(titles).toContain("Global Rule");
    expect(titles).not.toContain("Repo B Rule");
    expect(titles).not.toContain("Repo A Archive Rule");
    expect(pack.diagnostics.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
  });

  test("repoPath never mixes draft knowledge from other repos", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-a/rule-draft-safe.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo A Active Rule",
      body: "draft scope guard token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-b/rule-draft-danger.md",
      type: "rule",
      status: "draft",
      scope: "repo",
      title: "Repo B Draft Rule",
      body: "draft scope guard token",
      metadata: {
        repoPath: "/workspace/repo-b",
        repoKey: "/workspace/repo-b",
      },
    });

    const { pack } = await compileContextPack({
      goal: "draft scope guard token",
      intent: "edit",
      repoPath: "/workspace/repo-a",
      includeDraft: true,
      tokenBudget: 4000,
    });

    const titles = pack.rules.map((item) => item.title);
    expect(titles).toContain("Repo A Active Rule");
    expect(titles).not.toContain("Repo B Draft Rule");
  });

  test("does not fall back to another repository when scoped knowledge is missing", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///legacy/rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Legacy Rule",
      body: "legacy fallback token",
      repoPath: "/workspace/legacy",
    });

    const { pack } = await compileContextPack({
      goal: "legacy fallback token",
      intent: "edit",
      repoPath: "/workspace/repo-a",
    });

    expect(pack.rules.some((item) => item.title === "Legacy Rule")).toBe(false);
    expect(pack.diagnostics.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
  });

  test("uses canonical repository columns when appliesTo identity is missing", async () => {
    const sourceUri = "file:///legacy-metadata/rule.md";
    await upsertKnowledgeFromSource({
      sourceUri,
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Legacy Metadata Rule",
      body: "legacy metadata scope token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });

    const db = getDb();
    await db.execute(sql`
      UPDATE knowledge_items
      SET applies_to = '{}'::jsonb
      WHERE metadata ->> 'sourceUri' = ${sourceUri}
    `);

    const { pack } = await compileContextPack({
      goal: "legacy metadata scope token",
      intent: "edit",
      repoPath: "/workspace/repo-a",
    });

    expect(pack.rules.some((item) => item.title === "Legacy Metadata Rule")).toBe(true);
    expect(pack.diagnostics.degradedReasons).not.toContain("KNOWLEDGE_APPLIES_TO_FALLBACK");
    expect(pack.diagnostics.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
  });

  test("canonical repository columns keep eligible rows independent of appliesTo metadata", async () => {
    const legacySourceUri = "file:///legacy-mixed/rule.md";
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repo-a/primary-rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo A Primary Rule",
      body: "repo scope priority token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });
    await upsertKnowledgeFromSource({
      sourceUri: legacySourceUri,
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repo A Legacy Metadata Rule",
      body: "repo scope priority token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });

    const db = getDb();
    await db.execute(sql`
      UPDATE knowledge_items
      SET applies_to = '{}'::jsonb
      WHERE metadata ->> 'sourceUri' = ${legacySourceUri}
    `);

    const { pack } = await compileContextPack({
      goal: "repo scope priority token",
      intent: "edit",
      repoPath: "/workspace/repo-a",
    });

    const titles = pack.rules.map((item) => item.title);
    expect(titles).toContain("Repo A Primary Rule");
    expect(titles).toContain("Repo A Legacy Metadata Rule");
    expect(pack.diagnostics.degradedReasons).not.toContain("KNOWLEDGE_APPLIES_TO_FALLBACK");
  });
});
