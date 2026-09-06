import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  compileRunEpisodeFeedbackWriteSchema,
  compileRunKnowledgeFeedbackWriteSchema,
} from "../../../src/shared/schemas/compile-run.schema.js";
import { compileInputSchema } from "../../../src/shared/schemas/compile.schema.js";
import {
  compilePackForApi,
  deprecateRunEpisodeForApi,
  getRunDetailForApi,
  getRunRankingTraceForApi,
  listRunsForApi,
  listRunsQuerySchema,
  runEpisodeDeprecateParamSchema,
  runIdParamSchema,
  saveRunEpisodeFeedbackForApi,
  saveRunKnowledgeFeedbackForApi,
} from "./context-compiler.service.js";

export const contextCompilerRouter = new Hono()
  .post("/compile", zValidator("json", compileInputSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await compilePackForApi(input);
    return c.json(result);
  })
  .get("/runs", zValidator("query", listRunsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const runs = await listRunsForApi(query);
    return c.json({ runs });
  })
  .get("/runs/:id", zValidator("param", runIdParamSchema), async (c) => {
    const params = c.req.valid("param");
    const detail = await getRunDetailForApi(params);
    if (!detail) {
      return c.json({ error: "Compile run not found." }, 404);
    }
    return c.json({ detail });
  })
  .get("/runs/:id/ranking-trace", zValidator("param", runIdParamSchema), async (c) => {
    const params = c.req.valid("param");
    const trace = await getRunRankingTraceForApi(params);
    if (!trace) {
      return c.json({ error: "Compile run not found." }, 404);
    }
    return c.json({ trace });
  })
  .post(
    "/runs/:id/knowledge-feedback",
    zValidator("param", runIdParamSchema),
    zValidator("json", compileRunKnowledgeFeedbackWriteSchema),
    async (c) => {
      try {
        const params = c.req.valid("param");
        const body = c.req.valid("json");
        const result = await saveRunKnowledgeFeedbackForApi(params, body);
        return c.json({ feedback: result });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          "message" in error
        ) {
          const statusCode = Number((error as { statusCode: unknown }).statusCode);
          const message = String((error as { message: unknown }).message);
          if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
            return c.json({ error: message }, statusCode === 404 ? 404 : 400);
          }
        }
        throw error;
      }
    },
  )
  .post(
    "/runs/:id/episode-feedback",
    zValidator("param", runIdParamSchema),
    zValidator("json", compileRunEpisodeFeedbackWriteSchema),
    async (c) => {
      try {
        const params = c.req.valid("param");
        const body = c.req.valid("json");
        const result = await saveRunEpisodeFeedbackForApi(params, body);
        return c.json({ feedback: result });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          "message" in error
        ) {
          const statusCode = Number((error as { statusCode: unknown }).statusCode);
          const message = String((error as { message: unknown }).message);
          if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
            return c.json({ error: message }, statusCode === 404 ? 404 : 400);
          }
        }
        throw error;
      }
    },
  )
  .post(
    "/runs/:id/episodes/:episodeId/deprecate",
    zValidator("param", runEpisodeDeprecateParamSchema),
    async (c) => {
      try {
        const params = c.req.valid("param");
        const result = await deprecateRunEpisodeForApi(params);
        return c.json(result);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          "message" in error
        ) {
          const statusCode = Number((error as { statusCode: unknown }).statusCode);
          const message = String((error as { message: unknown }).message);
          if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
            return c.json({ error: message }, statusCode === 404 ? 404 : 400);
          }
        }
        throw error;
      }
    },
  );
