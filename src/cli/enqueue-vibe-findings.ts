import { closeDbPool } from "../db/index.js";
import {
  type VibeFindingEnqueueMode,
  type VibeFindingEnqueueSource,
  type VibeFindingSelectorVersion,
  runVibeFindingEnqueue,
} from "../modules/findCandidate/vibe-finding-enqueue.service.js";

type CliOptions = {
  mode: VibeFindingEnqueueMode;
  source: VibeFindingEnqueueSource;
  sinceDays: number;
  limit: number;
  minScore: number;
  selectorVersion: VibeFindingSelectorVersion;
  json: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be >= 0`);
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be >= 1`);
  return parsed;
}

function parseSource(value: string): VibeFindingEnqueueSource {
  if (
    value === "codex_logs" ||
    value === "antigravity_logs" ||
    value === "claude_logs" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("--source must be codex_logs, antigravity_logs, claude_logs, or all");
}

function parseSelectorVersion(value: string): VibeFindingSelectorVersion {
  if (value === "legacy-v1" || value === "finding-selector-v2") return value;
  throw new Error("--selector-version must be legacy-v1 or finding-selector-v2");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    source: "codex_logs",
    sinceDays: 7,
    limit: 10,
    minScore: 50,
    selectorVersion: "finding-selector-v2",
    json: false,
  };
  let minScoreSpecified = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.mode = "dry-run";
    } else if (arg === "--write") {
      options.mode = "write";
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      options.source = parseSource(readArgValue(args, index, "--source").trim());
      if (arg === "--source") index += 1;
    } else if (arg === "--since-days" || arg.startsWith("--since-days=")) {
      options.sinceDays = parseNonNegativeInteger(
        readArgValue(args, index, "--since-days"),
        "--since-days",
      );
      if (arg === "--since-days") index += 1;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(readArgValue(args, index, "--limit"), "--limit");
      if (arg === "--limit") index += 1;
    } else if (arg === "--min-score" || arg.startsWith("--min-score=")) {
      minScoreSpecified = true;
      options.minScore = parseNonNegativeInteger(
        readArgValue(args, index, "--min-score"),
        "--min-score",
      );
      if (arg === "--min-score") index += 1;
    } else if (arg === "--selector-version" || arg.startsWith("--selector-version=")) {
      options.selectorVersion = parseSelectorVersion(
        readArgValue(args, index, "--selector-version").trim(),
      );
      if (arg === "--selector-version") index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (minScoreSpecified && options.selectorVersion !== "legacy-v1") {
    throw new Error("--min-score is only supported with --selector-version legacy-v1");
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runVibeFindingEnqueue(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${[
      `mode=${report.mode}`,
      `source=${report.source}`,
      `scanned=${report.scanned}`,
      `eligible=${report.eligible}`,
      `selectorVersion=${report.selectorVersion}`,
      `rejected=${report.rejected}`,
      `skippedAlreadyQueued=${report.skippedAlreadyQueued}`,
      `enqueued=${report.enqueued}`,
    ].join(" ")}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
