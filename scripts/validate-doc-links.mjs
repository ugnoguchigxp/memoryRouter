import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

const root = process.cwd();
const roots = ["README.md", "README.jp.md", "spec/pub", "spec/docs"];
const specDocsRoot = path.resolve(root, "spec/docs");
const ignoredSchemes = /^(https?:|mailto:|tel:|data:|javascript:|#)/i;
const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

async function listDocumentFiles(inputPath) {
  const absolutePath = path.resolve(root, inputPath);
  if (!existsSync(absolutePath)) return [];
  const stat = statSync(absolutePath);
  if (stat.isFile()) return /\.(?:html|md)$/.test(inputPath) ? [absolutePath] : [];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) return listDocumentFiles(path.relative(root, child));
      return entry.isFile() && /\.(?:html|md)$/.test(entry.name) ? [child] : [];
    }),
  );
  return files.flat();
}

function stripAnchor(link) {
  const index = link.indexOf("#");
  return index >= 0 ? link.slice(0, index) : link;
}

function resolveLinkTarget(file, rawLink) {
  const withoutQuery = stripAnchor(rawLink.split("?")[0] ?? rawLink);
  if (!withoutQuery || ignoredSchemes.test(withoutQuery)) return null;
  const decoded = decodeURIComponent(withoutQuery);

  if (file.endsWith(".html") && path.dirname(file).startsWith(specDocsRoot)) {
    const logicalSource = path
      .relative(specDocsRoot, file)
      .split(path.sep)
      .filter((segment) => segment !== ".archived")
      .join(path.sep);
    const logicalTarget = path.resolve(specDocsRoot, path.dirname(logicalSource), decoded);
    if (!logicalTarget.startsWith(`${specDocsRoot}${path.sep}`)) return logicalTarget;
    if (existsSync(logicalTarget)) return logicalTarget;

    return path.join(path.dirname(logicalTarget), ".archived", path.basename(logicalTarget));
  }

  return path.resolve(path.dirname(file), decoded);
}

function extractLinks(file, text) {
  if (file.endsWith(".md")) {
    return [...text.matchAll(markdownLinkPattern)].map((match) => match[1]).filter(Boolean);
  }

  const document = new JSDOM(text).window.document;
  return [...document.querySelectorAll("[href], [src]")].flatMap((element) =>
    [element.getAttribute("href"), element.getAttribute("src")].filter(Boolean),
  );
}

const files = (await Promise.all(roots.map(listDocumentFiles))).flat();
const failures = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const rawLink of extractLinks(file, text)) {
    const target = resolveLinkTarget(file, rawLink);
    if (!target) continue;
    if (existsSync(target)) continue;
    failures.push(`${path.relative(root, file)} -> ${rawLink}`);
  }
}

if (failures.length > 0) {
  console.error("[docs:check-links] missing local document link targets:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const markdownCount = files.filter((file) => file.endsWith(".md")).length;
const htmlCount = files.filter((file) => file.endsWith(".html")).length;
console.log(`[docs:check-links] ok (${markdownCount} markdown files, ${htmlCount} HTML files)`);
