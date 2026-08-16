import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFolder,
  deletePage,
  ensureContentRoot,
  getGitSummary,
  getPageHistory,
  listFolders,
  listPages,
  readPage,
  renameFolder,
  writePage,
} from "../src/modules/sources/wiki/content-repo.js";

vi.mock("node:fs/promises");
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

describe("Content Repo Service", () => {
  const contentRoot = "/wiki-root";
  const fromCommit = "a".repeat(40);
  const toCommit = "b".repeat(40);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.lstat).mockResolvedValue({ isSymbolicLink: () => false } as any);
    vi.mocked(fs.stat).mockResolvedValue({
      size: 1024,
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);
  });

  test("ensureContentRoot creates necessary directories", async () => {
    await ensureContentRoot(contentRoot);
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining("pages"), { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".wiki"), { recursive: true });
  });

  test("listPages returns sorted pages with slugs", async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { isFile: () => true, isDirectory: () => false, name: "index.md" },
      { isFile: () => true, isDirectory: () => false, name: "about.md" },
    ] as any);
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);

    const pages = await listPages(contentRoot);
    expect(pages).toHaveLength(2);
    expect(pages[0].slug).toBe(""); // index.md
    expect(pages[1].slug).toBe("about");
  });

  test("readPage parses gray-matter", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("---\ntitle: Custom Title\n---\n# Content");

    const page = await readPage(contentRoot, "about");
    expect(page?.title).toBe("Custom Title");
    expect(page?.body).toContain("# Content");
  });

  test("writePage serializes content and saves to disk", async () => {
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await writePage(contentRoot, "new-page", "New Page", "Content", {
      author: "test",
    });
    expect(result.path).toContain("new-page.md");
    expect(fs.writeFile).toHaveBeenCalled();
  });

  test("deletePage removes file and cleans up empty directories", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]); // Empty dir cleanup
    vi.mocked(fs.rmdir).mockResolvedValue(undefined);

    // Use a nested path to trigger cleanup loop
    await deletePage(contentRoot, "folder/old-page");
    expect(fs.rm).toHaveBeenCalled();
    expect(fs.rmdir).toHaveBeenCalled();
  });

  test("createFolder adds .gitkeep", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValue(error);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await createFolder(contentRoot, "new-folder");
    expect(result.path).toBe("new-folder");
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining(".gitkeep"), "", "utf8");
  });

  test("listFolders returns recursive folder paths", async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isDirectory: () => true, name: "subdir" },
      { isDirectory: () => false, name: "file.txt" },
    ] as any);
    vi.mocked(fs.readdir).mockResolvedValueOnce([]) as any; // Inside subdir

    const folders = await listFolders(contentRoot);
    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe("subdir");
  });

  test("renameFolder moves directory and updates pages", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // Old exists
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValueOnce(error); // New doesn't exist
    vi.mocked(fs.readdir).mockResolvedValue([]); // No pages under folder for simplicity
    vi.mocked(fs.rename).mockResolvedValue(undefined);

    const result = await renameFolder(contentRoot, "old-dir", "new-dir");
    expect(result.path).toBe("new-dir");
    expect(fs.rename).toHaveBeenCalled();
  });

  test("getGitSummary returns current branch and commit", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "main\n" }, "");
      return {} as any;
    });

    const summary = await getGitSummary(contentRoot);
    expect(summary?.branch).toBe("main");
  });

  test("getPageHistory parses git log output", async () => {
    const logOutput = "commit1\tauthor1\t2023-01-01\tmsg1\n";
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: logOutput }, "");
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const history = await getPageHistory(contentRoot, "about");
    expect(history).toHaveLength(1);
    expect(history[0].commit).toBe("commit1");
  });

  test("commitFileChange adds and commits a file", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "commit-abc\n" }, "");
      return {} as any;
    });

    const { commitFileChange } = await import("../src/modules/sources/wiki/content-repo.js");
    const commit = await commitFileChange(contentRoot, "/wiki-root/pages/test.md", "feat: test");
    expect(commit).toBe("commit-abc");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit", "-m", "feat: test"]),
      expect.any(Function),
    );
  });

  test("deleteFolder removes directory and lists deleted slugs", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // Folder check
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => false, isDirectory: () => true, name: "my-folder" },
    ] as any); // pagesRoot readdir
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => true, isDirectory: () => false, name: "page.md" },
    ] as any); // my-folder readdir
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.rmdir).mockResolvedValue(undefined);

    const { deleteFolder } = await import("../src/modules/sources/wiki/content-repo.js");
    const result = await deleteFolder(contentRoot, "my-folder");
    expect(result.deletedSlugs).toContain("my-folder/page");
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining("my-folder"), { recursive: true });
  });

  test("getPageDiff returns git diff output", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, args, callback: any) => {
      const gitArgs = args as string[];
      if (gitArgs.includes("rev-parse")) {
        const revision = gitArgs.at(-1) ?? "";
        const resolved = revision.startsWith(fromCommit) ? fromCommit : toCommit;
        callback(null, { stdout: `${resolved}\n` }, "");
      } else {
        callback(null, { stdout: "diff content" }, "");
      }
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const { getPageDiff } = await import("../src/modules/sources/wiki/content-repo.js");
    const diff = await getPageDiff(contentRoot, "about", fromCommit, toCommit);
    expect(diff).toBe("diff content");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["-C", contentRoot, "diff", fromCommit, toCommit, "--", "pages/about.md"],
      expect.any(Function),
    );
  });

  test("getPageDiff rejects option-like revisions before invoking git", async () => {
    const { getPageDiff } = await import("../src/modules/sources/wiki/content-repo.js");

    await expect(
      getPageDiff(contentRoot, "about", "--output=/tmp/contextstill-pwned", toCommit),
    ).rejects.toThrow("Invalid git object ID");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("ensureGitRepo initializes if .git is missing", async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(new Error("Missing"));
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "" }, "");
      return {} as any;
    });

    const { ensureGitRepo } = await import("../src/modules/sources/wiki/content-repo.js");
    await ensureGitRepo(contentRoot);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["init"]),
      expect.any(Function),
    );
  });

  test("commitPathsChange commits multiple files", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "commit-multi\n" }, "");
      return {} as any;
    });

    const { commitPathsChange } = await import("../src/modules/sources/wiki/content-repo.js");
    const commit = await commitPathsChange(
      contentRoot,
      ["/wiki-root/pages/a.md", "/wiki-root/pages/b.md"],
      "feat: multi",
    );
    expect(commit).toBe("commit-multi");
  });

  test("deletePage throws error if page not found", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.rm).mockRejectedValue(error);
    await expect(deletePage(contentRoot, "missing")).rejects.toThrow("Page not found");
  });

  test("writePage throws error if slug doesn't match relativePath", async () => {
    await expect(
      writePage(contentRoot, "slug-a", "Title", "Body", {}, { relativePath: "slug-b.md" }),
    ).rejects.toThrow("Existing page path does not match slug");
  });

  test("throws error for invalid path escaping pages root", async () => {
    await expect(readPage(contentRoot, "../secret")).rejects.toThrow("Invalid page slug");
  });

  test("rejects page reads through symbolic links", async () => {
    vi.mocked(fs.lstat).mockResolvedValueOnce({ isSymbolicLink: () => false } as any);
    vi.mocked(fs.lstat).mockResolvedValueOnce({ isSymbolicLink: () => true } as any);

    await expect(readPage(contentRoot, "outside")).rejects.toThrow(
      "Symbolic links are not allowed",
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  test("rejects oversized wiki pages before reading them", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ size: 16 * 1024 * 1024 + 1 } as any);

    await expect(readPage(contentRoot, "large")).rejects.toThrow(
      "Wiki page exceeds 16777216 bytes",
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  test("rejects Git paths outside the content root", async () => {
    const { commitFileChange } = await import("../src/modules/sources/wiki/content-repo.js");

    await expect(
      commitFileChange(contentRoot, "/outside/pages/test.md", "feat: reject escape"),
    ).rejects.toThrow("Git path must remain inside the content root");
    expect(execFile).not.toHaveBeenCalled();
  });

  test("createFolder throws for empty path", async () => {
    await expect(createFolder(contentRoot, "")).rejects.toThrow("Invalid folder path");
  });

  test("getPageHistory handles missing existing file pathspecs", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValue(error);

    const logOutput = "commit1\tauthor1\t2023-01-01\tmsg1\n";
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: logOutput }, "");
      return {} as any;
    });

    const history = await getPageHistory(contentRoot, "about");
    expect(history).toHaveLength(1);
    expect(history[0].commit).toBe("commit1");
  });

  test("getPageHistory returns empty array on git error", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(new Error("git error"), null, "");
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const history = await getPageHistory(contentRoot, "about");
    expect(history).toEqual([]);
  });

  test("getPageDiff returns empty string on git error", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(new Error("git error"), null, "");
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const { getPageDiff } = await import("../src/modules/sources/wiki/content-repo.js");
    const diff = await getPageDiff(contentRoot, "about", fromCommit, toCommit);
    expect(diff).toBe("");
  });

  test("commitDeleteChange stage and commit delete", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "commit-del\n" }, "");
      return {} as any;
    });

    const { commitDeleteChange } = await import("../src/modules/sources/wiki/content-repo.js");
    const commit = await commitDeleteChange(
      contentRoot,
      "/wiki-root/pages/delete-me.md",
      "feat: delete",
    );
    expect(commit).toBe("commit-del");
  });

  test("commitPathsChange throws error if staged changes remain on failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, args, callback: any) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv.includes("commit")) {
        // commit fails
        callback(new Error("commit failed"), null, "");
      } else if (argv.includes("diff") && argv.includes("--cached")) {
        // hasAnyStagedChanges returns true (meaning git diff --quiet failed, callback with error/non-zero status)
        callback(new Error("diff failed"), null, "");
      } else {
        callback(null, { stdout: "" }, "");
      }
      return {} as any;
    });

    const { commitPathsChange } = await import("../src/modules/sources/wiki/content-repo.js");
    await expect(
      commitPathsChange(contentRoot, ["/wiki-root/pages/a.md"], "feat: fail"),
    ).rejects.toThrow("commit failed");
  });

  test("commitFileChange throws error if staged changes remain on failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, args, callback: any) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv.includes("commit")) {
        callback(new Error("commit failed"), null, "");
      } else if (argv.includes("diff") && argv.includes("--cached")) {
        callback(new Error("diff failed"), null, "");
      } else {
        callback(null, { stdout: "" }, "");
      }
      return {} as any;
    });

    const { commitFileChange } = await import("../src/modules/sources/wiki/content-repo.js");
    await expect(
      commitFileChange(contentRoot, "/wiki-root/pages/test.md", "feat: fail"),
    ).rejects.toThrow("commit failed");
  });

  test("commitDeleteChange throws error if staged changes remain on failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, args, callback: any) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv.includes("commit")) {
        callback(new Error("commit failed"), null, "");
      } else if (argv.includes("diff") && argv.includes("--cached")) {
        callback(new Error("diff failed"), null, "");
      } else {
        callback(null, { stdout: "" }, "");
      }
      return {} as any;
    });

    const { commitDeleteChange } = await import("../src/modules/sources/wiki/content-repo.js");
    await expect(
      commitDeleteChange(contentRoot, "/wiki-root/pages/delete-me.md", "feat: fail"),
    ).rejects.toThrow("commit failed");
  });

  test("renameFolder calculates movedPages correctly when folder contains pages", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // source folder check
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValueOnce(error); // new path check

    // mock listPages -> readMarkdownFiles
    // 1st readdir (pagesRoot) finds old-dir directory
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => false, isDirectory: () => true, name: "old-dir" },
    ] as any);
    // 2nd readdir (inside old-dir) finds my-page.md
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => true, isDirectory: () => false, name: "my-page.md" },
    ] as any);

    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);

    vi.mocked(fs.rename).mockResolvedValue(undefined);

    const { renameFolder } = await import("../src/modules/sources/wiki/content-repo.js");
    const result = await renameFolder(contentRoot, "old-dir", "new-dir");
    expect(result.movedPages).toHaveLength(1);
    expect(result.movedPages[0].from).toBe("old-dir/my-page");
    expect(result.movedPages[0].to).toBe("new-dir/my-page");
  });

  test("renameFolder throws generic error if new path stat check throws non-ENOENT error", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // old exists
    const error = new Error("Generic error");
    (error as any).code = "EACCES";
    vi.mocked(fs.stat).mockRejectedValueOnce(error); // new stat check throws EACCES

    const { renameFolder } = await import("../src/modules/sources/wiki/content-repo.js");
    await expect(renameFolder(contentRoot, "old-dir", "new-dir")).rejects.toThrow("Generic error");
  });

  test("renameFolder throws error if old path is not a directory", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => false,
      isFile: () => true,
    } as any); // old exists but is not directory

    const { renameFolder } = await import("../src/modules/sources/wiki/content-repo.js");
    await expect(renameFolder(contentRoot, "old-dir", "new-dir")).rejects.toThrow(
      "Folder not found",
    );
  });

  test("getGitSummary returns null on git error", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(new Error("git error"), null, "");
      return {} as any;
    });

    const summary = await getGitSummary(contentRoot);
    expect(summary).toBeNull();
  });
});
