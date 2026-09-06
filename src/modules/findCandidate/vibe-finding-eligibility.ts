import { readFileSync } from "node:fs";

export type VibeFindingSelectorVersion = "legacy-v1" | "finding-selector-v2";
export type VibeFindingEligibilityVerdict = "eligible" | "uncertain" | "ineligible";

export type VibeFindingEligibilityInput = {
  id: string;
  sessionId: string;
  content: string;
  metadata?: unknown;
  agentDiffCount?: number;
  minScore?: number;
  minContentChars?: number;
  selectorVersion?: VibeFindingSelectorVersion;
};

export type VibeFindingEligibilityResult = {
  eligible: boolean;
  score: number;
  signals: string[];
  rejectReasons: string[];
  verdict: VibeFindingEligibilityVerdict;
  reasonCodes: string[];
  features: string[];
  selectorVersion: VibeFindingSelectorVersion;
};

const defaultMinScore = 50;
const defaultMinContentChars = 120;

const verificationTerms =
  /検証|確認|通りました|失敗|原因|修正|完了|問題|エラー|レビュー|復旧|再発|test|build|lint|verify|failed|failure|error|timeout|panic|assertion|review|fixed|root cause/iu;
const runtimeTerms =
  /queue|db|database|sqlite|daemon|provider|runtime|worker|launchagent|process|heartbeat|requeue|retry|finding|candidate|distillation/iu;
const commandTerms =
  /bunx?|npm|pnpm|cargo|sqlite3|git|rg|curl|lsof|ps aux|test|build|lint|verify/iu;
const preferenceTerms =
  /必ず|禁止|避け|しない|してください|方針|境界|優先|好み|prefer|avoid|must|never|do not|should/iu;
const boilerplateTerms =
  /AGENTS\.md instructions|<INSTRUCTIONS>|<\/INSTRUCTIONS>|<environment_context>|<\/environment_context>|<filesystem>|<\/filesystem>|initial_instructions|project-doc|workspace_roots/iu;
const progressOnlyTerms =
  /^(?:ASSISTANT:\s*)?(?:確認します|調べます|読みます|実行します|進めます|次に|最後に|了解しました)[。.!！\s]*$/u;
const durablePreferenceTerms =
  /今後|以後|毎回|常に|必ず|禁止|always|never|must|do not/iu;
const operationTerms =
  /実行|確認|検証|修正|復旧|再開|停止|保存|enqueue|requeue|retry|run|test|build|lint|verify|cargo|bunx?|npm|pnpm|sqlite3/iu;
const causeTerms = /原因|理由|root cause|because|due to/iu;
const fixTerms = /修正|直し|改善|変更|fix(?:ed)?|resolve(?:d)?|recover(?:ed)?/iu;
const successOnlyTerms = /^(?:.*?\b)?(?:build|test|lint)\s+succeeded[。.!！\s]*$/iu;

type SelectorContract = {
  version: "finding-selector-v2";
  uncertainLimit: { fraction: number; maximumPerRun: number };
};

const selectorContract = JSON.parse(
  readFileSync(new URL("../../../shared/finding/selector-v2.json", import.meta.url), "utf8"),
) as SelectorContract;

export const findingSelectorV2UncertainLimit = selectorContract.uncertainLimit;

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

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function rolesFromInput(input: VibeFindingEligibilityInput): Set<string> {
  const metadata = asRecord(input.metadata);
  const roles = new Set<string>();
  const rawRoles = metadata.roles;
  if (Array.isArray(rawRoles)) {
    for (const role of rawRoles) {
      if (typeof role === "string" && role.trim()) roles.add(role.trim().toLowerCase());
    }
  }
  if (/\bUSER:/u.test(input.content)) roles.add("user");
  if (/\bASSISTANT:/u.test(input.content)) roles.add("assistant");
  return roles;
}

function boilerplateRatio(content: string): number {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 1;
  const boilerplateLines = lines.filter((line) => boilerplateTerms.test(line)).length;
  return boilerplateLines / lines.length;
}

function isProgressOnly(content: string): boolean {
  const blocks = content
    .split(/\n{2,}/u)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (blocks.length === 0) return true;
  return blocks.every((block) => progressOnlyTerms.test(block));
}

export function evaluateVibeFindingEligibility(
  input: VibeFindingEligibilityInput,
): VibeFindingEligibilityResult {
  if ((input.selectorVersion ?? "finding-selector-v2") === "legacy-v1") {
    return evaluateLegacyVibeFindingEligibility(input);
  }

  return evaluateFindingSelectorV2(input);
}

