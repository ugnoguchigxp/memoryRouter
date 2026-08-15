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
    const input = fixture("security-knowledge-candidate-batch-v1.json") as {
      valid: { batch: unknown; response: unknown };
    };
    expect(securityKnowledgeCandidateBatchSchema.parse(input.valid.batch)).toBeDefined();
    expect(securityKnowledgeCandidateBatchResponseSchema.parse(input.valid.response)).toBeDefined();
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
