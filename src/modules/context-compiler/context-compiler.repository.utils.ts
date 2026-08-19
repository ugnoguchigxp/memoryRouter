import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import { compileRunSourceSchema } from "../../shared/schemas/compile-run.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";

const runStatusValues = new Set(["ok", "degraded", "failed"]);
export const maxEpochMillis = 8_640_000_000_000_000;
export const knowledgeVerdictValues = new Set(["used", "not_used", "off_topic", "wrong"]);
export const feedbackActorValues = new Set(["agent", "user", "system"]);

export function normalizeRunStatus(value: unknown): "ok" | "degraded" | "failed" {
  return typeof value === "string" && runStatusValues.has(value)
    ? (value as "ok" | "degraded" | "failed")
    : "failed";
}

export function normalizeCompileRunSource(value: unknown): CompileRunSource {
  if (value === "mcp-rust" || value === "rust-mcp-native") return "mcp";
  const parsed = compileRunSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

export function normalizeDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const unixMs = trimmed.match(/^unix-ms:(\d{1,16})$/);
    if (unixMs) {
      const parsedMillis = Number(unixMs[1]);
      if (
        Number.isSafeInteger(parsedMillis) &&
        parsedMillis >= 0 &&
        parsedMillis <= maxEpochMillis
      ) {
        return new Date(parsedMillis);
      }
    }
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
      ? `${trimmed.replace(" ", "T")}Z`
      : trimmed;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizeDuration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function normalizeKnowledgeVerdict(
  value: unknown,
): "used" | "not_used" | "off_topic" | "wrong" {
  return typeof value === "string" && knowledgeVerdictValues.has(value)
    ? (value as "used" | "not_used" | "off_topic" | "wrong")
    : "used";
}

export function normalizeFeedbackActor(value: unknown): "agent" | "user" | "system" {
  return typeof value === "string" && feedbackActorValues.has(value)
    ? (value as "agent" | "user" | "system")
    : "system";
}

export function extractOutputMarkdown(pack: ContextPack | null): string | null {
  if (!pack) return null;
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  const fromComposer =
    typeof responseComposer.outputMarkdown === "string"
      ? responseComposer.outputMarkdown.trim()
      : "";
  if (fromComposer) return fromComposer;
  return renderContextPackMarkdown(pack);
}

function normalizeOutputMarkdownKind(value: unknown): "narrative" | "no-content" | null {
  if (value === "narrative" || value === "no-content") return value;
  return null;
}

export function extractCompileRunSignals(packSnapshot: unknown): {
  selectedItemCount: number;
  outputMarkdownKind: "narrative" | "no-content" | null;
} {
  const pack = asRecord(packSnapshot);
  const rules = Array.isArray(pack.rules) ? pack.rules.length : 0;
  const procedures = Array.isArray(pack.procedures) ? pack.procedures.length : 0;
  const diagnostics = asRecord(pack.diagnostics);
  const retrievalStats = asRecord(diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  const storedKind = normalizeOutputMarkdownKind(responseComposer.markdownKind);
  if (storedKind) {
    return {
      selectedItemCount: rules + procedures,
      outputMarkdownKind: storedKind,
    };
  }

  const outputMarkdown =
    typeof responseComposer.outputMarkdown === "string"
      ? responseComposer.outputMarkdown.trim()
      : typeof pack.outputMarkdown === "string"
        ? pack.outputMarkdown.trim()
        : "";
  return {
    selectedItemCount: rules + procedures,
    outputMarkdownKind: outputMarkdown && outputMarkdown !== "No Content" ? "narrative" : null,
  };
}
