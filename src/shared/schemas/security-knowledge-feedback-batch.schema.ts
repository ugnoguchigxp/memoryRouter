import { z } from "zod";
import {
  canonicalStringifySecurityIntelligenceValue,
  securityIntelligenceSafeBoundedTextSchema,
  securityIntelligenceSha256,
} from "./security-knowledge-candidate-batch.schema.js";

export const SECURITY_KNOWLEDGE_FEEDBACK_CONTRACT_VERSION = 1 as const;
export const SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES = 128 * 1024;

const opaqueRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const eventRefSchema = z.string().regex(/^skfe:v1:[a-f0-9]{64}$/);
const reasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const sortedRefsSchema = z
  .array(opaqueRefSchema)
  .max(100)
  .superRefine((values, ctx) => {
    if (values.some((value, index) => index > 0 && (values[index - 1] ?? "") >= value)) {
      ctx.addIssue({
        code: "custom",
        message: "security_intelligence:array_must_be_unique_and_canonically_sorted",
      });
    }
  });

const feedbackEventSemanticObjectSchema = z
  .object({
    eventType: z.enum([
      "retrieved",
      "selected",
      "actually_used",
      "verification_outcome",
      "user_override",
      "false_warning",
      "harm_signal",
    ]),
    occurredAt: z.string().datetime({ offset: true }),
    correlation: z
      .object({
        taskRef: opaqueRefSchema,
        runRef: opaqueRefSchema,
        compileRunRef: opaqueRefSchema.optional(),
        verificationRef: opaqueRefSchema.optional(),
      })
      .strict(),
    knowledgeRef: opaqueRefSchema,
    knowledgeRevision: z.number().int().nonnegative(),
    outcome: z.enum(["supported", "contradicted", "inconclusive", "not_applicable"]).optional(),
    evidenceRefs: sortedRefsSchema,
    reasonCode: reasonCodeSchema.optional(),
  })
  .strict();

function validateEvidenceRequirement(
  value: z.infer<typeof feedbackEventSemanticObjectSchema>,
  ctx: z.RefinementCtx,
) {
  if (
    ["retrieved", "selected", "actually_used"].includes(value.eventType) &&
    value.correlation.compileRunRef === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["correlation", "compileRunRef"],
      message: "security_intelligence:compile_run_ref_required",
    });
  }
  if (
    ["verification_outcome", "false_warning", "harm_signal"].includes(value.eventType) &&
    value.evidenceRefs.length === 0 &&
    value.correlation.verificationRef === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceRefs"],
      message: "security_intelligence:independent_evidence_required",
    });
  }
  if (value.eventType === "user_override" && value.evidenceRefs.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["evidenceRefs"],
      message: "security_intelligence:user_command_ref_required",
    });
  }
}

export const securityKnowledgeFeedbackEventSemanticSchema =
  feedbackEventSemanticObjectSchema.superRefine(validateEvidenceRequirement);

export const securityKnowledgeFeedbackEventSchema = feedbackEventSemanticObjectSchema
  .extend({ eventRef: eventRefSchema })
  .strict()
  .superRefine((value, ctx) => {
    validateEvidenceRequirement(value, ctx);
    const { eventRef: _eventRef, ...semantic } = value;
    const digest = securityIntelligenceSha256({
      contractVersion: SECURITY_KNOWLEDGE_FEEDBACK_CONTRACT_VERSION,
      ...semantic,
    });
    if (value.eventRef !== `skfe:v1:${digest.slice(7)}`) {
      ctx.addIssue({
        code: "custom",
        path: ["eventRef"],
        message: "security_intelligence:feedback_event_ref_mismatch",
      });
    }
  });

export type SecurityKnowledgeFeedbackEvent = z.infer<typeof securityKnowledgeFeedbackEventSchema>;

