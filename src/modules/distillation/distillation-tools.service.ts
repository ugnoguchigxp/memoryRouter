import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { executeMcpEvidenceTool } from "./mcp-evidence-tools.service.js";
import { normalizeDistillationSearchQuery, searchWeb } from "./search-providers.js";
import { fetchContent, validateFetchContentUrl } from "./url-fetcher.js";

// Re-export public functions for compatibility
export { validateFetchContentUrl, normalizeDistillationSearchQuery };

export const distillationEvidenceToolNames = ["search_web", "fetch_content"] as const;
export const distillationMcpToolNames = ["context7", "deepwiki"] as const;
export const distillationToolNames = [
  ...distillationEvidenceToolNames,
  ...distillationMcpToolNames,
] as const;
export type DistillationToolName = (typeof distillationToolNames)[number];

export type DistillationToolDefinition = {
  type: "function";
  function: {
    name: DistillationToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
  };
};

export type DistillationToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type DistillationToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

const SEARCH_SELECTION_MAX = 3;
const searchResultUrlCache = new Map<string, string[]>();

export const distillationToolDefinitions: DistillationToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search public web results for current documentation, specifications, APIs, packages, and URLs mentioned in evidence.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Focused search query.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_content",
      description:
        "Fetch and clean a public URL so claims can be grounded before distilling compile-ready knowledge.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "HTTP or HTTPS URL to fetch.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "context7",
      description:
        "Ask an optional Context7 MCP server for library, framework, API, or package documentation evidence.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Focused documentation query.",
          },
          library: {
            type: "string",
            description: "Optional library or framework name.",
          },
          topic: {
            type: "string",
            description: "Optional documentation topic.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deepwiki",
      description:
        "Ask an optional DeepWiki MCP server for repository or project documentation evidence.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Focused repository or project documentation query.",
          },
          repository: {
            type: "string",
            description: "Optional repository identifier.",
          },
          topic: {
            type: "string",
            description: "Optional documentation topic.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function distillationToolAuditEventType(toolName: string): string | null {
  if (isDistillationEvidenceToolName(toolName)) {
    return distillationToolAuditEventTypes[toolName];
  }
  if (isDistillationMcpToolName(toolName)) {
    return auditEventTypes.distillationMcpEvidence;
  }
  return null;
}

function isDistillationToolName(value: string): value is DistillationToolName {
  return distillationToolNames.includes(value as DistillationToolName);
}

function isDistillationEvidenceToolName(
  value: string,
): value is (typeof distillationEvidenceToolNames)[number] {
  return distillationEvidenceToolNames.includes(
    value as (typeof distillationEvidenceToolNames)[number],
  );
}

function isDistillationMcpToolName(
  value: string,
): value is (typeof distillationMcpToolNames)[number] {
  return distillationMcpToolNames.includes(value as (typeof distillationMcpToolNames)[number]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function searchCacheKey(auditContext?: Record<string, unknown>): string {
  const domain = stringValue(auditContext?.domain) ?? "unknown";
  const id = stringValue(auditContext?.id) ?? "global";
  const stage = stringValue(auditContext?.stage) ?? "unknown";
  return `${domain}:${id}:${stage}`;
}

function isCoverEvidenceAuditContext(auditContext?: Record<string, unknown>): boolean {
  return auditContext?.domain === "coverEvidence";
}

function fetchContentOptionsForAuditContext(auditContext?: Record<string, unknown>): {
  forceRefreshEvidence: boolean;
  maxTokensPerSite?: number;
  guardExternalEvidence?: boolean;
} {
  const forceRefreshEvidence = Boolean(auditContext?.forceRefreshEvidence);
  if (!isCoverEvidenceAuditContext(auditContext)) return { forceRefreshEvidence };
  return {
    forceRefreshEvidence,
    maxTokensPerSite: groupedConfig.distillationTools.coverEvidenceFetchMaxTokensPerSite,
    guardExternalEvidence: true,
  };
}

function extractSearchResultUrls(content: string): string[] {
  const parsed = parseLlmJsonLike(content)?.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? stringValue((entry as Record<string, unknown>).url)
        : undefined,
    )
    .filter((url): url is string => Boolean(url));
}

function parseSelectionIndexes(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(trimmed)) return [];
  const unique = new Set<number>();
  for (const token of trimmed.split(",")) {
    const parsed = Number.parseInt(token.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) unique.add(parsed);
  }
  return [...unique];
}

