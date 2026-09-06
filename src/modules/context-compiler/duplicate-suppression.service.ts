type DuplicateSuppressionReason =
  | "same_normalized_title"
  | "title_body_overlap"
  | "shared_source_overlap";

type DuplicateSuppressionCandidate = {
  id: string;
  type: string;
  status?: string;
  title: string;
  content: string;
  sourceRefs?: string[];
  polarity?: string;
};

export type DuplicateSuppressionInfo = {
  representativeId: string;
  reason: DuplicateSuppressionReason;
  confidence: number;
};

export type DuplicateSuppressionGroup = {
  representativeId: string;
  memberIds: string[];
  reason: DuplicateSuppressionReason;
  confidence: number;
};

export type DuplicateSuppressionResult<T> = {
  items: T[];
  groups: DuplicateSuppressionGroup[];
  suppressedById: Map<string, DuplicateSuppressionInfo>;
};

type DuplicateMatch = {
  reason: DuplicateSuppressionReason;
  confidence: number;
};

const MIN_TOKEN_LENGTH = 3;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value: string): string {
  return normalizeText(value).replace(/[\s_-]+/g, "");
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

function toSet(tokens: string[]): Set<string> {
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function hasOppositePolarity(left: string, right: string): boolean {
  const requirePattern =
    /\b(use|must|should|prefer|required|enable|推奨|必須|使う|利用|有効)\b|(?:すること|してください)/i;
  const avoidPattern =
    /\b(avoid|never|forbid|forbidden|禁止|避ける|しない|不要|無効)\b|(?:してはいけない)/i;
  const leftRequire = requirePattern.test(left);
  const leftAvoid = avoidPattern.test(left);
  const rightRequire = requirePattern.test(right);
  const rightAvoid = avoidPattern.test(right);
  return (leftRequire && rightAvoid) || (leftAvoid && rightRequire);
}

function hasSharedSourceRef(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  for (const ref of left) {
    if (rightSet.has(ref)) return true;
  }
  return false;
}

function resolveDuplicateMatch(
  representative: DuplicateSuppressionCandidate,
  candidate: DuplicateSuppressionCandidate,
): DuplicateMatch | null {
  if (representative.id === candidate.id) return null;
  if (representative.type !== candidate.type) return null;
  // Keep phase-1 conservative: status mismatch can be supersedes-like, not duplicate.
  if ((representative.status ?? "active") !== (candidate.status ?? "active")) return null;
  // A negative guardrail and a positive rule may share most of their wording while
  // imposing opposite operational constraints. Preserve both unless their polarity
  // is explicitly the same.
  if (
    (representative.polarity === "negative" || candidate.polarity === "negative") &&
    representative.polarity !== candidate.polarity
  ) {
    return null;
  }

  const representativeTitle = normalizeTitle(representative.title);
  const candidateTitle = normalizeTitle(candidate.title);
  if (!representativeTitle || !candidateTitle) return null;

  const representativeSummary = `${representative.title}\n${representative.content.slice(0, 400)}`;
  const candidateSummary = `${candidate.title}\n${candidate.content.slice(0, 400)}`;
  if (hasOppositePolarity(representativeSummary, candidateSummary)) return null;

  const titleSimilarity = jaccardSimilarity(
    toSet(tokenize(representative.title)),
    toSet(tokenize(candidate.title)),
  );
  const bodySimilarity = jaccardSimilarity(
    toSet(tokenize(representativeSummary)),
    toSet(tokenize(candidateSummary)),
  );
  const sourceOverlap = hasSharedSourceRef(
    representative.sourceRefs ?? [],
    candidate.sourceRefs ?? [],
  );
  const sameNormalizedTitle = representativeTitle === candidateTitle;

  if (sameNormalizedTitle && (bodySimilarity >= 0.45 || sourceOverlap)) {
    return {
      reason: "same_normalized_title",
      confidence: Math.min(1, Math.max(0.6, bodySimilarity + (sourceOverlap ? 0.2 : 0.05))),
    };
  }
  if (titleSimilarity >= 0.9 && bodySimilarity >= 0.72) {
    return {
      reason: "title_body_overlap",
      confidence: Math.min(1, Math.max(0.55, (titleSimilarity + bodySimilarity) / 2)),
    };
  }
  if (sourceOverlap && bodySimilarity >= 0.82) {
    return {
      reason: "shared_source_overlap",
      confidence: Math.min(1, Math.max(0.5, bodySimilarity)),
    };
  }
  return null;
}

export function suppressNearDuplicateKnowledge<T extends DuplicateSuppressionCandidate>(
  items: T[],
): DuplicateSuppressionResult<T> {
  const representatives: T[] = [];
  const groupsByRepresentativeId = new Map<string, DuplicateSuppressionGroup>();
  const suppressedById = new Map<string, DuplicateSuppressionInfo>();

  for (const candidate of items) {
    let matchedRepresentative: T | null = null;
    let matched: DuplicateMatch | null = null;

    for (const representative of representatives) {
      const match = resolveDuplicateMatch(representative, candidate);
      if (!match) continue;
      matchedRepresentative = representative;
      matched = match;
      break;
    }

    if (!matchedRepresentative || !matched) {
      representatives.push(candidate);
      continue;
    }

    suppressedById.set(candidate.id, {
      representativeId: matchedRepresentative.id,
      reason: matched.reason,
      confidence: matched.confidence,
    });

    const existing = groupsByRepresentativeId.get(matchedRepresentative.id);
    if (!existing) {
      groupsByRepresentativeId.set(matchedRepresentative.id, {
        representativeId: matchedRepresentative.id,
        memberIds: [matchedRepresentative.id, candidate.id],
        reason: matched.reason,
        confidence: matched.confidence,
      });
      continue;
    }

    if (!existing.memberIds.includes(candidate.id)) {
      existing.memberIds.push(candidate.id);
    }
    if (matched.confidence > existing.confidence) {
      existing.confidence = matched.confidence;
      existing.reason = matched.reason;
    }
  }

  return {
    items: representatives,
    groups: [...groupsByRepresentativeId.values()],
    suppressedById,
  };
}
