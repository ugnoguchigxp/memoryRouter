import { z } from "zod";
import {
  compileProjectRefSchema,
  compileRepoKeySchema,
  compileRepoPathSchema,
} from "./compile.schema.js";

export const contextEvalCaseSchema = z
  .object({
    id: z.string().optional(),
    goal: z.string().trim().min(1),
    projectRef: compileProjectRefSchema.optional(),
    repoKey: compileRepoKeySchema.optional(),
    repoPath: compileRepoPathSchema.optional(),
    changeTypes: z.array(z.string().trim().min(1)).optional(),
    technologies: z.array(z.string().trim().min(1)).optional(),
    domains: z.array(z.string().trim().min(1)).optional(),
    expectedKnowledgeIds: z.array(z.string().trim().min(1)).optional(),
    forbiddenKnowledgeIds: z.array(z.string().trim().min(1)).optional(),
    expectNoContent: z.boolean().optional(),
    judgmentsComplete: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .strict()
  .refine((data) => !data.expectNoContent || !data.expectedKnowledgeIds?.length, {
    message: "expectNoContent cannot be combined with expectedKnowledgeIds",
    path: ["expectNoContent"],
  })
  .refine(
    (data) => {
      const expected = new Set(data.expectedKnowledgeIds || []);
      const forbidden = data.forbiddenKnowledgeIds || [];
      return !forbidden.some((id) => expected.has(id));
    },
    {
      message: "expectedKnowledgeIds and forbiddenKnowledgeIds must not overlap",
      path: ["forbiddenKnowledgeIds"],
    },
  );

export type ContextEvalCase = z.infer<typeof contextEvalCaseSchema>;

export const contextEvalCaseResultSchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(["passed", "failed", "unscored"]),
  retrievalMs: z.number().nonnegative().optional(),
  reciprocalRank: z.number().min(0).max(1).nullable().optional(),
  ndcg: z.number().min(0).max(1).nullable().optional(),
  errorCategory: z.literal("retrieval_failed").nullable().optional(),
  retrievedKnowledgeIds: z.array(z.string()),
  expectedKnowledgeIds: z.array(z.string()),
  expectedHitIds: z.array(z.string()),
  missingExpectedIds: z.array(z.string()),
  forbiddenKnowledgeIds: z.array(z.string()),
  forbiddenHitIds: z.array(z.string()),
  degradedReasons: z.array(z.string()),
});

export type ContextEvalCaseResult = z.infer<typeof contextEvalCaseResultSchema>;

export const contextEvalCaseReportSchema = z.object({
  generatedAt: z.string(),
  source: z.object({
    mode: z.literal("cases"),
    path: z.string(),
    currentLimit: z.number(),
    readOnly: z.literal(true),
    engine: z.literal("typescript-knowledge").optional(),
    datasetSha256: z.string().optional(),
  }),
  summary: z.object({
    status: z.enum(["passed", "failed", "no_data"]),
    caseCount: z.number(),
    passedCount: z.number(),
    failedCount: z.number(),
    passRate: z.number(),
    reason: z.string(),
    unscoredCount: z.number().default(0),
  }),
  metrics: z.object({
    expectedTotalCount: z.number(),
    expectedHitCount: z.number(),
    missingExpectedCount: z.number(),
    forbiddenTotalCount: z.number(),
    forbiddenHitCount: z.number(),
    retrievedTotalCount: z.number(),
    expectedRecall: z.number().nullable(),
    strictPrecision: z.number().nullable(),
    strictF1: z.number().nullable(),
    noContentCaseCount: z.number(),
    degradedCaseCount: z.number(),
    errorCaseCount: z.number().default(0),
    meanReciprocalRank: z.number().nullable().optional(),
    meanNdcg: z.number().nullable().optional(),
    completeJudgmentCaseCount: z.number().default(0),
  }),
  cases: z.array(contextEvalCaseResultSchema),
});

export type ContextEvalCaseReport = z.infer<typeof contextEvalCaseReportSchema>;
