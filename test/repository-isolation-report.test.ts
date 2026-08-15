import { describe, expect, test } from "vitest";
import { buildRepositoryIsolationReport } from "../src/modules/context-compiler/repository-isolation-report.js";
import type { RepositoryScopeCandidate } from "../src/modules/context-compiler/repository-scope.js";

const candidate: RepositoryScopeCandidate = {
  id: "repo-item",
  entityKind: "knowledge",
  status: "active",
  classificationStatus: "classified",
  scope: "repo",
  projectRef: "project-A",
  repoKey: null,
  repoPath: null,
  general: true,
  facets: {},
  producer: "fixture",
};

function run(overrides: {
  id: string;
  scopeMode: "project" | "global_only";
  matchBasis: "project_ref" | "repo_key" | "repo_path" | "none";
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  identityContractVersion?: number;
}) {
  return {
    id: overrides.id,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    durationMs: 1,
    status: "ok",
    degradedReasons: [],
    scopeMode: overrides.scopeMode,
    matchBasis: overrides.matchBasis,
    projectRef: overrides.projectRef ?? null,
    repoKey: overrides.repoKey ?? null,
    repoPath: overrides.repoPath ?? null,
    identityContractVersion: overrides.identityContractVersion ?? 1,
    outputMarkdownKind: "narrative" as const,
    selectedIdsByEntity: { knowledge: [candidate.id], source: [], episode: [] },
  };
}

describe("repository isolation report run identity", () => {
  test("fails closed for inconsistent, incomplete, or unsupported run identity", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [candidate],
      runs: [
        run({
          id: "valid",
          scopeMode: "project",
          matchBasis: "project_ref",
          projectRef: "project-A",
        }),
        run({
          id: "global-mode-with-project-fields",
          scopeMode: "global_only",
          matchBasis: "project_ref",
          projectRef: "project-A",
        }),
        run({
          id: "selected-basis-missing",
          scopeMode: "project",
          matchBasis: "project_ref",
          repoPath: "/work/repo-a",
        }),
        run({
          id: "unsupported-contract",
          scopeMode: "project",
          matchBasis: "project_ref",
          projectRef: "project-A",
          identityContractVersion: 2,
        }),
        run({
          id: "noncanonical-path",
          scopeMode: "project",
          matchBasis: "repo_path",
          repoPath: "/work/repo-a/../repo-a",
        }),
        run({
          id: "relative-path",
          scopeMode: "project",
          matchBasis: "repo_path",
          repoPath: "work/repo-a",
        }),
      ],
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    const reevaluated = Object.fromEntries(
      report.recentRunReevaluation.map((item) => [item.runId, item]),
    );
    expect(reevaluated.valid).toMatchObject({
      identityKnown: true,
      mismatchCount: 0,
    });
    for (const id of [
      "global-mode-with-project-fields",
      "selected-basis-missing",
      "unsupported-contract",
      "noncanonical-path",
      "relative-path",
    ]) {
      expect(reevaluated[id]).toMatchObject({
        identityKnown: false,
        mismatchCount: 1,
      });
    }
    expect(report.baseline.identityPresentRuns).toBe(1);
  });
});
