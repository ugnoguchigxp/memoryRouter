import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildGraphSnapshot } from "../api/modules/graph/graph.repository.js";
import { createKnowledgeItem } from "../api/modules/knowledge/knowledge.repository.js";
import { db } from "../src/db/index.js";
import { knowledgeSourceLinks, sourceFragments } from "../src/db/schema.js";
import {
  getLatestCompileRunSnapshot,
  insertCompileRun,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { linkKnowledgeToSourceFragment } from "../src/modules/finalizeDistille/source-link.repository.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "../src/modules/knowledge/knowledge.repository.js";
import {
  upsertSourceDocument,
  vectorSearchSourceContent,
} from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn().mockImplementation(async (text: string) => {
    return Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  }),
}));

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("repositories integration additional", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("graph evidence view renders source nodes and keeps linked/unlinked stats under truncation", async () => {
    const linkedA = await upsertKnowledgeFromSource({
      sourceUri: "file:///evidence-k1.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Evidence Linked A",
      body: "evidence linked knowledge a",
    });
    const linkedB = await upsertKnowledgeFromSource({
      sourceUri: "file:///evidence-k2.md",
      type: "procedure",
      status: "active",
      scope: "global",
      title: "Evidence Linked B",
      body: "evidence linked knowledge b",
    });
    const unlinked = await upsertKnowledgeFromSource({
      sourceUri: "file:///evidence-k3.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Evidence Unlinked",
      body: "evidence unlinked knowledge",
    });

    const sourceA = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///evidence/source-a.md",
      title: "Source A",
      body: "Source A body",
    });
    const sourceB = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///evidence/source-b.md",
      title: "Source B",
      body: "Source B body",
    });
    const sourceC = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///evidence/source-c.md",
      title: "Source C",
      body: "Source C body",
    });

    const [fragmentA] = await db
      .select({ id: sourceFragments.id })
      .from(sourceFragments)
      .where(eq(sourceFragments.sourceId, sourceA))
      .limit(1);
    const [fragmentB] = await db
      .select({ id: sourceFragments.id })
      .from(sourceFragments)
      .where(eq(sourceFragments.sourceId, sourceB))
      .limit(1);
    const [fragmentC] = await db
      .select({ id: sourceFragments.id })
      .from(sourceFragments)
      .where(eq(sourceFragments.sourceId, sourceC))
      .limit(1);

    expect(fragmentA?.id).toBeDefined();
    expect(fragmentB?.id).toBeDefined();
    expect(fragmentC?.id).toBeDefined();
    if (!fragmentA || !fragmentB || !fragmentC) {
      throw new Error("source fragment was not created");
    }

    await linkKnowledgeToSourceFragment({
      knowledgeId: linkedA,
      sourceFragmentId: fragmentA.id,
      confidence: 0.95,
    });
    await linkKnowledgeToSourceFragment({
      knowledgeId: linkedA,
      sourceFragmentId: fragmentB.id,
      confidence: 0.85,
    });
    await linkKnowledgeToSourceFragment({
      knowledgeId: linkedB,
      sourceFragmentId: fragmentA.id,
      confidence: 0.75,
    });
    await linkKnowledgeToSourceFragment({
      knowledgeId: linkedB,
      sourceFragmentId: fragmentC.id,
      confidence: 0.65,
    });

    const snapshot = await buildGraphSnapshot({
      limit: 20,
      status: "all",
      view: "evidence",
      sourceNodeLimit: 1,
    });

    const sourceNodes = snapshot.nodes.filter((node) => node.kind === "source");
    expect(sourceNodes.length).toBe(1);
    expect(snapshot.edges.every((edge) => edge.edgeKind === "evidence")).toBe(true);
    expect(snapshot.edges.every((edge) => edge.source.startsWith("knowledge:"))).toBe(true);
    expect(snapshot.edges.every((edge) => edge.target.startsWith("source:"))).toBe(true);

    expect(snapshot.stats.sourceNodeCount).toBe(1);
    expect(snapshot.stats.evidenceEdgeCount).toBe(2);
    expect(snapshot.stats.evidenceLinkedKnowledgeCount).toBe(2);
    expect(snapshot.stats.evidenceUnlinkedKnowledgeCount).toBe(1);
    expect(snapshot.stats.truncatedSourceNodeCount).toBe(2);

    expect(snapshot.nodes.some((node) => node.id === `knowledge:${unlinked}`)).toBe(true);
    const firstSourceNode = sourceNodes[0];
    expect(firstSourceNode?.sourceKind).toBe("wiki");
    expect(firstSourceNode?.sourceUri).toBe("file:///evidence/source-a.md");
    expect(firstSourceNode?.linkedKnowledgeCount).toBe(2);
  });

  test("vectorSearchKnowledge returns results based on similarity", async () => {
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await upsertKnowledgeFromSource({
      sourceUri: "file:///vector-1.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Vector Rule",
      body: "vector search content",
      embedding: vector,
    });

    const results = await vectorSearchKnowledge(vector, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("Vector Rule");
  });

  test("vectorSearchSourceContent returns results based on similarity", async () => {
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///source-v.md",
      title: "Source V",
      body: "source vector content",
    });

    const results = await vectorSearchSourceContent(vector, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sourceUri).toBe("file:///source-v.md");
  });

  test("upsertKnowledgeFromSource updates existing item by uri", async () => {
    const params = {
      sourceUri: "file:///upsert.md",
      type: "rule" as const,
      status: "active" as const,
      scope: "global" as const,
      title: "Initial Title",
      body: "Initial Body",
    };
    const firstId = await upsertKnowledgeFromSource(params);
    const secondId = await upsertKnowledgeFromSource({
      ...params,
      title: "Updated Title",
    });

    expect(secondId).toBe(firstId);
    const results = await searchKnowledge({
      query: "Updated",
      limit: 1,
      status: "active",
      includeDraft: false,
    });
    expect(results[0].title).toBe("Updated Title");
  });

  test("upsertKnowledgeFromSource auto-links source references from metadata", async () => {
    const sourceUri = "/workspace/wiki/auto-linking.md";
    const sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: sourceUri,
      title: "Auto Linking Source",
      body: "auto-linking source body",
    });
    expect(sourceId).toBeDefined();

    const knowledgeId = await upsertKnowledgeFromSource({
      sourceUri: "cover-evidence-result://auto-linking",
      type: "rule",
      status: "draft",
      scope: "global",
      title: "Auto Linking Knowledge",
      body: "source link should be added at registration time",
      metadata: {
        sourceDocumentUri: sourceUri,
        sourceFragmentLocator: "tokens:0-512",
      },
    });

    const linkedRows = await db
      .select({
        sourceFragmentId: knowledgeSourceLinks.sourceFragmentId,
      })
      .from(knowledgeSourceLinks)
      .where(eq(knowledgeSourceLinks.knowledgeId, knowledgeId));
    expect(linkedRows.length).toBe(1);
    const [firstLinked] = linkedRows;
    expect(firstLinked?.sourceFragmentId).toBeDefined();
    if (!firstLinked) {
      throw new Error("linked source fragment was not found");
    }

    const [fragment] = await db
      .select({
        locator: sourceFragments.locator,
      })
      .from(sourceFragments)
      .where(eq(sourceFragments.id, firstLinked.sourceFragmentId))
      .limit(1);
    expect(fragment?.locator).toBe("chunk:0001");
  });

  test("createKnowledgeItem auto-links source references from metadata", async () => {
    const sourceUri = "file:///workspace/wiki/manual-registration.md";
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: sourceUri,
      title: "Manual Registration Source",
      body: "manual registration body",
    });

    const created = await createKnowledgeItem({
      type: "rule",
      status: "draft",
      scope: "global",
      title: "Manual registration should auto link",
      body: "knowledge registration should attach source link when possible",
      confidence: 70,
      importance: 70,
      metadata: {
        sourceDocumentUri: sourceUri,
        sourceFragmentLocator: "tokens:0-128",
      },
    });

    const linkedRows = await db
      .select({
        sourceFragmentId: knowledgeSourceLinks.sourceFragmentId,
      })
      .from(knowledgeSourceLinks)
      .where(eq(knowledgeSourceLinks.knowledgeId, created.id));
    expect(linkedRows.length).toBe(1);
  });

  test("getLatestCompileRunSnapshot returns the most recent run", async () => {
    const runId = await insertCompileRun({
      goal: "latest goal",
      intent: "latest intent",
      input: {},
      retrievalMode: "mode",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 88,
    });
    const snapshot = await getLatestCompileRunSnapshot();
    expect(snapshot?.run.id).toBe(runId);
  });

  test("searchKnowledge respects metadata fallback for sourceRefs", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///metadata-ref.md",
      type: "rule",
      status: "active",
      scope: "global",
      title: "Metadata Ref Rule",
      body: "body",
      metadata: {
        sourceDocumentUri: "file:///docs/ref.md",
        sourceFragmentLocator: "custom-locator",
      },
    });

    const results = await searchKnowledge({
      query: "Metadata Ref",
      limit: 1,
      status: "active",
      includeDraft: false,
    });
    expect(results[0].sourceRefs).toContain("file:///docs/ref.md#custom-locator");
  });

  test("searchKnowledge supports repoKey and types filters", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///repokey.md",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "RepoKey Rule",
      body: "body",
      metadata: {
        repoKey: "special-repo",
      },
    });

    const results = await searchKnowledge(
      { query: "RepoKey", limit: 5, status: "active", includeDraft: false },
      { repoKey: "special-repo", types: ["procedure"] },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("RepoKey Rule");
  });
});
