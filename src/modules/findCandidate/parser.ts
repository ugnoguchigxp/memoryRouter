import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import type {
  CandidateKnowledgePolarity,
  CandidateKnowledgeType,
  CandidateRecord,
} from "./repository.js";

export type StorageCandidateParseDiagnostics = {
  rawWasEmptyArray: boolean;
  rawCandidateLikeCount: number;
  droppedMissingType: number;
  droppedMissingPolarity: number;
  droppedNeutral: number;
  droppedNegativeProcedure: number;
  droppedInvalidProcedureShape: number;
  plainTextFallbackUsed: boolean;
};

export type StorageCandidateParseResult = {
  candidates: CandidateRecord[];
  diagnostics: StorageCandidateParseDiagnostics;
};

function emptyDiagnostics(): StorageCandidateParseDiagnostics {
  return {
    rawWasEmptyArray: false,
    rawCandidateLikeCount: 0,
    droppedMissingType: 0,
    droppedMissingPolarity: 0,
    droppedNeutral: 0,
    droppedNegativeProcedure: 0,
    droppedInvalidProcedureShape: 0,
    plainTextFallbackUsed: false,
  };
}

function toCandidateType(value: unknown): CandidateKnowledgeType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rule" || normalized === "procedure") return normalized;
  return undefined;
}

function hasCandidatePolarityValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "neutral";
}

function toCandidatePolarity(
  value: unknown,
): Exclude<CandidateKnowledgePolarity, "neutral"> | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "positive" || normalized === "negative") {
    return normalized;
  }
  return undefined;
}

function candidateRecordFromValue(
  value: unknown,
  diagnostics: StorageCandidateParseDiagnostics,
): CandidateRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    type?: unknown;
    candidateType?: unknown;
    polarity?: unknown;
    title?: unknown;
    name?: unknown;
    content?: unknown;
    body?: unknown;
    description?: unknown;
  };
  const type = toCandidateType(record.type ?? record.candidateType);
  const polarity = toCandidatePolarity(record.polarity);
  if (!type) {
    diagnostics.droppedMissingType += 1;
    return null;
  }
  if (!polarity) {
    if (hasCandidatePolarityValue(record.polarity)) {
      diagnostics.droppedNeutral += 1;
    } else {
      diagnostics.droppedMissingPolarity += 1;
    }
    return null;
  }
  const title =
    typeof record.title === "string"
      ? record.title.trim()
      : typeof record.name === "string"
        ? record.name.trim()
        : "";
  const content =
    typeof record.content === "string"
      ? record.content.trim()
      : typeof record.body === "string"
        ? record.body.trim()
        : typeof record.description === "string"
          ? record.description.trim()
          : "";
  const normalizedTitle = title || content.slice(0, 80).replace(/\s+/g, " ").trim();
  const normalizedContent = content || title;
  if (!normalizedTitle || !normalizedContent) return null;
  if (polarity === "negative" && type === "procedure") {
    diagnostics.droppedNegativeProcedure += 1;
    return null;
  }
  if (type === "procedure" && !hasSkillLikeProcedureBody(normalizedContent)) {
    diagnostics.droppedInvalidProcedureShape += 1;
    return null;
  }
  return {
    type,
    polarity,
    title: normalizedTitle,
    content: normalizedContent,
  };
}

function hasCandidateFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.title === "string" ||
    typeof record.name === "string" ||
    typeof record.content === "string" ||
    typeof record.body === "string" ||
    typeof record.description === "string"
  );
}

function collectCandidateValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as {
    candidates?: unknown;
    candidate?: unknown;
  };
  if (Array.isArray(record.candidates)) return record.candidates;
  if (record.candidate && typeof record.candidate === "object") return [record.candidate];
  if (hasCandidateFields(value as Record<string, unknown>)) return [value];
  return [];
}

function isEmptyCandidateArrayPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  const record = value as { candidates?: unknown };
  return Array.isArray(record.candidates) && record.candidates.length === 0;
}

function parsePlainTextCandidates(llmOutput: string): CandidateRecord[] {
  return llmOutput
    .split(/\n-{3,}\n/g)
    .map((block) => {
      const fields: Record<string, string[]> = {};
      let currentField: string | null = null;
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^(TYPE|POLARITY|TITLE|CONTENT):\s*(.*)$/i);
        if (match) {
          currentField = match[1].toUpperCase();
          fields[currentField] = [match[2] ?? ""];
          continue;
        }
        if (currentField) {
          fields[currentField].push(line);
        }
      }
      const title = fields.TITLE?.join("\n").trim() ?? "";
      const content = fields.CONTENT?.join("\n").trim() ?? "";
      const type = toCandidateType(fields.TYPE?.join("\n"));
      const polarity = toCandidatePolarity(fields.POLARITY?.join("\n"));
      if (!type || !polarity || !title || !content) return null;
      if (polarity === "negative" && type === "procedure") return null;
      if (type === "procedure" && !hasSkillLikeProcedureBody(content)) return null;
      return {
        type,
        polarity,
        title,
        content,
      };
    })
    .filter((candidate): candidate is CandidateRecord => Boolean(candidate));
}

export function parseStorageCandidatesWithDiagnostics(
  llmOutput: string,
): StorageCandidateParseResult {
  const diagnostics = emptyDiagnostics();
  const parsed = parseLlmJsonLike(llmOutput)?.value;
  if (parsed === undefined || parsed === null) {
    diagnostics.plainTextFallbackUsed = true;
    return { candidates: parsePlainTextCandidates(llmOutput), diagnostics };
  }

  diagnostics.rawWasEmptyArray = isEmptyCandidateArrayPayload(parsed);
  const rawCandidates = collectCandidateValues(parsed);
  diagnostics.rawCandidateLikeCount = rawCandidates.filter(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  ).length;
  if (diagnostics.rawWasEmptyArray && rawCandidates.length === 0) {
    return { candidates: [], diagnostics };
  }
  const candidates = rawCandidates
    .map((value) => candidateRecordFromValue(value, diagnostics))
    .filter((candidate): candidate is CandidateRecord => Boolean(candidate));
  if (candidates.length > 0) return { candidates, diagnostics };
  diagnostics.plainTextFallbackUsed = true;
  return { candidates: parsePlainTextCandidates(llmOutput), diagnostics };
}

export function parseStorageCandidatesFromLlmOutput(llmOutput: string): CandidateRecord[] {
  return parseStorageCandidatesWithDiagnostics(llmOutput).candidates;
}
