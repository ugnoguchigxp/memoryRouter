import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function filesUnder(directory, extension) {
  const result = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) result.push(...filesUnder(absolute, extension));
    else if (absolute.endsWith(extension)) result.push(absolute);
  }
  return result;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

const rustRoot = path.join(root, "crates/context-stilld/src");
for (const file of filesUnder(rustRoot, ".rs")) {
  const name = relative(file);
  if (name.endsWith("_tests.rs")) continue;
  const source = readFileSync(file, "utf8");
  const testModule = source.search(/#\[cfg\(test\)\]\s*mod tests\s*\{/);
  const production = testModule >= 0 ? source.slice(0, testModule) : source;
  const lines = production.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/Connection::open(?:_with_flags)?\s*\(/.test(line)) continue;
    if (name === "crates/context-stilld/src/domains/sqlite_writer/service.rs") continue;
    const neighborhood = lines.slice(Math.max(0, index - 4), index + 4).join("\n");
    if (neighborhood.includes("SQLITE_OPEN_READ_ONLY")) continue;
    if (neighborhood.includes("sqlite-writer-guard: test-only-direct-open")) continue;
    failures.push(`${name}:${index + 1}: direct read-write SQLite open outside SqliteWriter`);
  }
}

for (const directory of ["src", "api"]) {
  const absolute = path.join(root, directory);
  for (const file of filesUnder(absolute, ".ts")) {
    const name = relative(file);
    const source = readFileSync(file, "utf8");
    if (!/new\s+(?:sqlite\.)?Database\s*\(/.test(source)) continue;
    if (name !== "src/db/sqlite/client.ts") {
      failures.push(`${name}: direct Bun SQLite open is forbidden`);
    }
  }
}

const clientPath = path.join(root, "src/db/sqlite/client.ts");
const client = readFileSync(clientPath, "utf8");
for (const required of [
  "readonly: true",
  "new RemoteWriterSqliteClient",
  "isDirectWriteTestRuntime()",
]) {
  if (!client.includes(required)) {
    failures.push(
      `src/db/sqlite/client.ts: missing ownership invariant ${JSON.stringify(required)}`,
    );
  }
}

if (failures.length > 0) {
  console.error("SQLite Writer ownership verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("SQLite Writer ownership verification passed");
