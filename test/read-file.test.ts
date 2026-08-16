// Bunグローバルのモック (Node環境でVitestを動かすため)
if (typeof (globalThis as any).Bun === "undefined") {
  (globalThis as any).Bun = {
    markdown: {
      render: (markdown: string, callbacks: any) => {
        let result = markdown;
        // 簡易的な Markdown -> PlainText 変換のモック
        result = result.replace(/^#\s+(.+)$/gm, (_, p1) => {
          return callbacks.heading ? callbacks.heading(p1) : `${p1}\n\n`;
        });
        result = result.replace(/\*\*(.*?)\*\*/g, (_, p1) => {
          return callbacks.strong ? callbacks.strong(p1) : p1;
        });
        result = result.replace(/\[(.*?)\]\((.*?)\)/g, (_, p1, p2) => {
          return callbacks.link ? callbacks.link(p1, { href: p2 }) : p1;
        });
        return result;
      },
    },
  };
}

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileDomain } from "../src/modules/readFile/domain.js";
import { markdownifyContent } from "../src/modules/readFile/markdownify.service.js";
import {
  maybeStripFrontmatter,
  normalizeReadFileText,
  stripMarkdownFormatting,
} from "../src/modules/readFile/normalize.service.js";
import { sliceTextByTokenWindow } from "../src/modules/readFile/token-window.service.js";

// fs と config をモックする
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("../src/config.js", () => {
  return {
    groupedConfig: {
      readFile: {
        root: "/mock/root",
        defaultTokens: 10,
        maxTokens: 100,
      },
    },
  };
});

describe("markdownifyContent", () => {
  it("should return content as is if extension is markdown (e.g. .md)", () => {
    const content = "# Heading\nSome content";
    const result = markdownifyContent({ content, filePath: "test.md" });
    expect(result).toBe(content);
  });

  it("should convert HTML content to markdown if extension is HTML (e.g. .html)", () => {
    const content = "<h1>Heading</h1><p>Some content</p>";
    const result = markdownifyContent({ content, filePath: "test.html" });
    expect(result.trim()).toBe("# Heading\n\nSome content");
  });

  it("should convert HTML content if file content matches HTML pattern regardless of extension", () => {
    const content = "<div><p>Some content</p></div>";
    const result = markdownifyContent({ content, filePath: "test.json" });
    expect(result.trim()).toBe("Some content");
  });

  it("should return content as is if not markdown/html and not html-like", () => {
    const content = "Just plain text without html tag";
    const result = markdownifyContent({ content, filePath: "test.log" });
    expect(result).toBe(content);
  });
});

describe("normalize service", () => {
  describe("maybeStripFrontmatter", () => {
    const markdownWithFrontmatter = "---\ntitle: Test\n---\nActual content here";

    it("should keep frontmatter if includeFrontmatter is true", () => {
      const result = maybeStripFrontmatter(markdownWithFrontmatter, true);
      expect(result).toBe(markdownWithFrontmatter);
    });

    it("should strip frontmatter if includeFrontmatter is false", () => {
      const result = maybeStripFrontmatter(markdownWithFrontmatter, false);
      expect(result.trim()).toBe("Actual content here");
    });

    it("should return original string if it does not start with ---", () => {
      const markdownWithoutFrontmatter = "Actual content without frontmatter";
      const result = maybeStripFrontmatter(markdownWithoutFrontmatter, false);
      expect(result).toBe(markdownWithoutFrontmatter);
    });
  });

  describe("stripMarkdownFormatting", () => {
    it("should strip markdown formatting using Bun.markdown.render", () => {
      const markdown = "# Header\n**Bold Text**\n[link](http://example.com)";
      const result = stripMarkdownFormatting(markdown);
      expect(result).toContain("Header");
      expect(result).toContain("Bold Text");
      expect(result).toContain("link");
    });
  });

  describe("normalizeReadFileText", () => {
    it("should normalize line endings from CRLF to LF", () => {
      const text = "line1\r\nline2\r\n";
      const result = normalizeReadFileText({ text, minify: false });
      expect(result).toBe("line1\nline2\n");
    });

    it("should minify whitespace if minify is true", () => {
      const text = "  line1  \n   line2 \t\t line3  ";
      const result = normalizeReadFileText({ text, minify: true });
      expect(result).toBe("line1 line2 line3");
    });

    it("should not minify if minify is false", () => {
      const text = "  line1  \n   line2 \t\t line3  ";
      const result = normalizeReadFileText({ text, minify: false });
      expect(result).toBe(text);
    });
  });
});

