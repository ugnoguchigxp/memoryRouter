import { z } from "zod";

const vibeMemoryTypeSchema = z.enum(["chat", "action", "observation", "system"]);

const metadataSchema = z.record(z.string(), z.unknown()).default({});

const agentDiffEntryInputSchema = z
  .object({
    filePath: z.string().trim().min(1),
    diffHunk: z.string().optional(),
    diff: z.string().optional(),
    changeType: z.string().trim().min(1).nullable().optional(),
    language: z.string().trim().min(1).nullable().optional(),
    symbolName: z.string().trim().min(1).nullable().optional(),
    symbolKind: z.string().trim().min(1).nullable().optional(),
    signature: z.string().nullable().optional(),
    startLine: z.number().int().positive().nullable().optional(),
    endLine: z.number().int().positive().nullable().optional(),
    metadata: metadataSchema,
  })
  .transform((value) => ({
    ...value,
    diffHunk: value.diffHunk ?? value.diff,
  }))
  .refine((value) => Boolean(value.diffHunk?.trim()), {
    message: "Agent diff entry requires diffHunk or diff",
  });

const agentDiffSymbolInputSchema = z.object({
  symbolName: z.string().trim().min(1),
  symbolKind: z.string().trim().min(1),
  signature: z.string().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  metadata: metadataSchema,
});

export const recordVibeMemoryInputSchema = z.object({
  sessionId: z.string().trim().min(1),
  content: z.string().min(1),
  memoryType: vibeMemoryTypeSchema.default("chat"),
  scope: z.enum(["repo", "global"]).default("repo"),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoKey: z.string().trim().min(1).max(1024).optional(),
  repoPath: z.string().trim().min(1).max(4096).optional(),
  metadata: metadataSchema,
  diff: z.string().optional(),
  agentDiffs: z.array(agentDiffEntryInputSchema).default([]),
});

export type AgentDiffEntryInput = z.output<typeof agentDiffEntryInputSchema>;
export type AgentDiffSymbolInput = z.input<typeof agentDiffSymbolInputSchema>;
export type RecordVibeMemoryInput = z.input<typeof recordVibeMemoryInputSchema>;
