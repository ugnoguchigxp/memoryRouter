import type { Database as NativeBunSqliteDatabase } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type SqliteWriterMethod, executeSqliteWriterSync } from "./writer-client.js";

type NativeStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  values(...params: unknown[]): unknown[][];
};

export class RemoteWriterSqliteClient {
  readonly filename: string;
  private readonly clientId = `typescript-${process.pid}-${randomUUID()}`;
  private transactionDepth = 0;

  constructor(
    private readonly readOnly: NativeBunSqliteDatabase,
    filename: string,
    private readonly executeWriter: typeof executeSqliteWriterSync = executeSqliteWriterSync,
  ) {
    this.filename = filename;
  }

  query<T = unknown, P extends unknown[] = unknown[]>(sql: string) {
    let native: NativeStatement | undefined;
    const nativeStatement = (): NativeStatement => {
      native ??= this.readOnly.query(sql) as unknown as NativeStatement;
      return native;
    };
    return {
      all: (...params: P): T[] =>
        this.shouldUseWriter(sql)
          ? (this.remote(sql, params, "all", "object").rows as T[])
          : (nativeStatement().all(...params) as T[]),
      get: (...params: P): T | null =>
        this.shouldUseWriter(sql)
          ? ((this.remote(sql, params, "get", "object").rows[0] as T | undefined) ?? null)
          : ((nativeStatement().get(...params) as T | null) ?? null),
      values: (...params: P): unknown[][] =>
        this.shouldUseWriter(sql)
          ? (this.remote(sql, params, "values", "array").rows as unknown[][])
          : nativeStatement().values(...params),
      run: (...params: P): { changes: number; lastInsertRowid: number | bigint } => {
        if (!this.shouldUseWriter(sql)) return nativeStatement().run(...params);
        const response = this.remote(sql, params, "run", "array");
        this.updateTransactionState(sql);
        return { changes: response.changes, lastInsertRowid: response.lastInsertRowid };
      },
    };
  }

  prepare(sql: string) {
    return this.query(sql);
  }

  exec(sql: string): void {
    this.remote(sql, [], "exec", "array");
    this.updateTransactionState(sql);
  }

  transaction<TArgs extends unknown[], T>(callback: (...args: TArgs) => T) {
    const execute = (behavior: "deferred" | "immediate" | "exclusive", args: TArgs): T => {
      this.query(`BEGIN ${behavior.toUpperCase()}`).run();
      try {
        const result = callback(...args);
        if (result instanceof Promise) {
          throw new Error("Async callback is not supported by the synchronous SQLite adapter");
        }
        this.query("COMMIT").run();
        return result;
      } catch (error) {
        this.query("ROLLBACK").run();
        throw error;
      }
    };
    const transaction = ((...args: TArgs) => execute("deferred", args)) as ((
      ...args: TArgs
    ) => T) & {
      deferred(...args: TArgs): T;
      immediate(...args: TArgs): T;
      exclusive(...args: TArgs): T;
    };
    transaction.deferred = (...args) => execute("deferred", args);
    transaction.immediate = (...args) => execute("immediate", args);
    transaction.exclusive = (...args) => execute("exclusive", args);
    return transaction;
  }

  serialize(): Buffer {
    throw new Error("SQLite serialization is an offline Rust writer operation");
  }

  loadExtension(): never {
    throw new Error("sqlite-vec is owned by the resident Rust writer");
  }

  close(): void {
    this.readOnly.close();
  }

  private shouldUseWriter(sql: string): boolean {
    return this.transactionDepth > 0 || isMutationSql(sql);
  }

  private remote(
    sql: string,
    params: unknown[],
    method: SqliteWriterMethod,
    rowMode: "array" | "object",
  ) {
    return this.executeWriter({ clientId: this.clientId, sql, params, method, rowMode });
  }

  private updateTransactionState(sql: string): void {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("begin")) this.transactionDepth += 1;
    if (
      normalized.startsWith("commit") ||
      normalized === "end" ||
      (normalized.startsWith("rollback") && !normalized.startsWith("rollback to"))
    ) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    }
  }
}

function isMutationSql(sql: string): boolean {
  const normalized = normalizeSql(sql);
  if (
    /^(insert|update|delete|replace|create|alter|drop|reindex|vacuum|begin|commit|rollback|end|savepoint|release)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (normalized.startsWith("pragma")) {
    return normalized.includes("=") || /\b(wal_checkpoint|optimize)\b/.test(normalized);
  }
  if (normalized.startsWith("with")) {
    return /\b(insert|update|delete|replace)\b/.test(normalized.slice(0, 4096));
  }
  return false;
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/, "")
    .trimStart()
    .toLowerCase();
}