function evaluateLegacyVibeFindingEligibility(
  input: VibeFindingEligibilityInput,
): VibeFindingEligibilityResult {
  const minScore = Math.max(0, Math.floor(input.minScore ?? defaultMinScore));
  const minContentChars = Math.max(0, Math.floor(input.minContentChars ?? defaultMinContentChars));
  const content = input.content.trim();
  const metadata = asRecord(input.metadata);
  const signals: string[] = [];
  const rejectReasons: string[] = [];
  let score = 0;

  if (content.length < minContentChars) {
    score -= 30;
    rejectReasons.push("content_too_short");
  }

  if (verificationTerms.test(content)) {
    score += 40;
    signals.push("verification_or_failure_terms");
  }

  const agentDiffCount = numberOrZero(input.agentDiffCount ?? metadata.agentDiffCount);
  if (agentDiffCount > 0) {
    score += 30;
    signals.push("has_agent_diff");
  }

  const roles = rolesFromInput(input);
  if (roles.has("user") && roles.has("assistant")) {
    score += 20;
    signals.push("mixed_roles");
  }

  if (runtimeTerms.test(content)) {
    score += 15;
    signals.push("runtime_or_queue_terms");
  }

  if (commandTerms.test(content)) {
    score += 10;
    signals.push("command_terms");
  }

  if (preferenceTerms.test(content)) {
    score += 20;
    signals.push("preference_terms");
  }

  const ratio = boilerplateRatio(content);
  if (ratio >= 0.6) {
    score -= 40;
    rejectReasons.push("boilerplate_heavy");
  }

  if (isProgressOnly(content)) {
    score -= 40;
    rejectReasons.push("progress_only");
  }

  if (signals.length === 0) {
    rejectReasons.push("no_reusable_signal");
  }

  if (score < minScore) {
    rejectReasons.push("below_min_score");
  }

  return {
    eligible: rejectReasons.length === 0,
    score,
    signals,
    rejectReasons: Array.from(new Set(rejectReasons)),
    verdict: rejectReasons.length === 0 ? "eligible" : "ineligible",
    reasonCodes: Array.from(new Set(rejectReasons)),
    features: signals,
    selectorVersion: "legacy-v1",
  };
}

function evaluateFindingSelectorV2(
  input: VibeFindingEligibilityInput,
): VibeFindingEligibilityResult {
  const content = input.content.trim();
  const metadata = asRecord(input.metadata);
  const roles = rolesFromInput(input);
  const features: string[] = [];
  const reasonCodes: string[] = [];
  const agentDiffCount = numberOrZero(input.agentDiffCount ?? metadata.agentDiffCount);

  if (!content) reasonCodes.push("empty_content");
  if (boilerplateRatio(content) >= 0.6) reasonCodes.push("boilerplate_heavy");
  if (isProgressOnly(content)) reasonCodes.push("progress_only");
  if (successOnlyTerms.test(content.replace(/^ASSISTANT:\s*/u, ""))) {
    reasonCodes.push("build_succeeded_only");
  }
  if (reasonCodes.length > 0) {
    return {
      eligible: false,
      score: 0,
      signals: [],
      rejectReasons: reasonCodes,
      verdict: "ineligible",
      reasonCodes,
      features,
      selectorVersion: selectorContract.version,
    };
  }

  const hasVerification = verificationTerms.test(content);
  const hasPersistentPreference =
    roles.has("user") && durablePreferenceTerms.test(content) && operationTerms.test(content);
  const hasCausalResolution =
    causeTerms.test(content) && fixTerms.test(content) && hasVerification;
  const hasSubstantiveDiff = agentDiffCount > 0;
  const hasRepeatableOperation = operationTerms.test(content) && hasVerification;

  if (hasPersistentPreference) features.push("persistent_preference");
  if (hasCausalResolution) features.push("causal_resolution_verified");
  if (hasSubstantiveDiff) features.push("substantive_agent_diff");
  if (hasRepeatableOperation) features.push("repeatable_operation_verified");

  const eligible = features.length > 0;
  const weakSignal =
    !eligible &&
    content.length > 0 &&
    (hasVerification || operationTerms.test(content) || roles.size > 0);
  if (!eligible) reasonCodes.push(weakSignal ? "uncertain_weak_signal" : "no_reusable_signal");

  return {
    eligible,
    score: features.length * 25,
    signals: features,
    rejectReasons: eligible ? [] : reasonCodes,
    verdict: eligible ? "eligible" : weakSignal ? "uncertain" : "ineligible",
    reasonCodes: eligible ? features.map((feature) => `eligible_${feature}`) : reasonCodes,
    features,
    selectorVersion: selectorContract.version,
  };
}
