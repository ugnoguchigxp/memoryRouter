import { describe, expect, it } from "vitest";
import { evaluateLandscapeCurationPolicy } from "../src/modules/landscape/landscape-curation.service.js";
import type { LandscapeCurationInputSnapshotV1 } from "../src/shared/schemas/landscape-curation.schema.js";

function inputSnapshot(): LandscapeCurationInputSnapshotV1 {
  const now = "2026-08-27T00:00:00.000Z";
  const knowledge = {
    title: "Knowledge",
    body: "same body",
    bodyHash: "same-body-hash",
    appliesToHash: "same-applies-to-hash",
    status: "active",
    type: "rule",
    polarity: "positive",
    scope: "global",
    classificationStatus: "classified",
    projectRef: null,
    repoKey: null,
    repoPath: null,
    appliesTo: {},
    confidence: 90,
    importance: 80,
    updatedAt: now,
    createdAt: now,
    lastVerifiedAt: now,
    similarity: null,
    scopeOverlap: null,
  };
  return {
    schemaVersion: 1,
    capturedAt: now,
    finding: { type: "duplicate_candidate", reviewItemId: "review", evidenceHash: "evidence" },
    subject: { ...knowledge, id: "subject" },
    candidates: [{ ...knowledge, id: "canonical" }],
    evidence: [
      {
        id: "evidence-1",
        kind: "review_evidence",
        knowledgeId: "subject",
        value: "same guidance",
        observedAt: now,
        source: "test",
      },
    ],
    usage: {},
    lineage: {},
    reviewItem: null,
    capabilities: {},
    versions: { detector: "v1", policy: "v1", prompt: "v1" },
  };
}

describe("evaluateLandscapeCurationPolicy", () => {
  it("delegates duplicate deprecation to the safe merge-review queue without human approval", () => {
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "deprecate_duplicate",
        confidence: "high",
        canonicalKnowledgeId: "canonical",
        rationale: ["same operational guidance"],
        supportingEvidenceIds: ["evidence-1"],
        counterEvidence: [],
        blockers: [],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: inputSnapshot(),
      dailyRemaining: 1,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.releaseMode).toBe("auto_bounded");
    expect(policy.disposition).toBe("enqueue_downstream");
    expect(policy.effectiveAction).toBe("enqueue_merge_review");
  });

  it("ends evidence-insufficient findings without requesting a human decision", () => {
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "needs_evidence",
        confidence: "low",
        canonicalKnowledgeId: null,
        rationale: ["evidence is not sufficient"],
        supportingEvidenceIds: [],
        counterEvidence: [],
        blockers: ["missing usage evidence"],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: inputSnapshot(),
      dailyRemaining: 1,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.disposition).toBe("await_evidence");
    expect(policy.effectiveAction).toBe("none");
    expect(policy.reasonCodes).toEqual(["EVIDENCE_INCOMPLETE"]);
  });

  it("blocks an input-external canonical reference without asking a human", () => {
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "merge_review",
        confidence: "high",
        canonicalKnowledgeId: "not-in-input",
        rationale: ["looks similar"],
        supportingEvidenceIds: ["evidence-1"],
        counterEvidence: [],
        blockers: [],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: inputSnapshot(),
      dailyRemaining: 1,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.disposition).toBe("blocked");
    expect(policy.reasonCodes).toContain("CANDIDATE_REFERENCE_INVALID");
  });

  it("blocks low-confidence merge recommendations deterministically", () => {
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "merge_review",
        confidence: "medium",
        canonicalKnowledgeId: "canonical",
        rationale: ["looks similar"],
        supportingEvidenceIds: ["evidence-1"],
        counterEvidence: [],
        blockers: [],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: inputSnapshot(),
      dailyRemaining: 1,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.disposition).toBe("blocked");
    expect(policy.reasonCodes).toContain("LOW_CONFIDENCE");
  });

  it("does not autonomously mutate semantic-only duplicates in V1", () => {
    const snapshot = inputSnapshot();
    snapshot.candidates[0] = {
      ...snapshot.candidates[0],
      body: "similar but not identical body",
      bodyHash: "different-body-hash",
      similarity: 0.99,
      scopeOverlap: 0.99,
    };
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "merge_review",
        confidence: "high",
        canonicalKnowledgeId: "canonical",
        rationale: ["semantically equivalent"],
        supportingEvidenceIds: ["evidence-1"],
        counterEvidence: [],
        blockers: [],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: snapshot,
      dailyRemaining: 1,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.disposition).toBe("blocked");
    expect(policy.reasonCodes).toContain("AUTONOMOUS_EXACT_DUPLICATE_REQUIRED");
  });

  it("blocks automatic downstream work when the daily budget is exhausted", () => {
    const policy = evaluateLandscapeCurationPolicy({
      result: {
        schemaVersion: 1,
        decision: "merge_review",
        confidence: "high",
        canonicalKnowledgeId: "canonical",
        rationale: ["same guidance"],
        supportingEvidenceIds: ["evidence-1"],
        counterEvidence: [],
        blockers: [],
        proposedAppliesTo: null,
        proposedSummary: null,
      },
      inputSnapshot: inputSnapshot(),
      dailyRemaining: 0,
      repoRemaining: 1,
      evaluatedAt: "2026-08-27T00:00:00.000Z",
    });
    expect(policy.disposition).toBe("blocked");
    expect(policy.reasonCodes).toContain("DAILY_BUDGET_EXHAUSTED");
  });
});
