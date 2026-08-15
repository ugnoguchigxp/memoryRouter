import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildGraphSnapshot } from "../api/modules/graph/graph.repository.js";
import { groupedConfig } from "../src/config.js";
import {
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
} from "../src/modules/knowledge/knowledge.repository.js";
import {
  deleteStaleSourcesForRoot,
  searchSourceContent,
  upsertSourceDocument,
} from "../src/modules/sources/source.repository.js";

import { vi } from "vitest";
import {
  recordVibeMemory,
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn().mockImplementation(async (text: string) => {
    // Return a dummy vector of the correct dimension (default is 384)
    return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  }),
}));

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("repositories integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("knowledge upsert/search respects lifecycle filters", async () => {
    const activeId = await upsertKnowledgeFromSource({
      sourceUri: "file:///active.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Repository Integration Rule",
      body: "Always keep source refs attached to source-backed claims.",
    });

    const draftId = await upsertKnowledgeFromSource({
      sourceUri: "file:///draft.md",
      type: "procedure",
      status: "draft",
      scope: "global",
      title: "Repository Integration Skill",
      body: "Use runbook command sequence for integration checks.",
    });

    const activeOnly = await searchKnowledge({
      query: "integration",
      limit: 10,
      status: "active",
      statuses: ["active"],
      includeDraft: false,
    });
    expect(activeOnly.some((item) => item.id === activeId)).toBe(true);
    expect(activeOnly.some((item) => item.id === draftId)).toBe(false);

    const withDrafts = await searchKnowledge({
      query: "integration",
      limit: 10,
      status: "active",
      statuses: ["active", "draft"],
      includeDraft: true,
    });
    expect(withDrafts.some((item) => item.id === activeId)).toBe(true);
    expect(withDrafts.some((item) => item.id === draftId)).toBe(true);
  });

  test("source document upsert creates searchable source content", async () => {
    const sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///docs/source.md",
      title: "Source",
      body: "compile command failed because vector extension was missing.",
      metadata: { tags: ["vector-runtime", "operations"] },
    });

    const hits = await searchSourceContent("vector extension", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceId).toBe(sourceId);
    expect(hits[0]?.sourceUri).toBe("file:///docs/source.md");

    const tagHits = await searchSourceContent("vector-runtime", 5);
    expect(tagHits.some((hit) => hit.sourceId === sourceId)).toBe(true);
  });

  test("source upsert keeps a single row per uri and refreshes searchable content", async () => {
    const uri = "/tmp/wiki/single-source.md";
    const firstId = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri,
      title: "Single Source",
      body: "old-token source body",
    });
    const secondId = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri,
      title: "Single Source",
      body: "new-token source body",
    });

    expect(secondId).toBe(firstId);
    const oldHits = await searchSourceContent("old-token", 5);
    expect(oldHits.some((hit) => hit.sourceUri === uri)).toBe(false);
    const newHits = await searchSourceContent("new-token", 5);
    expect(newHits.some((hit) => hit.sourceUri === uri)).toBe(true);
  });

  test("deleteStaleSourcesForRoot removes stale rows under the root only", async () => {
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "/tmp/wiki/keep.md",
      title: "Keep",
      body: "keep body",
      metadata: { sourceRootPath: "/tmp/wiki" },
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "/tmp/wiki/stale.md",
      title: "Stale",
      body: "stale body",
      metadata: { sourceRootPath: "/tmp/wiki" },
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "/tmp/other/outside.md",
      title: "Outside",
      body: "outside body",
      metadata: { sourceRootPath: "/tmp/other" },
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "/tmp/wiki-archive/keep-by-boundary.md",
      title: "Boundary Outside",
      body: "boundary outside body",
      metadata: { sourceRootPath: "/tmp/wiki-archive" },
    });

    const removed = await deleteStaleSourcesForRoot({
      rootPath: "/tmp/wiki",
      keepUris: ["/tmp/wiki/keep.md"],
    });
    expect(removed).toBe(1);
    const staleHits = await searchSourceContent("stale body", 5);
    expect(staleHits.some((hit) => hit.sourceUri === "/tmp/wiki/stale.md")).toBe(false);
    const outsideHits = await searchSourceContent("outside body", 5);
    expect(outsideHits.some((hit) => hit.sourceUri === "/tmp/other/outside.md")).toBe(true);
    const boundaryOutsideHits = await searchSourceContent("boundary outside body", 5);
    expect(
      boundaryOutsideHits.some((hit) => hit.sourceUri === "/tmp/wiki-archive/keep-by-boundary.md"),
    ).toBe(true);
  });

  test("source search scope keeps boundary and repoKey constraints", async () => {
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "repo",
      uri: "/workspace/repo-a/wiki/rule.md",
      title: "Repo A Rule",
      body: "repo-scope-token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "repo",
      uri: "/workspace/repo-a-archive/wiki/rule.md",
      title: "Repo A Archive Rule",
      body: "repo-scope-token",
      metadata: {
        repoPath: "/workspace/repo-a-archive",
        repoKey: "/workspace/repo-a-archive",
      },
    });

    const scopedByPath = await searchSourceContent("repo-scope-token", 10, undefined, {
      repoPath: "/workspace/repo-a",
    });
    expect(
      scopedByPath.some((hit) => hit.sourceUri.includes("/workspace/repo-a/wiki/rule.md")),
    ).toBe(true);
    expect(
      scopedByPath.some((hit) => hit.sourceUri.includes("/workspace/repo-a-archive/wiki/rule.md")),
    ).toBe(false);

    const scopedByRepoKey = await searchSourceContent("repo-scope-token", 10, undefined, {
      repoKey: "/workspace/repo-a",
    });
    expect(
      scopedByRepoKey.some((hit) => hit.sourceUri.includes("/workspace/repo-a/wiki/rule.md")),
    ).toBe(true);
    expect(
      scopedByRepoKey.some((hit) =>
        hit.sourceUri.includes("/workspace/repo-a-archive/wiki/rule.md"),
      ),
    ).toBe(false);
  });

  test("compile run and context pack items are persisted and retrievable", async () => {
    const runId = await insertCompileRun({
      goal: "integration run",
      intent: "review",
      input: { goal: "integration run", intent: "review" },
      retrievalMode: "review_context",
      status: "degraded",
      degradedReasons: ["NO_SOURCE_MATCH"],
      tokenBudget: 2048,
      durationMs: 123,
    });

    await insertContextPackItems(runId, [
      {
        itemKind: "rule",
        itemId: "rule-1",
        section: "rules",
        score: 0.9,
        rankingReason: "integration test",
        sourceRefs: ["file:///docs/source.md#line:1-5"],
      },
      {
        itemKind: "procedure",
        itemId: "procedure-1",
        section: "procedures",
        score: 0.8,
        rankingReason: "integration test",
        sourceRefs: [],
      },
    ]);

    const runs = await listRecentCompileRuns(5);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe("degraded");

    const snapshot = await getCompileRunSnapshot(runId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items.length).toBe(2);
    expect(snapshot?.items[0]?.section).toBe("rules");
    expect(snapshot?.items[0]?.sourceRefs.length).toBeGreaterThan(0);
  });

  test("vibe memory recording persists agent diffs and extracted symbols", async () => {
    const result = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "integration-agent-diff-session",
      content: "AI generated repository diff",
      memoryType: "action",
      diff: `diff --git a/src/integration.ts b/src/integration.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/integration.ts
@@ -0,0 +1,5 @@
+export function integrationValue(): number {
+  return 7;
+}
+
+export const integrationName = "memory-router";
`,
    });

    expect(result.memory.sessionId).toBe("integration-agent-diff-session");
    expect(result.diffEntries.length).toBeGreaterThan(0);
    expect(result.diffEntries[0]?.vibeMemoryId).toBe(result.memory.id);
    expect(result.diffEntries[0]?.filePath).toBe("src/integration.ts");
    expect(result.diffEntries.some((entry) => entry.symbolName === "integrationValue")).toBe(true);
    expect(result.diffEntries.some((entry) => entry.startLine === 1)).toBe(true);

    const hits = await retrieveVibeMemoryContext({
      query: "integrationValue",
      sessionId: "integration-agent-diff-session",
      limit: 5,
    });
    expect(hits.some((hit: any) => hit.id === result.memory.id)).toBe(true);
  });

  test("vibe memory recording moves embedded content diffs into agent_diff_entries", async () => {
    const result = await recordVibeMemoryWithDiffEntries({
      scope: "global",
      sessionId: "integration-embedded-agent-diff-session",
      content: `差分を作りました。

\`\`\`diff
diff --git a/src/embedded.ts b/src/embedded.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/embedded.ts
@@ -0,0 +1,3 @@
+export function embeddedValue(): number {
+  return 9;
+}
\`\`\`

確認してください。`,
      memoryType: "chat",
    });

    expect(result.memory.content).toBe("差分を作りました。\n\n確認してください。");
    expect(result.memory.content).not.toContain("diff --git");
    expect(result.diffEntries.length).toBeGreaterThan(0);
    expect(result.diffEntries.some((entry) => entry.filePath === "src/embedded.ts")).toBe(true);
    expect(result.diffEntries.some((entry) => entry.symbolName === "embeddedValue")).toBe(true);
  });

  test("graph relation view enforces global per-node cap and supports axis filtering", async () => {
    await recordVibeMemory({
      scope: "global",
      sessionId: "graph-session-fallback",
      content: "project fallback context",
      memoryType: "chat",
      metadata: {
        projectRoot: "/workspace/graph-fallback",
      },
    });

    const knowledgeIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const sessionId = index < 3 ? "graph-session-a" : "graph-session-b";
      const id = await upsertKnowledgeFromSource({
        sourceUri: `vibe-memory://graph-${index}`,
        type: "rule",
        status: "active",
        scope: "repo",
        title: `Graph Relation ${index}`,
        body: "graph relation test body",
        metadata: {
          sourceSessionId: sessionId,
          repoPath: "/workspace/repo-graph",
          repoKey: "/workspace/repo-graph",
        },
      });
      knowledgeIds.push(id);
    }

    const fallbackA = await upsertKnowledgeFromSource({
      sourceUri: "vibe-memory://graph-fallback-a",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Graph Fallback A",
      body: "graph fallback body",
      metadata: {
        sourceSessionId: "graph-session-fallback",
        repoPath: "/workspace/graph-fallback",
      },
    });
    const fallbackB = await upsertKnowledgeFromSource({
      sourceUri: "vibe-memory://graph-fallback-b",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Graph Fallback B",
      body: "graph fallback body",
      metadata: {
        sourceSessionId: "graph-session-fallback",
        repoPath: "/workspace/graph-fallback",
      },
    });

    const relationSnapshot = await buildGraphSnapshot({
      limit: 30,
      view: "relation",
      relationAxes: ["session", "project"],
      maxContextEdgesPerNode: 2,
      status: "all",
    });
    expect(relationSnapshot.edges.length).toBeGreaterThan(0);
    const degree = new Map<string, number>();
    for (const edge of relationSnapshot.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBeLessThanOrEqual(2);

    const sessionOnly = await buildGraphSnapshot({
      limit: 30,
      view: "relation",
      relationAxes: ["session"],
      status: "all",
    });
    expect(sessionOnly.edges.length).toBeGreaterThan(0);
    expect(sessionOnly.edges.every((edge) => edge.edgeKind === "session")).toBe(true);
    expect(sessionOnly.stats.projectEdgeCount).toBe(0);

    const projectOnly = await buildGraphSnapshot({
      limit: 30,
      view: "relation",
      relationAxes: ["project"],
      status: "all",
    });
    expect(projectOnly.edges.length).toBeGreaterThan(0);
    expect(projectOnly.edges.every((edge) => edge.edgeKind === "project")).toBe(true);
    expect(projectOnly.stats.sessionEdgeCount).toBe(0);
    const fallbackNodeIds = new Set([`knowledge:${fallbackA}`, `knowledge:${fallbackB}`]);
    expect(
      projectOnly.edges.some(
        (edge) => fallbackNodeIds.has(edge.source) && fallbackNodeIds.has(edge.target),
      ),
    ).toBe(true);

    const legacySourceA = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://legacy-source-a",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Graph Legacy Source A",
      body: "graph legacy source body",
      metadata: {
        sourceDocumentUri: "file:///workspace/wiki/shared-source.md",
        repoPath: "/workspace/wiki",
      },
    });
    const legacySourceB = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://legacy-source-b",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Graph Legacy Source B",
      body: "graph legacy source body",
      metadata: {
        sourceDocumentUri: "file:///workspace/wiki/shared-source.md",
        repoPath: "/workspace/wiki",
      },
    });
    const sourceOnly = await buildGraphSnapshot({
      limit: 30,
      view: "relation",
      relationAxes: ["source"],
      status: "all",
    });
    const legacySourceNodeIds = new Set([
      `knowledge:${legacySourceA}`,
      `knowledge:${legacySourceB}`,
    ]);
    expect(
      sourceOnly.edges.some(
        (edge) =>
          edge.edgeKind === "source" &&
          legacySourceNodeIds.has(edge.source) &&
          legacySourceNodeIds.has(edge.target),
      ),
    ).toBe(true);

    for (const id of knowledgeIds) {
      expect(relationSnapshot.nodes.some((node) => node.id === `knowledge:${id}`)).toBe(true);
    }
  });

  test("graph semantic view keeps threshold and topK behavior", async () => {
    const vectorA = Array.from({ length: groupedConfig.embedding.dimension }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const vectorB = Array.from({ length: groupedConfig.embedding.dimension }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const vectorC = Array.from({ length: groupedConfig.embedding.dimension }, (_, index) =>
      index === 0 ? -1 : 0,
    );

    const idA = await upsertKnowledgeFromSource({
      sourceUri: "file:///semantic-a.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Semantic A",
      body: "semantic edge test",
      embedding: vectorA,
      repoPath: "/workspace/semantic",
    });
    const idB = await upsertKnowledgeFromSource({
      sourceUri: "file:///semantic-b.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Semantic B",
      body: "semantic edge test",
      embedding: vectorB,
      repoPath: "/workspace/semantic",
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///semantic-c.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Semantic C",
      body: "semantic edge test",
      embedding: vectorC,
      repoPath: "/workspace/semantic",
    });

    const semanticSnapshot = await buildGraphSnapshot({
      limit: 20,
      view: "semantic",
      minSimilarity: 0.72,
      semanticTopK: 1,
      status: "all",
    });

    expect(semanticSnapshot.edges.length).toBeGreaterThan(0);
    expect(semanticSnapshot.edges.every((edge) => edge.edgeKind === "semantic")).toBe(true);
    expect(semanticSnapshot.stats.relationEdgeCount).toBe(0);
    const expectedPair = [`knowledge:${idA}`, `knowledge:${idB}`].sort().join("::");
    const edgePairs = semanticSnapshot.edges.map((edge) =>
      [edge.source, edge.target].sort().join("::"),
    );
    expect(edgePairs).toContain(expectedPair);
  });

  test("graph community view assigns community metadata and orphan stats", async () => {
    const sharedA = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://community-shared-a",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Community Shared A",
      body: "community source shared body",
      metadata: {
        sourceDocumentUri: "file:///workspace/wiki/community-shared.md",
        repoPath: "/workspace/wiki",
      },
    });
    const sharedB = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://community-shared-b",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Community Shared B",
      body: "community source shared body",
      metadata: {
        sourceDocumentUri: "file:///workspace/wiki/community-shared.md",
        repoPath: "/workspace/wiki",
      },
    });
    const orphan = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://community-orphan",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Community Orphan",
      body: "community orphan body",
      metadata: {
        sourceDocumentUri: "file:///workspace/wiki/community-orphan.md",
        repoPath: "/workspace/wiki",
      },
    });

    const snapshot = await buildGraphSnapshot({
      limit: 20,
      view: "community",
      relationAxes: ["source"],
      status: "all",
    });

    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.edges.every((edge) => edge.edgeKind === "source")).toBe(true);

    const nodeA = snapshot.nodes.find((node) => node.id === `knowledge:${sharedA}`);
    const nodeB = snapshot.nodes.find((node) => node.id === `knowledge:${sharedB}`);
    const orphanNode = snapshot.nodes.find((node) => node.id === `knowledge:${orphan}`);

    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(orphanNode).toBeDefined();

    expect(nodeA?.communityId).toBe(nodeB?.communityId);
    expect(nodeA?.communitySize).toBeGreaterThanOrEqual(2);
    expect(nodeA?.communityRank).toBeGreaterThanOrEqual(1);
    expect(orphanNode?.communitySize).toBe(1);

    expect(snapshot.stats.communityCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.stats.largestCommunitySize).toBeGreaterThanOrEqual(2);
    expect(snapshot.stats.orphanNodeCount).toBeGreaterThanOrEqual(1);
    expect(snapshot.communities.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.supernodes.length).toBe(snapshot.stats.communityCount);
    const topCommunity = snapshot.communities[0];
    expect(topCommunity?.size).toBeGreaterThanOrEqual(2);
    expect(topCommunity?.typeCounts.rule ?? 0).toBeGreaterThanOrEqual(1);
    expect(topCommunity?.compileSelectCount).toBeGreaterThanOrEqual(0);
    expect(topCommunity?.health.dead).toBe(true);
    expect(snapshot.stats.deadCommunityCount).toBeGreaterThanOrEqual(1);
  });
});
