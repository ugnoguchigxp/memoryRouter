import { compileContextPack } from "../../modules/context-compiler/context-compiler.service.js";
import { reloadRuntimeSettingsCache } from "../../modules/settings/settings.service.js";
import { compileInputSchema } from "../../shared/schemas/compile.schema.js";
import type { ToolEntry } from "../registry.js";

const contextCompileMcpInputSchema = compileInputSchema
  .pick({
    goal: true,
    changeTypes: true,
    technologies: true,
    domains: true,
    projectRef: true,
    repoKey: true,
    repoPath: true,
    securityIntelligenceShadow: true,
  })
  .strict();

function resolveSessionIdFromMeta(requestMeta?: Record<string, unknown>): string | undefined {
  const keys = ["sessionId", "threadId", "conversationId", "codexSessionId"] as const;
  for (const key of keys) {
    const value = requestMeta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export const contextCompileTool: ToolEntry = {
  name: "context_compile",
  description:
    "Primary workflow tool. Build the minimal task context pack from knowledge + source evidence before coding.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string" },
      changeTypes: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
      projectRef: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
        description: "Stable, opaque, case-sensitive project identity used as a selection hint.",
      },
      repoKey: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
        description: "Explicit legacy repository lookup key. Not derived from repoPath.",
      },
      repoPath: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
        description: "Absolute lexical repository path or local absolute file URI.",
      },
      securityIntelligenceShadow: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", const: true },
          taskRef: { type: "string", minLength: 1, maxLength: 256 },
          runRef: { type: "string", minLength: 1, maxLength: 256 },
          projectRef: {
            type: "string",
            pattern: "^project:[A-Za-z0-9._:-]{1,247}$",
          },
        },
        required: ["enabled", "taskRef", "runRef", "projectRef"],
        description:
          "Explicit Security Contract-bound shadow retrieval. Candidate/draft refs are recorded but never added to the context markdown.",
      },
    },
    required: ["goal"],
  },
  handler: async (args, context) => {
    const parsed = contextCompileMcpInputSchema.parse(args ?? {});
    await reloadRuntimeSettingsCache();
    const { markdown, securityIntelligenceShadow } = await compileContextPack(parsed, {
      source: "mcp",
      sessionId: resolveSessionIdFromMeta(context?.requestMeta),
    });
    return {
      content: [{ type: "text", text: markdown }],
      ...(securityIntelligenceShadow ? { _meta: { securityIntelligenceShadow } } : {}),
    };
  },
};
