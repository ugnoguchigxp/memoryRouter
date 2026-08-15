import { z } from "zod";

const knowledgeTypeSchema = z.enum(["rule", "procedure"]);

const knowledgeStatusSchema = z.enum(["draft", "active", "deprecated"]);

const scopeSchema = z.enum(["repo", "global"]);
const knowledgeScoreSchema = z.number().min(0).max(100);

const optionalKnowledgeScoreSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}, knowledgeScoreSchema.optional());

const optionalApplicabilityBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}, z.boolean().optional());

const optionalApplicabilityStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().optional());

const optionalApplicabilityArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return undefined;
}, z.array(z.string().trim().min(1)).optional());

const knowledgeApplicabilitySchema = z.object({
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
});

const knowledgeItemSchema = z.object({
  id: z.string().uuid(),
  type: knowledgeTypeSchema,
  status: knowledgeStatusSchema,
  scope: scopeSchema,
  polarity: z.enum(["positive", "negative", "neutral"]).default("positive"),
  intentTags: z.array(z.string()).default([]),
  title: z.string().min(1),
  body: z.string().min(1),
  appliesTo: z.record(z.unknown()).default({}),
  confidence: knowledgeScoreSchema,
  importance: knowledgeScoreSchema,
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastVerifiedAt: z.coerce.date().nullable().optional(),
});

export const knowledgeSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  types: z.array(knowledgeTypeSchema).optional(),
  statuses: z.array(knowledgeStatusSchema).min(1).optional(),
  status: knowledgeStatusSchema.default("active"),
  polarities: z.array(z.enum(["positive", "negative", "neutral"])).optional(),
  intentTags: z.array(z.string().trim().min(1)).optional(),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoKey: z.string().trim().min(1).max(1024).optional(),
  repoPath: z.string().trim().min(1).optional(),
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  domains: z.array(z.string().trim().min(1)).optional(),
  includeGeneral: z.boolean().default(true),
  includeDraft: z.boolean().default(false),
});

export const registerKnowledgeInputSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  type: knowledgeTypeSchema.default("rule"),
  status: knowledgeStatusSchema.default("draft"),
  scope: scopeSchema.default("repo"),
  polarity: z.enum(["positive", "negative", "neutral"]).default("positive").optional(),
  intentTags: z.array(z.string()).default([]).optional(),
  confidence: optionalKnowledgeScoreSchema,
  importance: optionalKnowledgeScoreSchema,
  appliesTo: knowledgeApplicabilitySchema.optional(),
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
  metadata: z.record(z.unknown()).default({}),
});

export const registerCandidateInputSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1).optional(),
    avoid: z.string().trim().min(1).optional(),
    prefer: z.string().trim().min(1).optional(),
    type: knowledgeTypeSchema.optional(),
    polarity: z.enum(["positive", "negative", "neutral"]).optional(),
    intentTags: z.array(z.string()).optional(),
    confidence: optionalKnowledgeScoreSchema,
    importance: optionalKnowledgeScoreSchema,
    appliesTo: knowledgeApplicabilitySchema.optional(),
    general: optionalApplicabilityBooleanSchema,
    technologies: optionalApplicabilityArraySchema,
    changeTypes: optionalApplicabilityArraySchema,
    domains: optionalApplicabilityArraySchema,
    scope: scopeSchema.default("repo"),
    projectRef: z.string().trim().min(1).max(256).optional(),
    repoPath: optionalApplicabilityStringSchema,
    repoKey: optionalApplicabilityStringSchema,
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((value, context) => {
    const isNegative = value.polarity === "negative";
    if (!isNegative) {
      const isProcedureAvoid = value.type === "procedure" && value.avoid !== undefined;
      if (!value.body && !value.text) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["body"],
          message: "body or text is required",
        });
      }
      if (value.avoid !== undefined && !isProcedureAvoid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["avoid"],
          message: "avoid is only supported for negative candidates or procedure Avoid sections",
        });
      }
      if (value.prefer !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prefer"],
          message: "prefer is only supported when polarity is negative",
        });
      }
      return;
    }

    if (!value.body && !value.text) {
      if (!value.avoid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["avoid"],
          message: "avoid is required when negative candidate body or text is omitted",
        });
      }
      if (!value.prefer) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prefer"],
          message: "prefer is required when negative candidate body or text is omitted",
        });
      }
    }

    if (value.avoid && value.prefer && value.avoid === value.prefer) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prefer"],
        message: "prefer must differ from avoid",
      });
    }

    const technologies = value.technologies ?? value.appliesTo?.technologies;
    const changeTypes = value.changeTypes ?? value.appliesTo?.changeTypes;
    const domains = value.domains ?? value.appliesTo?.domains;
    if (!technologies?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["technologies"],
        message: "technologies is required for negative candidates",
      });
    }
    if (!changeTypes?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changeTypes"],
        message: "changeTypes is required for negative candidates",
      });
    }
    if (!domains?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domains"],
        message: "domains is required for negative candidates",
      });
    }
  });

export const registerCandidatesBulkInputSchema = z
  .array(registerCandidateInputSchema)
  .min(1)
  .max(10);

export const registerCandidatesToolInputSchema = z
  .object({
    items: registerCandidatesBulkInputSchema,
  })
  .strict();

export const listKnowledgeInputSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  status: knowledgeStatusSchema.optional(),
  type: knowledgeTypeSchema.optional(),
  query: z.string().trim().optional(),
  polarities: z.array(z.enum(["positive", "negative", "neutral"])).optional(),
  intentTags: z.array(z.string().trim().min(1)).optional(),
});

const knowledgeUpdatePatchSchema = z.object({
  type: knowledgeTypeSchema.optional(),
  status: knowledgeStatusSchema.optional(),
  scope: scopeSchema.optional(),
  polarity: z.enum(["positive", "negative", "neutral"]).optional(),
  intentTags: z.array(z.string()).optional(),
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  confidence: optionalKnowledgeScoreSchema,
  importance: optionalKnowledgeScoreSchema,
  appliesTo: knowledgeApplicabilitySchema.optional(),
  general: optionalApplicabilityBooleanSchema,
  technologies: optionalApplicabilityArraySchema,
  changeTypes: optionalApplicabilityArraySchema,
  domains: optionalApplicabilityArraySchema,
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: optionalApplicabilityStringSchema,
  repoKey: optionalApplicabilityStringSchema,
  metadata: z.record(z.unknown()).optional(),
});

export const updateKnowledgeInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .merge(knowledgeUpdatePatchSchema)
  .refine(
    (value) =>
      value.type !== undefined ||
      value.status !== undefined ||
      value.scope !== undefined ||
      value.title !== undefined ||
      value.body !== undefined ||
      value.confidence !== undefined ||
      value.importance !== undefined ||
      value.appliesTo !== undefined ||
      value.general !== undefined ||
      value.technologies !== undefined ||
      value.changeTypes !== undefined ||
      value.domains !== undefined ||
      value.projectRef !== undefined ||
      value.repoPath !== undefined ||
      value.repoKey !== undefined ||
      value.metadata !== undefined,
    { message: "at least one update field is required" },
  );

export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeApplicabilityInput = z.infer<typeof knowledgeApplicabilitySchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInputSchema>;
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;
