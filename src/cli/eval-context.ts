import { closeDbPool } from "../db/index.js";
import { buildContextEvalCaseReport } from "../modules/landscape/context-eval-case.service.js";
import {
  type ContextEvalReport,
  buildContextEvalReportFromReplay,
} from "../modules/landscape/context-eval.service.js";
import type { LandscapeRunStatusFilter } from "../modules/landscape/landscape-replay.types.js";
import type { ContextEvalCaseReport } from "../shared/schemas/context-eval-case.schema.js";

type CliOptions = {
  fromReplay: boolean;
  casesPath?: string;
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
  currentLimit: number;
  asJson: boolean;
  check: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parsePositiveInt(
  args: string[],
  index: number,
  name: string,
  max?: number,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be ${max} or less`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseRunStatus(value: string): LandscapeRunStatusFilter {
  if (value === "ok" || value === "degraded" || value === "failed" || value === "all") {
    return value;
  }
  throw new Error("--run-status must be one of ok|degraded|failed|all");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    fromReplay: false,
    windowDays: 30,
    limit: 1000,
    runStatus: "all",
    currentLimit: 12,
    asJson: false,
    check: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--from-replay") {
      options.fromReplay = true;
      continue;
    }
    if (arg === "--cases" || arg.startsWith("--cases=")) {
      const value = readArgValue(args, index, "--cases");
      options.casesPath = value;
      if (arg === "--cases") index += 1;
      continue;
    }
    if (arg === "--json") {
      options.asJson = true;
      continue;
    }
    if (arg === "--window" || arg.startsWith("--window=")) {
      const parsed = parsePositiveInt(args, index, "--window", 180);
      options.windowDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--window-days" || arg.startsWith("--window-days=")) {
      const parsed = parsePositiveInt(args, index, "--window-days", 180);
      options.windowDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = parsePositiveInt(args, index, "--limit", 1000);
      options.limit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--run-status" || arg.startsWith("--run-status=")) {
      const value = readArgValue(args, index, "--run-status");
      options.runStatus = parseRunStatus(value);
      if (arg === "--run-status") index += 1;
      continue;
    }
    if (arg === "--current-limit" || arg.startsWith("--current-limit=")) {
      const parsed = parsePositiveInt(args, index, "--current-limit", 50);
      options.currentLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printSummary(report: ContextEvalReport): void {
  console.log(
    `Context Eval (${report.source.mode}, ${report.source.windowDays}d, runs=${report.source.runStatus})`,
  );
  console.log(`Summary: ${report.summary.status} (${report.summary.reason})`);
  console.log(
    `Scores: retention=${report.scores.retentionScore.value.toFixed(2)} churn=${report.scores.churnScore.value.toFixed(2)} repulsion=${report.scores.repulsionScore.value.toFixed(2)} reachability=${report.scores.reachabilityScore.value.toFixed(2)} stability=${report.scores.stabilityScore.value.toFixed(2)}`,
  );
  console.log(
    `Metrics: compared=${report.metrics.comparedRunCount} used_lost=${report.metrics.usedBaselineLostItemCount} high_churn=${report.metrics.highChurnRunCount} no_current_match=${report.metrics.noCurrentMatchRunCount}`,
  );
  console.log(
    `Next action: ${report.recommendedNextAction.strategy} candidates=${report.recommendedNextAction.candidateRunCount} production=${report.recommendedNextAction.productionEnabled}`,
  );
  if (report.riskyRuns.length === 0) return;

  console.log("");
  console.log("Risky runs:");
  for (const run of report.riskyRuns.slice(0, 10)) {
    console.log(
      `- ${run.runId} ${run.comparison} overlap=${run.overlapRate.toFixed(2)} replacement=${run.replacementRate.toFixed(2)} used_lost=${run.usedBaselineLostCount} negative_reselected=${run.negativeReselectedCount} goal=${run.goal.slice(0, 80)}`,
    );
  }
}

function printCaseSummary(report: ContextEvalCaseReport): void {
  console.log(
    `Context Eval (cases, cases=${report.summary.caseCount}, currentLimit=${report.source.currentLimit})`,
  );
  console.log(
    `Summary: ${report.summary.status} passRate=${report.summary.passRate.toFixed(2)} expectedRecall=${report.metrics.expectedRecall !== null ? report.metrics.expectedRecall.toFixed(2) : "null"} forbiddenHits=${report.metrics.forbiddenHitCount} degraded=${report.metrics.degradedCaseCount} unscored=${report.summary.unscoredCount} errors=${report.metrics.errorCaseCount}`,
  );

  const failedCases = report.cases.filter((c) => c.status === "failed");
  if (failedCases.length === 0) return;

  console.log("");
  console.log("Failed cases:");
  for (const c of failedCases) {
    console.log(
      `- ${c.id} missing=[${c.missingExpectedIds.join(", ")}] forbidden=[${c.forbiddenHitIds.join(", ")}]`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.fromReplay && !options.casesPath) {
    throw new Error("Either --from-replay or --cases <path> must be specified.");
  }
  if (options.fromReplay && options.casesPath) {
    throw new Error("Cannot specify both --from-replay and --cases <path> simultaneously.");
  }

  if (options.check && !options.casesPath) throw new Error("--check requires --cases");

  if (options.casesPath) {
    const report = await buildContextEvalCaseReport({
      casesPath: options.casesPath,
      currentLimit: options.currentLimit,
    });
    if (options.check && report.summary.status !== "passed") process.exitCode = 1;

    if (options.asJson) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printCaseSummary(report);
    return;
  }

  const report = await buildContextEvalReportFromReplay({
    windowDays: options.windowDays,
    limit: options.limit,
    runStatus: options.runStatus,
    currentLimit: options.currentLimit,
  });

  if (options.asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSummary(report);
}

main()
  .catch((error) => {
    console.error("[eval:context] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
