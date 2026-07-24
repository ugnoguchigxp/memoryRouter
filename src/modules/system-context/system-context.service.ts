import { readFileSync } from "node:fs";

import { type CatalogBinding, type SystemContextInvocation, verifyRenderedHash } from "s11tnext";

import {
  createAppCatalog,
  type SystemContextKey,
  type SystemContextValueMap,
} from "../../../.s11tnext/catalog.generated.js";

const artifact: unknown = JSON.parse(
  readFileSync(new URL("../../../.s11tnext/catalog.json", import.meta.url), "utf8"),
);

const catalog = createAppCatalog(artifact);

export const defaultSystemContextBinding = {
  instructionLocale: "ja-JP",
  fallbackLocales: ["en-US"],
} as const satisfies CatalogBinding;

export const englishSystemContextBinding = {
  instructionLocale: "en-US",
  fallbackLocales: ["ja-JP"],
} as const satisfies CatalogBinding;

export type SystemContextManifest = SystemContextInvocation["manifest"];

export function renderSystemContext<K extends SystemContextKey>(
  key: K,
  values: SystemContextValueMap[K],
  binding: CatalogBinding = defaultSystemContextBinding,
): SystemContextInvocation<K> {
  return catalog.bind(binding)(key, values);
}

export function systemContextMessage<K extends SystemContextKey>(
  invocation: SystemContextInvocation<K>,
): {
  role: "system";
  content: string;
} {
  if (!verifyRenderedHash(invocation.content.text, invocation.manifest.renderedHash)) {
    throw new Error(`SystemContext rendered hash mismatch: ${invocation.manifest.key}`);
  }
  return Object.freeze({
    role: "system",
    content: invocation.content.text,
  });
}

export function listSystemContexts() {
  return catalog.list();
}
