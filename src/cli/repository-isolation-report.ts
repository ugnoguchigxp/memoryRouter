import { closeDbPool } from "../db/index.js";
import { loadRepositoryIsolationProducerManifest } from "../modules/context-compiler/repository-isolation-producer-manifest.js";
import { collectRepositoryIsolationReport } from "../modules/context-compiler/repository-isolation-report.repository.js";
import type { RepositoryFacets } from "../modules/context-compiler/repository-scope.js";

type Options = {
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
  previewLimit?: number;
  recentRunLimit?: number;
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
    producerManifest: loadRepositoryIsolationProducerManifest(),
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
