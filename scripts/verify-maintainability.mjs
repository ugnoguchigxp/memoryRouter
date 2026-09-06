import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const roots = ["src", "api", "web/src", "crates/context-stilld/src"];
const extensions = new Set([".ts", ".tsx", ".rs"]);

export function auditSizes(files, baseline) {
  const errors = [];
  for (const [file, lines] of Object.entries(files)) {
    const limit = baseline.exceptions[file] ?? baseline.maxLines;
    if (lines > limit)
      errors.push(`${file}: ${lines} lines exceeds ${limit}; split by responsibility`);
  }
  // Removing a large module must also retire its exemption.
  for (const file of Object.keys(baseline.exceptions)) {
    if (!(file in files)) errors.push(`${file}: stale maintainability exception`);
  }
  return errors;
}

async function collect(root, relative, files) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await collect(root, name, files);
    else if (entry.isFile() && extensions.has(path.extname(name))) {
      const text = await readFile(path.join(root, name), "utf8");
      files[name] = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    }
  }
}

export async function collectSourceSizes(root) {
  const files = {};
  for (const relative of roots) await collect(root, relative, files);
  return files;
}

async function main() {
  const baseline = JSON.parse(
    await readFile(new URL("../spec/maintainability-budget.json", import.meta.url), "utf8"),
  );
  if (baseline.version !== 1 || baseline.maxLines !== 1200)
    throw new Error("invalid maintainability budget contract");
  const files = await collectSourceSizes(process.cwd());
  const errors = auditSizes(files, baseline);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Maintainability: ${Object.keys(files).length} modules checked; new modules <= ${baseline.maxLines} lines; existing exceptions cannot grow.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
