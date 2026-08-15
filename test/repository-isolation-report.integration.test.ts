import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db/index.js";
import { episodeCards, knowledgeItems, projectIdentityAliases, sources } from "../src/db/schema.js";
import { collectRepositoryIsolationReport } from "../src/modules/context-compiler/repository-isolation-report.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

type FixtureCandidate = {
  id: string;
  entityKind: "knowledge" | "source" | "episode";
  status: string;
  classificationStatus: "classified" | "unresolved" | "malformed" | "conflict";
  scope: "repo" | "global";
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
  general: boolean;
  producer?: string;
  facets: {
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
  };
};

type Fixture = {
  aliases: Array<{
    projectRef: string;
    aliasKind: "repo_key" | "repo_path";
    normalizedValue: string;
  }>;
  candidates: FixtureCandidate[];
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/context-compile-repository-isolation-v1.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function fixtureUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

describeDb("PostgreSQL repository isolation read-only report", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
    await db.delete(projectIdentityAliases);
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("reads the same cross-repository fixture as SQLite", async () => {
    await db
      .insert(projectIdentityAliases)
      .values(fixture.aliases.map((alias) => ({ ...alias, source: "fixture" })));
    const ids = new Map(
      fixture.candidates.map((candidate, index) => [candidate.id, fixtureUuid(index)]),
    );
    const knowledge = fixture.candidates.filter((item) => item.entityKind === "knowledge");
    const sourceCandidates = fixture.candidates.filter((item) => item.entityKind === "source");
    const episodes = fixture.candidates.filter((item) => item.entityKind === "episode");
    await db.insert(knowledgeItems).values(
      knowledge.map((item) => ({
        id: ids.get(item.id),
        type: "rule",
        status: item.status,
        scope: item.scope,
        classificationStatus: item.classificationStatus,
        projectRef: item.projectRef ?? null,
        repoKey: item.repoKey ?? null,
        repoPath: item.repoPath ?? null,
        title: "fixture title",
        body: "fixture body",
        appliesTo: { ...item.facets, general: item.general },
        metadata: { producer: item.producer ?? "fixture" },
      })),
    );
    await db.insert(sources).values(
      sourceCandidates.map((item) => ({
        id: ids.get(item.id),
        sourceKind: "wiki",
        classificationStatus: item.classificationStatus,
        scope: item.scope,
        projectRef: item.projectRef ?? null,
        repoKey: item.repoKey ?? null,
        repoPath: item.repoPath ?? null,
        uri: `fixture://${item.id}`,
        body: "fixture body",
        metadata: { ...item.facets, general: item.general },
      })),
    );
    await db.insert(episodeCards).values(
      episodes.map((item) => ({
        id: ids.get(item.id),
        title: "fixture title",
        situation: "fixture situation",
        applicability: { general: item.general },
        technologies: item.facets.technologies ?? [],
        changeTypes: item.facets.changeTypes ?? [],
        domains: item.facets.domains ?? [],
        classificationStatus: item.classificationStatus,
        scope: item.scope,
        projectRef: item.projectRef ?? null,
        repoKey: item.repoKey ?? null,
        repoPath: item.repoPath ?? null,
        sourceKind: item.producer ?? "compile_run",
        sourceKey: item.id,
        status: item.status,
      })),
    );

    const report = await collectRepositoryIsolationReport({
      identityInput: { projectRef: "project-A" },
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    expect(report.backend).toBe("postgres");
    expect(report.inventory.knowledge).toMatchObject({
      total: 12,
      classifications: { global: 2, repo: 7, unresolved: 1, malformed: 1, conflict: 1 },
    });
    expect(report.inventory.source.total).toBe(5);
    expect(report.inventory.episode.total).toBe(5);
    expect(report.requestComparison?.wouldSelectCount).toBe(8);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("fixture title");
    expect(serialized).not.toContain("fixture body");
    expect(serialized).not.toContain("/work/");
  });
});
