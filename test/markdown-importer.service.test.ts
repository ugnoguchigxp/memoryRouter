import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  collectMarkdownFiles,
  importMarkdownDirectory,
} from "../src/modules/sources/markdown-importer.service.js";
import {
  deleteStaleSourcesForRoot,
  upsertSourceDocument,
} from "../src/modules/sources/source.repository.js";
import { enqueueFindingJob, findFindingJob } from "../src/modules/queue/core/index.js";

vi.mock("node:fs/promises");
vi.mock("../src/modules/sources/source.repository.js");
vi.mock("../src/modules/queue/core/index.js");

describe("Markdown Importer Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteStaleSourcesForRoot).mockResolvedValue(0);
    vi.mocked(findFindingJob).mockResolvedValue(null);
    vi.mocked(enqueueFindingJob).mockResolvedValue({ id: "job-1" } as any);
  });

  test("collects markdown files recursively", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "a.md", parentPath: "/root" },
      { isFile: () => true, name: "b.txt", parentPath: "/root" },
      { isFile: () => false, name: "subdir", parentPath: "/root" },
    ] as any);

    const files = await collectMarkdownFiles("/root");
    expect(files).toEqual(["/root/a.md"]);
  });

  test("imports a directory of markdown files", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue(
      '---\ntitle: "Frontmatter Title"\n---\n# Heading Title\nBody content',
    );
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");

    const result = await importMarkdownDirectory("/root", { scope: "global" });

    expect(result.importedFiles).toBe(1);
    expect(result.files[0].sourceId).toBe("s1");
    expect(upsertSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Frontmatter Title",
      }),
    );
  });

  test("enqueues wiki markdown files using read root relative target keys", async () => {
    const filePath = "/Users/y.noguchi/Code/contextStill/wiki/pages/skill/test.md";
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: path.dirname(filePath) },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("# Test\nBody content");
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");

    const result = await importMarkdownDirectory(path.dirname(filePath), {
      scope: "repo",
      projectRoot: "/Users/y.noguchi/Code/contextStill",
    });

    expect(result.enqueuedFindingJobs).toBe(1);
    expect(enqueueFindingJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inputKind: "source_target",
        sourceKind: "wiki_file",
        sourceKey: "skill/test.md",
        sourceUri: filePath,
      }),
    );
  });

  test("does not reset existing finding jobs on re-import", async () => {
    const filePath = "/Users/y.noguchi/Code/contextStill/wiki/pages/skill/test.md";
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: path.dirname(filePath) },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("# Test\nBody content");
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");
    vi.mocked(findFindingJob).mockResolvedValue({ id: "existing-job" } as any);

    const result = await importMarkdownDirectory(path.dirname(filePath), {
      scope: "repo",
      projectRoot: "/Users/y.noguchi/Code/contextStill",
    });

    expect(result.enqueuedFindingJobs).toBe(0);
    expect(result.skippedFindingJobs).toBe(1);
    expect(enqueueFindingJob).not.toHaveBeenCalled();
  });

  test("uses inferred title when frontmatter is missing", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("# Heading Title\nBody content");
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");

    await importMarkdownDirectory("/root", { scope: "global" });

    expect(upsertSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Heading Title",
      }),
    );
  });

  test("skips empty files", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "empty.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("  \n ");

    const result = await importMarkdownDirectory("/root", { scope: "global" });

    expect(result.skippedFiles).toBe(1);
    expect(upsertSourceDocument).not.toHaveBeenCalled();
  });

  test("keeps content root separate from the captured project root", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "plan.md", parentPath: "/repo/spec/docs" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("# Plan\nBody");
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");

    await importMarkdownDirectory("/repo/spec/docs", {
      scope: "repo",
      projectRoot: "/repo",
    });

    expect(upsertSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "repo",
        repoPath: "/repo",
        metadata: expect.objectContaining({
          repoPath: "/repo",
          sourceRootPath: "/repo/spec/docs",
        }),
      }),
    );
  });

  test("rejects a relative project root instead of resolving it from cwd", async () => {
    vi.mocked(readdir).mockResolvedValue([] as any);

    await expect(
      importMarkdownDirectory("/repo/spec/docs", {
        scope: "repo",
        projectRoot: "../repo",
      }),
    ).rejects.toThrow("repoPath must be absolute");
    expect(upsertSourceDocument).not.toHaveBeenCalled();
  });
});
