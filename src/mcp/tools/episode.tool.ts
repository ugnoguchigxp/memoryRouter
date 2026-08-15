import { z } from "zod";
import {
  fetchEpisode,
  searchEpisodes,
} from "../../modules/episodic-memory/episode-card.service.js";

const searchEpisodesArgsSchema = z.object({
  query: z.string().trim().optional(),
  status: z.enum(["active", "deprecated"]).optional(),
  statuses: z.array(z.enum(["active", "deprecated"])).optional(),
  domains: z.array(z.string()).optional(),
  technologies: z.array(z.string()).optional(),
  changeTypes: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  projectRef: z.string().trim().min(1).max(256).optional(),
  repoPath: z.string().trim().optional(),
  repoKey: z.string().trim().optional(),
  outcomeKinds: z.array(z.enum(["success", "failure", "mixed", "unknown"])).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const fetchEpisodeArgsSchema = z.object({
  id: z.string().min(1),
});

export const searchEpisodesTool = {
  name: "search_episodes",
  description: "Search EpisodeCards, compact past-work precedents with refs back to raw evidence.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search text for title, situation, lesson, refs." },
      status: {
        type: "string",
        enum: ["active", "deprecated"],
        description: "Single status filter. Defaults to active.",
      },
      statuses: {
        type: "array",
        items: { type: "string", enum: ["active", "deprecated"] },
        description: "Multiple status filters.",
      },
      domains: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      changeTypes: { type: "array", items: { type: "string" } },
      tools: { type: "array", items: { type: "string" } },
      projectRef: { type: "string", minLength: 1, maxLength: 256 },
      repoPath: { type: "string" },
      repoKey: { type: "string" },
      outcomeKinds: {
        type: "array",
        items: { type: "string", enum: ["success", "failure", "mixed", "unknown"] },
      },
      limit: { type: "number", default: 10, description: "Maximum results, up to 100." },
    },
  },
  async handler(args: unknown) {
    const parsed = searchEpisodesArgsSchema.parse(args ?? {});
    const items = await searchEpisodes(parsed);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              items: items.map((item) => ({
                id: item.id,
                title: item.title,
                situation: item.situation,
                outcome: item.outcome,
                lesson: item.lesson,
                outcomeKind: item.outcomeKind,
                importance: item.importance,
                confidence: item.confidence,
                compileUseCount: item.compileUseCount,
                decisionUseCount: item.decisionUseCount,
                status: item.status,
                score: item.score,
                domains: item.domains,
                technologies: item.technologies,
                changeTypes: item.changeTypes,
                repoPath: item.repoPath,
                repoKey: item.repoKey,
                refs: item.refs.map((ref) => ({
                  refKind: ref.refKind,
                  refValue: ref.refValue,
                  locator: ref.locator,
                  queryHint: ref.queryHint,
                })),
                createdAt: item.createdAt,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const fetchEpisodeTool = {
  name: "fetch_episode",
  description: "Fetch one EpisodeCard with refs for raw evidence drill down.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "EpisodeCard id." },
    },
    required: ["id"],
  },
  async handler(args: unknown) {
    const parsed = fetchEpisodeArgsSchema.parse(args ?? {});
    const episode = await fetchEpisode(parsed.id);
    if (!episode) {
      return { content: [{ type: "text", text: "Episode not found." }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(episode, null, 2),
        },
      ],
    };
  },
};
