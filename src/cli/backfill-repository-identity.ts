#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import type { RepositoryIdentityEntityKind } from "../modules/context-compiler/repository-identity-backfill.js";
import {
  type RepositoryIdentityReviewDecision,
  type RunRepositoryIdentityBackfillInput,
  runRepositoryIdentityBackfill,
} from "../modules/context-compiler/repository-identity-backfill.service.js";

type RepositoryIdentityBackfillCliInput = RunRepositoryIdentityBackfillInput & {
  reviewFile?: string;
};

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseRepositoryIdentityBackfillArgs(
  args: readonly string[],
): RepositoryIdentityBackfillCliInput {
  const input: RepositoryIdentityBackfillCliInput = { mode: "dry-run" };
  const promotions: Partial<Record<RepositoryIdentityEntityKind, string[]>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") input.mode = "dry-run";
    else if (arg === "--write") input.mode = "write";
    else if (arg === "--expected-checksum") {
      input.expectedChecksum = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--backup-reference") {
      input.backupReference = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--sqlite-path") {
      input.sqlitePath = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--review-file") {
      input.reviewFile = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--batch-size") {
      input.batchSize = Number(requiredValue(args, index, arg));
      index += 1;
    } else if (arg === "--promote-global") {
      const declaration = requiredValue(args, index, arg);
      index += 1;
      const separator = declaration.indexOf(":");
      const kind = declaration.slice(0, separator) as RepositoryIdentityEntityKind;
      const id = declaration.slice(separator + 1);
      if (!(["knowledge", "source", "episode"] as const).includes(kind) || !id.trim()) {
        throw new Error("--promote-global requires knowledge:<id>, source:<id>, or episode:<id>");
      }
      const values = promotions[kind] ?? [];
      values.push(id.trim());
      promotions[kind] = values;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (Object.keys(promotions).length > 0) input.explicitGlobalPromotions = promotions;
  if (
    input.batchSize !== undefined &&
    (!Number.isInteger(input.batchSize) || input.batchSize < 1)
  ) {
    throw new Error("--batch-size must be a positive integer");
  }
  return input;
}

function reviewDecisionsFromFile(filePath: string): RepositoryIdentityReviewDecision[] {
  const document = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const reviewer = typeof document.reviewer === "string" ? document.reviewer : "";
  const reviewedAt = typeof document.reviewedAt === "string" ? document.reviewedAt : "";
  if (!reviewer.trim() || Number.isNaN(new Date(reviewedAt).getTime())) {
    throw new Error("review file requires reviewer and an ISO reviewedAt timestamp");
  }
  if (!Array.isArray(document.decisions)) throw new Error("review file requires decisions[]");
  return document.decisions.map((raw, index) => {
    const decision =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const entityKind = decision.entityKind;
    const entityId = decision.entityId;
    const outcome = decision.decision;
    const reason = decision.reason;
    if (
      !(entityKind === "knowledge" || entityKind === "source" || entityKind === "episode") ||
      typeof entityId !== "string" ||
      !entityId.trim() ||
      !(outcome === "global" || outcome === "repo" || outcome === "unresolved") ||
      typeof reason !== "string" ||
      !reason.trim()
    ) {
      throw new Error(`invalid review decision at index ${index}`);
    }
    return {
      entityKind,
      entityId: entityId.trim(),
      decision: outcome,
      reviewer: reviewer.trim(),
      reason: reason.trim(),
      reviewedAt,
    };
  });
}

async function main(): Promise<void> {
  const parsed = parseRepositoryIdentityBackfillArgs(process.argv.slice(2));
  const { reviewFile, ...input } = parsed;
  if (reviewFile) input.reviewDecisions = reviewDecisionsFromFile(reviewFile);
  const summary = await runRepositoryIdentityBackfill(input);
  const changed = summary.decisions.filter((item) => item.changed);
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: summary.mode,
        backend: summary.backend,
        migrationVersion: summary.migrationVersion,
        checksum: summary.checksum,
        counts: summary.counts,
        updatedCount: summary.updatedCount,
        auditInsertedCount: summary.auditInsertedCount,
        backupReference: summary.backupReference,
        changedPreview: changed.slice(0, 20).map((item) => ({
          entityKind: item.entityKind,
          entityId: item.entityId,
          outcome: item.outcome,
          reasonCode: item.reasonCode,
        })),
        changedPreviewTruncated: changed.length > 20,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
