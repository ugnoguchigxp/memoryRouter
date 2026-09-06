import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("cli eval-context e2e", () => {
  async function createEmptyCasesFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-context-cases-"));
    const filePath = path.join(dir, "cases.jsonl");
    await fs.writeFile(filePath, "\n");
    return filePath;
  }

  test("fails when neither --from-replay nor --cases is specified", () => {
    const run = spawnSync("bun", ["run", "src/cli/eval-context.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Either --from-replay or --cases <path> must be specified.");
  });

  test("fails when both --from-replay and --cases are specified", () => {
    const run = spawnSync(
      "bun",
      [
        "run",
        "src/cli/eval-context.ts",
        "--from-replay",
        "--cases",
        "spec/context-eval-cases.example.jsonl",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "Cannot specify both --from-replay and --cases <path> simultaneously.",
    );
  });

  test("fails with validation / file not found if cases file does not exist", () => {
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--cases", "nonexistent-file.jsonl"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ENOENT");
  });

  test("runs successfully and outputs JSON for empty cases without DB dependency", async () => {
    const casesPath = await createEmptyCasesFile();
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--cases", casesPath, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.source.mode).toBe("cases");
    expect(parsed.source.path).toBe(casesPath);
    expect(parsed.summary.status).toBe("no_data");
    expect(parsed.cases).toHaveLength(0);
  });

  test("runs successfully and outputs text summary for empty cases", async () => {
    const casesPath = await createEmptyCasesFile();
    const run = spawnSync("bun", ["run", "src/cli/eval-context.ts", "--cases", casesPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Context Eval (cases, cases=0");
    expect(run.stdout).toContain("Summary: no_data");
  });

  test("check mode fails on an empty dataset while preserving its JSON report", async () => {
    const casesPath = await createEmptyCasesFile();
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--cases", casesPath, "--json", "--check"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).summary.status).toBe("no_data");
  });
});
