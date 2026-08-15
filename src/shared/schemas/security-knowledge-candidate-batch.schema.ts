import { createHash } from "node:crypto";
import { z } from "zod";

export const SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION = 1 as const;
export const SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES = 256 * 1024;
export const SECURITY_KNOWLEDGE_CANDIDATE_ITEM_MAX_BYTES = 32 * 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const candidateRefSchema = z.string().regex(/^skc:v1:[a-f0-9]{64}$/);
const fingerprintSchema = z.string().regex(/^skcf:v1:[a-f0-9]{64}$/);
const batchRefSchema = z.string().regex(/^skcb:v1:[a-f0-9]{64}$/);
const receiptRefSchema = z.string().regex(/^skcr:v1:[a-f0-9]{64}$/);
const opaqueRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const reasonCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const absolutePathPattern =
  /(?:file:\/\/\/|\/(?:Users|app|etc|home|mnt|opt|private|root|srv|tmp|usr|var|Volumes|workspace)\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)/;
const secretLikePattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|refresh[_-]?token)\s*[:=]\s*[^\s,;}]+)/i;

export type SecurityIntelligenceCanonicalJson =
  | null
  | boolean
  | number
  | string
  | SecurityIntelligenceCanonicalJson[]
  | { [key: string]: SecurityIntelligenceCanonicalJson };

export function canonicalizeSecurityIntelligenceValue(
  value: unknown,
): SecurityIntelligenceCanonicalJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) {
      throw new Error("security_intelligence:canonical_unicode_must_be_nfc");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("security_intelligence:canonical_number_must_be_finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("security_intelligence:canonical_sparse_or_extended_array_not_supported");
    }
    return value.map((item) => canonicalizeSecurityIntelligenceValue(item));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("security_intelligence:canonical_plain_object_required");
    }
    const result = Object.create(null) as Record<string, SecurityIntelligenceCanonicalJson>;
    for (const key of Object.keys(value as object).sort()) {
      if (key.normalize("NFC") !== key) {
        throw new Error("security_intelligence:canonical_unicode_must_be_nfc");
      }
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new Error("security_intelligence:canonical_undefined_not_supported");
      }
      result[key] = canonicalizeSecurityIntelligenceValue(item);
    }
    return result;
  }
  throw new Error("security_intelligence:canonical_value_not_json");
}

export function canonicalStringifySecurityIntelligenceValue(value: unknown): string {
  return JSON.stringify(canonicalizeSecurityIntelligenceValue(value));
}

export function securityIntelligenceSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalStringifySecurityIntelligenceValue(value))
    .digest("hex")}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeBoundedTextSchema(maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => value.normalize("NFC") === value,
      "security_intelligence:non_canonical_unicode",
    )
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 0x1f || code === 0x7f;
        }),
      "security_intelligence:control_character_forbidden",
    )
    .refine(
      (value) => !absolutePathPattern.test(value),
      "security_intelligence:absolute_path_forbidden",
    )
    .refine(
      (value) => !secretLikePattern.test(value),
      "security_intelligence:secret_like_value_forbidden",
    )
    .refine(
      (value) => utf8Bytes(value) <= maxBytes,
      "security_intelligence:utf8_byte_limit_exceeded",
    );
}

function canonicalStringArray(maxItems: number, maxItemBytes: number) {
  return z
    .array(safeBoundedTextSchema(maxItemBytes))
    .max(maxItems)
    .superRefine((values, ctx) => {
      if (values.some((value, index) => index > 0 && (values[index - 1] ?? "") >= value)) {
        ctx.addIssue({
          code: "custom",
          message: "security_intelligence:array_must_be_unique_and_canonically_sorted",
        });
      }
    });
}

const applicabilitySchema = z
  .object({
    domains: canonicalStringArray(50, 256),
    technologies: canonicalStringArray(50, 256),
    changeTypes: canonicalStringArray(50, 256),
  })
  .strict();

const evidenceRefSchema = z
  .object({
    assessmentRef: opaqueRefSchema,
    evidenceRef: opaqueRefSchema,
    evidenceDigest: digestSchema,
    sourceProjectRef: z.string().regex(/^project:[A-Za-z0-9._:-]{1,247}$/),
    sourceRevision: safeBoundedTextSchema(512),
    targetDigest: digestSchema,
  })
  .strict();

