import { parseLlmJsonLike } from "../../../lib/llm-output-parser.js";
import { normalizeLlmUsage } from "../../llm/usage-normalizer.js";
import type { DistillationToolCall } from "../distillation-tools.service.js";
import type { DistillationChatResponse } from "../types.js";

type OpenAiToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type ToolCallLikeObject = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
  tool_calls?: unknown;
  toolCalls?: unknown;
};

export function abortError(): Error {
  const error = new Error("distillation request aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

export function withRequestTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let parentAbortHandler: (() => void) | undefined;
  const timeoutError = () => new Error(`distillation LLM request timed out after ${timeoutMs}ms`);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const parentAbort = new Promise<never>((_, reject) => {
    if (!parentSignal) return;
    parentAbortHandler = () => {
      controller.abort();
      reject(abortError());
    };
    if (parentSignal.aborted) {
      parentAbortHandler();
      return;
    }
    parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
  });
  const request = task(controller.signal).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") {
      if (!timedOut && parentSignal?.aborted) {
        throw abortError();
      }
      throw timeoutError();
    }
    throw error;
  });

  return Promise.race([request, timeout, parentAbort]).finally(() => {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentAbortHandler) {
      parentSignal.removeEventListener("abort", parentAbortHandler);
    }
  });
}

/** @internal */
export function parseToolCalls(value: unknown): DistillationToolCall[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawCall, index) => {
    if (!rawCall || typeof rawCall !== "object") return [];
    const call = rawCall as OpenAiToolCall;
    const name = call.function?.name;
    if (typeof name !== "string" || !name.trim()) return [];
    const rawArguments = call.function?.arguments;
    const args =
      typeof rawArguments === "string"
        ? rawArguments
        : rawArguments === undefined
          ? "{}"
          : JSON.stringify(rawArguments);
    return [
      {
        id: typeof call.id === "string" && call.id.trim() ? call.id : `tool-call-${index + 1}`,
        type: "function",
        function: {
          name,
          arguments: args,
        },
      },
    ];
  });
}

function normalizeToolCallLike(
  value: unknown,
  index: number,
  options: { requireArguments: boolean },
): DistillationToolCall | null {
  if (!value || typeof value !== "object") return null;
  const call = value as ToolCallLikeObject;
  const functionShape =
    call.function && typeof call.function === "object"
      ? call.function
      : {
          name: call.name,
          arguments: call.arguments,
        };
  const name = functionShape.name;
  if (typeof name !== "string" || !name.trim()) return null;
  if (options.requireArguments && functionShape.arguments === undefined) return null;

  const rawArguments = functionShape.arguments;
  const argumentsText =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined
        ? "{}"
        : JSON.stringify(rawArguments);

  return {
    id: typeof call.id === "string" && call.id.trim() ? call.id : `tool-call-content-${index + 1}`,
    type: "function",
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

function parseToolCallsFromContent(rawContent: unknown): DistillationToolCall[] {
  if (typeof rawContent !== "string" || !rawContent.trim()) return [];
  const parsed = parseLlmJsonLike(rawContent)?.value;
  if (!parsed) {
    return recoverToolCallFromMalformedContent(rawContent);
  }

  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry, index) => {
      const normalized = normalizeToolCallLike(entry, index, { requireArguments: true });
      return normalized ? [normalized] : [];
    });
  }

  if (!parsed || typeof parsed !== "object") return [];
  const objectValue = parsed as ToolCallLikeObject;
  const nestedCalls = parseToolCalls(objectValue.tool_calls ?? objectValue.toolCalls);
  if (nestedCalls.length > 0) return nestedCalls;

  const single = normalizeToolCallLike(objectValue, 0, { requireArguments: true });
  return single ? [single] : [];
}

function extractQuotedField(raw: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
  const match = raw.match(pattern);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

const recoveredSearchStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "keyword",
  "term",
  "この",
  "その",
  "あの",
  "これ",
  "それ",
  "について",
  "とは",
  "では",
  "です",
  "ます",
  "する",
  "した",
  "して",
  "ください",
  "教えて",
  "単語",
  "検索",
  "キーワード",
]);

