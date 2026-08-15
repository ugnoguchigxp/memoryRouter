import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CompileProjectIdentityError,
  resolveCompileProjectIdentity,
} from "../src/modules/context-compiler/compile-project-identity.js";
import { compileInputSchema } from "../src/shared/schemas/compile.schema.js";

type Fixture = {
  valid: Array<{
    name: string;
    input: { projectRef?: string; repoKey?: string; repoPath?: string };
    expected: Record<string, unknown>;
  }>;
  invalid: Array<{
    name: string;
    input: { projectRef?: string; repoKey?: string; repoPath?: string };
    code: string;
  }>;
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/context-compile-project-identity.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("compile project identity", () => {
  for (const item of fixture.valid) {
    test(item.name, () => {
      const result = resolveCompileProjectIdentity(item.input);
      expect(result).toMatchObject(item.expected);
      if (result.matchBasis === "none") {
        expect(result.identityFingerprint).toBeNull();
      } else {
        expect(result.identityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      }
    });
  }

  for (const item of fixture.invalid) {
    test(item.name, () => {
      try {
        resolveCompileProjectIdentity(item.input);
        throw new Error("expected identity resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CompileProjectIdentityError);
        expect((error as CompileProjectIdentityError).code).toBe(item.code);
      }
    });
  }

  test("authoritative aliases verify multiple identifiers", () => {
    const result = resolveCompileProjectIdentity(
      {
        projectRef: "project-A",
        repoKey: "ORG/Repo-A",
        repoPath: "/work/repo-a",
      },
      {
        aliases: [
          { projectRef: "project-A", aliasKind: "repo_key", normalizedValue: "org/repo-a" },
          { projectRef: "project-A", aliasKind: "repo_path", normalizedValue: "/work/repo-a" },
        ],
      },
    );
    expect(result.bindingStatus).toBe("verified");
  });

  test("authoritative alias conflicts fail closed", () => {
    expect(() =>
      resolveCompileProjectIdentity(
        { projectRef: "project-A", repoPath: "/work/repo-b" },
        {
          aliases: [
            { projectRef: "project-B", aliasKind: "repo_path", normalizedValue: "/work/repo-b" },
          ],
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "IDENTITY_CONFLICT" }));
  });

  test("repo paths remain case sensitive", () => {
    const upper = resolveCompileProjectIdentity({ repoPath: "/Work/Repo" });
    const lower = resolveCompileProjectIdentity({ repoPath: "/work/repo" });
    expect(upper.matchValue).not.toBe(lower.matchValue);
    expect(upper.identityFingerprint).not.toBe(lower.identityFingerprint);
  });

  test("length limits count Unicode code points consistently", () => {
    expect(resolveCompileProjectIdentity({ projectRef: "😀".repeat(256) }).projectRef).toHaveLength(
      512,
    );
    expect(
      compileInputSchema.safeParse({
        goal: "Unicode project identity",
        projectRef: "😀".repeat(256),
      }).success,
    ).toBe(true);
    expect(() => resolveCompileProjectIdentity({ projectRef: "😀".repeat(257) })).toThrowError(
      expect.objectContaining({ code: "INVALID_PROJECT_REF" }),
    );
    expect(
      compileInputSchema.safeParse({
        goal: "Unicode project identity",
        projectRef: "😀".repeat(257),
      }).success,
    ).toBe(false);
  });

  test("compile input rejects controls before trimming", () => {
    expect(
      compileInputSchema.safeParse({ goal: "Control validation", projectRef: "project-A\n" })
        .success,
    ).toBe(false);
    expect(
      compileInputSchema.safeParse({ goal: "Control validation", repoKey: "repo-A\t" }).success,
    ).toBe(false);
  });

  test("internal compile input rejects unknown keys", () => {
    expect(
      compileInputSchema.safeParse({ goal: "Strict compile input", unexpectedIdentity: "repo-A" })
        .success,
    ).toBe(false);
  });
});
