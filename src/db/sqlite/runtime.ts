import { resolveDatabaseBackendConfig } from "../backend.js";
import { type SqliteCoreDatabase, openSqliteCoreDatabase } from "./client.js";

let runtimeDatabase: Promise<SqliteCoreDatabase> | undefined;

export function getRuntimeSqliteCoreDatabase(): Promise<SqliteCoreDatabase> {
  if (!runtimeDatabase) {
    const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
    if (!config.sqlitePath) {
      throw new Error("SQLite backend selected but no sqlitePath could be resolved");
    }
    const pending = openSqliteCoreDatabase({ path: config.sqlitePath });
    runtimeDatabase = pending;
    void pending.catch(() => {
      // A missing DB can be initialized while the API stays running.
      if (runtimeDatabase === pending) runtimeDatabase = undefined;
    });
  }
  return runtimeDatabase;
}

export function resetRuntimeSqliteCoreDatabaseForTests(): void {
  runtimeDatabase = undefined;
}
