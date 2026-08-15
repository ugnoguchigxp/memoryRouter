import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  knowledgeStatusValues,
  knowledgeTagKindValues,
  knowledgeTagStatusValues,
  knowledgeTypeValues,
  scopeValues,
} from "../../../src/db/schema.js";
import {
  bulkUpdateKnowledgeStatus,
  countKnowledgeItems,
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeTagDefinitionsForApi,
  recordKnowledgeFeedback,
  updateKnowledgeItem,
} from "./knowledge.repository.js";

const listKnowledgeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  query: z.string().trim().optional(),
  polarities: z
    .preprocess(
      (val) => {
        if (typeof val === "string")
          return val
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        return val;
      },
      z.array(z.enum(["positive", "negative", "neutral"])),
    )
    .optional(),
  intentTags: z
    .preprocess((val) => {
      if (typeof val === "string")
        return val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      return val;
    }, z.array(z.string()))
    .optional(),
  displayFilter: z
    .enum(["all", "draft", "active", "deprecated", "unused-active", "stale", "high-value"])
    .optional(),
  minQuality: z.coerce.number().min(0).max(100).optional(),
  sortBy: z
    .enum(["title", "type", "status", "scope", "qualityScore", "updatedAt"])
    .default("updatedAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

const knowledgeApplicabilitySchema = z
  .object({
    general: z.boolean().optional(),
    technologies: z.array(z.string().trim().min(1)).optional(),
    changeTypes: z.array(z.string().trim().min(1)).optional(),
    domains: z.array(z.string().trim().min(1)).optional(),
    repoPath: z.string().trim().min(1).optional(),
    repoKey: z.string().trim().min(1).optional(),
  })
  .passthrough();

const knowledgeCreateSchema = z.object({
  type: z.enum(knowledgeTypeValues),
  status: z.enum(knowledgeStatusValues),
  scope: z.enum(scopeValues),
  polarity: z.enum(["positive", "negative", "neutral"]).default("positive"),
  intentTags: z.array(z.string()).default([]),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  confidence: z.number().min(0).max(100).default(70),
  importance: z.number().min(0).max(100).default(70),
  appliesTo: knowledgeApplicabilitySchema.optional(),
  general: z.boolean().optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  changeTypes: z.array(z.string().trim().min(1)).optional(),
  domains: z.array(z.string().trim().min(1)).optional(),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: z.string().trim().min(1).optional(),
  repoKey: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).default({}),
});

const knowledgeUpdateSchema = z
  .object({
    type: z.enum(knowledgeTypeValues).optional(),
    status: z.enum(knowledgeStatusValues).optional(),
    scope: z.enum(scopeValues).optional(),
    polarity: z.enum(["positive", "negative", "neutral"]).optional(),
    intentTags: z.array(z.string()).optional(),
    title: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    confidence: z.number().min(0).max(100).optional(),
    importance: z.number().min(0).max(100).optional(),
    appliesTo: knowledgeApplicabilitySchema.optional(),
    general: z.boolean().optional(),
    technologies: z.array(z.string().trim().min(1)).optional(),
    changeTypes: z.array(z.string().trim().min(1)).optional(),
    domains: z.array(z.string().trim().min(1)).optional(),
    projectRef: z.string().trim().min(1).max(256).optional(),
    repoPath: z.string().trim().min(1).optional(),
    repoKey: z.string().trim().min(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one update field is required",
  });

const listKnowledgeTagsQuerySchema = z.object({
  kind: z.enum(knowledgeTagKindValues).optional(),
  status: z.enum(knowledgeTagStatusValues).optional(),
});

const bulkStatusTargetSchema = z.enum(["active", "deprecated"]);

const bulkStatusSchema = z.union([
  z.object({
    ids: z.array(z.string().trim().min(1)).min(1).max(200),
    status: bulkStatusTargetSchema,
  }),
  z.object({
    selection: z.object({
      status: z.enum(knowledgeStatusValues).optional(),
      type: z.enum(knowledgeTypeValues).optional(),
      query: z.string().trim().optional(),
    }),
    status: bulkStatusTargetSchema,
  }),
]);

const feedbackSchema = z.object({
  direction: z.enum(["up", "down"]),
  reason: z.string().trim().max(160).optional(),
});

export const knowledgeRouter = new Hono()
  .get("/tags", zValidator("query", listKnowledgeTagsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const tags = await listKnowledgeTagDefinitionsForApi({
      kind: query.kind,
      status: query.status,
    });
    return c.json({ tags });
  })
  .get("/", zValidator("query", listKnowledgeQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const [items, total] = await Promise.all([
      listKnowledgeItems(query),
      countKnowledgeItems(query),
    ]);
    return c.json({
      items,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    });
  })
  .post("/", zValidator("json", knowledgeCreateSchema), async (c) => {
    const input = c.req.valid("json");
    const item = await createKnowledgeItem(input);
    return c.json({ item }, 201);
  })
  .post("/bulk-status", zValidator("json", bulkStatusSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await bulkUpdateKnowledgeStatus(input);
    const failureCount = result.notFoundIds.length + result.invalidTransitionIds.length;
    const affectedCount = result.updatedIds.length + result.unchangedIds.length + failureCount;
    const response = {
      ...result,
      outcome:
        affectedCount === 0
          ? "none"
          : failureCount === 0
            ? "ok"
            : result.updatedIds.length > 0 || result.unchangedIds.length > 0
              ? "partial"
              : "none",
    } as const;
    if (response.outcome === "none" && failureCount > 0) {
      return c.json(response, 409);
    }
    return c.json(response);
  })
  .put("/:id", zValidator("json", knowledgeUpdateSchema), async (c) => {
    const item = await updateKnowledgeItem(c.req.param("id"), c.req.valid("json"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json({ item });
  })
  .post("/:id/feedback", zValidator("json", feedbackSchema), async (c) => {
    const result = await recordKnowledgeFeedback({
      id: c.req.param("id"),
      direction: c.req.valid("json").direction,
      reason: c.req.valid("json").reason,
    });
    if (!result) return c.json({ error: "not found" }, 404);
    return c.json({ feedback: result });
  })
  .delete("/:id", async (c) => {
    const item = await deleteKnowledgeItem(c.req.param("id"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json({ item });
  });
