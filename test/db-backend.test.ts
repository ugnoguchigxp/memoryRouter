import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveDatabaseBackendConfig } from "../src/db/backend.js";
import { assertSafeDirectWriteTestPath } from "../src/db/sqlite/test-path-safety.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;
const originalAllowDestructiveDbTests = process.env.CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS;

afterEach(() => {
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("CONTEXT_STILL_DB_BACKEND", originalBackend);
  restoreEnv("CONTEXT_STILL_SQLITE_CORE_PATH", originalSqlitePath);
  restoreEnv("CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS", originalAllowDestructiveDbTests);
});

describe("sqlite test write safety", () => {
  test("refuses direct test writes outside the OS temporary directory", () => {
    clearEnv("CONTEXT_STILL_ALLOW_DESTRUCTIVE_DB_TESTS");

    expect(() => assertSafeDirectWriteTestPath("/workspace/context-still-core.sqlite")).toThrow(
      "Refusing to open a non-temporary SQLite database",
    );
  });
});

describe("database backend config", () => {
  beforeEach(() => {
    clearEnv("DATABASE_URL");
    clearEnv("CONTEXT_STILL_DB_BACKEND");
    clearEnv("CONTEXT_STILL_SQLITE_CORE_PATH");
  });

  test("defaults postgres for postgres URLs", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "postgres://postgres:postgres@localhost/context_still",
    });

    expect(config).toEqual({
      kind: "postgres",
      url: "postgres://postgres:postgres@localhost/context_still",
      sqlitePath: null,
    });
  });

  test("infers sqlite from sqlite URL", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "sqlite:///tmp/context-still-core.sqlite",
    });

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-core.sqlite");
  });

  test("honors explicit backend when provided", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "postgres://postgres:postgres@localhost/context_still",
      backend: "sqlite",
      sqlitePath: "/tmp/context-still-core.sqlite",
    });

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-core.sqlite");
  });

  test("infers sqlite from sqlite sentinel database URL", () => {
    process.env.DATABASE_URL = "sqlite";

    const config = resolveDatabaseBackendConfig();

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toMatch(/data\/context-still-core\.sqlite$/);
  });

  test("does not override a postgres URL just because a sqlite path is configured", () => {
    process.env.DATABASE_URL = "postgres://postgres:postgres@localhost/context_still";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = "/tmp/context-still-core.sqlite";

    const config = resolveDatabaseBackendConfig();

    expect(config).toEqual({
      kind: "postgres",
      url: "postgres://postgres:postgres@localhost/context_still",
      sqlitePath: null,
    });
  });

  test("honors sqlite core path env when sqlite backend is selected", () => {
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = "/tmp/context-still-env.sqlite";

    const config = resolveDatabaseBackendConfig();

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-env.sqlite");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    clearEnv(key);
    return;
  }
  process.env[key] = value;
}

function clearEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}
