import {
  evaluateVibeFindingEligibility,
  findingSelectorV2UncertainLimit,
  type VibeFindingSelectorVersion,
} from "./vibe-finding-eligibility.js";
import { isCodexFindingEscalationMetadata } from "./self-ingestion-guard.js";

export type { VibeFindingSelectorVersion } from "./vibe-finding-eligibility.js";

export type VibeFindingEnqueueMode = "dry-run" | "write";
export type VibeFindingEnqueueSource = "codex_logs" | "antigravity_logs" | "claude_logs" | "all";

export type VibeFindingEnqueueOptions = {
  mode: VibeFindingEnqueueMode;
  source: VibeFindingEnqueueSource;
  sinceDays: number;
  limit: number;
  minScore: number;
  selectorVersion: VibeFindingSelectorVersion;
  scanLimit?: number;
};

export type VibeFindingSourceRow = {
  id: string;
  sessionId: string;
  content: string;
  metadata: unknown;
  createdAt: string;
  agentDiffCount: number;
};

export type VibeFindingEnqueueReportItem = {
  vibeMemoryId: string;
  sessionId: string;
  sourceId: string | null;
  createdAt: string;
  action: "would_enqueue" | "enqueued" | "rejected" | "skipped_already_queued";
  score: number;
  signals: string[];
  rejectReasons: string[];
  reasonCodes: string[];
  selectorVersion: VibeFindingSelectorVersion;
  findingJobId?: string;
};

export type VibeFindingEnqueueReport = {
  mode: VibeFindingEnqueueMode;
  source: VibeFindingEnqueueSource;
  sinceDays: number;
  limit: number;
  minScore: number;
  selectorVersion: VibeFindingSelectorVersion;
  scanned: number;
  eligible: number;
  rejected: number;
  enqueued: number;
  skippedAlreadyQueued: number;
  items: VibeFindingEnqueueReportItem[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeVibeFindingEnqueueOptions(
  options: Partial<VibeFindingEnqueueOptions>,
): VibeFindingEnqueueOptions {
  return {
    mode: options.mode ?? "dry-run",
    source: options.source ?? "codex_logs",
    sinceDays: Math.max(0, Math.floor(options.sinceDays ?? 7)),
    limit: Math.max(1, Math.floor(options.limit ?? 10)),
    minScore: Math.max(0, Math.floor(options.minScore ?? 50)),
    selectorVersion: options.selectorVersion ?? "finding-selector-v2",
    scanLimit: Math.max(
      1,
      Math.floor(options.scanLimit ?? Math.max(100, (options.limit ?? 10) * 20)),
    ),
  };
}

export function parseVibeMemoryCreatedAt(value: string): number | null {
  if (value.startsWith("unix-ms:")) {
    const parsed = Number(value.slice("unix-ms:".length));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isVibeMemoryWithinSinceDays(createdAt: string, sinceDays: number): boolean {
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) return true;
  const createdMs = parseVibeMemoryCreatedAt(createdAt);
  if (createdMs === null) return true;
  return createdMs >= Date.now() - Math.floor(sinceDays) * 24 * 60 * 60 * 1000;
}

export function sourceIdFromVibeMetadata(metadata: unknown): string | null {
  return asString(asRecord(metadata).sourceId);
}

export function planVibeFindingEnqueueRows(
  rows: VibeFindingSourceRow[],
  options: Partial<VibeFindingEnqueueOptions>,
): VibeFindingEnqueueReport {
  const normalized = normalizeVibeFindingEnqueueOptions(options);
  const report: VibeFindingEnqueueReport = {
    mode: normalized.mode,
    source: normalized.source,
    sinceDays: normalized.sinceDays,
    limit: normalized.limit,
    minScore: normalized.minScore,
    selectorVersion: normalized.selectorVersion,
    scanned: rows.length,
    eligible: 0,
    rejected: 0,
    enqueued: 0,
    skippedAlreadyQueued: 0,
    items: [],
  };

  const maxReportedItems = normalized.limit * 2;

  let uncertainCount = 0;
  const uncertainLimit = Math.min(
    findingSelectorV2UncertainLimit.maximumPerRun,
    Math.ceil(normalized.limit * findingSelectorV2UncertainLimit.fraction),
  );
  for (const row of rows) {
    if (!isVibeMemoryWithinSinceDays(row.createdAt, normalized.sinceDays)) continue;

    const sourceId = sourceIdFromVibeMetadata(row.metadata);
    if (isCodexFindingEscalationMetadata(row.metadata)) {
      report.rejected += 1;
      if (report.items.length < maxReportedItems) {
        report.items.push({
          vibeMemoryId: row.id,
          sessionId: row.sessionId,
          sourceId,
          createdAt: row.createdAt,
          action: "rejected",
          score: 0,
          signals: [],
          rejectReasons: ["codex_finding_escalation_self_ingestion"],
          reasonCodes: ["codex_finding_escalation_self_ingestion"],
          selectorVersion: normalized.selectorVersion,
        });
      }
      continue;
    }

    const eligibility = evaluateVibeFindingEligibility({
      id: row.id,
      sessionId: row.sessionId,
      content: row.content,
      metadata: row.metadata,
      agentDiffCount: row.agentDiffCount,
      minScore: normalized.minScore,
      selectorVersion: normalized.selectorVersion,
    });

    const canUseUncertain =
      eligibility.verdict === "uncertain" && uncertainCount < uncertainLimit;
    if (!eligibility.eligible && !canUseUncertain) {
      report.rejected += 1;
      if (report.items.length < maxReportedItems) {
        report.items.push({
          vibeMemoryId: row.id,
          sessionId: row.sessionId,
          sourceId,
          createdAt: row.createdAt,
          action: "rejected",
          score: eligibility.score,
          signals: eligibility.signals,
          rejectReasons: eligibility.rejectReasons,
          reasonCodes: eligibility.reasonCodes,
          selectorVersion: eligibility.selectorVersion,
        });
      }
      continue;
    }

    if (report.eligible >= normalized.limit) continue;
    if (canUseUncertain) uncertainCount += 1;
    report.eligible += 1;
    report.items.push({
      vibeMemoryId: row.id,
      sessionId: row.sessionId,
      sourceId,
      createdAt: row.createdAt,
      action: normalized.mode === "write" ? "enqueued" : "would_enqueue",
      score: eligibility.score,
      signals: eligibility.signals,
      rejectReasons: eligibility.eligible ? [] : eligibility.rejectReasons,
      reasonCodes: eligibility.reasonCodes,
      selectorVersion: eligibility.selectorVersion,
    });
  }

  return report;
}
