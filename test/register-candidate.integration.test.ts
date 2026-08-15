import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "../src/db/index.js";
import {
  coveringEvidenceQueue,
  distillationTargetStates,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
  knowledgeItems,
} from "../src/db/schema.js";
import { registerCandidate } from "../src/modules/registerCandidate/register-candidate.service.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("registerCandidate", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("stores a distillation target and find-candidate row without creating knowledge", async () => {
    const result = await registerCandidate({
      scope: "repo",
      repoKey: "test/register-candidate",
      text: JSON.stringify({
        type: "procedure",
        title: "Verify before reporting fixed",
        body: [
          "Use when:",
          "- Reporting a bug fix as complete",
          "",
          "Workflow:",
          "1. Re-run the failing scenario",
          "2. Confirm the observed result",
          "",
          "Verification:",
          "- The failing scenario now passes",
          "",
          "Avoid:",
          "- Reporting completion from code inspection alone",
        ].join("\n"),
      }),
      changeTypes: ["bugfix"],
      metadata: {},
    });

    const db = getDb();
    const [target] = await db
      .select()
      .from(distillationTargetStates)
      .where(eq(distillationTargetStates.id, result.targetStateId));
    const [candidate] = await db
      .select()
      .from(findCandidateResults)
      .where(eq(findCandidateResults.id, result.findCandidateResultId));
    expect(result.findingJobId).toBeTruthy();
    const [findingJob] = await db
      .select()
      .from(findingCandidateQueue)
      .where(eq(findingCandidateQueue.id, result.findingJobId as string));
    const knowledgeRows = await db.select({ id: knowledgeItems.id }).from(knowledgeItems);

    expect(target).toMatchObject({
      targetKind: "knowledge_candidate",
      priorityGroup: "knowledge_candidate",
      status: "pending",
      metadata: {
        projectIdentity: {
          classificationStatus: "classified",
          scope: "repo",
          matchBasis: "repo_key",
          repoKey: "test/register-candidate",
        },
      },
    });
    expect(candidate).toMatchObject({
      targetStateId: result.targetStateId,
      title: "Verify before reporting fixed",
      status: "selected",
    });
    expect(findingJob).toMatchObject({
      inputKind: "provided_candidate",
      sourceKind: "knowledge_candidate",
      status: "completed",
    });

    const [foundCandidate] = await db
      .select()
      .from(foundCandidates)
      .where(eq(foundCandidates.findingJobId, findingJob.id));

    expect(foundCandidate).toMatchObject({
      title: "Verify before reporting fixed",
      candidateIndex: 0,
    });

    const [coveringJob] = await db
      .select()
      .from(coveringEvidenceQueue)
      .where(eq(coveringEvidenceQueue.foundCandidateId, foundCandidate.id));

    expect(coveringJob).toMatchObject({
      status: "pending",
      priority: 90,
    });

    expect(knowledgeRows).toEqual([]);
  });

  test("preserves negative polarity and intent tags through provided candidate rows", async () => {
    const result = await registerCandidate({
      scope: "global",
      title: "Do not trust stale queue status alone",
      body: "Stale queue status alone is not enough evidence for diagnosis.",
      type: "procedure",
      polarity: "negative",
      intentTags: ["failure_pattern", "guardrail"],
      technologies: ["sqlite"],
      changeTypes: ["diagnosis"],
      domains: ["queue"],
      metadata: {},
    });

    const db = getDb();
    const [candidate] = await db
      .select()
      .from(findCandidateResults)
      .where(eq(findCandidateResults.id, result.findCandidateResultId));
    const [findingJob] = await db
      .select()
      .from(findingCandidateQueue)
      .where(eq(findingCandidateQueue.id, result.findingJobId as string));
    const [foundCandidate] = await db
      .select()
      .from(foundCandidates)
      .where(eq(foundCandidates.findingJobId, findingJob.id));

    expect(result.type).toBe("rule");
    expect(candidate.origin).toMatchObject({
      candidateType: "rule",
      originalCandidateType: "procedure",
      polarity: "negative",
      intentTags: ["failure_pattern", "guardrail"],
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      },
    });
    expect(findingJob.payload).toMatchObject({
      type: "rule",
      polarity: "negative",
      intentTags: ["failure_pattern", "guardrail"],
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      },
    });
    expect(foundCandidate).toMatchObject({
      type: "rule",
      title: "Do not trust stale queue status alone",
    });
    expect(foundCandidate.origin).toMatchObject({
      originalCandidateType: "procedure",
      polarity: "negative",
      intentTags: ["failure_pattern", "guardrail"],
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      },
    });
    expect(foundCandidate.metadata).toMatchObject({
      polarity: "negative",
      intentTags: ["failure_pattern", "guardrail"],
      appliesTo: {
        technologies: ["sqlite"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      },
    });
  });

  test("sets wiki priority when metadata indicates wiki parent", async () => {
    const result = await registerCandidate({
      scope: "global",
      title: "Keep wiki priority",
      body: "Use when:\n- From wiki parent",
      type: "rule",
      metadata: {
        parentTargetKind: "wiki_file",
      },
    });

    const db = getDb();
    const [target] = await db
      .select()
      .from(distillationTargetStates)
      .where(eq(distillationTargetStates.id, result.targetStateId));

    expect(target).toMatchObject({
      targetKind: "knowledge_candidate",
      priorityGroup: "wiki",
      status: "pending",
    });
  });
});