async function fetchContentBySelection(params: {
  selection: string;
  auditContext?: Record<string, unknown>;
}): Promise<DistillationToolResult> {
  const key = searchCacheKey(params.auditContext);
  const urls = searchResultUrlCache.get(key) ?? [];
  const indexes = parseSelectionIndexes(params.selection);
  if (indexes.length === 0) {
    throw new Error("invalid fetch_content selection format (expected: 2,3,4)");
  }
  const selectedUrls = indexes
    .map((index) => urls[index - 1])
    .filter((url): url is string => Boolean(url))
    .slice(0, SEARCH_SELECTION_MAX);
  if (selectedUrls.length === 0) {
    throw new Error("no cached search results for selected indexes");
  }
  // Selection format is used as a one-shot control step.
  // Remove cached URLs to avoid reusing stale rankings in later unrelated rounds.
  searchResultUrlCache.delete(key);

  const results: Array<{
    index: number;
    url: string;
    ok: boolean;
    content?: string;
    error?: string;
  }> = [];
  for (const index of indexes.slice(0, SEARCH_SELECTION_MAX)) {
    const url = urls[index - 1];
    if (!url) continue;
    const fetched = await fetchContent(url, {
      ...fetchContentOptionsForAuditContext(params.auditContext),
    });
    results.push({
      index,
      url,
      ok: fetched.ok,
      ...(fetched.ok ? { content: fetched.content } : { error: fetched.error ?? "fetch_failed" }),
    });
  }
  return {
    callId: "",
    name: "fetch_content",
    ok: results.some((result) => result.ok),
    content: JSON.stringify(
      {
        selected: results.map((result) => ({
          index: result.index,
          url: result.url,
          ok: result.ok,
          ...(result.ok ? { content: result.content } : { error: result.error }),
        })),
        instruction:
          "Use fetched primary source content to produce the final coverEvidence result.",
      },
      null,
      2,
    ),
    metadata: {
      selection: params.selection,
      selectedUrls: results.map((result) => result.url),
      selectedCount: results.length,
    },
  };
}

async function recordDistillationToolAudit(params: {
  toolCall: DistillationToolCall;
  args: Record<string, unknown>;
  result: DistillationToolResult;
  durationMs: number;
  auditContext?: Record<string, unknown>;
}): Promise<void> {
  const eventType = distillationToolAuditEventType(params.toolCall.function.name);
  if (!eventType) return;

  const metadata = params.result.metadata ?? {};
  const payload: Record<string, unknown> = {
    ...(params.auditContext ?? {}),
    callId: params.toolCall.id,
    toolName: params.toolCall.function.name,
    ok: params.result.ok,
    durationMs: params.durationMs,
  };

  if (params.toolCall.function.name === "search_web") {
    payload.query = stringValue(metadata.query) ?? stringValue(params.args.query);
    payload.resultCount =
      typeof metadata.resultCount === "number" ? metadata.resultCount : undefined;
    payload.provider = stringValue(metadata.provider);
    payload.attemptedProviders = Array.isArray(metadata.attemptedProviders)
      ? metadata.attemptedProviders
      : undefined;
    payload.providerAttemptCount =
      typeof metadata.providerAttemptCount === "number" ? metadata.providerAttemptCount : undefined;
    payload.providerErrors = isRecord(metadata.providerErrors)
      ? (metadata.providerErrors as Record<string, unknown>)
      : undefined;
    payload.rateLimit = isRecord(metadata.rateLimit)
      ? (metadata.rateLimit as Record<string, unknown>)
      : undefined;
    payload.cooldownApplied =
      typeof metadata.cooldownApplied === "boolean" ? metadata.cooldownApplied : undefined;
    payload.cooldownUntil = isRecord(metadata.cooldownUntil)
      ? (metadata.cooldownUntil as Record<string, unknown>)
      : undefined;
    payload.cacheHit = typeof metadata.cacheHit === "boolean" ? metadata.cacheHit : undefined;
    payload.braveError = stringValue(metadata.braveError);
  }

  if (params.toolCall.function.name === "fetch_content") {
    payload.url = stringValue(params.args.url);
    payload.finalUrl = stringValue(metadata.finalUrl);
    payload.contentChars =
      typeof metadata.contentChars === "number" ? metadata.contentChars : undefined;
    payload.redirectCount =
      typeof metadata.redirectCount === "number" ? metadata.redirectCount : undefined;
  }

  if (isDistillationMcpToolName(params.toolCall.function.name)) {
    payload.query = stringValue(params.args.query);
    payload.uri = stringValue(metadata.uri);
    payload.title = stringValue(metadata.title);
    payload.locator = stringValue(metadata.locator);
    payload.server = stringValue(metadata.server);
    payload.mcpToolName = stringValue(metadata.mcpToolName);
    payload.unavailable =
      typeof metadata.unavailable === "boolean" ? metadata.unavailable : undefined;
  }

  if (!params.result.ok) {
    payload.error = params.result.error;
  }

  await recordAuditLogSafe({
    eventType,
    actor: "system",
    payload,
  });
}

