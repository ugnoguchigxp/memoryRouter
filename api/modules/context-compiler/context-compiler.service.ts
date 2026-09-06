import { z } from "zod";
import {
  compileRunEpisodeFeedbackResultSchema,
  type compileRunEpisodeFeedbackWriteSchema,
  compileRunKnowledgeFeedbackResultSchema,
  type compileRunKnowledgeFeedbackWriteSchema,
} from "../../../src/shared/schemas/compile-run.schema.js";
import type { CompileInput } from "../../../src/shared/schemas/compile.schema.js";
import {
  compilePack,
  deprecateRunEpisodeForRepository,
  getRunDetail,
  getRunRankingTrace,
  listRuns,
  saveRunEpisodeFeedbackForRepository,
  saveRunKnowledgeFeedback,
} from "./context-compiler.repository.js";

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const runIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const runEpisodeDeprecateParamSchema = runIdParamSchema.extend({
  episodeId: z.string().trim().min(1),
});

export async function compilePackForApi(input: CompileInput) {
  return compilePack(input);
}

export async function listRunsForApi(input: z.infer<typeof listRunsQuerySchema>) {
  return listRuns(input.limit);
}

export async function getRunDetailForApi(input: z.infer<typeof runIdParamSchema>) {
  return getRunDetail(input.id);
}

export async function getRunRankingTraceForApi(input: z.infer<typeof runIdParamSchema>) {
  return getRunRankingTrace(input.id);
}

export async function saveRunKnowledgeFeedbackForApi(
  params: z.infer<typeof runIdParamSchema>,
  body: z.infer<typeof compileRunKnowledgeFeedbackWriteSchema>,
) {
  const result = await saveRunKnowledgeFeedback({
    runId: params.id,
    items: body.items,
  });
  return compileRunKnowledgeFeedbackResultSchema.parse(result);
}

export async function saveRunEpisodeFeedbackForApi(
  params: z.infer<typeof runIdParamSchema>,
  body: z.infer<typeof compileRunEpisodeFeedbackWriteSchema>,
) {
  const result = await saveRunEpisodeFeedbackForRepository({
    runId: params.id,
    items: body.items,
  });
  return compileRunEpisodeFeedbackResultSchema.parse(result);
}

export async function deprecateRunEpisodeForApi(
  params: z.infer<typeof runEpisodeDeprecateParamSchema>,
) {
  await deprecateRunEpisodeForRepository({ runId: params.id, episodeId: params.episodeId });
  return { ok: true };
}
