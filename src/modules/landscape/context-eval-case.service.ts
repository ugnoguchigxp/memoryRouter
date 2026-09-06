import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { deriveRetrievalModeFromChangeTypes } from "../../shared/schemas/compile.schema.js";
import {
  type ContextEvalCase,
  type ContextEvalCaseReport,
  type ContextEvalCaseResult,
  contextEvalCaseReportSchema,
  contextEvalCaseSchema,
} from "../../shared/schemas/context-eval-case.schema.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
import { meanMeasured, rankedRetrievalMetrics } from "./context-eval-metrics.js";

/**
 * Loads and validates evaluation cases from a JSONL file.
 * Ignores empty lines and lines starting with '#'.
 */
export async function loadContextEvalCases(filePath: string): Promise<ContextEvalCase[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const cases: ContextEvalCase[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Invalid JSON on line ${lineNum}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const result = contextEvalCaseSchema.safeParse(parsedJson);
    if (!result.success) {
      const errorMsg = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new Error(`Validation failed on line ${lineNum}: ${errorMsg}`);
    }

    const data = result.data;
    data.id ||= `case-${cases.length + 1}`;
    if (cases.some((item) => item.id === data.id))
      throw new Error(`Duplicate case id on line ${lineNum}: ${data.id}`);
    data.expectedKnowledgeIds = [...new Set(data.expectedKnowledgeIds ?? [])];
    data.forbiddenKnowledgeIds = [...new Set(data.forbiddenKnowledgeIds ?? [])];
    cases.push(data);
  }

  return cases;
}

export type BuildContextEvalCaseReportInput = {
  casesPath: string;
  currentLimit: number;
};

/**
 * Performs dry-run retrieval for each test case and builds an aggregated report.
 */