const distillationToolHandlers: Record<
  DistillationToolName,
  (
    args: Record<string, unknown>,
    auditContext?: Record<string, unknown>,
  ) => Promise<DistillationToolResult>
> = {
  search_web: async (args, auditContext) => {
    const result = await searchWeb(args.query, {
      forceRefreshEvidence: Boolean(auditContext?.forceRefreshEvidence),
    });
    if (result.ok) {
      const urls = extractSearchResultUrls(result.content);
      if (urls.length > 0) {
        searchResultUrlCache.set(searchCacheKey(auditContext), urls);
      }
    }
    return result;
  },
  fetch_content: async (args, auditContext) => {
    const rawUrl = stringValue(args.url);
    if (rawUrl && !/^https?:\/\//i.test(rawUrl) && parseSelectionIndexes(rawUrl).length > 0) {
      return fetchContentBySelection({ selection: rawUrl, auditContext });
    }
    return fetchContent(args.url, {
      ...fetchContentOptionsForAuditContext(auditContext),
    });
  },
  context7: (args) => executeMcpEvidenceTool("context7", args),
  deepwiki: (args) => executeMcpEvidenceTool("deepwiki", args),
};

const distillationToolAuditEventTypes: Record<
  (typeof distillationEvidenceToolNames)[number],
  string
> = {
  search_web: auditEventTypes.distillationWebSearch,
  fetch_content: auditEventTypes.distillationFetchContent,
};

export async function executeDistillationToolCall(
  toolCall: DistillationToolCall,
  auditContext?: Record<string, unknown>,
): Promise<DistillationToolResult> {
  const startedAt = Date.now();
  const args = parseToolArguments(toolCall.function.arguments);
  try {
    if (!isDistillationToolName(toolCall.function.name)) {
      throw new Error(`unknown distillation tool: ${toolCall.function.name}`);
    }
    const result = await distillationToolHandlers[toolCall.function.name](args, auditContext);

    const auditedResult = {
      ...result,
      callId: toolCall.id,
    };
    await recordDistillationToolAudit({
      toolCall,
      args,
      result: auditedResult,
      durationMs: Date.now() - startedAt,
      auditContext,
    });
    return auditedResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureResult = {
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: false,
      content: JSON.stringify({
        error: message,
        instruction: "Treat this tool result as insufficient evidence for external claims.",
      }),
      error: message,
    };
    await recordDistillationToolAudit({
      toolCall,
      args,
      result: failureResult,
      durationMs: Date.now() - startedAt,
      auditContext,
    });
    return failureResult;
  }
}
