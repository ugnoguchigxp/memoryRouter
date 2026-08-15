import { closeDbPool } from "../db/index.js";
import { compileContextPack } from "../modules/context-compiler/context-compiler.service.js";
import type { CompileInput } from "../shared/schemas/compile.schema.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function readArgs(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1] ?? "");
    }
  }
  return values;
}

function parseCsvArgs(values: string[]): string[] {
  const items = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(items)];
}

function assertNoRemovedFlags(argv: string[]): void {
  const removedFlags = [
    "--intent",
    "--retrieval-mode",
    "--files",
    "--file",
    "--token-budget",
    "--include-draft",
    "--query-embedding",
    "--error-kind",
    "--last-error-context",
  ] as const;
  const found = removedFlags.find((flag) => argv.includes(flag));
  if (!found) return;
  throw new Error(
    `${found} is no longer supported. Use only --goal, --repo-path (or --global), --change-types, --technologies, --domains, --json.`,
  );
}

async function main(): Promise<void> {
  assertNoRemovedFlags(process.argv);
  const goal = readArg("--goal") || process.argv[2];
  if (!goal) {
    console.error(
      [
        'Usage: bun run compile --goal "your task goal"',
        "[--change-types backend,api]",
        "[--technologies bun,typescript]",
        "[--domains context-compiler,knowledge]",
        "[--repo-path /absolute/workspace/root | --global]",
        "[--json]",
      ].join(" "),
    );
    process.exitCode = 1;
    return;
  }

  const changeTypes = parseCsvArgs([...readArgs("--change-types"), ...readArgs("--change-type")]);
  const technologies = parseCsvArgs([...readArgs("--technologies"), ...readArgs("--technology")]);
  const domains = parseCsvArgs([...readArgs("--domains"), ...readArgs("--domain")]);
  const asJson = process.argv.includes("--json");
  const repoPath = readArg("--repo-path");
  const globalOnly = process.argv.includes("--global");
  if (repoPath && globalOnly) {
    throw new Error("Use either --repo-path or --global, not both.");
  }
  if (!repoPath && !globalOnly) {
    throw new Error(
      "Repository identity is required. Pass the absolute workspace root with --repo-path, or explicitly request global-only retrieval with --global.",
    );
  }

  const compileInput: CompileInput = {
    goal,
    ...(changeTypes.length > 0 ? { changeTypes } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(domains.length > 0 ? { domains } : {}),
    ...(repoPath ? { repoPath } : {}),
  };

  const result = await compileContextPack(compileInput, { source: "cli" });
  if (asJson) {
    console.log(JSON.stringify(result.pack, null, 2));
  } else {
    console.log(result.markdown);
  }
}

main()
  .catch((error) => {
    console.error("[compile] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
