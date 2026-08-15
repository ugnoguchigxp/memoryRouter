import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import {
  getRuntimeSettingsSnapshot,
  saveRuntimeSettings,
} from "../src/modules/settings/settings.service.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function parsePackJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const runIdMarker = trimmed.indexOf('"runId"');
  if (runIdMarker < 0) {
    throw new Error("runId not found in CLI output");
  }
  const jsonStart = trimmed.lastIndexOf("{", runIdMarker);
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error("JSON object not found in CLI output");
  }
  return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
}

describeDb("cli compile e2e", () => {
  let originalRuntimeSettings: ReturnType<typeof getRuntimeSettingsSnapshot> | null = null;

  beforeAll(async () => {
    await ensureDbIntegrationReady();
    originalRuntimeSettings = structuredClone(getRuntimeSettingsSnapshot());
    const settings = structuredClone(originalRuntimeSettings);
    settings.taskRouting.agenticCompile.enabled = false;
    await saveRuntimeSettings({
      settings,
      updatedBy: "integration-test",
    });
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    if (originalRuntimeSettings) {
      await saveRuntimeSettings({
        settings: originalRuntimeSettings,
        updatedBy: "integration-test-restore",
      });
    }
    await closeIntegrationDb();
  });

  test("bun run compile --json returns parseable context pack JSON", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///cli/knowledge.md",
      type: "rule",
      status: "active",
      scope: "repo",
      repoPath: process.cwd(),
      title: "CLI rule",
      body: "cli compile goal",
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      scope: "global",
      uri: "file:///cli/source.md",
      title: "CLI source",
      body: "cli compile goal source",
    });

    const run = spawnSync(
      "bun",
      [
        "run",
        "src/cli/compile.ts",
        "--goal",
        "cli compile goal",
        "--repo-path",
        process.cwd(),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_ROUTER_RUN_DB_TESTS: "1",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const output = run.stdout.trim();
    expect(output.length).toBeGreaterThan(0);
    const parsed = parsePackJson(output);
    expect(typeof parsed.runId).toBe("string");
    expect(
      parsed.status === "ok" || parsed.status === "degraded" || parsed.status === "failed",
    ).toBe(true);
    expect(typeof parsed.retrievalMode).toBe("string");
    expect(typeof parsed.diagnostics).toBe("object");
  });

  test("compile accepts change type, technology, and domain flags", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///cli/procedure.md",
      type: "procedure",
      status: "active",
      scope: "repo",
      repoPath: process.cwd(),
      title: "CLI Procedure",
      body: "draft-mode command sequence",
      appliesTo: {
        changeTypes: ["procedure"],
        technologies: ["typescript"],
        domains: ["context-compiler"],
      },
    });

    const run = spawnSync(
      "bun",
      [
        "run",
        "src/cli/compile.ts",
        "--goal",
        "draft-mode command sequence",
        "--change-types",
        "procedure",
        "--technologies",
        "typescript",
        "--domains",
        "context-compiler",
        "--repo-path",
        process.cwd(),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_ROUTER_RUN_DB_TESTS: "1",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const parsed = parsePackJson(run.stdout) as {
      procedures?: Array<{ title?: string }>;
      retrievalMode?: string;
      diagnostics?: {
        inputFacets?: {
          requested?: {
            changeTypes?: string[];
            technologies?: string[];
            domains?: string[];
          };
          matched?: {
            changeTypes?: string[];
            technologies?: string[];
            domains?: string[];
          };
        };
      };
    };

    expect(parsed.retrievalMode).toBe("procedure_context");
    expect(parsed.procedures?.some((item) => item.title === "CLI Procedure")).toBe(true);
    expect(parsed.diagnostics?.inputFacets?.requested?.changeTypes).toContain("procedure");
    expect(parsed.diagnostics?.inputFacets?.requested?.technologies).toContain("typescript");
    expect(parsed.diagnostics?.inputFacets?.requested?.domains).toContain("context-compiler");
  });

  test("compile rejects an implicit repository identity", () => {
    const run = spawnSync(
      "bun",
      ["run", "src/cli/compile.ts", "--goal", "identity required", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_ROUTER_RUN_DB_TESTS: "1",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Repository identity is required");
  });
});
