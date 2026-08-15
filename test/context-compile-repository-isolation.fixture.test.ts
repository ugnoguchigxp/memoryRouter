import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type CompileProjectIdentityAlias,
  CompileProjectIdentityError,
  type CompileProjectIdentityInput,
  resolveCompileProjectIdentity,
} from "../src/modules/context-compiler/compile-project-identity.js";
import {
  type RepositoryFacets,
  type RepositoryScopeCandidate,
  evaluateRepositoryScope,
  selectRepositoryScopedCandidates,
} from "../src/modules/context-compiler/repository-scope.js";

type FixtureCandidate = Omit<
  RepositoryScopeCandidate,
  "projectRef" | "repoKey" | "repoPath" | "producer"
> & {
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
  producer?: string;
};

type Fixture = {
  identities: Array<{
    id: string;
    input: CompileProjectIdentityInput;
    expected: Record<string, unknown>;
  }>;
  invalidIdentities: Array<{
    id: string;
    input: CompileProjectIdentityInput;
    expectedError: string;
  }>;
  aliases: CompileProjectIdentityAlias[];
  conflictingIdentities: Array<{
    id: string;
    input: CompileProjectIdentityInput;
    expectedError: string;
  }>;
  candidates: FixtureCandidate[];
  scenarios: Array<{
    id: string;
    identityId: string;
    requestFacets: RepositoryFacets;
    expectedEligibleIds: string[];
  }>;
  saturation: Array<{
    id: string;
    entityKind: RepositoryScopeCandidate["entityKind"];
    generatedCount: number;
    generatedCandidate: Omit<FixtureCandidate, "id" | "entityKind">;
    anchorCandidateId: string;
    identityId: string;
    requestFacets: RepositoryFacets;
    expectedAnchorEligible: boolean;
  }>;
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/context-compile-repository-isolation-v1.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

function candidate(input: FixtureCandidate): RepositoryScopeCandidate {
  return {
    ...input,
    projectRef: input.projectRef ?? null,
    repoKey: input.repoKey ?? null,
    repoPath: input.repoPath ?? null,
    producer: input.producer ?? "fixture",
  };
}

function identityById(id: string) {
  const fixtureIdentity = fixture.identities.find((item) => item.id === id);
  if (!fixtureIdentity) throw new Error(`missing fixture identity: ${id}`);
  return resolveCompileProjectIdentity(fixtureIdentity.input, {
    aliases: fixture.aliases,
  });
}

describe("context compile repository isolation shared fixture", () => {
  test("normalizes every valid identity and rejects every invalid or conflicting identity", () => {
    for (const item of fixture.identities) {
      expect(
        resolveCompileProjectIdentity(item.input, { aliases: fixture.aliases }),
        item.id,
      ).toMatchObject(item.expected);
    }
    for (const item of [...fixture.invalidIdentities, ...fixture.conflictingIdentities]) {
      try {
        resolveCompileProjectIdentity(item.input, { aliases: fixture.aliases });
        throw new Error(`expected ${item.id} to fail`);
      } catch (error) {
        expect(error, item.id).toBeInstanceOf(CompileProjectIdentityError);
        expect((error as CompileProjectIdentityError).code, item.id).toBe(item.expectedError);
      }
    }
  });

  for (const scenario of fixture.scenarios) {
    test(`scope and facet semantics: ${scenario.id}`, () => {
      const selected = selectRepositoryScopedCandidates(
        fixture.candidates.map(candidate),
        identityById(scenario.identityId),
        scenario.requestFacets,
      );
      expect(selected.map((item) => item.id).sort(), scenario.id).toEqual(
        [...scenario.expectedEligibleIds].sort(),
      );
    });
  }

  for (const saturation of fixture.saturation) {
    test(`scope gate precedes arbitrary limit: ${saturation.id}`, () => {
      const generated = Array.from({ length: saturation.generatedCount }, (_, index) =>
        candidate({
          ...saturation.generatedCandidate,
          id: `${saturation.id}-${String(index).padStart(4, "0")}`,
          entityKind: saturation.entityKind,
        }),
      );
      const anchorFixture = fixture.candidates.find(
        (item) => item.id === saturation.anchorCandidateId,
      );
      if (!anchorFixture)
        throw new Error(`missing saturation anchor: ${saturation.anchorCandidateId}`);
      const anchor = candidate(anchorFixture);
      const identity = identityById(saturation.identityId);
      const selected = selectRepositoryScopedCandidates(
        [...generated, anchor],
        identity,
        saturation.requestFacets,
      );
      expect(selected.some((item) => item.id === anchor.id)).toBe(
        saturation.expectedAnchorEligible,
      );
      expect(selected.some((item) => item.id.startsWith(`${saturation.id}-`))).toBe(false);
    });
  }

  test("selected identity basis never falls back to another populated candidate identity", () => {
    const fixtureCandidate = fixture.candidates.find(
      (item) => item.id === "knowledge-repo-a-lower-basis-only",
    );
    if (!fixtureCandidate) throw new Error("missing lower-basis-only fixture candidate");
    const candidateWithLowerBasisOnly = candidate(fixtureCandidate);
    const decision = evaluateRepositoryScope(
      candidateWithLowerBasisOnly,
      identityById("identity-project-a"),
    );
    expect(decision).toMatchObject({
      allowed: false,
      reason: "PROJECT_IDENTITY_BASIS_MISSING",
    });
  });

  test("normalizes facet separators and punctuation consistently with persisted facets", () => {
    const fixtureCandidate = candidate({
      id: "facet-normalization",
      entityKind: "knowledge",
      status: "active",
      classificationStatus: "classified",
      scope: "global",
      general: false,
      facets: { technologies: ["type_script", "C++"] },
    });
    const identity = identityById("identity-project-a");

    expect(
      evaluateRepositoryScope(fixtureCandidate, identity, {
        technologies: ["Type Script!"],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOW_GLOBAL" });
    expect(
      evaluateRepositoryScope(fixtureCandidate, identity, {
        technologies: ["c++"],
      }),
    ).toMatchObject({ allowed: true, reason: "ALLOW_GLOBAL" });
  });
});
