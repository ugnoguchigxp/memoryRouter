import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import { assertFullGitObjectId, assertGitObjectId } from "./git-revision.js";
import { sanitizeMarkdownBody, sanitizePlainText } from "./sanitize.js";
import { assertSafeSlug, filePathToSlug } from "./slug.js";

const execFileAsync = promisify(execFile);
const MAX_WIKI_PAGE_BYTES = 16 * 1024 * 1024;

export type GitSummary = {
  branch: string;
  commit: string;
} | null;

export type PageTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: Date;
};

export type FolderTreeItem = {
  path: string;
};

export type MovedPage = {
  from: string;
  to: string;
};

export type PageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

const pagesDirectory = (contentRoot: string) => path.resolve(contentRoot, "pages");

const normalizePosixPath = (targetPath: string): string => targetPath.split(path.sep).join("/");

const isNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
};

const assertInsidePages = (contentRoot: string, relativePath: string): string => {
  const pagesRoot = pagesDirectory(contentRoot);
  const safeRelative = relativePath.replace(/^\/+/, "");
  const absolute = path.resolve(pagesRoot, safeRelative);
  const isInside = absolute === pagesRoot || absolute.startsWith(`${pagesRoot}${path.sep}`);
  if (!isInside) {
    throw new Error("Invalid page path");
  }
  return absolute;
};

const assertNoSymlinkComponents = async (
  contentRoot: string,
  absolutePath: string,
): Promise<void> => {
  const pagesRoot = pagesDirectory(contentRoot);
  const relative = path.relative(pagesRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Invalid page path");
  }
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = pagesRoot;
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed in the pages directory");
      }
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  }
};

const assertSafeFolderPath = (folderPath: string): string => {
  const safe = assertSafeSlug(folderPath);
  if (safe === "") {
    throw new Error("Invalid folder path");
  }
  return safe;
};

export const ensureContentRoot = async (contentRoot: string): Promise<void> => {
  const pagesRoot = pagesDirectory(contentRoot);
  await fs.mkdir(pagesRoot, { recursive: true });
  await fs.mkdir(path.resolve(contentRoot, ".wiki"), { recursive: true });
};

const readMarkdownFiles = async (
  root: string,
): Promise<Array<{ filePath: string; updatedAt: Date }>> => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: Array<{ filePath: string; updatedAt: Date }> = [];
  for (const entry of entries) {
    const fullPath = path.resolve(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await readMarkdownFiles(fullPath);
      results.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const stat = await fs.stat(fullPath);
      results.push({ filePath: fullPath, updatedAt: stat.mtime });
    }
  }
  return results;
};

const readFolderPaths = async (root: string, base = root): Promise<string[]> => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.resolve(root, entry.name);
    const relativePath = normalizePosixPath(path.relative(base, fullPath));
    results.push(relativePath);
    results.push(...(await readFolderPaths(fullPath, base)));
  }
  return results;
};

export const listPages = async (contentRoot: string): Promise<PageTreeItem[]> => {
  const pagesRoot = pagesDirectory(contentRoot);
  await assertNoSymlinkComponents(contentRoot, pagesRoot);
  const files = await readMarkdownFiles(pagesRoot);
  const items: PageTreeItem[] = files.map((file) => {
    const relativePath = path.relative(pagesRoot, file.filePath);
    const slug = filePathToSlug(relativePath);
    return {
      slug,
      title: slug || "Home",
      path: normalizePosixPath(relativePath),
      updatedAt: file.updatedAt,
    };
  });
  return items.sort((a, b) => a.slug.localeCompare(b.slug));
};

export const listFolders = async (contentRoot: string): Promise<FolderTreeItem[]> => {
  const pagesRoot = pagesDirectory(contentRoot);
  await assertNoSymlinkComponents(contentRoot, pagesRoot);
  const folders = await readFolderPaths(pagesRoot);
  return folders
    .map((folderPath) => ({ path: folderPath }))
    .sort((a, b) => a.path.localeCompare(b.path));
};

const resolveCandidateRelativePaths = (slug: string): string[] => {
  const safe = assertSafeSlug(slug);
  if (safe === "") {
    return ["index.md"];
  }
  return [`${safe}.md`, path.join(safe, "index.md")];
};

