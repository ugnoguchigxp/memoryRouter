import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  mergeApplicabilityInput,
  normalizeKnowledgeApplicability,
  parseApplicabilityFromRecord,
} from "../src/modules/knowledge/applicability.service.js";
import { listKnowledgeTagDefinitions } from "../src/modules/knowledge/knowledge-tags.repository.js";

vi.mock("../src/modules/knowledge/knowledge-tags.repository.js", () => ({
  listKnowledgeTagDefinitions: vi.fn(),
}));

describe("knowledge applicability service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("normalizes aliases to canonical tags", async () => {
    vi.mocked(listKnowledgeTagDefinitions).mockResolvedValue([
      {
        id: "tag-1",
        kind: "technology",
        slug: "typescript",
        label: "TypeScript",
        description: null,
        aliases: ["ts"],
        status: "active",
        sortOrder: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const result = await normalizeKnowledgeApplicability({
      technologies: ["ts"],
    });

    expect(result.appliesTo.technologies).toEqual(["typescript"]);
    expect(result.warnings.some((warning) => warning.includes("normalized technology"))).toBe(true);
  });

  test("tracks unknown tags as candidates", async () => {
    vi.mocked(listKnowledgeTagDefinitions).mockResolvedValue([] as any);
    const result = await normalizeKnowledgeApplicability({
      technologies: ["fastapi"],
    });
    expect(result.unknownTagCandidates).toHaveLength(1);
    expect(result.unknownTagCandidates[0]?.normalizedSlug).toBe("fastapi");
    expect(result.appliesTo.technologies).toEqual(["fastapi"]);
  });

  test("does not derive a legacy repoKey from repoPath", async () => {
    vi.mocked(listKnowledgeTagDefinitions).mockResolvedValue([] as any);
    const result = await normalizeKnowledgeApplicability({ repoPath: "/workspace/repo-a" });
    expect(result.appliesTo).toMatchObject({ repoPath: "/workspace/repo-a" });
    expect(result.appliesTo).not.toHaveProperty("repoKey");
  });

  test("mergeApplicabilityInput merges top-level and appliesTo facets", () => {
    const merged = mergeApplicabilityInput({
      appliesTo: {
        general: true,
        technologies: ["typescript"],
        changeTypes: ["schema"],
        repoPath: "/workspace/repo-a",
      },
      general: "false",
      technologies: ["python"],
      changeTypes: ["feature"],
      repoPath: "/workspace/repo-b",
      repoKey: "repo-b",
    });

    expect(merged.technologies).toEqual(["python", "typescript"]);
    expect(merged.changeTypes).toEqual(["feature", "schema"]);
    expect(merged.general).toBe(false);
    expect(merged.repoPath).toBe("/workspace/repo-b");
    expect(merged.repoKey).toBe("repo-b");
  });

  // 追加されたテストケース
  describe("toStringArray - conversion and split tests", () => {
    test("converts comma-separated string to string array", () => {
      const merged = mergeApplicabilityInput({
        technologies: "ts, js, react",
      });
      expect(merged.technologies).toEqual(["ts", "js", "react"]);
    });

    test("handles non-string/non-array gracefully by returning empty array", () => {
      const merged = mergeApplicabilityInput({
        technologies: 12345 as any,
      });
      expect(merged.technologies).toEqual([]);
    });
  });

  describe("asBoolean - boolean conversion tests", () => {
    test("converts various values to boolean", () => {
      const caseTrueString = mergeApplicabilityInput({ general: "true" });
      expect(caseTrueString.general).toBe(true);

      const caseFalseString = mergeApplicabilityInput({ general: "false" });
      expect(caseFalseString.general).toBe(false);

      const caseBooleanTrue = mergeApplicabilityInput({ general: true });
      expect(caseBooleanTrue.general).toBe(true);

      const caseBooleanFalse = mergeApplicabilityInput({ general: false });
      expect(caseBooleanFalse.general).toBe(false);

      const caseInvalidString = mergeApplicabilityInput({ general: "maybe" });
      expect(caseInvalidString.general).toBeUndefined();

      const caseNull = mergeApplicabilityInput({ general: null });
      expect(caseNull.general).toBeUndefined();
    });
  });

  describe("normalizeKnowledgeApplicability error handling", () => {
    test("adds warning when tag definitions fail to load", async () => {
      vi.mocked(listKnowledgeTagDefinitions).mockRejectedValue(new Error("Database failure"));

      const result = await normalizeKnowledgeApplicability({
        technologies: ["typescript"],
      });

      expect(result.warnings).toContain(
        "knowledge tag definitions unavailable; applying best-effort normalization",
      );
      // fallback maps will be empty, so "typescript" will be treated as unknown tag candidate
      expect(result.unknownTagCandidates).toHaveLength(1);
      expect(result.unknownTagCandidates[0]?.normalizedSlug).toBe("typescript");
      expect(result.appliesTo.technologies).toEqual(["typescript"]);
    });
  });

  describe("parseApplicabilityFromRecord tests", () => {
    test("parses appliesTo record correctly", () => {
      const record = {
        general: "true",
        technologies: ["ts", "rust"],
        changeTypes: "schema,feature",
        repoPath: "/workspace/project",
        repoKey: "project",
      };

      const parsed = parseApplicabilityFromRecord(record);

      expect(parsed.general).toBe(true);
      expect(parsed.technologies).toEqual(["ts", "rust"]);
      expect(parsed.changeTypes).toEqual(["schema", "feature"]);
      expect(parsed.repoPath).toBe("/workspace/project");
      expect(parsed.repoKey).toBe("project");
    });

    test("handles null or undefined input records gracefully", () => {
      const parsedNull = parseApplicabilityFromRecord(null);
      expect(parsedNull.general).toBeUndefined();
      expect(parsedNull.technologies).toEqual([]);

      const parsedUndefined = parseApplicabilityFromRecord(undefined);
      expect(parsedUndefined.general).toBeUndefined();
    });
  });

  describe("toSlug formatting tests", () => {
    test("converts various formats into clean slugs", async () => {
      vi.mocked(listKnowledgeTagDefinitions).mockResolvedValue([] as any);

      const result = await normalizeKnowledgeApplicability({
        technologies: ["Type_Script!! ", "  React-Router  ", "c#"],
      });

      const slugs = result.unknownTagCandidates.map((c) => c.normalizedSlug);
      expect(slugs).toContain("type-script");
      expect(slugs).toContain("react-router");
      expect(slugs).toContain("c"); // non-alphanumeric replacement
    });
  });
});
