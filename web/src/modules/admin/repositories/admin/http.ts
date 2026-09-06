export const ADMIN_API_KEY_STORAGE_KEY = "context_still_admin_api_key";

export const LEGACY_ADMIN_API_KEY_STORAGE_KEY = "memory_router_admin_api_key";

export const ADMIN_API_KEY_QUERY_PARAM_KEYS = ["admin_api_key", "adminApiKey", "x-admin-api-key"];

export const ADMIN_SESSION_INVALID_EVENT = "context-still:admin-session-invalid";

export let adminSessionBootstrap: Promise<void> | null = null;

export function normalizeAdminApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function clearLegacyAdminCredentials(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ADMIN_API_KEY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_ADMIN_API_KEY_STORAGE_KEY);
  } catch {
    // Continue with URL cleanup even when browser storage is unavailable.
  }
  try {
    const currentUrl = new URL(window.location.href);
    let mutated = false;
    for (const key of ADMIN_API_KEY_QUERY_PARAM_KEYS) {
      if (!currentUrl.searchParams.has(key)) continue;
      currentUrl.searchParams.delete(key);
      mutated = true;
    }
    if (!mutated) return;
    const nextSearch = currentUrl.searchParams.toString();
    const nextRelativeUrl = `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ""}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, "", nextRelativeUrl);
  } catch {
    // Legacy credentials are never read even when URL cleanup is unavailable.
  }
}

export function takeAdminApiKeyFromGlobal(): string | null {
  const runtime = globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: unknown };
  const globalKey = normalizeAdminApiKey(runtime.__MEMORY_ROUTER_ADMIN_API_KEY__);
  runtime.__MEMORY_ROUTER_ADMIN_API_KEY__ = undefined;
  return globalKey;
}

export async function exchangeAdminApiKeyForSession(apiKey: string): Promise<void> {
  const response = await fetch("/api/admin-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) {
    throw new AdminApiError(`Admin session bootstrap failed: ${response.status}`, response.status);
  }
}

function startSessionExchange(apiKey: string): Promise<void> {
  const pending = exchangeAdminApiKeyForSession(apiKey).finally(() => {
    // A failed attempt must not poison session status, logout or a later sign-in.
    if (adminSessionBootstrap === pending) adminSessionBootstrap = null;
  });
  return pending;
}

export async function ensureAdminSession(): Promise<void> {
  clearLegacyAdminCredentials();
  const bootstrapKey = takeAdminApiKeyFromGlobal();
  if (bootstrapKey) {
    adminSessionBootstrap = startSessionExchange(bootstrapKey);
  }
  if (adminSessionBootstrap) {
    await adminSessionBootstrap;
  }
}

export type AdminSessionStatus = {
  configured: boolean;
  authenticated: boolean;
  configurationError: "admin_api_key_not_configured" | "admin_api_key_too_short" | null;
};

export async function createAdminSession(apiKey: string): Promise<void> {
  const normalized = normalizeAdminApiKey(apiKey);
  if (!normalized) throw new Error("Admin API key is required.");
  adminSessionBootstrap = startSessionExchange(normalized);
  await adminSessionBootstrap;
}

export function buildRequestHeaders(options?: {
  includeJsonContentType?: boolean;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (options?.includeJsonContentType) {
    headers["content-type"] = "application/json";
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export class AdminApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly payload: unknown = null,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export function parseErrorRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseStringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

export function parseResponseErrorPayload(payload: unknown): {
  message: string | null;
  code: string | null;
} {
  const record = parseErrorRecord(payload);
  if (!record) {
    return { message: null, code: null };
  }
  const nestedError = parseErrorRecord(record.error);
  const code = parseStringField(record, "code") ?? parseStringField(nestedError, "code");
  const message =
    typeof record.error === "string"
      ? record.error
      : (parseStringField(record, "message") ??
        parseStringField(record, "reason") ??
        parseStringField(nestedError, "message") ??
        parseStringField(nestedError, "reason"));
  return { message, code };
}

export function notifyInvalidAdminSession(url: string, status: number): void {
  if (status !== 401 || url === "/api/admin-session" || typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(ADMIN_SESSION_INVALID_EVENT));
}

export async function getJson<T>(url: string): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders();
  const response = headers ? await fetch(url, { headers }) : await fetch(url);
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const payload =
      typeof response.json === "function" ? await response.json().catch(() => null) : null;
    const parsed = parseResponseErrorPayload(payload);
    throw new AdminApiError(
      parsed.message ?? `${url} failed: ${response.status}`,
      response.status,
      parsed.code,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

export function parseRequestErrorMessage(
  method: string,
  url: string,
  status: number,
  payload: unknown,
): string {
  if (typeof payload === "object" && payload !== null && "outcome" in payload) {
    // Conflict consumers use the structured outcome encoded in this legacy message.
    return JSON.stringify(payload);
  }
  const record = parseErrorRecord(payload);
  return (
    parseStringField(record, "reason") ??
    parseStringField(record, "message") ??
    parseResponseErrorPayload(payload).message ??
    `${method} ${url} failed: ${status}`
  );
}

export async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders({ includeJsonContentType: body !== undefined });
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const payload = await response.json().catch(() => null);
    throw new AdminApiError(
      parseRequestErrorMessage(method, url, response.status, payload),
      response.status,
      parseResponseErrorPayload(payload).code,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

export async function requestForm<T>(url: string, method: string, body: FormData): Promise<T> {
  await ensureAdminSession();
  const headers = buildRequestHeaders();
  const response = headers
    ? await fetch(url, {
        method,
        headers,
        body,
      })
    : await fetch(url, {
        method,
        body,
      });
  if (!response.ok) {
    notifyInvalidAdminSession(url, response.status);
    const payload = await response.json().catch(() => null);
    throw new AdminApiError(
      parseRequestErrorMessage(method, url, response.status, payload),
      response.status,
      parseResponseErrorPayload(payload).code,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

export async function fetchAdminSessionStatus(): Promise<AdminSessionStatus> {
  return getJson<AdminSessionStatus>("/api/admin-session");
}

export async function deleteAdminSession(): Promise<void> {
  await requestJson<{ ok: true }>("/api/admin-session", "DELETE");
  adminSessionBootstrap = null;
}
