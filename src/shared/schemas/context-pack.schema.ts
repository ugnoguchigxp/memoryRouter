import { z } from "zod";
import { retrievalModeSchema } from "./compile.schema.js";

const contextPackStatusSchema = z.enum(["ok", "degraded", "failed"]);

const contextPackSectionSchema = z.enum(["rules", "procedures", "warnings", "guardrails"]);

const contextPackItemSchema = z.object({
  id: z.string().min(1),
  itemKind: z.string().min(1),
  itemId: z.string().min(1),
  section: contextPackSectionSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  score: z.number(),
  rankingReason: z.string().min(1),
  sourceRefs: z.array(z.string()).default([]),
  scopeSnapshot: z.record(z.unknown()).optional(),
  changeTypes: z.array(z.string()).optional(),
  technologies: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
});

export const contextPackSchema = z.object({
  runId: z.string().uuid(),
  goal: z.string().min(1),
  retrievalMode: retrievalModeSchema,
  status: contextPackStatusSchema,
  minimalTasks: z.array(z.string()),
  rules: z.array(contextPackItemSchema),
  procedures: z.array(contextPackItemSchema),
  guardrails: z.array(contextPackItemSchema).default([]),
  warnings: z.array(z.string()),
  sourceRefs: z.array(z.string()),
  diagnostics: z.object({
    degradedReasons: z.array(z.string()),
    retrievalStats: z.record(z.unknown()),
    inputFacets: z
      .object({
        requested: z.record(z.array(z.string())),
        matched: z.record(z.array(z.string())),
        unknown: z.record(z.array(z.string())),
      })
      .optional(),
  }),
});

export type ContextPack = z.infer<typeof contextPackSchema>;
export type ContextPackItem = z.infer<typeof contextPackItemSchema>;