describe("sliceTextByTokenWindow", () => {
  const text = "one two three four five"; // 5 tokens

  it("should slice by token window and return token slice with nextFromToken", () => {
    const result = sliceTextByTokenWindow({ text, fromToken: 1, readTokens: 2 });
    expect(result).toEqual({
      content: "two three",
      tokenRange: { from: 1, toExclusive: 3 },
      totalTokens: 5,
      returnedTokens: 2,
      hasMore: true,
      nextFromToken: 3,
    });
  });

  it("should handle hasMore: false when reaching the end", () => {
    const result = sliceTextByTokenWindow({ text, fromToken: 3, readTokens: 3 });
    expect(result).toEqual({
      content: "four five",
      tokenRange: { from: 3, toExclusive: 5 },
      totalTokens: 5,
      returnedTokens: 2,
      hasMore: false,
      nextFromToken: undefined,
    });
  });

  it("should return empty content if text is empty", () => {
    const result = sliceTextByTokenWindow({ text: "", fromToken: 0, readTokens: 5 });
    expect(result).toEqual({
      content: "",
      tokenRange: { from: 0, toExclusive: 0 },
      totalTokens: 0,
      returnedTokens: 0,
      hasMore: false,
      nextFromToken: undefined,
    });
  });

  it("should return empty content if fromToken is out of bound", () => {
    const result = sliceTextByTokenWindow({ text, fromToken: 5, readTokens: 5 });
    expect(result).toEqual({
      content: "",
      tokenRange: { from: 5, toExclusive: 5 },
      totalTokens: 5,
      returnedTokens: 0,
      hasMore: false,
      nextFromToken: undefined,
    });
  });
});

describe("readFileDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(realpath).mockImplementation(async (value) => path.resolve(String(value)));
    vi.mocked(stat).mockResolvedValue({ size: 1024 } as any);
  });

  it("should throw error if path is empty", async () => {
    await expect(readFileDomain({ path: "" })).rejects.toThrow("path must be a non-empty string");
  });

  it("should throw error if path is outside rootPath", async () => {
    await expect(readFileDomain({ path: "../outside" })).rejects.toThrow(
      "path must be inside read_file root",
    );
  });

  it("should reject a symbolic link that resolves outside rootPath", async () => {
    vi.mocked(realpath).mockImplementation(async (value) =>
      String(value) === "/mock/root" ? "/mock/root" : "/outside/secret.md",
    );

    await expect(readFileDomain({ path: "linked-secret.md" })).rejects.toThrow(
      "path must be inside read_file root",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("should reject files larger than the input byte limit", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 16 * 1024 * 1024 + 1 } as any);

    await expect(readFileDomain({ path: "large.md" })).rejects.toThrow(
      "read_file input exceeds 16777216 bytes",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("should read and process file correctly", async () => {
    const fileContent = "---\ntitle: Hello\n---\n# Welcome\nThis is a test file.";
    vi.mocked(readFile).mockResolvedValue(fileContent);

    const result = await readFileDomain({
      path: "test.md",
      fromToken: 0,
      readTokens: 10,
      includeFrontmatter: false,
      minify: false,
    });

    expect(readFile).toHaveBeenCalledWith("/mock/root/test.md", "utf8");
    expect(result.content).toContain("# Welcome");
    expect(result.content).toContain("Welcome");
    expect(result.content).toContain("This is a test file");
    expect(result.from).toBe(0);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.returnedTokens).toBeGreaterThan(0);
  });

  it("should support both minify and minifiy (typo)", async () => {
    const fileContent = "word1\nword2\nword3";
    vi.mocked(readFile).mockResolvedValue(fileContent);

    const resultWithMinifiy = await readFileDomain({
      path: "test.md",
      minifiy: true,
    });
    expect(resultWithMinifiy.content).toBe("word1 word2 word3");

    const resultWithMinify = await readFileDomain({
      path: "test.md",
      minify: true,
    });
    expect(resultWithMinify.content).toBe("word1 word2 word3");
  });

  it("should strip markdown only in compressed mode", async () => {
    const fileContent = "# Title\n**important**";
    vi.mocked(readFile).mockResolvedValue(fileContent);

    const compressed = await readFileDomain({
      path: "test.md",
      minify: true,
    });
    expect(compressed.content).toBe("Title important");

    const original = await readFileDomain({
      path: "test.md",
      minify: false,
    });
    expect(original.content).toContain("# Title");
    expect(original.content).toContain("**important**");
  });
});
