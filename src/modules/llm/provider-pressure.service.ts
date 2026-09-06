import { eq } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/client.js";
import { syncStates } from "../../db/schema.js";
import { LlmProviderHttpError } from "./provider-http-error.js";

type ProviderPressureUsageKind = "interactive" | "background";

type ProviderPressureMetadata = {
  provider: string;
  model: string;
  cooldownUntil: string | null;
  reason: string | null;
  updatedAt: string | null;
  lastRateLimitedAt: string | null;
  lastInteractiveAt: string | null;
  lastBackgroundAt: string | null;
  consecutiveFailures: number;
  source: string | null;
};

type ProviderPressureState = {
  metadata: ProviderPressureMetadata;
  cooldownActive: boolean;
  waitMs: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function providerPressureStateId(provider: string, model: string): string {
  return `llm_provider_pressure:${provider}:${encodeURIComponent(model.toLowerCase())}`;
}

function parseCooldownWaitMs(cooldownUntil: string | null): number {
  if (!cooldownUntil) return 0;
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return 0;
  return Math.max(0, untilMs - Date.now());
}

function normalizeMetadata(
  provider: string,
  model: string,
  metadata: unknown,
): ProviderPressureMetadata {
  const record = asRecord(metadata);
  return {
    provider,
    model,
    cooldownUntil: asString(record.cooldownUntil),
    reason: asString(record.reason),
    updatedAt: asString(record.updatedAt),
    lastRateLimitedAt: asString(record.lastRateLimitedAt),
    lastInteractiveAt: asString(record.lastInteractiveAt),
    lastBackgroundAt: asString(record.lastBackgroundAt),
    consecutiveFailures: Math.max(0, Math.floor(asNumber(record.consecutiveFailures) ?? 0)),
    source: asString(record.source),
  };
}

async function loadMetadata(provider: string, model: string): Promise<ProviderPressureMetadata> {
  const id = providerPressureStateId(provider, model);
  try {
    const [row] = await db
      .select({ metadata: syncStates.metadata })
      .from(syncStates)
      .where(eq(syncStates.id, id))
      .limit(1);
    return normalizeMetadata(provider, model, row?.metadata);
  } catch {
    return normalizeMetadata(provider, model, {});
  }
}

async function saveMetadata(metadata: ProviderPressureMetadata): Promise<void> {
  const now = new Date();
  const id = providerPressureStateId(metadata.provider, metadata.model);
  const values = {
    lastSyncedAt: now,
    cursor: {},
    metadata: {
      cooldownUntil: metadata.cooldownUntil,
      reason: metadata.reason,
      updatedAt: metadata.updatedAt,
      lastRateLimitedAt: metadata.lastRateLimitedAt,
      lastInteractiveAt: metadata.lastInteractiveAt,
      lastBackgroundAt: metadata.lastBackgroundAt,
      consecutiveFailures: metadata.consecutiveFailures,
      source: metadata.source,
    },
    updatedAt: now,
  };
  await db
    .insert(syncStates)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: syncStates.id, set: values });
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof LlmProviderHttpError) {
    return error.status === 429;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes(" http 429") || normalized.includes("rate limit");
}

function retryAfterSecondsFromError(error: unknown): number | null {
  if (error instanceof LlmProviderHttpError && typeof error.retryAfterSeconds === "number") {
    return Math.max(0, error.retryAfterSeconds);
  }
  return null;
}

export async function readProviderPressureState(params: {
  provider: string;
  model: string;
}): Promise<ProviderPressureState> {
  const metadata = await loadMetadata(params.provider, params.model);
  const waitMs = parseCooldownWaitMs(metadata.cooldownUntil);
  return {
    metadata,
    cooldownActive: waitMs > 0,
    waitMs,
  };
}

export async function recordProviderUsage(params: {
  provider: string;
  model: string;
  source: string;
  kind: ProviderPressureUsageKind;
}): Promise<void> {
  const metadata = await loadMetadata(params.provider, params.model);
  const nowIso = new Date().toISOString();
  const next: ProviderPressureMetadata = {
    ...metadata,
    updatedAt: nowIso,
    source: params.source,
    ...(params.kind === "interactive"
      ? { lastInteractiveAt: nowIso }
      : { lastBackgroundAt: nowIso }),
  };
  await saveMetadata(next);
}

export async function recordProviderRateLimit(params: {
  provider: string;
  model: string;
  source: string;
  error: unknown;
}): Promise<void> {
  const metadata = await loadMetadata(params.provider, params.model);
  const now = new Date();
  const retryAfterSeconds =
    retryAfterSecondsFromError(params.error) ??
    groupedConfig.distillation.findCandidateRateLimitCooldownSeconds;
  const cooldownUntil = new Date(now.getTime() + retryAfterSeconds * 1000).toISOString();
  const next: ProviderPressureMetadata = {
    ...metadata,
    cooldownUntil,
    reason: "rate_limit",
    updatedAt: now.toISOString(),
    lastRateLimitedAt: now.toISOString(),
    consecutiveFailures: metadata.consecutiveFailures + 1,
    source: params.source,
  };
  await saveMetadata(next);
}
