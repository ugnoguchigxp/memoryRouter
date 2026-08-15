import { closeDbPool } from "../db/index.js";
import { collectRepositoryIsolationReport } from "../modules/context-compiler/repository-isolation-report.repository.js";
import type { RepositoryFacets } from "../modules/context-compiler/repository-scope.js";

type Options = {
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
  previewLimit?: number;
  recentRunLimit?: number;
  enabledProducers?: string[];
  producerObservationStartedAt?: Date;
  requestFacets: RepositoryFacets;
};

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isoTimestamp(value: string, option: string): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) {
    throw new Error(`${option} must be an ISO-8601 timestamp with a timezone`);
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  const daysInMonth =
    month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const parsed = new Date(value);
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(parsed.getTime())
  ) {
    throw new Error(`${option} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

export function parseRepositoryIsolationReportArgs(args: string[]): Options {
  const options: Options = { requestFacets: {} };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") continue;
    const value = requiredValue(args, index, option ?? "option");
    index += 1;
    if (option === "--project-ref") options.projectRef = value;
    else if (option === "--repo-key") options.repoKey = value;
    else if (option === "--repo-path") options.repoPath = value;
    else if (option === "--preview-limit") options.previewLimit = positiveInteger(value, option);
    else if (option === "--recent-run-limit") {
      options.recentRunLimit = positiveInteger(value, option);
    } else if (option === "--technologies") {
      options.requestFacets.technologies = commaSeparated(value);
    } else if (option === "--change-types") {
      options.requestFacets.changeTypes = commaSeparated(value);
    } else if (option === "--domains") {
      options.requestFacets.domains = commaSeparated(value);
    } else if (option === "--enabled-producers") {
      options.enabledProducers = commaSeparated(value);
    } else if (option === "--producer-observation-started-at") {
      options.producerObservationStartedAt = isoTimestamp(value, option);
    } else {
      throw new Error(`Unknown argument: ${option}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseRepositoryIsolationReportArgs(process.argv.slice(2));
  const hasIdentity = options.projectRef || options.repoKey || options.repoPath;
  const report = await collectRepositoryIsolationReport({
    identityInput: hasIdentity
      ? {
          projectRef: options.projectRef,
          repoKey: options.repoKey,
          repoPath: options.repoPath,
        }
      : undefined,
    requestFacets: options.requestFacets,
    previewLimit: options.previewLimit,
    recentRunLimit: options.recentRunLimit,
    enabledProducers: options.enabledProducers,
    producerObservationStartedAt: options.producerObservationStartedAt,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDbPool();
    });
}
