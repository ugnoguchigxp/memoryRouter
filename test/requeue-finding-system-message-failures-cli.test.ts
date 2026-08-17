import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/requeue-finding-system-message-failures.js";

describe("requeue finding system message failures CLI", () => {
  test("defaults to a bounded dry-run", () => {
    expect(parseArgs([])).toEqual({
      mode: "dry-run",
      limit: 100,
      limitProvided: false,
    });
  });

  test("requires an explicit limit for writes", () => {
    expect(() => parseArgs(["--write"])).toThrow("--write requires an explicit --limit");
    expect(parseArgs(["--write", "--limit", "10"])).toEqual({
      mode: "write",
      limit: 10,
      limitProvided: true,
    });
  });

  test("rejects unbounded or unknown input", () => {
    expect(() => parseArgs(["--limit", "5001"])).toThrow(
      "--limit must be an integer between 1 and 5000",
    );
    expect(() => parseArgs(["--all"])).toThrow("Unknown argument: --all");
  });

  test("rejects ambiguous mode or limit arguments", () => {
    expect(() => parseArgs(["--write", "--dry-run", "--limit", "1"])).toThrow(
      "--dry-run and --write are mutually exclusive",
    );
    expect(() => parseArgs(["--limit", "1", "--limit=2"])).toThrow(
      "--limit may only be specified once",
    );
  });
});