export async function buildContextEvalCaseReport(
  input: BuildContextEvalCaseReportInput,
): Promise<ContextEvalCaseReport> {
  const generatedAt = new Date().toISOString();
  const cases = await loadContextEvalCases(input.casesPath);
  if (!Number.isInteger(input.currentLimit) || input.currentLimit < 1 || input.currentLimit > 50) {
    throw new Error("currentLimit must be an integer between 1 and 50");
  }
  const datasetSha256 = createHash("sha256").update(JSON.stringify(cases)).digest("hex");

  if (cases.length === 0) {
    return contextEvalCaseReportSchema.parse({
      generatedAt,
      source: {
        mode: "cases",
        path: input.casesPath,
        currentLimit: input.currentLimit,
        readOnly: true,
        engine: "typescript-knowledge",
        datasetSha256,
      },
      summary: {
        status: "no_data",
        caseCount: 0,
        passedCount: 0,
        failedCount: 0,
        passRate: 0,
        reason: "No evaluation cases to run.",
      },
      metrics: {
        expectedTotalCount: 0,
        expectedHitCount: 0,
        missingExpectedCount: 0,
        forbiddenTotalCount: 0,
        forbiddenHitCount: 0,
        retrievedTotalCount: 0,
        expectedRecall: null,
        strictPrecision: null,
        strictF1: null,
        noContentCaseCount: 0,
        degradedCaseCount: 0,
      },
      cases: [],
    });
  }

  const results: ContextEvalCaseResult[] = [];

  for (let index = 0; index < cases.length; index += 1) {
    const c = cases[index];
    const id = c.id || `case-${index + 1}`;
    const compileInput = {
      goal: c.goal,
      changeTypes: c.changeTypes,
      technologies: c.technologies,
      domains: c.domains,
      projectRef: c.projectRef,
      repoKey: c.repoKey,
      repoPath: c.repoPath,
    };
    const retrievalMode = deriveRetrievalModeFromChangeTypes(c.changeTypes);

    const started = performance.now();
    let result: Pick<Awaited<ReturnType<typeof retrieveKnowledge>>, "items" | "degradedReasons">;
    let errorCategory: "retrieval_failed" | null = null;
    try {
      result = await retrieveKnowledge(compileInput, { retrievalMode, limit: input.currentLimit });
    } catch {
      errorCategory = "retrieval_failed";
      result = { items: [], degradedReasons: ["RETRIEVAL_FAILED"] };
    }
    const retrievalMs = performance.now() - started;

    const retrievedKnowledgeIds = [...new Set(result.items.map((item) => item.id))].slice(
      0,
      input.currentLimit,
    );
    const expectedKnowledgeIds = c.expectedKnowledgeIds || [];
    const forbiddenKnowledgeIds = c.forbiddenKnowledgeIds || [];

    const expectedHitIds = expectedKnowledgeIds.filter((expectedId) =>
      retrievedKnowledgeIds.includes(expectedId),
    );
    const missingExpectedIds = expectedKnowledgeIds.filter(
      (expectedId) => !retrievedKnowledgeIds.includes(expectedId),
    );
    const forbiddenHitIds = forbiddenKnowledgeIds.filter((forbiddenId) =>
      retrievedKnowledgeIds.includes(forbiddenId),
    );

    const labelled =
      expectedKnowledgeIds.length > 0 ||
      forbiddenKnowledgeIds.length > 0 ||
      c.expectNoContent === true;
    const failed =
      errorCategory !== null ||
      result.degradedReasons.length > 0 ||
      missingExpectedIds.length > 0 ||
      forbiddenHitIds.length > 0 ||
      (c.expectNoContent === true && retrievedKnowledgeIds.length > 0);
    const status = failed ? "failed" : labelled ? "passed" : "unscored";

    results.push({
      id,
      goal: c.goal,
      status,
      retrievalMs,
      errorCategory,
      ...rankedRetrievalMetrics(expectedKnowledgeIds, retrievedKnowledgeIds, input.currentLimit),
      retrievedKnowledgeIds,
      expectedKnowledgeIds,
      expectedHitIds,
      missingExpectedIds,
      forbiddenKnowledgeIds,
      forbiddenHitIds,
      degradedReasons: result.degradedReasons || [],
    });
  }

  const caseCount = results.length;
  const passedCount = results.filter((r) => r.status === "passed").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const unscoredCount = results.filter((r) => r.status === "unscored").length;
  const passRate = caseCount > 0 ? passedCount / caseCount : 0;

  const expectedTotalCount = results.reduce((sum, r) => sum + r.expectedKnowledgeIds.length, 0);
  const expectedHitCount = results.reduce((sum, r) => sum + r.expectedHitIds.length, 0);
  const missingExpectedCount = results.reduce((sum, r) => sum + r.missingExpectedIds.length, 0);
  const forbiddenTotalCount = results.reduce((sum, r) => sum + r.forbiddenKnowledgeIds.length, 0);
  const forbiddenHitCount = results.reduce((sum, r) => sum + r.forbiddenHitIds.length, 0);
  const retrievedTotalCount = results.reduce((sum, r) => sum + r.retrievedKnowledgeIds.length, 0);

  const expectedRecall = expectedTotalCount > 0 ? expectedHitCount / expectedTotalCount : null;
  const fullyJudged = results.filter((_, index) => cases[index].judgmentsComplete);
  const judgedRetrieved = fullyJudged.reduce(
    (sum, row) => sum + row.retrievedKnowledgeIds.length,
    0,
  );
  const judgedHits = fullyJudged.reduce((sum, row) => sum + row.expectedHitIds.length, 0);
  const judgedExpected = fullyJudged.reduce((sum, row) => sum + row.expectedKnowledgeIds.length, 0);
  const strictPrecision = judgedRetrieved > 0 ? judgedHits / judgedRetrieved : null;
  const strictF1 =
    judgedExpected + judgedRetrieved > 0
      ? (2 * judgedHits) / (judgedExpected + judgedRetrieved)
      : null;

  const noContentCaseCount = results.filter(
    (r) => r.errorCategory === null && r.retrievedKnowledgeIds.length === 0,
  ).length;
  const degradedCaseCount = results.filter((r) => r.degradedReasons.length > 0).length;

  const summaryStatus = failedCount > 0 ? "failed" : unscoredCount > 0 ? "no_data" : "passed";
  const reason =
    summaryStatus === "passed"
      ? "All evaluation cases passed."
      : `${failedCount} failed and ${unscoredCount} unscored of ${caseCount} cases.`;

  return contextEvalCaseReportSchema.parse({
    generatedAt,
    source: {
      mode: "cases",
      path: input.casesPath,
      currentLimit: input.currentLimit,
      readOnly: true,
      engine: "typescript-knowledge",
      datasetSha256,
    },
    summary: {
      status: summaryStatus,
      caseCount,
      passedCount,
      failedCount,
      unscoredCount,
      passRate,
      reason,
    },
    metrics: {
      expectedTotalCount,
      expectedHitCount,
      missingExpectedCount,
      forbiddenTotalCount,
      forbiddenHitCount,
      retrievedTotalCount,
      expectedRecall,
      strictPrecision,
      strictF1,
      noContentCaseCount,
      degradedCaseCount,
      errorCaseCount: results.filter((r) => r.errorCategory !== null).length,
      meanReciprocalRank: meanMeasured(results.map((r) => r.reciprocalRank)),
      meanNdcg: meanMeasured(results.map((r) => r.ndcg)),
      completeJudgmentCaseCount: fullyJudged.length,
    },
    cases: results,
  });
}
