import { z } from "zod";

export const episodeCardStatusSchema = z.enum(["active", "deprecated"]);
export const episodeOutcomeKindSchema = z.enum(["success", "failure", "mixed", "unknown"]);
export const episodeSourceKindSchema = z.enum([
  "vibe_memory",
  "compile_run",
  "decision_run",
  "audit_log",
  "manual",
]);
export const episodeRefKindSchema = z.enum([
  "vibe_memory",
  "agent_diff",
  "compile_run",
  "decision_run",
  "audit_log",
  "file",
  "commit",
]);
export const episodeRetrievalRunKindSchema = z.enum(["compile", "decision", "mcp", "api"]);
export const episodeRetrievalUsedForSchema = z.enum([
  "compile",
  "decision",
  "search",
  "drill_down",
]);
export const episodeRetrievalVerdictSchema = z.enum([
  "used",
  "not_relevant",
  "wrong",
  "needs_raw_check",
  "stale",
]);

const metadataSchema = z.record(z.string(), z.unknown()).default({});
const stringListSchema = z.array(z.string().trim().min(1)).default([]);
const conditionSchema = z.record(z.string(), z.unknown()).default({});

export const episodeRefInputSchema = z.object({
  refKind: episodeRefKindSchema,
  refValue: z.string().trim().min(1),
  locator: z.string().trim().min(1).nullable().optional(),
  queryHint: z.string().trim().min(1).nullable().optional(),
  metadata: metadataSchema,
});

export const episodeRefSchema = episodeRefInputSchema.extend({
  id: z.string().min(1),
  episodeCardId: z.string().min(1),
  createdAt: z.coerce.date(),
});

export const episodeCardCreateSchema = z.object({
  title: z.string().trim().min(1),
  situation: z.string().trim().min(1),
  observations: z.string().default(""),
  action: z.string().default(""),
  outcome: z.string().default(""),
  lesson: z.string().default(""),
  applicability: conditionSchema,
  antiApplicability: conditionSchema,
  domains: stringListSchema,
  technologies: stringListSchema,
  changeTypes: stringListSchema,
  tools: stringListSchema,
  scope: z.enum(["repo", "global"]).default("repo"),
  projectRef: z.string().trim().min(1).nullable().optional(),
  repoPath: z.string().trim().min(1).nullable().optional(),
  repoKey: z.string().trim().min(1).nullable().optional(),
  sourceKind: episodeSourceKindSchema,
  sourceKey: z.string().trim().min(1),
  outcomeKind: episodeOutcomeKindSchema.default("unknown"),
  importance: z.number().int().min(0).max(100).default(50),
  confidence: z.number().int().min(0).max(100).default(50),
  compileUseCount: z.number().int().min(0).default(0),
  decisionUseCount: z.number().int().min(0).default(0),
  status: episodeCardStatusSchema.default("active"),
  staleAt: z.coerce.date().nullable().optional(),
  metadata: metadataSchema,
  refs: z.array(episodeRefInputSchema).default([]),
});

export const episodeCardSearchInputSchema = z.object({
  query: z.string().trim().optional(),
  statuses: z.array(episodeCardStatusSchema).optional(),
  status: episodeCardStatusSchema.optional(),
  domains: stringListSchema.optional(),
  technologies: stringListSchema.optional(),
  changeTypes: stringListSchema.optional(),
  tools: stringListSchema.optional(),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: z.string().trim().min(1).optional(),
  repoKey: z.string().trim().min(1).optional(),
  outcomeKinds: z.array(episodeOutcomeKindSchema).optional(),
  limit: z.number().int().positive().max(100).default(10),
});

export const episodeRetrievalFeedbackInputSchema = z.object({
  episodeCardId: z.string().min(1),
  runKind: episodeRetrievalRunKindSchema,
  runId: z.string().trim().min(1),
  usedFor: episodeRetrievalUsedForSchema,
  verdict: episodeRetrievalVerdictSchema,
  reason: z.string().trim().min(1).nullable().optional(),
  metadata: metadataSchema,
});

export const episodeCardSchema = episodeCardCreateSchema.omit({ refs: true }).extend({
  id: z.string().min(1),
  classificationStatus: z.enum(["classified", "unresolved", "conflict", "malformed"]),
  staleAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  score: z.number().optional(),
  refs: z.array(episodeRefSchema).default([]),
});

export type EpisodeCardStatus = z.infer<typeof episodeCardStatusSchema>;
export type EpisodeOutcomeKind = z.infer<typeof episodeOutcomeKindSchema>;
export type EpisodeSourceKind = z.infer<typeof episodeSourceKindSchema>;
export type EpisodeRefKind = z.infer<typeof episodeRefKindSchema>;
export type EpisodeRefInput = z.input<typeof episodeRefInputSchema>;
export type EpisodeRef = z.infer<typeof episodeRefSchema>;
export type EpisodeCardCreateInput = z.input<typeof episodeCardCreateSchema>;
export type EpisodeCard = z.infer<typeof episodeCardSchema>;
export type EpisodeCardSearchInput = z.input<typeof episodeCardSearchInputSchema>;
export type EpisodeRetrievalFeedbackInput = z.input<typeof episodeRetrievalFeedbackInputSchema>;
