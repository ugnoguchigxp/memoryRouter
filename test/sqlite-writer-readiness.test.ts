import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probeSqliteWriter } from "../src/db/sqlite/writer-client.js";

const directory = mkdtempSync(path.join(tmpdir(), "context-still-probe-test-"));
const databasePath = path.join(directory, "reader.sqlite");
const otherPath = path.join(directory, "other.sqlite");
writeFileSync(databasePath, "");
writeFileSync(otherPath, "");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
// One fixture lifecycle: contents are irrelevant, only canonical path identity is compared.
import { afterAll } from "vitest";
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("requires a successful authenticated query to the same database", async () => {
  vi.stubEnv("CONTEXT_STILL_WRITER_URL", "http://127.0.0.1:1/writer/query");
  vi.stubEnv("CONTEXT_STILL_WRITER_TOKEN", "synthetic-token");
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ok: true, rows: [{ ready: 1, file: databasePath }] }))
    .mockResolvedValueOnce(Response.json({ ok: true, rows: [{ ready: 1, file: otherPath }] }))
    .mockResolvedValueOnce(Response.json({ ok: true, rows: [] }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  const signal = new AbortController().signal;
  await probeSqliteWriter(signal, databasePath);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    signal,
    redirect: "error",
    headers: { authorization: "Bearer synthetic-token" },
  });
  await expect(probeSqliteWriter(signal, databasePath)).rejects.toThrow("paths differ");
  await expect(probeSqliteWriter(signal, databasePath)).rejects.toThrow("probe failed");
  await expect(probeSqliteWriter(signal, databasePath)).rejects.toThrow("unavailable");
});
