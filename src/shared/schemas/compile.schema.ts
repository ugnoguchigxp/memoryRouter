import { z } from "zod";

export const retrievalModeSchema = z.enum([
  "task_context",
  "review_context",
  "debug_context",
  "architecture_context",
  "procedure_context",
  "learning_context",
  "sqlite_text",
]);

const noControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
};

const hasAtMostCodePoints = (value: string, maximum: number): boolean => {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
};

function compileIdentityTextSchema(label: string, maximum: number) {
  return z
    .string()
    .refine(noControlCharacters, `${label} must not contain control characters`)
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1)
        .refine(
          (value) => hasAtMostCodePoints(value, maximum),
          `${label} must be at most ${maximum} characters`,
        ),
    );
}

export const compileProjectRefSchema = compileIdentityTextSchema("projectRef", 256);

export const compileRepoKeySchema = compileIdentityTextSchema("repoKey", 1024);

export const compileRepoPathSchema = compileIdentityTextSchema("repoPath", 4096);

export const compileInputSchema = z
  .object({
    goal: z.string().trim().min(1),
    intent: z.string().trim().min(1).optional(),
    retrievalMode: retrievalModeSchema.optional(),
    changeTypes: z.array(z.string().trim().min(1)).optional(),
    technologies: z.array(z.string().trim().min(1)).optional(),
    domains: z.array(z.string().trim().min(1)).optional(),
    files: z.array(z.string().trim().min(1)).optional(),
    projectRef: compileProjectRefSchema.optional(),
    repoPath: compileRepoPathSchema.optional(),
    repoKey: compileRepoKeySchema.optional(),
    includeDraft: z.boolean().optional(),
    tokenBudget: z.number().int().positive().optional(),
    queryEmbedding: z.array(z.number()).optional(),
  })
  .strict();

export type CompileInput = z.infer<typeof compileInputSchema>;
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;

function hasChangeType(values: string[] | undefined, candidate: string): boolean {
  if (!values || values.length === 0) return false;
  const normalized = candidate.trim().toLowerCase();
  return values.some((value) => value.trim().toLowerCase() === normalized);
}

export function deriveRetrievalModeFromChangeTypes(
  changeTypes: string[] | undefined,
): RetrievalMode {
  if (hasChangeType(changeTypes, "debug")) return "debug_context";
  if (hasChangeType(changeTypes, "review")) return "review_context";
  if (hasChangeType(changeTypes, "plan") || hasChangeType(changeTypes, "docs")) {
    return "architecture_context";
  }
  if (hasChangeType(changeTypes, "procedure")) return "procedure_context";
  if (hasChangeType(changeTypes, "learning")) return "learning_context";
  return "task_context";
}
