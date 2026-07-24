import { readFileSync } from "node:fs";

import {
  type CatalogBinding,
  type PromptInvocation,
  verifyPromptMessageHash,
  verifyRenderedHash,
} from "s11tnext";

import {
  createAppCatalog,
  type PromptKey,
  type PromptMessageRoleMap,
  type PromptValueMap,
} from "../../../.s11tnext/catalog.generated.js";

const artifact: unknown = JSON.parse(
  readFileSync(new URL("../../../.s11tnext/catalog.json", import.meta.url), "utf8"),
);

const catalog = createAppCatalog(artifact);

export const defaultPromptBinding = {
  instructionLocale: "ja-JP",
  fallbackLocales: ["en-US"],
  trailingNewline: false,
} as const satisfies CatalogBinding;

export const englishPromptBinding = {
  instructionLocale: "en-US",
  fallbackLocales: ["ja-JP"],
  trailingNewline: false,
} as const satisfies CatalogBinding;

export type PromptManifest = PromptInvocation["manifest"];

export function renderPrompt<K extends PromptKey>(
  key: K,
  values: PromptValueMap[K],
  binding: CatalogBinding = defaultPromptBinding,
): PromptInvocation<K, PromptMessageRoleMap[K]> {
  return catalog.bind(binding)(key, values);
}

export function promptMessage<K extends PromptKey>(
  invocation: PromptInvocation<K, PromptMessageRoleMap[K]>,
): {
  role: PromptMessageRoleMap[K];
  content: string;
} {
  if (!verifyRenderedHash(invocation.content.text, invocation.manifest.renderedHash)) {
    throw new Error(`Prompt rendered hash mismatch: ${invocation.manifest.key}`);
  }
  if (
    !verifyPromptMessageHash(
      { role: invocation.role, text: invocation.content.text },
      invocation.manifest.messageHash,
    )
  ) {
    throw new Error(`Prompt message hash mismatch: ${invocation.manifest.key}`);
  }
  return Object.freeze({
    role: invocation.role,
    content: invocation.content.text,
  });
}

export function listPrompts() {
  return catalog.list();
}
