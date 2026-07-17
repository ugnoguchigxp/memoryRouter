import { describe, expect, test } from "vitest";
import { RemoteWriterSqliteClient } from "../src/db/sqlite/remote-client.js";
import type { executeSqliteWriterSync } from "../src/db/sqlite/writer-client.js";

type WriterInput = Parameters<typeof executeSqliteWriterSync>[0];

function writerResponse() {
  return { ok: true, rows: [], changes: 1, lastInsertRowid: 1 };
}

function readOnlyThatMustNotPrepare() {
  return {
    query(): never {
      throw new Error("mutation SQL was prepared on the read-only connection");
    },
    close() {},
  };
}

describe("RemoteWriterSqliteClient", () => {
  test("does not prepare mutation SQL on the read-only connection", () => {
    const requests: WriterInput[] = [];
    const client = new RemoteWriterSqliteClient(
      readOnlyThatMustNotPrepare() as never,
      "/tmp/context-still.sqlite",
      ((input: WriterInput) => {
        requests.push(input);
        return writerResponse();
      }) as typeof executeSqliteWriterSync,
    );

    client.query("INSERT INTO settings(id) VALUES (?)").run("setting-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("run");
  });

  test("uses a stable and isolated transaction owner for each database client", () => {
    const requests: WriterInput[] = [];
    const execute = ((input: WriterInput) => {
      requests.push(input);
      return writerResponse();
    }) as typeof executeSqliteWriterSync;
    const first = new RemoteWriterSqliteClient(
      readOnlyThatMustNotPrepare() as never,
      "/tmp/first.sqlite",
      execute,
    );
    const second = new RemoteWriterSqliteClient(
      readOnlyThatMustNotPrepare() as never,
      "/tmp/second.sqlite",
      execute,
    );

    first.transaction(() => {
      first.query("INSERT INTO settings(id) VALUES (?)").run("first");
    })();
    second.query("INSERT INTO settings(id) VALUES (?)").run("second");

    const firstOwner = requests[0]?.clientId;
    expect(requests.slice(0, 3).map((request) => request.clientId)).toEqual([
      firstOwner,
      firstOwner,
      firstOwner,
    ]);
    expect(requests[3]?.clientId).not.toBe(firstOwner);
  });
});