const findExistingPageRelativePath = async (
  contentRoot: string,
  slug: string,
): Promise<string | null> => {
  const candidates = resolveCandidateRelativePaths(slug);
  for (const candidate of candidates) {
    const absolute = assertInsidePages(contentRoot, candidate);
    try {
      await assertNoSymlinkComponents(contentRoot, absolute);
      const stat = await fs.stat(absolute);
      if (stat.isFile()) {
        return normalizePosixPath(candidate);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  return null;
};

export const readPage = async (contentRoot: string, slug: string): Promise<PageDocument | null> => {
  const candidates = resolveCandidateRelativePaths(slug);
  for (const candidate of candidates) {
    const absolute = assertInsidePages(contentRoot, candidate);
    try {
      await assertNoSymlinkComponents(contentRoot, absolute);
      const pageStat = await fs.stat(absolute);
      if (pageStat.size > MAX_WIKI_PAGE_BYTES) {
        throw new Error(`Wiki page exceeds ${MAX_WIKI_PAGE_BYTES} bytes`);
      }
      const raw = await fs.readFile(absolute, "utf8");
      const parsed = matter(raw);
      const relativePath = path.relative(pagesDirectory(contentRoot), absolute);
      const normalizedPath = normalizePosixPath(relativePath);
      const normalizedSlug = filePathToSlug(normalizedPath);
      const title =
        typeof parsed.data.title === "string" && parsed.data.title.length > 0
          ? parsed.data.title
          : normalizedSlug || "Home";
      return {
        slug: normalizedSlug,
        title,
        body: parsed.content,
        path: normalizedPath,
        meta: parsed.data as Record<string, unknown>,
      };
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  return null;
};

const serializeMarkdown = (title: string, body: string, meta: Record<string, unknown>): string => {
  const mergedMeta: Record<string, unknown> = {
    ...meta,
    title: sanitizePlainText(title),
  };
  const sanitizedBody = sanitizeMarkdownBody(body);
  return matter.stringify(
    sanitizedBody.endsWith("\n") ? sanitizedBody : `${sanitizedBody}\n`,
    mergedMeta,
  );
};

const resolveWritePath = (contentRoot: string, slug: string, relativePath?: string): string => {
  const safe = assertSafeSlug(slug);
  if (relativePath) {
    const normalizedRelativePath = normalizePosixPath(relativePath);
    if (
      !normalizedRelativePath.endsWith(".md") ||
      filePathToSlug(normalizedRelativePath) !== safe
    ) {
      throw new Error("Existing page path does not match slug");
    }
    return assertInsidePages(contentRoot, normalizedRelativePath);
  }
  const relative = safe === "" ? "index.md" : `${safe}.md`;
  return assertInsidePages(contentRoot, relative);
};

export const writePage = async (
  contentRoot: string,
  slug: string,
  title: string,
  body: string,
  meta: Record<string, unknown>,
  options: { relativePath?: string } = {},
): Promise<{ path: string }> => {
  const targetPath = resolveWritePath(contentRoot, slug, options.relativePath);
  await assertNoSymlinkComponents(contentRoot, targetPath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await assertNoSymlinkComponents(contentRoot, targetPath);
  const output = serializeMarkdown(title, body, meta);
  await fs.writeFile(targetPath, output, "utf8");
  return { path: targetPath };
};

const removeEmptyParentDirectories = async (
  contentRoot: string,
  removedFilePath: string,
): Promise<void> => {
  const pagesRoot = pagesDirectory(contentRoot);
  let currentDir = path.dirname(removedFilePath);
  while (currentDir !== pagesRoot && currentDir.startsWith(`${pagesRoot}${path.sep}`)) {
    try {
      const entries = await fs.readdir(currentDir);
      if (entries.length > 0) return;
      await fs.rmdir(currentDir);
      currentDir = path.dirname(currentDir);
    } catch {
      return;
    }
  }
};

export const deletePage = async (contentRoot: string, slug: string): Promise<string> => {
  const candidates = resolveCandidateRelativePaths(slug).map((candidate) =>
    assertInsidePages(contentRoot, candidate),
  );
  for (const candidate of candidates) {
    try {
      await assertNoSymlinkComponents(contentRoot, candidate);
      await fs.rm(candidate);
      await removeEmptyParentDirectories(contentRoot, candidate);
      return candidate;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }
  throw new Error("Page not found");
};

export const createFolder = async (
  contentRoot: string,
  folderPath: string,
): Promise<{ path: string; keepFilePath: string }> => {
  const safe = assertSafeFolderPath(folderPath);
  const folderAbsolutePath = assertInsidePages(contentRoot, safe);
  await assertNoSymlinkComponents(contentRoot, folderAbsolutePath);
  try {
    const stat = await fs.stat(folderAbsolutePath);
    if (stat.isDirectory()) {
      throw new Error("Folder already exists");
    }
    throw new Error("Folder path conflicts with a file");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  await fs.mkdir(folderAbsolutePath, { recursive: true });
  await assertNoSymlinkComponents(contentRoot, folderAbsolutePath);
  const keepFilePath = path.join(folderAbsolutePath, ".gitkeep");
  await fs.writeFile(keepFilePath, "", "utf8");
  return { path: safe, keepFilePath };
};

const listPagesUnderFolder = async (
  contentRoot: string,
  folderPath: string,
): Promise<PageTreeItem[]> => {
  const safe = assertSafeFolderPath(folderPath);
  const pages = await listPages(contentRoot);
  return pages.filter((page) => page.path.startsWith(`${safe}/`));
};

export const deleteFolder = async (
  contentRoot: string,
  folderPath: string,
): Promise<{ path: string; absolutePath: string; deletedSlugs: string[] }> => {
  const safe = assertSafeFolderPath(folderPath);
  const folderAbsolutePath = assertInsidePages(contentRoot, safe);
  await assertNoSymlinkComponents(contentRoot, folderAbsolutePath);
  const stat = await fs.stat(folderAbsolutePath);
  if (!stat.isDirectory()) {
    throw new Error("Folder not found");
  }
  const deletedSlugs = (await listPagesUnderFolder(contentRoot, safe)).map((page) => page.slug);
  await fs.rm(folderAbsolutePath, { recursive: true });
  await removeEmptyParentDirectories(contentRoot, folderAbsolutePath);
  return { path: safe, absolutePath: folderAbsolutePath, deletedSlugs };
};

export const renameFolder = async (
  contentRoot: string,
  folderPath: string,
  targetFolderPath: string,
): Promise<{
  path: string;
  from: string;
  oldAbsolutePath: string;
  newAbsolutePath: string;
  movedPages: MovedPage[];
}> => {
  const source = assertSafeFolderPath(folderPath);
  const target = assertSafeFolderPath(targetFolderPath);
  if (source === target) {
    throw new Error("Folder path is unchanged");
  }
  if (target.startsWith(`${source}/`)) {
    throw new Error("Cannot move a folder into itself");
  }
  const oldAbsolutePath = assertInsidePages(contentRoot, source);
  const newAbsolutePath = assertInsidePages(contentRoot, target);
  await assertNoSymlinkComponents(contentRoot, oldAbsolutePath);
  await assertNoSymlinkComponents(contentRoot, newAbsolutePath);
  const oldStat = await fs.stat(oldAbsolutePath);
  if (!oldStat.isDirectory()) {
    throw new Error("Folder not found");
  }
  try {
    await fs.stat(newAbsolutePath);
    throw new Error("Folder already exists");
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  const movedPages = (await listPagesUnderFolder(contentRoot, source)).map((page) => {
    const suffix = page.path.slice(source.length + 1);
    const targetPath = path.posix.join(target, suffix);
    return { from: page.slug, to: filePathToSlug(targetPath) };
  });
  await fs.mkdir(path.dirname(newAbsolutePath), { recursive: true });
  await assertNoSymlinkComponents(contentRoot, newAbsolutePath);
  await fs.rename(oldAbsolutePath, newAbsolutePath);
  await removeEmptyParentDirectories(contentRoot, oldAbsolutePath);
  return { path: target, from: source, oldAbsolutePath, newAbsolutePath, movedPages };
};

const runGit = async (
  contentRoot: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync("git", ["-C", contentRoot, ...args]);

const gitPathspecForAbsolutePath = (contentRoot: string, absolutePath: string): string => {
  const relative = path.relative(contentRoot, absolutePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Git path must remain inside the content root");
  }
  return normalizePosixPath(relative);
};

const resolveCommitObjectId = async (contentRoot: string, revision: string): Promise<string> => {
  const safeRevision = assertGitObjectId(revision);
  const { stdout } = await runGit(contentRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${safeRevision}^{commit}`,
  ]);
  return assertFullGitObjectId(stdout);
};

const hasStagedChanges = async (contentRoot: string, relativePath: string): Promise<boolean> => {
  try {
    await runGit(contentRoot, ["diff", "--cached", "--quiet", "--", relativePath]);
    return false;
  } catch {
    return true;
  }
};

const hasAnyStagedChanges = async (
  contentRoot: string,
  relativePaths: string[],
): Promise<boolean> => {
  try {
    await runGit(contentRoot, ["diff", "--cached", "--quiet", "--", ...relativePaths]);
    return false;
  } catch {
    return true;
  }
};

export const ensureGitRepo = async (contentRoot: string): Promise<void> => {
  const gitPath = path.resolve(contentRoot, ".git");
  try {
    await fs.access(gitPath);
  } catch {
    await runGit(contentRoot, ["init"]);
    await runGit(contentRoot, ["checkout", "-b", "main"]);
  }
};

export const getGitSummary = async (contentRoot: string): Promise<GitSummary> => {
  try {
    const [{ stdout: branchStdout }, { stdout: commitStdout }] = await Promise.all([
      execFileAsync("git", ["-C", contentRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
      execFileAsync("git", ["-C", contentRoot, "rev-parse", "--short", "HEAD"]),
    ]);
    return { branch: branchStdout.trim(), commit: commitStdout.trim() };
  } catch {
    return null;
  }
};

export const commitFileChange = async (
  contentRoot: string,
  absolutePath: string,
  message: string,
): Promise<string | null> => {
  const normalizedRelative = gitPathspecForAbsolutePath(contentRoot, absolutePath);
  await runGit(contentRoot, ["add", "--", normalizedRelative]);
  try {
    await runGit(contentRoot, ["commit", "-m", message]);
  } catch (error) {
    if (await hasStagedChanges(contentRoot, normalizedRelative)) {
      throw error;
    }
  }
  const summary = await getGitSummary(contentRoot);
  return summary?.commit ?? null;
};

export const commitDeleteChange = async (
  contentRoot: string,
  absolutePath: string,
  message: string,
): Promise<string | null> => {
  const normalizedRelative = gitPathspecForAbsolutePath(contentRoot, absolutePath);
  await runGit(contentRoot, ["add", "-A", "--", normalizedRelative]);
  try {
    await runGit(contentRoot, ["commit", "-m", message]);
  } catch (error) {
    if (await hasStagedChanges(contentRoot, normalizedRelative)) {
      throw error;
    }
  }
  const summary = await getGitSummary(contentRoot);
  return summary?.commit ?? null;
};

export const commitPathsChange = async (
  contentRoot: string,
  absolutePaths: string[],
  message: string,
): Promise<string | null> => {
  const normalizedRelatives = absolutePaths.map((absolutePath) =>
    gitPathspecForAbsolutePath(contentRoot, absolutePath),
  );
  await runGit(contentRoot, ["add", "-A", "--", ...normalizedRelatives]);
  try {
    await runGit(contentRoot, ["commit", "-m", message]);
  } catch (error) {
    if (await hasAnyStagedChanges(contentRoot, normalizedRelatives)) {
      throw error;
    }
  }
  const summary = await getGitSummary(contentRoot);
  return summary?.commit ?? null;
};

const resolveGitPathspecs = async (contentRoot: string, slug: string): Promise<string[]> => {
  const existing = await findExistingPageRelativePath(contentRoot, slug);
  if (existing) {
    return [path.posix.join("pages", existing)];
  }
  return resolveCandidateRelativePaths(slug).map((candidate) =>
    path.posix.join("pages", normalizePosixPath(candidate)),
  );
};

export const getPageHistory = async (
  contentRoot: string,
  slug: string,
): Promise<Array<{ commit: string; author: string; date: string; message: string }>> => {
  const pathspecs = await resolveGitPathspecs(contentRoot, slug);
  try {
    const { stdout } = await runGit(contentRoot, [
      "log",
      "--pretty=format:%H\t%an\t%ad\t%s",
      "--date=iso-strict",
      "--",
      ...pathspecs,
    ]);
    return stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [commit, author, date, message] = line.split("\t");
        return {
          commit: commit ?? "",
          author: author ?? "",
          date: date ?? "",
          message: message ?? "",
        };
      });
  } catch {
    return [];
  }
};

export const getPageDiff = async (
  contentRoot: string,
  slug: string,
  from: string,
  to: string,
): Promise<string> => {
  const safeFrom = assertGitObjectId(from);
  const safeTo = assertGitObjectId(to);
  const pathspecs = await resolveGitPathspecs(contentRoot, slug);
  try {
    const resolvedFrom = await resolveCommitObjectId(contentRoot, safeFrom);
    const resolvedTo = await resolveCommitObjectId(contentRoot, safeTo);
    const { stdout } = await runGit(contentRoot, [
      "diff",
      resolvedFrom,
      resolvedTo,
      "--",
      ...pathspecs,
    ]);
    return stdout;
  } catch {
    return "";
  }
};
