import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { groupedConfig } from "../../config.js";
import { normalizeCompileRepoPath } from "../context-compiler/compile-project-identity.js";
import { enqueueFindingJob, findFindingJob } from "../queue/core/index.js";
import { deleteStaleSourcesForRoot, upsertSourceDocument } from "./source.repository.js";

type MarkdownImportResult = {
  importedFiles: number;
  importedSources: number;
  importedKnowledge: number;
  enqueuedFindingJobs: number;
  skippedFindingJobs: number;
  skippedFiles: number;
  removedSources: number;
  files: Array<{ path: string; sourceId: string }>;
};

export type MarkdownImportProjectScope =
  | { scope: "repo"; projectRoot: string }
  | { scope: "global" };

type FrontmatterParseResult = {
  frontmatter: Record<string, string>;
  body: string;
};

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {}, body: markdown };
  }
  const block = markdown.slice(4, end);
  const body = markdown.slice(end + 5);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    frontmatter[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body };
}

function firstMarkdownHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const title = trimmed.replace(/^#+\s*/, "").trim();
    if (title) return title;
  }
  return null;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function wikiTargetKeyForFile(filePath: string): string | null {
  const readRoot = path.resolve(groupedConfig.readFile.root);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(readRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return toPosixPath(relative);
}

export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const parentPath =
      "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : rootDir;
    files.push(path.join(parentPath, entry.name));
  }
  return files.sort();
}

export async function importMarkdownDirectory(
  contentRoot: string,
  projectScope: MarkdownImportProjectScope,
): Promise<MarkdownImportResult> {
  const markdownFiles = await collectMarkdownFiles(contentRoot);
  const results: MarkdownImportResult = {
    importedFiles: 0,
    importedSources: 0,
    importedKnowledge: 0,
    enqueuedFindingJobs: 0,
    skippedFindingJobs: 0,
    skippedFiles: 0,
    removedSources: 0,
    files: [],
  };
  const normalizedRootPath = path.resolve(contentRoot);
  const captureRepoPath =
    projectScope.scope === "repo" ? normalizeCompileRepoPath(projectScope.projectRoot) : null;
  if (projectScope.scope === "repo" && !captureRepoPath) {
    throw new Error("projectRoot must be an absolute repository path");
  }

  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) {
      results.skippedFiles += 1;
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const inferredTitle = firstMarkdownHeading(body) ?? path.basename(filePath, ".md");

    const sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      scope: projectScope.scope,
      ...(captureRepoPath ? { repoPath: captureRepoPath } : {}),
      uri: filePath,
      title: frontmatter.title ?? inferredTitle,
      body: content,
      metadata: {
        importedAt: new Date().toISOString(),
        ...(captureRepoPath ? { repoPath: captureRepoPath } : {}),
        sourceRootPath: normalizedRootPath,
      },
    });

    results.importedFiles += 1;
    results.importedSources += 1;
    results.files.push({ path: filePath, sourceId });

    const targetKey = wikiTargetKeyForFile(filePath);
    if (!targetKey) {
      results.skippedFindingJobs += 1;
      continue;
    }

    const existingFindingJob = await findFindingJob({
      inputKind: "source_target",
      sourceKind: "wiki_file",
      sourceKey: targetKey,
    });
    if (existingFindingJob) {
      results.skippedFindingJobs += 1;
      continue;
    }

    const findingJob = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "wiki_file",
      sourceKey: targetKey,
      sourceUri: path.resolve(filePath),
      payload: {
        sourceType: "wiki_markdown_import",
        importedVia: "importMarkdownDirectory",
        sourceRootPath: normalizedRootPath,
      },
      metadata: {
        sourceType: "wiki_markdown_import",
        importedVia: "importMarkdownDirectory",
        sourceRootPath: normalizedRootPath,
        ...(captureRepoPath ? { repoPath: captureRepoPath } : {}),
      },
    });
    if (findingJob) {
      results.enqueuedFindingJobs += 1;
    } else {
      results.skippedFindingJobs += 1;
    }
  }

  results.removedSources = await deleteStaleSourcesForRoot({
    rootPath: normalizedRootPath,
    keepUris: results.files.map((item) => item.path),
  });

  return results;
}
