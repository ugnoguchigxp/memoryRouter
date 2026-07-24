import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  type DistillationChatClient,
  type DistillationProviderSetting,
  distillationToolEventsFromError,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationProviderName } from "../distillation/llm-resolver.js";
import {
  hasProcedureWorkflowSignal,
  hasSkillLikeProcedureBody,
} from "../distillation/procedure-quality.js";
import { renderPrompt, promptMessage } from "../system-context/system-context.service.js";
import type { CoverEvidenceCandidate, CoverEvidenceToolEvent } from "./types.js";

type ProcedureNotRepairableReason =
  | "insufficient_workflow_evidence"
  | "verification_not_supported"
  | "avoid_section_not_supported"
  | "repair_parse_failed";

export type ProcedureRepairInput = {
  id: string;
  title: string;
  body: string;
  sourceEvidence: string;
  provider: DistillationProviderSetting;
  model: string;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProcedureRepairResult =
  | {
      status: "repaired";
      candidate: CoverEvidenceCandidate & { type: "procedure" };
      reason: "procedure_repaired_from_source";
      toolEvents: CoverEvidenceToolEvent[];
    }
  | {
      status: "not_repairable";
      reason: ProcedureNotRepairableReason;
      toolEvents: CoverEvidenceToolEvent[];
    }
  | {
      status: "failed";
      reason: "repair_provider_failed" | "repair_tool_failed";
      toolEvents: CoverEvidenceToolEvent[];
    };

function countStepMarkers(value: string): number {
  return value.split("\n").filter((line) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line)).length;
}

function repairEvidenceGap(params: {
  title: string;
  body: string;
  sourceEvidence: string;
}): ProcedureNotRepairableReason | null {
  const combined = `${params.title}\n${params.body}\n${params.sourceEvidence}`;
  if (!hasProcedureWorkflowSignal(params.title, combined) || countStepMarkers(combined) < 2) {
    return "insufficient_workflow_evidence";
  }
  if (!/(\bverify\b|\btest\b|\bcheck\b|\bconfirm\b|\bsmoke\b|検証|確認|テスト)/i.test(combined)) {
    return "verification_not_supported";
  }
  if (
    !/(\bavoid\b|\bdo not\b|\bnever\b|\bskip\b|避ける|禁止|しない|してはいけない)/i.test(combined)
  ) {
    return "avoid_section_not_supported";
  }
  return null;
}

function toolEventsForRepair(events: unknown[]): CoverEvidenceToolEvent[] {
  return events
    .map((event) => {
      if (!event || typeof event !== "object") return null;
      const record = event as {
        name?: unknown;
        ok?: unknown;
        metadata?: unknown;
        error?: unknown;
      };
      if (typeof record.name !== "string" || typeof record.ok !== "boolean") return null;
      const metadata =
        record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : undefined;
      return {
        name: record.name,
        ok: record.ok,
        ...(metadata ? { metadata } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      };
    })
    .filter((event): event is CoverEvidenceToolEvent => Boolean(event));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseRepairOutput(raw: string): { title: string; body: string } | null {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const title = stringField(record, "title");
    const body = stringField(record, "body");
    if (title && body) return { title, body };
  }
  return null;
}

function repairUserPrompt(params: { title: string; body: string; sourceEvidence: string }): string {
  return [
    `Candidate title:\n${params.title}`,
    "",
    `Candidate body:\n${params.body}`,
    "",
    `Source evidence:\n${params.sourceEvidence.slice(0, 8000)}`,
  ].join("\n");
}

export async function repairProcedureCandidate(
  input: ProcedureRepairInput,
): Promise<ProcedureRepairResult> {
  const gap = repairEvidenceGap(input);
  if (gap) {
    return {
      status: "not_repairable",
      reason: gap,
      toolEvents: [],
    };
  }

  await recordAuditLogSafe({
    eventType: auditEventTypes.coverEvidenceProcedureRepairStarted,
    actor: "system",
    payload: { id: input.id },
  });

  try {
    const systemContext = renderPrompt("coverEvidence.procedureRepair", {});
    const completion = await runDistillationCompletion(
      {
        model: input.model,
        maxTokens: 2048,
        messages: [
          promptMessage(systemContext),
          { role: "user", content: repairUserPrompt(input) },
        ],
        systemContexts: [systemContext.manifest],
      },
      {
        providerSetting: input.provider,
        fallbackOrder: input.fallbackOrder,
        azureDeploymentSlots: input.azureDeploymentSlots,
        localLlmModel: input.localLlmModel,
        chatClient: input.chatClient,
        usageSource: "cover-evidence:procedure-repair",
        enableTools: false,
        timeoutMs: input.timeoutMs,
        blankResponseReminder: [
          "JSON だけを返してください。",
          "title と body の自然文は日本語で書いてください。固定見出しだけ Use when: / Workflow: / Verification: / Avoid: のまま残してください。",
          '{"title":"...","body":"Use when:\\n...\\n\\nWorkflow:\\n1. ...\\n2. ...\\n\\nVerification:\\n...\\n\\nAvoid:\\n..."}',
        ],
        auditContext: {
          domain: "coverEvidence",
          id: input.id,
          stage: "procedure_repair",
          assessment: "procedure-repair",
        },
        signal: input.signal,
      },
    );
    const toolEvents = toolEventsForRepair(completion.toolEvents);
    const repaired = parseRepairOutput(completion.content);
    if (!repaired || !hasSkillLikeProcedureBody(repaired.body)) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.coverEvidenceProcedureRepairCompleted,
        actor: "system",
        payload: { id: input.id, status: "not_repairable", reason: "repair_parse_failed" },
      });
      return {
        status: "not_repairable",
        reason: "repair_parse_failed",
        toolEvents,
      };
    }
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureRepairCompleted,
      actor: "system",
      payload: { id: input.id, status: "repaired" },
    });
    return {
      status: "repaired",
      candidate: {
        type: "procedure",
        title: repaired.title,
        body: repaired.body,
        importance: 80,
        confidence: 80,
      },
      reason: "procedure_repaired_from_source",
      toolEvents,
    };
  } catch (error) {
    const toolEvents = toolEventsForRepair(distillationToolEventsFromError(error));
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureRepairCompleted,
      actor: "system",
      payload: {
        id: input.id,
        status: "failed",
        reason: toolEvents.length > 0 ? "repair_tool_failed" : "repair_provider_failed",
      },
    });
    return {
      status: "failed",
      reason: toolEvents.length > 0 ? "repair_tool_failed" : "repair_provider_failed",
      toolEvents,
    };
  }
}
