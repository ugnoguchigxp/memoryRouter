import { eq } from "drizzle-orm";
import {
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../../../api/modules/knowledge/knowledge.repository.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import { rankAndDedupe } from "../../modules/context-compiler/ranking.service.js";
import { canTransitionKnowledgeStatus } from "../../modules/knowledge/knowledge-lifecycle.service.js";
import { searchKnowledgeCandidates } from "../../modules/knowledge/knowledge.service.js";
import {
  registerCandidate,
  registerCandidatesBulk,
} from "../../modules/registerCandidate/register-candidate.service.js";
import {
  knowledgeSearchInputSchema,
  listKnowledgeInputSchema,
  registerCandidateInputSchema,
  registerCandidatesToolInputSchema,
  updateKnowledgeInputSchema,
} from "../../shared/schemas/knowledge.schema.js";
import type { ToolEntry } from "../registry.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const searchKnowledgeTool: ToolEntry = {
  name: "search_knowledge",
  description:
    "Inspect raw knowledge candidates with scores and source refs. Prefer context_compile for normal workflows.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      repoPath: { type: "string" },
      changeTypes: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
      includeGeneral: { type: "boolean", default: true },
      statuses: {
        type: "array",
        items: { type: "string", enum: ["draft", "active", "deprecated"] },
      },
      polarities: {
        type: "array",
        items: { type: "string", enum: ["positive", "negative", "neutral"] },
      },
      intentTags: {
        type: "array",
        items: { type: "string" },
      },
      types: {
        type: "array",
        items: { type: "string", enum: ["rule", "procedure"] },
      },
      limit: { type: "number", default: 10 },
      includeDraft: { type: "boolean", default: false },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const parsed = knowledgeSearchInputSchema.parse(args ?? {});
    const result = await searchKnowledgeCandidates(parsed);
    const ranked = rankAndDedupe(
      result.items.map((item) => ({
        ...item,
        content: item.body,
        sourceRefCount: item.sourceRefs.length,
        stale: item.status === "deprecated",
      })),
      parsed.limit,
    ).map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      scope: item.scope,
      polarity: item.polarity,
      intentTags: item.intentTags,
      title: item.title,
      body: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      compileSelectCount: item.compileSelectCount,
      agenticAcceptCount: item.agenticAcceptCount,
      explicitUpvoteCount: item.explicitUpvoteCount,
      explicitDownvoteCount: item.explicitDownvoteCount,
      lastCompiledAt: item.lastCompiledAt,
      lastVerifiedAt: item.lastVerifiedAt,
      updatedAt: item.updatedAt,
      sourceRefs: item.sourceRefs,
      appliesTo: item.appliesTo,
      applicabilityScore: item.applicabilityScore,
      applicabilityMatches: item.applicabilityMatches,
      metadata: item.metadata,
    }));

    if (ranked.length === 0) {
      return {
        content: [{ type: "text", text: "no content" }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: parsed.query,
              normalizedQuery: result.stats.queryText,
              items: ranked,
              diagnostics: {
                degradedReasons: result.degradedReasons,
                stats: result.stats,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const registerCandidateTool: ToolEntry = {
  name: "register_candidate",
  description:
    "Register a lightweight rule/procedure candidate for later distillation. No embedding or knowledge draft is created synchronously. In Japanese-operated contexts, write title/body/avoid/prefer natural language in Japanese except identifiers, commands, API names, URLs, and error messages.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Clear, concise candidate title." },
      body: {
        type: "string",
        description:
          "Candidate body. In Japanese-operated contexts, natural language must be Japanese. For procedures, keep Use when / Workflow / Verification / Avoid headings, but write section bodies in Japanese.",
      },
      text: {
        type: "string",
        description:
          "Raw note or JSON-like text alternative to title/body. The server will normalize the first candidate into title/body.",
      },
      avoid: {
        type: "string",
        description:
          "For polarity=negative when body/text is omitted: decision, implementation, or operation to avoid. For type=procedure with non-negative polarity, this may populate a missing Avoid section. In Japanese-operated contexts, write natural language in Japanese.",
      },
      prefer: {
        type: "string",
        description:
          "For polarity=negative when body/text is omitted: safer decision, implementation, or operation to prefer. In Japanese-operated contexts, write natural language in Japanese.",
      },
      type: { type: "string", enum: ["rule", "procedure"] },
      polarity: { type: "string", enum: ["positive", "negative", "neutral"] },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      importance: { type: "number", minimum: 0, maximum: 100 },
      appliesTo: { type: "object" },
      general: { type: "boolean" },
      technologies: { type: "array", items: { type: "string" } },
      changeTypes: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
      repoPath: { type: "string" },
      repoKey: { type: "string" },
      metadata: { type: "object" },
    },
  },
  handler: async (args) => {
    const parsed = registerCandidateInputSchema.parse(args ?? {});
    const result = await registerCandidate(parsed, { strictProcedureSections: true });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};

export const registerCandidatesTool: ToolEntry = {
  name: "register_candidates",
  description:
    "Bulk-register lightweight rule/procedure candidates into the distillation pipeline. candidate_registered means transactionally persisted to that pipeline; it does not mean active Knowledge. Use when multiple durable lessons should be registered from the same task. In Japanese-operated contexts, write title/body/avoid/prefer natural language in Japanese except identifiers, commands, API names, URLs, and error messages.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "Clear candidate title. Use Japanese natural language in Japanese-operated contexts.",
            },
            body: {
              type: "string",
              description:
                "Candidate body. Use Japanese natural language in Japanese-operated contexts. Procedure headings stay Use when / Workflow / Verification / Avoid, but section bodies should be Japanese.",
            },
            text: { type: "string" },
            avoid: {
              type: "string",
              description:
                "For polarity=negative when body/text is omitted: decision, implementation, or operation to avoid. For type=procedure with non-negative polarity, this may populate a missing Avoid section. Use Japanese natural language in Japanese-operated contexts.",
            },
            prefer: {
              type: "string",
              description:
                "Negative candidate safer decision, implementation, or operation to prefer. Use Japanese natural language in Japanese-operated contexts.",
            },
            type: { type: "string", enum: ["rule", "procedure"] },
            polarity: { type: "string", enum: ["positive", "negative", "neutral"] },
            confidence: { type: "number", minimum: 0, maximum: 100 },
            importance: { type: "number", minimum: 0, maximum: 100 },
            appliesTo: { type: "object" },
            general: { type: "boolean" },
            technologies: { type: "array", items: { type: "string" } },
            changeTypes: { type: "array", items: { type: "string" } },
            domains: { type: "array", items: { type: "string" } },
            repoPath: { type: "string" },
            repoKey: { type: "string" },
            metadata: { type: "object" },
          },
        },
        minItems: 1,
        maxItems: 10,
      },
    },
    required: ["items"],
  },
  handler: async (args) => {
    const parsed = registerCandidatesToolInputSchema.parse(args ?? {});
    const result = await registerCandidatesBulk(parsed.items, { strictProcedureSections: true });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const listKnowledgeTool: ToolEntry = {
  name: "list_knowledge",
  description:
    "List knowledge backlog/items for review. Useful for draft triage or active knowledge inspection.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 50, minimum: 1, maximum: 200 },
      status: { type: "string", enum: ["draft", "active", "deprecated"] },
      type: { type: "string", enum: ["rule", "procedure"] },
      query: { type: "string" },
      polarities: {
        type: "array",
        items: { type: "string", enum: ["positive", "negative", "neutral"] },
      },
      intentTags: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  handler: async (args) => {
    const parsed = listKnowledgeInputSchema.parse(args ?? {});
    const items = await listKnowledgeItems(parsed);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              filters: parsed,
              count: items.length,
              items,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const updateKnowledgeTool: ToolEntry = {
  name: "update_knowledge",
  description:
    "Update knowledge content/status directly (for example draft -> active or active -> deprecated).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Knowledge UUID" },
      type: { type: "string", enum: ["rule", "procedure"] },
      status: { type: "string", enum: ["draft", "active", "deprecated"] },
      scope: { type: "string", enum: ["repo", "global"] },
      polarity: { type: "string", enum: ["positive", "negative", "neutral"] },
      intentTags: { type: "array", items: { type: "string" } },
      title: { type: "string" },
      body: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 100 },
      importance: { type: "number", minimum: 0, maximum: 100 },
      appliesTo: { type: "object" },
      general: { type: "boolean" },
      technologies: { type: "array", items: { type: "string" } },
      changeTypes: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
      repoPath: { type: "string" },
      repoKey: { type: "string" },
      metadata: { type: "object" },
    },
    required: ["id"],
  },
  handler: async (args) => {
    const parsed = updateKnowledgeInputSchema.parse(args ?? {});
    const [existing] = await db
      .select({
        id: knowledgeItems.id,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        scope: knowledgeItems.scope,
        polarity: knowledgeItems.polarity,
        intentTags: knowledgeItems.intentTags,
        title: knowledgeItems.title,
        body: knowledgeItems.body,
        confidence: knowledgeItems.confidence,
        importance: knowledgeItems.importance,
        appliesTo: knowledgeItems.appliesTo,
        metadata: knowledgeItems.metadata,
      })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, parsed.id))
      .limit(1);

    if (!existing) {
      return {
        content: [{ type: "text", text: `Knowledge not found: ${parsed.id}` }],
        isError: true,
      };
    }

    const currentStatus = existing.status as "draft" | "active" | "deprecated";
    const nextStatus = (parsed.status ?? currentStatus) as "draft" | "active" | "deprecated";
    if (nextStatus !== currentStatus && !canTransitionKnowledgeStatus(currentStatus, nextStatus)) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid status transition: ${currentStatus} -> ${nextStatus}`,
          },
        ],
        isError: true,
      };
    }

    const existingMetadata = asRecord(existing.metadata);
    const merged = {
      type: parsed.type ?? existing.type,
      status: nextStatus,
      scope: parsed.scope ?? existing.scope,
      polarity: (parsed.polarity ?? existing.polarity) as "positive" | "negative" | "neutral",
      intentTags: (parsed.intentTags ??
        (Array.isArray(existing.intentTags) ? existing.intentTags : [])) as string[],
      title: parsed.title ?? existing.title,
      body: parsed.body ?? existing.body,
      confidence: parsed.confidence ?? normalizeKnowledgeScore(existing.confidence, 70),
      importance: parsed.importance ?? normalizeKnowledgeScore(existing.importance, 70),
      appliesTo: {
        ...asRecord(existing.appliesTo),
        ...(parsed.appliesTo ? asRecord(parsed.appliesTo) : {}),
        ...(parsed.general !== undefined ? { general: parsed.general } : {}),
        ...(parsed.technologies ? { technologies: parsed.technologies } : {}),
        ...(parsed.changeTypes ? { changeTypes: parsed.changeTypes } : {}),
        ...(parsed.domains ? { domains: parsed.domains } : {}),
        ...(parsed.repoPath ? { repoPath: parsed.repoPath } : {}),
        ...(parsed.repoKey ? { repoKey: parsed.repoKey } : {}),
      },
      metadata: parsed.metadata
        ? {
            ...existingMetadata,
            ...parsed.metadata,
          }
        : existingMetadata,
    };

    const updated = await updateKnowledgeItem(parsed.id, merged);
    if (!updated) {
      return {
        content: [{ type: "text", text: `Knowledge not found: ${parsed.id}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: parsed.id,
              status: merged.status,
              type: merged.type,
              scope: merged.scope,
              updatedFields: Object.keys(parsed).filter((key) => key !== "id"),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
