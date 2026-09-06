import { randomUUID } from "node:crypto";
import type { LlmChatRequest, LlmChatResponse } from "../llm-provider.js";
import { LlmProviderHttpError, parseRetryAfterSeconds } from "../provider-http-error.js";
import { buildLocalLlmChatCompletionsUrl } from "./local-llm-config.js";

type AgentSessionConfig = {
  apiBaseUrl: string;
  apiPath: string;
  apiKey?: string;
  model: string;
};

type AgentSessionResponse = {
  id?: unknown;
  events_url?: unknown;
};

type AgentModelsResponse = {
  data?: Array<{ id?: unknown; runtime?: unknown }>;
  runtime?: { id?: unknown; status?: unknown; detail?: unknown };
};

function headers(apiKey?: string, idempotencyKey?: string): HeadersInit {
  const result: HeadersInit = { "content-type": "application/json" };
  const trimmed = apiKey?.trim();
  if (trimmed) result.Authorization = `Bearer ${trimmed}`;
  if (idempotencyKey) result["Idempotency-Key"] = idempotencyKey;
  return result;
}

function idempotencyKey(action: string): string {
  return `contextstill:${action}:${randomUUID()}`;
}

function runtimeForModel(model: string): string {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : "muse";
}

function agentModelsUrl(config: AgentSessionConfig): string {
  const sessionsUrl = new URL(buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, config.apiPath));
  sessionsUrl.pathname = sessionsUrl.pathname.replace(/\/sessions\/?$/, "/models");
  sessionsUrl.search = "";
  sessionsUrl.searchParams.set("runtime", runtimeForModel(config.model));
  return sessionsUrl.toString();
}

function sessionChildUrl(config: AgentSessionConfig, sessionId: string, child: string): string {
  const sessionsUrl = buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, config.apiPath);
  return `${sessionsUrl.replace(/\/+$/, "")}/${encodeURIComponent(sessionId)}/${child}`;
}

function responseError(response: Response, body: string): LlmProviderHttpError {
  return new LlmProviderHttpError({
    provider: "local-llm",
    status: response.status,
    retryAfterSeconds: parseRetryAfterSeconds(response.headers),
    requestId: response.headers.get("x-request-id") || undefined,
    message: `local-llm agent session HTTP ${response.status}: ${body.slice(0, 500)}`,
  });
}

async function requireJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw responseError(response, body);
  }
  return (await response.json()) as T;
}

function promptForAgentSession(request: LlmChatRequest): string {
  const messages = request.messages
    .map((message) => {
      const content = typeof message.content === "string" ? message.content : "";
      const toolCalls = message.tool_calls?.length
        ? `\nTool calls: ${JSON.stringify(message.tool_calls)}`
        : "";
      return `<${message.role}>\n${content}${toolCalls}\n</${message.role}>`;
    })
    .join("\n\n");
  const outputConstraint =
    request.responseFormat === "json"
      ? "Return only valid JSON. Do not wrap it in Markdown fences."
      : "Return only the requested final answer.";
  return [
    "Act as a text-only LLM backend for this request.",
    "Do not use tools, inspect files, modify a workspace, or ask follow-up questions.",
    outputConstraint,
    `Keep the response within approximately ${request.maxTokens} tokens.`,
    "Treat the role-tagged conversation below as the complete conversation and follow its system instructions.",
    "",
    messages,
  ].join("\n");
}

function parseSseEvent(block: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
  } catch {
    return { event, data: dataLines.join("\n") };
  }
}

function eventData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const root = value as Record<string, unknown>;
  return root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
}

async function readAgentSessionEvents(response: Response): Promise<string> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw responseError(response, body);
  }
  if (!response.body) throw new Error("local-llm agent session did not return an event stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltaText = "";
  let completedText = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
        const parsed = parseSseEvent(block);
        if (!parsed) continue;
        const data = eventData(parsed.data);
        if (parsed.event === "message.delta" && typeof data.text === "string") {
          deltaText += data.text;
        } else if (parsed.event === "message.completed" && typeof data.text === "string") {
          completedText = data.text;
        } else if (parsed.event === "turn.completed") {
          const content = (completedText || deltaText).trim();
          if (!content) {
            throw new Error("local-llm agent session completed without assistant content");
          }
          return content;
        } else if (
          parsed.event === "turn.failed" ||
          parsed.event === "turn.cancelled" ||
          parsed.event.includes("approval") ||
          parsed.event.includes("user_input")
        ) {
          throw new Error(`local-llm agent session stopped at ${parsed.event}`);
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("local-llm agent session event stream ended before turn completion");
}

async function releaseSession(config: AgentSessionConfig, sessionId: string): Promise<void> {
  const signal = AbortSignal.timeout(2_000);
  await fetch(sessionChildUrl(config, sessionId, "release"), {
    method: "POST",
    headers: headers(config.apiKey, idempotencyKey("release")),
    signal,
  }).catch(() => undefined);
}

export function isAgentSessionApiPath(apiPath: string): boolean {
  try {
    return new URL(apiPath, "http://localhost").pathname.endsWith("/agents/sessions");
  } catch {
    return false;
  }
}

export async function checkAgentSessionModel(
  config: AgentSessionConfig,
  signal: AbortSignal,
): Promise<{ reachable: boolean; error?: string }> {
  try {
    const response = await fetch(agentModelsUrl(config), {
      method: "GET",
      headers: headers(config.apiKey),
      signal,
    });
    const payload = await requireJsonResponse<AgentModelsResponse>(response);
    const runtime = runtimeForModel(config.model);
    const modelFound = payload.data?.some(
      (model) =>
        model.id === config.model && (model.runtime === undefined || model.runtime === runtime),
    );
    if (!modelFound) return { reachable: false, error: `model not found: ${config.model}` };
    if (payload.runtime?.status !== undefined && payload.runtime.status !== "ready") {
      const detail =
        typeof payload.runtime.detail === "string" ? `: ${payload.runtime.detail}` : "";
      return { reachable: false, error: `agent runtime is not ready${detail}` };
    }
    return { reachable: true };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runAgentSessionChat(
  config: AgentSessionConfig,
  request: LlmChatRequest,
  signal: AbortSignal,
): Promise<LlmChatResponse> {
  const session = await requireJsonResponse<AgentSessionResponse>(
    await fetch(buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, config.apiPath), {
      method: "POST",
      headers: headers(config.apiKey, idempotencyKey("create")),
      body: JSON.stringify({
        runtime: runtimeForModel(config.model),
        model: config.model,
        approval_policy: "strict",
      }),
      signal,
    }),
  );
  if (typeof session.id !== "string" || !session.id.trim()) {
    throw new Error("local-llm agent session response did not include a session id");
  }

  try {
    await requireJsonResponse(
      await fetch(sessionChildUrl(config, session.id, "turns"), {
        method: "POST",
        headers: headers(config.apiKey, idempotencyKey("turn")),
        body: JSON.stringify({
          input: [{ type: "text", text: promptForAgentSession(request) }],
        }),
        signal,
      }),
    );
    const eventsUrl =
      typeof session.events_url === "string" && session.events_url.trim()
        ? buildLocalLlmChatCompletionsUrl(config.apiBaseUrl, session.events_url)
        : sessionChildUrl(config, session.id, "events");
    const content = await readAgentSessionEvents(
      await fetch(eventsUrl, {
        method: "GET",
        headers: headers(config.apiKey),
        signal,
      }),
    );
    return { content, finishReason: "stop" };
  } finally {
    await releaseSession(config, session.id);
  }
}
