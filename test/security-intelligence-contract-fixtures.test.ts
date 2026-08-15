import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SECURITY_INTELLIGENCE_IDENTITY_FIXTURE_SHA256,
  securityIntelligenceIdentityFixtureSchema,
} from "../src/shared/schemas/security-intelligence-identity-mapping.schema.js";
import {
  securityKnowledgeCandidateBatchResponseSchema,
  securityKnowledgeCandidateBatchSchema,
} from "../src/shared/schemas/security-knowledge-candidate-batch.schema.js";
import {
  securityKnowledgeFeedbackBatchResponseSchema,
  securityKnowledgeFeedbackBatchSchema,
} from "../src/shared/schemas/security-knowledge-feedback-batch.schema.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../shared/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("Security Intelligence cross-repository fixtures", () => {
  it("freezes identity mapping and revision roles", () => {
    const input = fixture("security-intelligence-identity-v1.json");
    const parsed = securityIntelligenceIdentityFixtureSchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    expect(`sha256:${digest}`).toBe(SECURITY_INTELLIGENCE_IDENTITY_FIXTURE_SHA256);
    expect(parsed.workingTree.scanStartSourceRevisionRole).toBe("base_revision");
    expect(parsed.workingTree.assessmentSourceRevisionRole).toBe("assessed_revision");
    expect(parsed.fullTarget.available).toBe(false);
    expect(parsed.unsupportedTransports).toEqual(["local_cli"]);
  });

  it("accepts the candidate batch and receipt golden fixture", () => {
    const rawInput = fixture("security-knowledge-candidate-batch-v1.json");
    const digest = createHash("sha256").update(JSON.stringify(rawInput)).digest("hex");
    expect(`sha256:${digest}`).toBe(
      "sha256:727d0eed101ee983e836e025578a9af66efe58a17ea70f6d86ff85d7f118c2e0",
    );
    const input = rawInput as {
      valid: { batch: unknown; response: unknown };
    };
    expect(securityKnowledgeCandidateBatchSchema.parse(input.valid.batch)).toBeDefined();
    expect(securityKnowledgeCandidateBatchResponseSchema.parse(input.valid.response)).toBeDefined();
  });

  it("rejects a successful candidate receipt without a durable target reference", () => {
    const input = fixture("security-knowledge-candidate-batch-v1.json") as {
      valid: { response: { receipt: { items: Array<Record<string, unknown>> } } };
    };
    const response = input.valid.response;
    const successfulItem = response.receipt.items[0];
    if (!successfulItem) throw new Error("fixture must contain a receipt item");
    const { targetStateRef: _targetStateRef, ...withoutTargetStateRef } = successfulItem;
    const invalidResponse = {
      ...response,
      receipt: {
        ...response.receipt,
        items: [withoutTargetStateRef, ...response.receipt.items.slice(1)],
      },
    };
    expect(securityKnowledgeCandidateBatchResponseSchema.safeParse(invalidResponse).success).toBe(
      false,
    );
  });

  it("rejects duplicate refs in candidate and feedback receipts", () => {
    const candidateFixture = fixture("security-knowledge-candidate-batch-v1.json") as {
      valid: { response: { receipt: { items: unknown[] } } };
    };
    const candidateResponse = structuredClone(candidateFixture.valid.response);
    candidateResponse.receipt.items.push(candidateResponse.receipt.items[0]);
    expect(securityKnowledgeCandidateBatchResponseSchema.safeParse(candidateResponse).success).toBe(
      false,
    );

    const feedbackBatch = securityKnowledgeFeedbackBatchSchema.parse(
      fixture("security-knowledge-feedback-batch-v1.json"),
    );
    const eventRef = feedbackBatch.events[0]?.eventRef;
    if (!eventRef) throw new Error("fixture must contain a feedback event");
    expect(
      securityKnowledgeFeedbackBatchResponseSchema.safeParse({
        replayed: false,
        receipt: {
          contractVersion: 1,
          batchRef: feedbackBatch.batchRef,
          receiptRef: `skfr:v1:${"a".repeat(64)}`,
          acceptedEventRefs: [eventRef],
          duplicateEventRefs: [eventRef],
          rejectedEvents: [],
        },
      }).success,
    ).toBe(false);
  });

  it("freezes the feedback event and batch digests", () => {
    const input = fixture("security-knowledge-feedback-batch-v1.json");
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    expect(`sha256:${digest}`).toBe(
      "sha256:f1f8ea61c3d77f65f7d281fdfac8ab80751634690925f327d076ef1dcfe9795e",
    );
    const parsed = securityKnowledgeFeedbackBatchSchema.parse(input);
    expect(parsed.events.map((event) => event.eventType)).toEqual([
      "retrieved",
      "verification_outcome",
    ]);
    expect(parsed.events[0]?.correlation.compileRunRef).toBe("compile:fixture");
  });

  it("rejects secret-like, evidence-less, and digest-mismatched candidates", () => {
    const input = fixture("security-knowledge-candidate-batch-v1.json") as {
      valid: { batch: Record<string, unknown> };
    };
    const secret = structuredClone(input.valid.batch) as {
      items: Array<{ body: string }>;
    };
    const secretItem = secret.items[0];
    if (!secretItem) throw new Error("fixture must contain a candidate item");
    secretItem.body = "api_key=not-a-real-secret";
    expect(securityKnowledgeCandidateBatchSchema.safeParse(secret).success).toBe(false);

    const evidenceLess = structuredClone(input.valid.batch) as {
      items: Array<{ evidenceRefs: unknown[] }>;
    };
    const evidenceLessItem = evidenceLess.items[0];
    if (!evidenceLessItem) throw new Error("fixture must contain a candidate item");
    evidenceLessItem.evidenceRefs = [];
    expect(securityKnowledgeCandidateBatchSchema.safeParse(evidenceLess).success).toBe(false);

    const wrongItemDigest = structuredClone(input.valid.batch) as {
      items: Array<{ payloadDigest: string }>;
    };
    const wrongDigestItem = wrongItemDigest.items[0];
    if (!wrongDigestItem) throw new Error("fixture must contain a candidate item");
    wrongDigestItem.payloadDigest = `sha256:${"f".repeat(64)}`;
    expect(securityKnowledgeCandidateBatchSchema.safeParse(wrongItemDigest).success).toBe(false);

    const wrongBatchDigest = structuredClone(input.valid.batch) as {
      batchPayloadDigest: string;
    };
    wrongBatchDigest.batchPayloadDigest = `sha256:${"f".repeat(64)}`;
    expect(securityKnowledgeCandidateBatchSchema.safeParse(wrongBatchDigest).success).toBe(false);
  });
});
