import { and, eq, gte } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  findingCandidateEscalations,
  type findingCandidateQueue,
  vibeMemories,
} from "../../db/schema.js";
import { runDistillationCompletion } from "../distillation/distillation-runtime.service.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
} from "../settings/settings.service.js";
import {
  englishPromptBinding,
  renderPrompt,
  promptMessage,
} from "../system-context/system-context.service.js";
import type { FindCandidateResult } from "./domain.js";
import { evaluateVibeFindingEligibility } from "./vibe-finding-eligibility.js";
import {
  type FilteredVibeMemoryReadResult,
  readFilteredVibeMemoryForCandidateWindow,
} from "./vibe-memory-filter.js";
import {
  CODEX_FINDING_ESCALATION_GENERATED_BY,
  isCodexFindingEscalationMetadata,
  parseMetadataRecord,
} from "./self-ingestion-guard.js";
import {
  type StorageCandidateParseDiagnostics,
  parseStorageCandidatesWithDiagnostics,
} from "./parser.js";
import type { CandidateRecord } from "./repository.js";

export type FindingCodexEscalationMode = "off" | "trace" | "write";

export type FindingCodexEscalationResult = {
  mode: FindingCodexEscalationMode;
  status: string;
  reason: string;
  escalationId?: string;
  candidates: CandidateRecord[];
  parseDiagnostics?: StorageCandidateParseDiagnostics;
  readRanges?: Array<{ from: number; toExclusive: number }>;
  outputSummary?: string;
};

export type FindingCodexEscalationDeps = {
  readMetadata?: typeof readVibeMemoryMetadata;
  readVibeMemory?: typeof readFilteredVibeMemoryForCandidateWindow;
  runCompletion?: typeof runDistillationCompletion;
  insertStart?: typeof insertFindingCandidateEscalationStart;
  updateStatus?: typeof updateFindingCandidateEscalationStatus;
  countToday?: typeof countFindingCodexEscalationsToday;
};

type FindingJobForEscalation = Pick<
  typeof findingCandidateQueue.$inferSelect,
  "id" | "sourceKind" | "sourceKey" | "sourceUri" | "distillationVersion" | "metadata"
>;

type VibeMemoryMetadataRow = {
  metadata: unknown;
  dedupeKey: string | null;
  agentDiffCount: number;
};