function normalizeRecoveredSearchTerms(raw: string): string[] {
  const tokens =
    raw
      .normalize("NFKC")
      .toLowerCase()
      .match(/(?:--?)?[a-z0-9][a-z0-9._:/@+-]*|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/giu) ?? [];
  const terms: string[] = [];
  for (const token of tokens) {
    const value = token.trim();
    if (!value || recoveredSearchStopWords.has(value)) continue;
    if (value.length < 2 && !value.startsWith("-")) continue;
    if (!terms.includes(value)) terms.push(value);
    if (terms.length >= 5) break;
  }
  return terms;
}

function recoverToolCallFromMalformedContent(rawContent: string): DistillationToolCall[] {
  const delimited = recoverDelimitedToolCall(rawContent);
  if (delimited) return [delimited];

  const name = extractQuotedField(rawContent, "name");
  if (!name) return [];

  const query = extractQuotedField(rawContent, "query");
  const url = extractQuotedField(rawContent, "url");
  const args: Record<string, string> = {};

  if (query) args.query = query;
  if (url) args.url = url;

  if (Object.keys(args).length === 0) return [];

  return [
    {
      id: "tool-call-content-1",
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
  ];
}

function recoverDelimitedToolCall(rawContent: string): DistillationToolCall | null {
  const normalized = rawContent.trim();
  const compactLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  // Pipe-delimited keyword control format: | keyword 1 | keyword 2 |
  if (compactLines.includes("|")) {
    const tokens = compactLines
      .split("|")
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length > 0 && !tokens.every((token) => /^\d+$/.test(token))) {
      const rawQuery = tokens.join(" ").replace(/\s+/g, " ").trim();
      const query = normalizeRecoveredSearchTerms(rawQuery).join(" ");
      if (query) {
        const args =
          query === rawQuery
            ? { query }
            : {
                query,
                normalizedFrom: "pipe_keywords",
                rawQueryPreview: rawQuery.slice(0, 240),
              };
        return {
          id: "tool-call-content-1",
          type: "function",
          function: {
            name: "search_web",
            arguments: JSON.stringify(args),
          },
        };
      }
    }
  }

  // Index selection control format after search results: 2,3,4
  const indexListMatch = compactLines.match(/^\s*(\d+\s*(?:,\s*\d+\s*)+)\s*$/);
  if (indexListMatch?.[1]) {
    const selection = indexListMatch[1].replace(/\s+/g, "");
    return {
      id: "tool-call-content-1",
      type: "function",
      function: {
        name: "fetch_content",
        arguments: JSON.stringify({ url: selection }),
      },
    };
  }

  const urlMatch = normalized.match(/https?:\/\/[^\s"']+/i);
  if (normalized.includes("fetch_content") && urlMatch?.[0]) {
    return {
      id: "tool-call-content-1",
      type: "function",
      function: {
        name: "fetch_content",
        arguments: JSON.stringify({ url: urlMatch[0] }),
      },
    };
  }

  if (!normalized.includes("search_web")) return null;

  const queryField =
    normalized.match(/query\s*[:=]\s*(.+)$/i)?.[1] ??
    normalized.match(/query\s*\/\s*(.+)$/i)?.[1] ??
    normalized.match(/search_web\s*\/\s*(.+)$/i)?.[1] ??
    normalized.match(/search_web\s+(.+)$/i)?.[1];
  const query = queryField?.trim().replace(/^["']|["']$/g, "");
  if (!query) return null;

  return {
    id: "tool-call-content-1",
    type: "function",
    function: {
      name: "search_web",
      arguments: JSON.stringify({ query }),
    },
  };
}

/** @internal */
export function parseOpenAiStyleResponse(payload: unknown): DistillationChatResponse {
  const parsed = payload as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      completion_tokens_details?: {
        reasoning_tokens?: unknown;
      };
    };
  };
  const choice = parsed.choices?.[0];
  const rawContent = choice?.message?.content;
  const usage = normalizeLlmUsage({
    promptTokens: parsed.usage?.prompt_tokens,
    completionTokens: parsed.usage?.completion_tokens,
    totalTokens: parsed.usage?.total_tokens,
    reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens,
  });
  const explicitToolCalls = parseToolCalls(choice?.message?.tool_calls);
  const recoveredToolCalls =
    explicitToolCalls.length > 0 ? [] : parseToolCallsFromContent(rawContent);
  const toolCalls = explicitToolCalls.length > 0 ? explicitToolCalls : recoveredToolCalls;
  const normalizedContent =
    recoveredToolCalls.length > 0 ? null : typeof rawContent === "string" ? rawContent : null;
  return {
    content: normalizedContent,
    toolCalls,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage,
  };
}
