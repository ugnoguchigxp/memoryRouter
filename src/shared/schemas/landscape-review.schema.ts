import { z } from "zod";
import { landscapeRunStatusFilterSchema } from "./landscape-replay.schema.js";
import { landscapeRelationAxisSchema, landscapeStatusFilterSchema } from "./landscape.schema.js";

export const landscapeReviewItemSourceSchema = z.enum([
  "replay_compare",
  "landscape_snapshot",
  "semantic_relation_comparison",
  "promotion_gate",
  "contradiction_detection",
]);

export const landscapeReviewItemReasonSchema = z.enum([
  "duplicate_candidate",
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "semantic_reachable_dead_zone",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "promotion_gate_review",
  "contradiction_review",
]);

export const landscapeReviewItemStatusSchema = z.enum([
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
]);

export const landscapeReviewItemProposedActionSchema = z.enum([
  "review_only",
  "refine_applies_to",
  "repair_reachability",
  "review_wrong",
  "split_or_merge_review",
  "promotion_gate_review",
  "demote_to_draft_candidate",
  "review_contradiction",
]);

export const landscapeReviewItemConfidenceSchema = z.enum(["low", "medium", "high"]);

export const landscapeReviewItemSchema = z.object({
  id: z.string(),
  source: landscapeReviewItemSourceSchema,
  reason: landscapeReviewItemReasonSchema,
  status: landscapeReviewItemStatusSchema,
  proposedAction: landscapeReviewItemProposedActionSchema,
  priority: z.number().int().min(0).max(100),
  confidence: landscapeReviewItemConfidenceSchema,
  knowledgeId: z.string().nullable(),
  runId: z.string().nullable(),
  triggerEventId: z.string().nullable(),
  communityKey: z.string().nullable(),
  communityLabel: z.string().nullable(),
  suggestedAppliesTo: z.record(z.unknown()),
  evidence: z.array(z.string()),
  payload: z.record(z.unknown()),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});

export const landscapeReviewItemCandidateSchema = z.object({
  source: landscapeReviewItemSourceSchema,
  reason: landscapeReviewItemReasonSchema,
  proposedAction: landscapeReviewItemProposedActionSchema,
  priority: z.number().int().min(0).max(100),
  confidence: landscapeReviewItemConfidenceSchema,
  idempotencyKey: z.string().min(1),
  knowledgeId: z.string().nullable(),
  runId: z.string().nullable(),
  triggerEventId: z.string().nullable(),
  communityKey: z.string().nullable(),
  communityLabel: z.string().nullable(),
  suggestedAppliesTo: z.record(z.unknown()),
  evidence: z.array(z.string()),
  payload: z.record(z.unknown()),
  note: z.string().nullable().optional(),
});

export const landscapeReviewItemsMaterializeInputSchema = z.object({
  dryRun: z.boolean().default(true),
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  runStatus: landscapeRunStatusFilterSchema.default("all"),
  currentLimit: z.coerce.number().int().min(1).max(50).default(12),
  landscapeLimit: z.coerce.number().int().min(1).max(2000).default(1000),
  landscapeStatus: landscapeStatusFilterSchema.default("active"),
  relationAxes: z.preprocess(
    (value) => {
      if (typeof value === "string") {
        return value
          .split(",")
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
      }
      return value;
    },
    z.array(landscapeRelationAxisSchema).min(1).default(["session", "project", "source"]),
  ),
  minSelectedCount: z.coerce.number().int().min(1).max(100).default(3),
  minFeedbackCount: z.coerce.number().int().min(1).max(100).default(3),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  sources: z.array(landscapeReviewItemSourceSchema).min(1).default(["replay_compare"]),
  materializeLimit: z.coerce.number().int().min(1).max(500).default(50),
});

export const landscapeReviewItemsMaterializeResultSchema = z.object({
  dryRun: z.boolean(),
  generatedAt: z.string().datetime(),
  candidateCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  existingCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  items: z.array(landscapeReviewItemSchema),
  candidates: z.array(landscapeReviewItemCandidateSchema),
});

export const landscapeReviewItemsListQuerySchema = z.object({
  status: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.union([landscapeReviewItemStatusSchema, z.literal("all")]).default("all"),
  ),
  source: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.union([landscapeReviewItemSourceSchema, z.literal("all")]).default("all"),
  ),
  reason: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.union([landscapeReviewItemReasonSchema, z.literal("all")]).default("all"),
  ),
  proposedAction: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.union([landscapeReviewItemProposedActionSchema, z.literal("all")]).default("all"),
  ),
  knowledgeId: z.string().optional(),
  runId: z.string().optional(),
  communityKey: z.string().trim().min(1).optional(),
  priorityMin: z.coerce.number().int().min(0).max(100).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const landscapeReviewItemStatusUpdateSchema = z.object({
  status: landscapeReviewItemStatusSchema,
  note: z.string().trim().max(500).optional(),
});

export type LandscapeReviewItem = z.infer<typeof landscapeReviewItemSchema>;
export type LandscapeReviewItemCandidate = z.infer<typeof landscapeReviewItemCandidateSchema>;
export type LandscapeReviewItemSource = z.infer<typeof landscapeReviewItemSourceSchema>;
export type LandscapeReviewItemReason = z.infer<typeof landscapeReviewItemReasonSchema>;
export type LandscapeReviewItemStatus = z.infer<typeof landscapeReviewItemStatusSchema>;
export type LandscapeReviewItemProposedAction = z.infer<
  typeof landscapeReviewItemProposedActionSchema
>;
export type LandscapeReviewItemConfidence = z.infer<typeof landscapeReviewItemConfidenceSchema>;
export type LandscapeReviewItemsMaterializeInput = z.infer<
  typeof landscapeReviewItemsMaterializeInputSchema
>;
export type LandscapeReviewItemsMaterializeResult = z.infer<
  typeof landscapeReviewItemsMaterializeResultSchema
>;
export type LandscapeReviewItemsListQuery = z.infer<typeof landscapeReviewItemsListQuerySchema>;
