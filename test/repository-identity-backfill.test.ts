import { describe, expect, test } from "vitest";
import {
  type RepositoryIdentityBackfillRow,
  planRepositoryIdentityBackfill,
} from "../src/modules/context-compiler/repository-identity-backfill.js";

function row(overrides: Partial<RepositoryIdentityBackfillRow>): RepositoryIdentityBackfillRow {
  return {
    id: "item-1",
    entityKind: "knowledge",
    classificationStatus: "unresolved",
    scope: "repo",
    projectRef: null,
    repoKey: null,
    repoPath: null,
    metadata: {},
    ...overrides,
  };
}

describe("repository identity deterministic backfill", () => {
  test("classifies exact canonical metadata and is deterministic", () => {
    const input = {
      rows: [
        row({
          metadata: {
            projectIdentity: {
              classificationStatus: "classified",
              scope: "repo",
              repoPath: "/work/repo-a/./",
            },
          },
        }),
      ],
    };
    const first = planRepositoryIdentityBackfill(input);
    const second = planRepositoryIdentityBackfill(input);
    expect(second).toEqual(first);
    expect(first.counts.backfilled).toBe(1);
    expect(first.decisions[0]).toMatchObject({
      changed: true,
      reasonCode: "authoritative_identity_exact_match",
      after: {
        classificationStatus: "classified",
        scope: "repo",
        repoPath: "/work/repo-a",
      },
    });
  });

  test("uses authoritative aliases and rejects conflicting identity", () => {
    const aliases = [
      { projectRef: "project-A", aliasKind: "repo_key" as const, normalizedValue: "org/repo-a" },
    ];
    const accepted = planRepositoryIdentityBackfill({
      aliases,
      rows: [row({ metadata: { repoKey: "ORG\\Repo-A" } })],
    });
    expect(accepted.decisions[0]?.after).toMatchObject({
      classificationStatus: "classified",
      projectRef: "project-A",
      repoKey: "org/repo-a",
    });

    const conflict = planRepositoryIdentityBackfill({
      aliases,
      rows: [row({ metadata: { projectRef: "project-B", repoKey: "org/repo-a" } })],
    });
    expect(conflict.decisions[0]).toMatchObject({
      outcome: "conflict",
      reasonCode: "identity_conflict",
      after: { classificationStatus: "conflict" },
    });
  });

  test("does not infer from content, URI, basename, or identityless provenance", () => {
    const result = planRepositoryIdentityBackfill({
      rows: [
        row({
          metadata: {
            sourceUri: "cover-evidence-result://repo-a",
            title: "repo-a",
            relativePath: "repo-a/file.ts",
            gitRemote: "git@example.invalid:org/repo-a.git",
          },
          provenance: [{ source: "target_state", snapshot: { title: "repo-a" } }],
        }),
      ],
    });
    expect(result.decisions[0]).toMatchObject({
      changed: false,
      outcome: "unresolved",
      reasonCode: "no_authoritative_identity_provenance",
    });
  });

  test("marks invalid exact identity malformed and never auto-promotes global", () => {
    const invalid = planRepositoryIdentityBackfill({
      rows: [row({ metadata: { repoPath: "relative/repo-a" } })],
    });
    expect(invalid.decisions[0]).toMatchObject({
      outcome: "malformed",
      after: { classificationStatus: "malformed", scope: "repo" },
    });

    const unresolvedGlobal = planRepositoryIdentityBackfill({
      rows: [row({ scope: "global" })],
    });
    expect(unresolvedGlobal.decisions[0]?.after).toMatchObject({
      classificationStatus: "unresolved",
      scope: "repo",
    });
  });

  test("requires an explicit reviewed decision for global promotion", () => {
    const result = planRepositoryIdentityBackfill({
      rows: [row({ explicitGlobalPromotion: true })],
    });
    expect(result.decisions[0]).toMatchObject({
      changed: true,
      outcome: "global_promoted",
      provenanceSource: "user_reviewed_global_promotion",
      after: {
        classificationStatus: "classified",
        scope: "global",
        projectRef: null,
        repoKey: null,
        repoPath: null,
      },
    });
  });

  test("compile run provenance is accepted only when it contains exact identity", () => {
    const accepted = planRepositoryIdentityBackfill({
      rows: [
        row({
          entityKind: "episode",
          provenance: [
            {
              source: "compile_run",
              snapshot: { projectRef: "project-A", repoPath: "/work/repo-a" },
            },
          ],
        }),
      ],
    });
    expect(accepted.decisions[0]?.after).toMatchObject({
      classificationStatus: "classified",
      projectRef: "project-A",
      repoPath: "/work/repo-a",
    });

    const legacy = planRepositoryIdentityBackfill({
      rows: [
        row({
          entityKind: "episode",
          provenance: [{ source: "compile_run", snapshot: { daemonRepoPath: "/work/repo-a" } }],
        }),
      ],
    });
    expect(legacy.decisions[0]).toMatchObject({
      outcome: "unresolved",
      reasonCode: "no_authoritative_identity_provenance",
    });
  });
});
