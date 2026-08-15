import { describe, expect, it } from "vitest";
import {
  PROJECT_IDENTITY_FORBIDDEN,
  PROJECT_IDENTITY_REQUIRED,
  ProjectScopedWriteError,
  resolveProjectScopedWriteIdentity,
} from "../src/modules/context-compiler/project-scoped-write.js";

describe("project-scoped write identity", () => {
  it.each([
    [{ projectRef: "project-a" }, "project_ref", "project-a"],
    [{ repoKey: "Owner/Repo" }, "repo_key", "owner/repo"],
    [{ repoPath: "file:///workspace/repo-a/../repo-b" }, "repo_path", "/workspace/repo-b"],
  ] as const)("classifies a repo write from a canonical identity", (raw, basis, value) => {
    const result = resolveProjectScopedWriteIdentity({ scope: "repo", ...raw });
    expect(result).toMatchObject({
      classificationStatus: "classified",
      scope: "repo",
      scopeMode: "project",
      matchBasis: basis,
    });
    expect(
      result[
        basis === "project_ref" ? "projectRef" : basis === "repo_key" ? "repoKey" : "repoPath"
      ],
    ).toBe(value);
    expect(result.identityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an identity-less repo write with the stable contract code", () => {
    try {
      resolveProjectScopedWriteIdentity({ scope: "repo" });
      expect.fail("expected the write to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectScopedWriteError);
      expect((error as ProjectScopedWriteError).code).toBe(PROJECT_IDENTITY_REQUIRED);
    }
  });

  it("keeps global identity columns null", () => {
    expect(resolveProjectScopedWriteIdentity({ scope: "global" })).toEqual({
      contractVersion: 1,
      classificationStatus: "classified",
      scope: "global",
      scopeMode: "global_only",
      projectRef: null,
      repoKey: null,
      repoPath: null,
      matchBasis: "none",
      identityFingerprint: null,
      bindingStatus: "not_applicable",
    });
  });

  it("rejects identity on a global write instead of silently discarding it", () => {
    try {
      resolveProjectScopedWriteIdentity({ scope: "global", repoKey: "owner/repo" });
      expect.fail("expected the write to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectScopedWriteError);
      expect((error as ProjectScopedWriteError).code).toBe(PROJECT_IDENTITY_FORBIDDEN);
    }
  });
});