function getSqliteCoreDatabase() {
  return import("../../db/sqlite/runtime.js").then((module) =>
    module.getRuntimeSqliteCoreDatabase(),
  );
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function envString(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveFindingCodexEscalationMode(): FindingCodexEscalationMode {
  const value = envString("FINDING_CODEX_ESCALATION")?.toLowerCase();
  if (value === "write") return "write";
  if (value === "trace" || value === "1" || value === "true") return "trace";
  return "off";
}

function resolveMinScore(): number {
  const parsed = Number(envString("FINDING_CODEX_ESCALATION_MIN_SCORE"));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 70;
}

function resolveMaxPerDay(): number {
  const parsed = Number(envString("FINDING_CODEX_ESCALATION_MAX_PER_DAY"));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 20;
}

function resolveReadTokens(): number {
  const parsed = Number(envString("FINDING_CODEX_ESCALATION_READ_TOKENS"));
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 24_000;
}

async function resolveCodexEscalationModel(): Promise<string> {
  const configured = envString("FINDING_CODEX_ESCALATION_MODEL");
  if (configured) return configured;
  await ensureRuntimeSettingsLoaded();
  return getRuntimeSettingsSnapshot().providers.codex.model.trim() || "codex-sdk-agent";
}

function primaryNoCandidateReason(findResult: FindCandidateResult): string {
  const diagnostics = findResult.parseDiagnostics;
  if (diagnostics && diagnostics.rawCandidateLikeCount > 0) {
    return "primary_parser_rejected_candidate_like";
  }
  if (diagnostics?.rawWasEmptyArray) return "primary_empty_candidate_array";
  return "primary_no_candidate";
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildCodexEscalationUserMessage(params: {
  sourceKey: string;
  sourceUri: string;
  content: string;
  primaryReason: string;
  primaryDiagnostics?: StorageCandidateParseDiagnostics;
}) {
  return {
    role: "user" as const,
    content: JSON.stringify({
      sourceKind: "vibe_memory",
      sourceKey: params.sourceKey,
      sourceUri: params.sourceUri,
      primaryReason: params.primaryReason,
      primaryDiagnostics: params.primaryDiagnostics ?? null,
      transcript: params.content,
    }),
  };
}

async function readVibeMemoryMetadata(sourceKey: string): Promise<VibeMemoryMetadataRow | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query(
        `
        select
          vm.metadata,
          vm.dedupe_key as dedupeKey,
          (
            select count(*)
            from agent_diff_entries ade
            where ade.vibe_memory_id = vm.id
          ) as agentDiffCount
        from vibe_memories vm
        where vm.id = ?
        limit 1
      `,
      )
      .get(sourceKey) as VibeMemoryMetadataRow | null;
    return row;
  }

  const [row] = await db
    .select({
      metadata: vibeMemories.metadata,
      dedupeKey: vibeMemories.dedupeKey,
    })
    .from(vibeMemories)
    .where(eq(vibeMemories.id, sourceKey))
    .limit(1);
  if (!row) return null;
  return {
    metadata: row.metadata,
    dedupeKey: row.dedupeKey,
    agentDiffCount: 0,
  };
}

async function insertFindingCandidateEscalationStart(params: {
  sourceKind: string;
  sourceKey: string;
  distillationVersion: string;
  sourceDedupeKey?: string | null;
  primaryJobId: string;
  escalationProvider: string;
  escalationModel: string;
  status: string;
  reason: string;
}): Promise<{ id: string; inserted: boolean }> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sqlite.db
      .query(
        `
        insert or ignore into finding_candidate_escalations (
          id, source_kind, source_key, distillation_version, source_dedupe_key, primary_job_id,
          escalation_provider, escalation_model, status, reason,
          output_summary, candidate_count, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, ?)
      `,
      )
      .run(
        id,
        params.sourceKind,
        params.sourceKey,
        params.distillationVersion,
        params.sourceDedupeKey ?? null,
        params.primaryJobId,
        params.escalationProvider,
        params.escalationModel,
        params.status,
        params.reason,
        now,
        now,
      );
    const row = sqlite.db
      .query(
        `
        select id
        from finding_candidate_escalations
        where source_kind = ?
          and source_key = ?
          and distillation_version = ?
          and escalation_provider = ?
          and escalation_model = ?
        limit 1
      `,
      )
      .get(
        params.sourceKind,
        params.sourceKey,
        params.distillationVersion,
        params.escalationProvider,
        params.escalationModel,
      ) as { id: string } | null;
    if (!row) throw new Error("failed to create finding_candidate_escalations row");
    return { id: row.id, inserted: row.id === id };
  }

  const [inserted] = await db
    .insert(findingCandidateEscalations)
    .values({
      sourceKind: params.sourceKind,
      sourceKey: params.sourceKey,
      distillationVersion: params.distillationVersion,
      sourceDedupeKey: params.sourceDedupeKey ?? null,
      primaryJobId: params.primaryJobId,
      escalationProvider: params.escalationProvider,
      escalationModel: params.escalationModel,
      status: params.status,
      reason: params.reason,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        findingCandidateEscalations.sourceKind,
        findingCandidateEscalations.sourceKey,
        findingCandidateEscalations.distillationVersion,
        findingCandidateEscalations.escalationProvider,
        findingCandidateEscalations.escalationModel,
      ],
    })
    .returning({ id: findingCandidateEscalations.id });
  if (inserted?.id) return { id: inserted.id, inserted: true };
  const [existing] = await db
    .select({ id: findingCandidateEscalations.id })
    .from(findingCandidateEscalations)
    .where(
      and(
        eq(findingCandidateEscalations.sourceKind, params.sourceKind),
        eq(findingCandidateEscalations.sourceKey, params.sourceKey),
        eq(findingCandidateEscalations.distillationVersion, params.distillationVersion),
        eq(findingCandidateEscalations.escalationProvider, params.escalationProvider),
        eq(findingCandidateEscalations.escalationModel, params.escalationModel),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("failed to read existing finding_candidate_escalations row");
  return { id: existing.id, inserted: false };
}

async function updateFindingCandidateEscalationStatus(params: {
  id: string;
  status: string;
  reason?: string | null;
  outputSummary?: string | null;
  candidateCount?: number;
}): Promise<void> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        update finding_candidate_escalations
        set status = ?,
            reason = coalesce(?, reason),
            output_summary = coalesce(?, output_summary),
            candidate_count = coalesce(?, candidate_count),
            updated_at = ?
        where id = ?
      `,
      )
      .run(
        params.status,
        params.reason ?? null,
        params.outputSummary ?? null,
        params.candidateCount ?? null,
        new Date().toISOString(),
        params.id,
      );
    return;
  }

  await db
    .update(findingCandidateEscalations)
    .set({
      status: params.status,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.outputSummary !== undefined ? { outputSummary: params.outputSummary } : {}),
      ...(params.candidateCount !== undefined ? { candidateCount: params.candidateCount } : {}),
      updatedAt: new Date(),
    })
    .where(eq(findingCandidateEscalations.id, params.id));
}

async function countFindingCodexEscalationsToday(params: {
  escalationProvider: string;
  escalationModel: string;
}): Promise<number> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query(
        `
        select count(*) as count
        from finding_candidate_escalations
        where escalation_provider = ?
          and escalation_model = ?
          and created_at >= ?
      `,
      )
      .get(params.escalationProvider, params.escalationModel, dayStart.toISOString()) as {
      count: number;
    } | null;
    return Number(row?.count ?? 0);
  }

  const rows = await db
    .select({ id: findingCandidateEscalations.id })
    .from(findingCandidateEscalations)
    .where(
      and(
        eq(findingCandidateEscalations.escalationProvider, params.escalationProvider),
        eq(findingCandidateEscalations.escalationModel, params.escalationModel),
        gte(findingCandidateEscalations.createdAt, dayStart),
      ),
    );
  return rows.length;
}

export async function markFindingCodexEscalationAccepted(
  escalationId: string,
  candidateCount: number,
): Promise<void> {
  await updateFindingCandidateEscalationStatus({
    id: escalationId,
    status: "accepted",
    reason: "write_candidates_enqueued",
    candidateCount,
  });
}

export async function isVibeMemorySelfIngestionBlocked(sourceKey: string): Promise<boolean> {
  const row = await readVibeMemoryMetadata(sourceKey);
  return Boolean(row && isCodexFindingEscalationMetadata(row.metadata));
}

export async function maybeRunFindingCodexEscalation(
  params: {
    findingJob: FindingJobForEscalation;
    findResult: FindCandidateResult;
    signal?: AbortSignal;
  },
  deps: FindingCodexEscalationDeps = {},
): Promise<FindingCodexEscalationResult> {
  const mode = resolveFindingCodexEscalationMode();
  if (mode === "off") {
    return { mode, status: "skipped", reason: "disabled", candidates: [] };
  }
  if (params.findingJob.sourceKind !== "vibe_memory") {
    return { mode, status: "skipped", reason: "non_vibe_memory_source", candidates: [] };
  }
  if (params.findResult.candidates.length > 0) {
    return { mode, status: "skipped", reason: "primary_candidates_found", candidates: [] };
  }

  const escalationProvider = "codex";
  const escalationModel = await resolveCodexEscalationModel();
  const readMetadata = deps.readMetadata ?? readVibeMemoryMetadata;
  const memoryRow = await readMetadata(params.findingJob.sourceKey);
  const metadata = parseMetadataRecord(memoryRow?.metadata ?? params.findingJob.metadata);
  if (isCodexFindingEscalationMetadata(metadata)) {
    return { mode, status: "self_ingestion_blocked", reason: "self_ingestion", candidates: [] };
  }

  const primaryReason = primaryNoCandidateReason(params.findResult);
  const sourceDedupeKey =
    memoryRow?.dedupeKey ??
    (typeof metadata.dedupeKey === "string" && metadata.dedupeKey.trim()
      ? metadata.dedupeKey.trim()
      : null);
  const insertStart = deps.insertStart ?? insertFindingCandidateEscalationStart;
  const updateStatus = deps.updateStatus ?? updateFindingCandidateEscalationStatus;
  const start = await insertStart({
    sourceKind: params.findingJob.sourceKind,
    sourceKey: params.findingJob.sourceKey,
    distillationVersion: params.findingJob.distillationVersion,
    sourceDedupeKey,
    primaryJobId: params.findingJob.id,
    escalationProvider,
    escalationModel,
    status: "running",
    reason: primaryReason,
  });
  if (!start.inserted) {
    return {
      mode,
      status: "skipped",
      reason: "duplicate_escalation",
      escalationId: start.id,
      candidates: [],
    };
  }

  const maxPerDay = resolveMaxPerDay();
  const countToday = deps.countToday ?? countFindingCodexEscalationsToday;
  if (maxPerDay === 0 || (await countToday({ escalationProvider, escalationModel })) > maxPerDay) {
    await updateStatus({
      id: start.id,
      status: "daily_cap_exceeded",
      reason: "daily_cap_exceeded",
      candidateCount: 0,
    });
    return {
      mode,
      status: "daily_cap_exceeded",
      reason: "daily_cap_exceeded",
      escalationId: start.id,
      candidates: [],
    };
  }

  let read: FilteredVibeMemoryReadResult;
  try {
    read = await (deps.readVibeMemory ?? readFilteredVibeMemoryForCandidateWindow)({
      vibeMemoryId: params.findingJob.sourceKey,
      fromToken: 0,
      readTokens: resolveReadTokens(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await updateStatus({
      id: start.id,
      status: "source_missing",
      reason,
      candidateCount: 0,
    });
    return { mode, status: "source_missing", reason, escalationId: start.id, candidates: [] };
  }

  const eligibility = evaluateVibeFindingEligibility({
    id: params.findingJob.sourceKey,
    sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : params.findingJob.id,
    content: read.content,
    metadata,
    agentDiffCount: memoryRow?.agentDiffCount,
    minScore: resolveMinScore(),
  });
  if (!eligibility.eligible) {
    await updateStatus({
      id: start.id,
      status: "not_eligible",
      reason: eligibility.rejectReasons.join(",").slice(0, 500),
      candidateCount: 0,
    });
    return {
      mode,
      status: "not_eligible",
      reason: eligibility.rejectReasons.join(","),
      escalationId: start.id,
      candidates: [],
    };
  }

  try {
    const systemContext = renderPrompt("findCandidate.codexEscalation", {}, englishPromptBinding);
    const completion = await (deps.runCompletion ?? runDistillationCompletion)(
      {
        model: escalationModel,
        messages: [
          promptMessage(systemContext),
          buildCodexEscalationUserMessage({
            sourceKey: params.findingJob.sourceKey,
            sourceUri: params.findingJob.sourceUri,
            content: read.content,
            primaryReason,
            primaryDiagnostics: params.findResult.parseDiagnostics,
          }),
        ],
        maxTokens: Math.max(4096, groupedConfig.vibeDistillation.maxOutputTokens),
        systemContexts: [systemContext.manifest],
      },
      {
        providerSetting: "codex",
        fallbackOrder: [],
        enableTools: false,
        maxToolRounds: 0,
        usageSource: "finding-codex-escalation",
        timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
        signal: params.signal,
      },
    );
    const parsed = parseStorageCandidatesWithDiagnostics(completion.content);
    const outputSummary = truncate(completion.content.trim(), 1200);
    const status =
      parsed.candidates.length > 0
        ? mode === "write"
          ? "candidate_ready"
          : "trace_candidate"
        : parsed.diagnostics.rawCandidateLikeCount > 0
          ? "parser_rejected"
          : "no_candidate";
    await updateStatus({
      id: start.id,
      status,
      reason: primaryReason,
      outputSummary,
      candidateCount: parsed.candidates.length,
    });
    return {
      mode,
      status,
      reason: primaryReason,
      escalationId: start.id,
      candidates: parsed.candidates,
      parseDiagnostics: parsed.diagnostics,
      readRanges: [{ from: read.from, toExclusive: read.toExclusive }],
      outputSummary,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await updateStatus({
      id: start.id,
      status: "provider_failed",
      reason: reason.slice(0, 500),
      candidateCount: 0,
    });
    return {
      mode,
      status: "provider_failed",
      reason,
      escalationId: start.id,
      candidates: [],
    };
  }
}

export const codexFindingEscalationGeneratedBy = CODEX_FINDING_ESCALATION_GENERATED_BY;
