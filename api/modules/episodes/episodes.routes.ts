import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  fetchEpisode,
  registerEpisode,
  listEpisodesForAdmin,
} from "../../../src/modules/episodic-memory/episode-card.service.js";
import { episodeCardCreateSchema } from "../../../src/shared/schemas/episode-card.schema.js";

const episodeApiCreateSchema = episodeCardCreateSchema
  .omit({ status: true })
  .extend({ status: z.never().optional() });

function csvArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return undefined;
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

const listEpisodesQuerySchema = z.object({
  q: z.string().trim().optional(),
  query: z.string().trim().optional(),
  status: z.enum(["active", "deprecated"]).optional(),
  domains: z.preprocess(csvArray, z.array(z.string()).optional()),
  technologies: z.preprocess(csvArray, z.array(z.string()).optional()),
  changeTypes: z.preprocess(csvArray, z.array(z.string()).optional()),
  tools: z.preprocess(csvArray, z.array(z.string()).optional()),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: z.string().trim().optional(),
  repoKey: z.string().trim().optional(),
  outcomeKinds: z.preprocess(
    csvArray,
    z.array(z.enum(["success", "failure", "mixed", "unknown"])).optional(),
  ),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const episodesRouter = new Hono()
  .post("/", zValidator("json", episodeApiCreateSchema), async (c) => {
    const episode = await registerEpisode(c.req.valid("json"));
    return c.json({ episode }, 201);
  })
  .get("/", zValidator("query", listEpisodesQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const items = await listEpisodesForAdmin({
      query: query.query ?? query.q,
      status: query.status,
      domains: query.domains,
      technologies: query.technologies,
      changeTypes: query.changeTypes,
      tools: query.tools,
      projectRef: query.projectRef,
      repoPath: query.repoPath,
      repoKey: query.repoKey,
      outcomeKinds: query.outcomeKinds,
      limit: query.limit,
    });
    return c.json({ items });
  })
  .get("/:id", async (c) => {
    const episode = await fetchEpisode(c.req.param("id"));
    if (!episode) return c.json({ error: "Episode not found" }, 404);
    return c.json({ episode });
  });
