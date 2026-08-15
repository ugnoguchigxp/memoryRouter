import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { importMarkdownDirectory } from "../modules/sources/markdown-importer.service.js";

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const argPath = positional[0];
  if (!argPath) {
    throw new Error("Usage: import-sources <content-root> --repo-path <workspace-root> | --global");
  }
  const rootPath = path.resolve(argPath);
  const repoPathIndex = process.argv.indexOf("--repo-path");
  const repoPath = repoPathIndex >= 0 ? process.argv[repoPathIndex + 1] : undefined;
  const globalOnly = process.argv.includes("--global");
  if (Boolean(repoPath) === globalOnly) {
    throw new Error("Pass exactly one of --repo-path <workspace-root> or --global");
  }
  const result = await importMarkdownDirectory(
    rootPath,
    repoPath ? { scope: "repo", projectRoot: path.resolve(repoPath) } : { scope: "global" },
  );

  console.log(
    JSON.stringify(
      {
        rootPath,
        importedFiles: result.importedFiles,
        importedSources: result.importedSources,
        importedKnowledge: result.importedKnowledge,
        enqueuedFindingJobs: result.enqueuedFindingJobs,
        skippedFindingJobs: result.skippedFindingJobs,
        skippedFiles: result.skippedFiles,
        removedSources: result.removedSources,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("[import-sources] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
