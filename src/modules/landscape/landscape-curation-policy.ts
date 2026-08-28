import type {
  LandscapeCurationInputSnapshotV1,
  LandscapeCurationPolicyReasonCode,
  LandscapeCurationPolicyResultV1,
  LandscapeCurationResultV1,
} from "../../shared/schemas/landscape-curation.schema.js";

export type LandscapeCurationPolicyInput = {
  result: LandscapeCurationResultV1;
  inputSnapshot: LandscapeCurationInputSnapshotV1;
  staleInput?: boolean;
  dailyRemaining?: number;
  repoRemaining?: number;
  evaluatedAt?: string;
};

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function repositoryReasonCodes(
  subject: LandscapeCurationInputSnapshotV1["subject"],
  candidate: LandscapeCurationInputSnapshotV1["candidates"][number],
): LandscapeCurationPolicyReasonCode[] {
  if (subject.scope !== candidate.scope) return ["GLOBAL_REPO_MIX"];
  if (subject.scope === "global") return [];

  const fields = ["repoKey", "repoPath", "projectRef"] as const;
  let sharedIdentity = false;
  for (const field of fields) {
    const subjectValue = normalized(subject[field]);
    const candidateValue = normalized(candidate[field]);
    if (subjectValue && candidateValue && subjectValue !== candidateValue) {
      return ["CROSS_REPOSITORY_CANDIDATE"];
    }
    if (subjectValue && candidateValue && subjectValue === candidateValue) {
      sharedIdentity = true;
    }
  }
  return sharedIdentity ? [] : ["REPOSITORY_IDENTITY_MISMATCH"];
}

function mergeGateReasonCodes(
  input: LandscapeCurationPolicyInput,
): LandscapeCurationPolicyReasonCode[] {
  const { result, inputSnapshot } = input;
  const reasons: LandscapeCurationPolicyReasonCode[] = [];
  if (input.staleInput) reasons.push("STALE_INPUT");
  if ((input.dailyRemaining ?? 0) <= 0) reasons.push("DAILY_BUDGET_EXHAUSTED");
  if ((input.repoRemaining ?? 0) <= 0) reasons.push("REPO_BUDGET_EXHAUSTED");
  if (result.confidence !== "high") reasons.push("LOW_CONFIDENCE");
  if (result.blockers.length > 0) reasons.push("LLM_BLOCKER_PRESENT");
  if (result.supportingEvidenceIds.length === 0) reasons.push("EVIDENCE_INCOMPLETE");

  const canonical = inputSnapshot.candidates.find(
    (candidate) => candidate.id === result.canonicalKnowledgeId,
  );
  if (!canonical) {
    reasons.push("CANDIDATE_REFERENCE_INVALID");
    return [...new Set(reasons)];
  }
  if (inputSnapshot.subject.status !== "active" || canonical.status !== "active") {
    reasons.push("CANDIDATE_NOT_ACTIVE");
  }
  if (inputSnapshot.subject.type !== canonical.type) reasons.push("TYPE_MISMATCH");
  if (inputSnapshot.subject.polarity !== canonical.polarity) reasons.push("POLARITY_MISMATCH");
  reasons.push(...repositoryReasonCodes(inputSnapshot.subject, canonical));

  const exactDuplicate =
    inputSnapshot.subject.bodyHash === canonical.bodyHash &&
    inputSnapshot.subject.appliesToHash === canonical.appliesToHash;
  if (!exactDuplicate) {
    reasons.push("AUTONOMOUS_EXACT_DUPLICATE_REQUIRED");
    if (canonical.similarity === null || canonical.similarity === undefined) {
      reasons.push("EVIDENCE_INCOMPLETE");
    } else if (canonical.similarity < 0.92) {
      reasons.push("SIMILARITY_BELOW_THRESHOLD");
    }
    if (canonical.scopeOverlap === null || canonical.scopeOverlap === undefined) {
      reasons.push("EVIDENCE_INCOMPLETE");
    } else if (canonical.scopeOverlap < 0.8) {
      reasons.push("SCOPE_OVERLAP_BELOW_THRESHOLD");
    }
  }

  return [...new Set(reasons)];
}

export function evaluateLandscapeCurationPolicy(
  input: LandscapeCurationPolicyInput,
): LandscapeCurationPolicyResultV1 {
  const { result, inputSnapshot } = input;
  let disposition: LandscapeCurationPolicyResultV1["disposition"];
  let effectiveAction: LandscapeCurationPolicyResultV1["effectiveAction"];
  let reasonCodes: LandscapeCurationPolicyReasonCode[];

  if (inputSnapshot.finding.type === "contradiction_candidate") {
    disposition = "blocked";
    effectiveAction = "none";
    reasonCodes = ["CONTRADICTION_AUTOMATION_BLOCKED"];
  } else if (result.decision === "merge_review" || result.decision === "deprecate_duplicate") {
    const mergeGateReasons = mergeGateReasonCodes(input);
    disposition = mergeGateReasons.length === 0 ? "enqueue_downstream" : "blocked";
    effectiveAction = disposition === "enqueue_downstream" ? "enqueue_merge_review" : "none";
    reasonCodes =
      disposition === "enqueue_downstream" ? ["AUTONOMOUS_SAFE_DOWNSTREAM"] : mergeGateReasons;
  } else if (result.decision === "needs_evidence") {
    disposition = "await_evidence";
    effectiveAction = "none";
    reasonCodes = ["EVIDENCE_INCOMPLETE"];
  } else if (result.decision === "repair_scope" || result.decision === "escalate") {
    disposition = "blocked";
    effectiveAction = "none";
    reasonCodes = ["ACTION_NOT_IMPLEMENTED"];
  } else {
    disposition = "record_only";
    effectiveAction = "record";
    reasonCodes = ["AUTONOMOUS_TERMINAL_DECISION"];
  }

  return {
    schemaVersion: 1,
    policyVersion: "curation-policy-v1",
    releaseMode: disposition === "enqueue_downstream" ? "auto_bounded" : "auto_non_destructive",
    requestedDecision: result.decision,
    disposition,
    effectiveAction,
    reasonCodes,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    limits: {
      dailyRemaining: input.dailyRemaining ?? 0,
      repoRemaining: input.repoRemaining ?? 0,
    },
  };
}
