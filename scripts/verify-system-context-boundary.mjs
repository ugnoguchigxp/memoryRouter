import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src");

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(absolute);
      return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
    }),
  );
  return nested.flat();
}

const violations = [];
for (const absolute of await collectTypeScriptFiles(sourceRoot)) {
  const relative = path.relative(process.cwd(), absolute).split(path.sep).join("/");
  if (relative === "src/modules/system-context/system-context.service.ts") {
    continue;
  }

  const source = await readFile(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const directSystemRoles = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const propertyName =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
      const initializer = node.initializer;
      const roleValue =
        ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
          ? initializer.text
          : undefined;
      if (propertyName === "role" && roleValue === "system") {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        directSystemRoles.push(position.line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (directSystemRoles.length > 0) {
    violations.push(`${relative}:${directSystemRoles.join(",")}: direct system-role construction`);
  }
}

if (violations.length > 0) {
  console.error(
    [
      "SystemContext boundary check failed.",
      "New provider-message construction must use promptMessage(renderPrompt(...)).",
      ...violations.map((violation) => `- ${violation}`),
    ].join("\n"),
  );
  process.exit(1);
}

console.log("SystemContext boundary check passed (0 allowlisted legacy call sites remain).");