export function deriveSecurityKnowledgeFeedbackEvent(
  semantic: z.infer<typeof securityKnowledgeFeedbackEventSemanticSchema>,
): SecurityKnowledgeFeedbackEvent {
  const parsed = securityKnowledgeFeedbackEventSemanticSchema.parse(semantic);
  const digest = securityIntelligenceSha256({
    contractVersion: SECURITY_KNOWLEDGE_FEEDBACK_CONTRACT_VERSION,
    ...parsed,
  });
  return securityKnowledgeFeedbackEventSchema.parse({
    ...parsed,
    eventRef: `skfe:v1:${digest.slice(7)}`,
  });
}

export const securityKnowledgeFeedbackBatchSchema = z
  .object({
    contractVersion: z.literal(SECURITY_KNOWLEDGE_FEEDBACK_CONTRACT_VERSION),
    batchRef: z.string().regex(/^skfb:v1:[a-f0-9]{64}$/),
    idempotencyKey: securityIntelligenceSafeBoundedTextSchema(256),
    batchPayloadDigest: digestSchema,
    producer: z
      .object({
        system: z.literal("nightworkers"),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
      })
      .strict(),
    events: z.array(securityKnowledgeFeedbackEventSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.events.map((event) => event.eventRef)).size !== value.events.length) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "security_intelligence:duplicate_feedback_event_ref",
      });
    }
    const {
      idempotencyKey: _idempotencyKey,
      batchRef: _batchRef,
      batchPayloadDigest: _batchPayloadDigest,
      ...semantic
    } = value;
    const digest = securityIntelligenceSha256(semantic);
    if (value.batchPayloadDigest !== digest || value.batchRef !== `skfb:v1:${digest.slice(7)}`) {
      ctx.addIssue({
        code: "custom",
        path: ["batchPayloadDigest"],
        message: "security_intelligence:feedback_batch_digest_mismatch",
      });
    }
    if (
      new TextEncoder().encode(canonicalStringifySecurityIntelligenceValue(value)).byteLength >
      SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES
    ) {
      ctx.addIssue({ code: "custom", message: "security_intelligence:feedback_batch_too_large" });
    }
  });

export type SecurityKnowledgeFeedbackBatch = z.infer<typeof securityKnowledgeFeedbackBatchSchema>;

export function deriveSecurityKnowledgeFeedbackBatch(input: {
  idempotencyKey: string;
  producer: { system: "nightworkers"; version: string };
  events: SecurityKnowledgeFeedbackEvent[];
}): SecurityKnowledgeFeedbackBatch {
  const semantic = {
    contractVersion: SECURITY_KNOWLEDGE_FEEDBACK_CONTRACT_VERSION,
    producer: input.producer,
    events: input.events,
  };
  const digest = securityIntelligenceSha256(semantic);
  return securityKnowledgeFeedbackBatchSchema.parse({
    ...semantic,
    idempotencyKey: input.idempotencyKey,
    batchRef: `skfb:v1:${digest.slice(7)}`,
    batchPayloadDigest: digest,
  });
}

export const securityKnowledgeFeedbackBatchReceiptSchema = z
  .object({
    contractVersion: z.literal(1),
    batchRef: z.string().regex(/^skfb:v1:[a-f0-9]{64}$/),
    receiptRef: z.string().regex(/^skfr:v1:[a-f0-9]{64}$/),
    acceptedEventRefs: z.array(eventRefSchema).max(100),
    duplicateEventRefs: z.array(eventRefSchema).max(100),
    rejectedEvents: z
      .array(z.object({ eventRef: eventRefSchema, reasonCode: reasonCodeSchema }).strict())
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const eventRefs = [
      ...value.acceptedEventRefs,
      ...value.duplicateEventRefs,
      ...value.rejectedEvents.map((event) => event.eventRef),
    ];
    if (new Set(eventRefs).size !== eventRefs.length) {
      ctx.addIssue({
        code: "custom",
        message: "security_intelligence:duplicate_feedback_receipt_event_ref",
      });
    }
  });

export const securityKnowledgeFeedbackBatchResponseSchema = z
  .object({ replayed: z.boolean(), receipt: securityKnowledgeFeedbackBatchReceiptSchema })
  .strict();