export const securityKnowledgeCandidateItemSchema = z
  .object({
    candidateRef: candidateRefSchema,
    fingerprint: fingerprintSchema,
    payloadDigest: digestSchema,
    type: z.enum(["rule", "procedure"]),
    polarity: z.enum(["positive", "negative"]),
    title: safeBoundedTextSchema(512),
    body: safeBoundedTextSchema(16 * 1024),
    applicability: applicabilitySchema,
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(20),
    confidence: z.number().min(0).max(1),
    limitations: canonicalStringArray(100, 2 * 1024).refine(
      (values) => utf8Bytes(values.join("")) <= 8 * 1024,
      "security_intelligence:limitations_byte_limit_exceeded",
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fingerprint = securityIntelligenceSha256({
      contractVersion: SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION,
      type: value.type,
      polarity: value.polarity,
      title: value.title,
      body: value.body,
      applicability: value.applicability,
    }).slice("sha256:".length);
    if (value.fingerprint !== `skcf:v1:${fingerprint}`) {
      ctx.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "security_intelligence:candidate_fingerprint_mismatch",
      });
    }
    if (value.candidateRef !== `skc:v1:${fingerprint}`) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateRef"],
        message: "security_intelligence:candidate_ref_mismatch",
      });
    }
    const { payloadDigest: _payloadDigest, ...semantic } = value;
    if (value.payloadDigest !== securityIntelligenceSha256(semantic)) {
      ctx.addIssue({
        code: "custom",
        path: ["payloadDigest"],
        message: "security_intelligence:item_digest_mismatch",
      });
    }
    if (
      utf8Bytes(canonicalStringifySecurityIntelligenceValue(value)) >
      SECURITY_KNOWLEDGE_CANDIDATE_ITEM_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: "security_intelligence:item_byte_limit_exceeded",
      });
    }
  });

export const securityKnowledgeCandidateBatchSchema = z
  .object({
    contractVersion: z.literal(SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION),
    batchRef: batchRefSchema,
    idempotencyKey: z.string().min(1).max(256),
    batchPayloadDigest: digestSchema,
    producer: z
      .object({
        system: z.literal("nightworkers"),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
      })
      .strict(),
    correlation: z
      .object({
        taskRef: opaqueRefSchema,
        runRef: opaqueRefSchema,
      })
      .strict(),
    items: z.array(securityKnowledgeCandidateItemSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const {
      idempotencyKey: _idempotencyKey,
      batchRef: _batchRef,
      batchPayloadDigest: _batchPayloadDigest,
      ...semantic
    } = value;
    const digest = securityIntelligenceSha256(semantic);
    if (value.batchPayloadDigest !== digest) {
      ctx.addIssue({
        code: "custom",
        path: ["batchPayloadDigest"],
        message: "security_intelligence:batch_digest_mismatch",
      });
    }
    if (value.batchRef !== `skcb:v1:${digest.slice("sha256:".length)}`) {
      ctx.addIssue({
        code: "custom",
        path: ["batchRef"],
        message: "security_intelligence:batch_ref_mismatch",
      });
    }
    if (utf8Bytes(JSON.stringify(value)) > SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: "security_intelligence:batch_byte_limit_exceeded",
      });
    }
  });
export type SecurityKnowledgeCandidateBatch = z.infer<typeof securityKnowledgeCandidateBatchSchema>;

export const securityKnowledgeCandidateBatchReceiptSchema = z
  .object({
    contractVersion: z.literal(SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION),
    batchRef: batchRefSchema,
    receiptRef: receiptRefSchema,
    items: z
      .array(
        z
          .object({
            candidateRef: candidateRefSchema,
            status: z.enum(["accepted", "duplicate", "rejected"]),
            targetStateRef: opaqueRefSchema.optional(),
            reasonCode: reasonCodeSchema.optional(),
          })
          .strict()
          .superRefine((value, ctx) => {
            if ((value.status === "rejected") !== (value.reasonCode !== undefined)) {
              ctx.addIssue({
                code: "custom",
                message: "security_intelligence:item_receipt_reason_mismatch",
              });
            }
            if (value.status === "rejected" && value.targetStateRef !== undefined) {
              ctx.addIssue({
                code: "custom",
                path: ["targetStateRef"],
                message: "security_intelligence:rejected_item_target_forbidden",
              });
            }
          }),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const securityKnowledgeCandidateBatchResponseSchema = z
  .object({
    replayed: z.boolean(),
    receipt: securityKnowledgeCandidateBatchReceiptSchema,
  })
  .strict();
