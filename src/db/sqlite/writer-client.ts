import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SqliteWriterMethod = "run" | "all" | "get" | "values" | "exec";

export type SqliteWriterResponse = {
  ok: boolean;
  rows: unknown[];
  changes: number;
  lastInsertRowid: number;
  error?: string;
};

type WriterEndpoint = {
  url: string;
  token: string;
};

export function executeSqliteWriterSync(input: {
  clientId: string;
  sql: string;
  params?: unknown[];
  method: SqliteWriterMethod;
  rowMode?: "array" | "object";
}): SqliteWriterResponse {
  const endpoint = resolveWriterEndpoint();
  const directory = mkdtempSync(path.join(os.tmpdir(), "context-still-writer-"));
  const requestPath = path.join(directory, "request.json");
  const responsePath = path.join(directory, "response.json");
  const workerPath = fileURLToPath(new URL("./writer-sync-worker.ts", import.meta.url));
  try {
    writeFileSync(
      requestPath,
      JSON.stringify({
        endpoint,
        body: {
          clientId: input.clientId,
          sql: input.sql,
          params: (input.params ?? []).map(normalizeParameter),
          method: input.method,
          rowMode: input.rowMode ?? "array",
        },
      }),
      { mode: 0o600 },
    );
    const child = Bun.spawnSync([process.execPath, workerPath, requestPath, responsePath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    if (child.exitCode !== 0) {
      const stderr = child.stderr.toString().trim();
      throw new Error(`SQLite writer transport failed (${child.exitCode}): ${stderr}`);
    }
    const response = JSON.parse(readFileSync(responsePath, "utf8")) as SqliteWriterResponse & {
      transportError?: string;
    };
    if (response.transportError) throw new Error(response.transportError);
    if (!response.ok) throw new Error(response.error ?? "SQLite writer request failed");
    return response;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function resolveWriterEndpoint(): WriterEndpoint {
  const explicitUrl = process.env.CONTEXT_STILL_WRITER_URL?.trim();
  const explicitToken = process.env.CONTEXT_STILL_WRITER_TOKEN?.trim();
  if (explicitUrl && explicitToken) {
    return { url: explicitUrl, token: explicitToken };
  }

  const appDataDir = resolveAppDataDir();
  const metadataPath =
    process.env.CONTEXT_STILL_MCP_ENDPOINT_PATH ??
    path.join(appDataDir, "run", "mcp-endpoint.json");
  let metadata: { writerUrl?: string; writerTokenPath?: string };
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as typeof metadata;
  } catch (error) {
    throw new Error(
      `SQLite writes require the resident context-stilld writer; cannot read ${metadataPath}: ${String(error)}`,
    );
  }
  const url = explicitUrl ?? metadata.writerUrl;
  const tokenPath =
    process.env.CONTEXT_STILL_WRITER_TOKEN_PATH ??
    metadata.writerTokenPath ??
    path.join(appDataDir, "run", "sqlite-writer.token");
  if (!url) throw new Error(`SQLite writer URL is missing from ${metadataPath}`);
  const token = explicitToken ?? readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error(`SQLite writer token is empty at ${tokenPath}`);
  return { url, token };
}

function resolveAppDataDir(): string {
  if (process.env.CONTEXT_STILL_APP_DATA_DIR) return process.env.CONTEXT_STILL_APP_DATA_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "contextStill");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "contextStill");
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "contextStill");
  return path.join(os.homedir(), ".local", "share", "contextStill");
}

function normalizeParameter(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $contextStillBlob: Array.from(bytes) };
  }
  if (Array.isArray(value)) return value.map(normalizeParameter);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeParameter(item),
      ]),
    );
  }
  return value;
}
