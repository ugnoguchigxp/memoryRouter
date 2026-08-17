import { closeDbPool } from "../db/index.js";
import { recoverFindingSystemMessageFailures } from "../modules/findCandidate/system-message-failure-recovery.service.js";

type CliOptions = {
  mode: "dry-run" | "write";
  limit: number;
  limitProvided: boolean;
};

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    limit: 100,
    limitProvided: false,
  };
  let requestedMode: CliOptions["mode"] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      if (requestedMode === "write") {
        throw new Error("--dry-run and --write are mutually exclusive");
      }
      requestedMode = "dry-run";
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--write") {
      if (requestedMode === "dry-run") {
        throw new Error("--dry-run and --write are mutually exclusive");
      }
      requestedMode = "write";
      options.mode = "write";
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      if (options.limitProvided) throw new Error("--limit may only be specified once");
      const inline = arg.match(/^--limit=(.*)$/)?.[1];
      const raw = inline ?? args[index + 1];
      if (!raw || raw.startsWith("--")) throw new Error("--limit requires a value");
      if (inline === undefined) index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5_000) {
        throw new Error("--limit must be an integer between 1 and 5000");
      }
      options.limit = parsed;
      options.limitProvided = true;
      continue;
    }
    if (arg === "--json") continue;
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode === "write" && !options.limitProvided) {
    throw new Error("--write requires an explicit --limit");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await recoverFindingSystemMessageFailures(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
