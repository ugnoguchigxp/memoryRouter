import type { CoverEvidenceSourceContext } from "./helpers.js";
import { buildCoverEvidenceSearchQuery } from "./search-query.service.js";
import type { CoverEvidenceCandidate, CoverEvidenceReference } from "./types.js";

const MAX_VALUE_ASSESSMENT_SOURCE_CHARS = 1000;

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function compactReferences(references: CoverEvidenceReference[]): Array<{
  kind: CoverEvidenceReference["kind"];
  uri: string;
  locator?: string;
  title?: string;
  evidenceRole: CoverEvidenceReference["evidenceRole"];
}> {
  return references.map((reference) => ({
    kind: reference.kind,
    uri: reference.uri,
    ...(reference.locator ? { locator: reference.locator } : {}),
    ...(reference.title ? { title: reference.title } : {}),
    evidenceRole: reference.evidenceRole,
  }));
}

function compactSourceContext(context: CoverEvidenceSourceContext): {
  targetKind: CoverEvidenceSourceContext["targetKind"];
  sourceUri: string;
  readRanges: CoverEvidenceSourceContext["readRanges"];
  assessmentSource?: CoverEvidenceSourceContext["assessmentSource"];
  hasPrimaryEvidence?: boolean;
} {
  return {
    targetKind: context.targetKind,
    sourceUri: context.sourceUri,
    readRanges: context.readRanges,
    ...(context.assessmentSource ? { assessmentSource: context.assessmentSource } : {}),
    ...(context.hasPrimaryEvidence !== undefined
      ? { hasPrimaryEvidence: context.hasPrimaryEvidence }
      : {}),
  };
}

function compactSourceEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_ASSESSMENT_SOURCE_CHARS);
}

export function applicabilityBlankResponseReminderLines(
  stage: "web" | "final",
  statuses: string,
): string[] {
  return [
    "直前の応答は空でした。",
    "出力はこの形だけです。",
    "1行目: タイトル",
    "2行目から最終行の前まで: 本文",
    `最終行: TYPE / rule|procedure / STATUS / ${statuses} / STAGE / ${stage} / IMPORTANCE / 0-100 / CONFIDENCE / 0-100 / TECHNOLOGIES / ... / CHANGE_TYPES / ... / DOMAINS / ... / REASON / ...`,
    "本文では空白や / を自由に使ってください。/ 区切りとして読むのは最終行だけです。",
  ];
}

export function externalEvidenceSearchQueryUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
}): string {
  const querySource = [
    params.candidate.title,
    ...(params.candidate.technologies ?? []),
    ...(params.candidate.changeTypes ?? []),
    ...(params.candidate.domains ?? []),
  ].join(" ");
  const query = buildCoverEvidenceSearchQuery(querySource || params.candidate.title);
  return [
    `title: ${params.candidate.title}`,
    `body: ${params.candidate.body.slice(0, 500)}`,
    `検索語ヒント（必要なら選び直してよい・最大3個）: ${query.searchTerms.join(" | ")}`,
  ].join("\n\n");
}

export function externalEvidenceFetchSelectionUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  searchQuery: string;
  searchResults: string;
}): string {
  return [
    `title: ${params.candidate.title}`,
    `body: ${params.candidate.body.slice(0, 600)}`,
    `search query: ${params.searchQuery}`,
    "search results:",
    params.searchResults,
  ].join("\n\n");
}

export function externalEvidenceFinalUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContext: CoverEvidenceSourceContext;
  sourceEvidence: string;
  searchQuery: string;
  fetchedEvidence: string;
}): string {
  return [
    "候補:",
    JSON.stringify(params.candidate, null, 2),
    "source references:",
    JSON.stringify(params.sourceReferences, null, 2),
    "system/source metadata:",
    JSON.stringify(params.sourceContext, null, 2),
    "source evidence:",
    compactSourceEvidence(params.sourceEvidence),
    `search query: ${params.searchQuery}`,
    "UNTRUSTED WEB EVIDENCE:",
    params.fetchedEvidence,
  ].join("\n\n");
}

export function valueAssessmentUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
}): string {
  return [
    "候補の value と source support を判定してください。",
    "候補:",
    compactJson(params.candidate),
    "source references:",
    compactJson(compactReferences(params.sourceReferences)),
    "system/source metadata:",
    compactJson(compactSourceContext(params.sourceContext)),
    "source evidence excerpt:",
    compactSourceEvidence(params.sourceContentExcerpt),
  ].join("\n\n");
}

export function applicabilityRefinementUserPrompt(params: {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  sourceContext: CoverEvidenceSourceContext;
}): string {
  return [
    "以下の candidate について、3カテゴリを補完してください。",
    "candidate:",
    compactJson(params.candidate),
    "source references:",
    compactJson(compactReferences(params.sourceReferences)),
    "system/source metadata:",
    compactJson(compactSourceContext(params.sourceContext)),
    "source evidence summary/excerpt:",
    compactSourceEvidence(params.sourceContentExcerpt),
  ].join("\n\n");
}

export function mcpEvidenceUserPrompt(candidate: CoverEvidenceCandidate): string {
  return [
    "候補に関連する補助 MCP evidence を収集してください。",
    "候補:",
    JSON.stringify(candidate, null, 2),
  ].join("\n\n");
}
