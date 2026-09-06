import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultPromptBinding,
  englishPromptBinding,
  promptMessage,
  renderPrompt,
} from "../src/modules/system-context/system-context.service.js";

const key = "contextCompiler.selectEvidence";
const schemaPath = path.resolve("shared/context-compile/selector-output.schema.json");
const outputPath = path.resolve(".s11tnext/compile-prompts.generated.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const selectorSchemaSha256 = sha256(await readFile(schemaPath));

const messages = [
  ["ja-JP", defaultPromptBinding],
  ["en-US", englishPromptBinding],
].map(([locale, binding]) => {
  const invocation = renderPrompt(key, {}, binding);
  const message = promptMessage(invocation);
  if (message.role !== "system" || invocation.manifest.key !== key) {
    throw new Error(`Invalid static compile prompt for ${locale}`);
  }
  return {
    key,
    locale,
    role: message.role,
    text: message.content,
    manifest: invocation.manifest,
    rawUtf8Sha256: sha256(message.content),
    selectorSchemaSha256,
  };
});

await writeFile(
  outputPath,
  `${JSON.stringify({ format: "context-still.compile-static-prompts", version: 1, messages }, null, 2)}\n`,
);
