import { getJson, requestForm, requestJson } from "./http";
import type {
  QueueWebSourcesBulkResponse,
  QueueWebSourceUploadResponse,
  SourceHealth,
  SourceHistoryItem,
  SourceMutationResponse,
  SourcePageDocument,
  SourceReindexResponse,
  SourceSearchItem,
  SourceTreeResponse,
  WebSourceQueueItem,
} from "./source-contracts";

export const encodeSlug = (slug: string): string =>
  slug
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export async function fetchSourceTree(): Promise<SourceTreeResponse> {
  return getJson<SourceTreeResponse>("/api/sources/tree");
}

export async function fetchSourceHealth(): Promise<SourceHealth> {
  return getJson<SourceHealth>("/api/sources/health");
}

export async function fetchSourcePage(slug: string): Promise<SourcePageDocument> {
  return getJson<SourcePageDocument>(`/api/sources/pages/${encodeSlug(slug)}`);
}

export async function createSourcePage(input: {
  slug: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/pages", "POST", input);
}

export async function updateSourcePage(
  slug: string,
  input: {
    slug?: string;
    title?: string;
    body: string;
    meta?: Record<string, unknown>;
    commitMessage?: string;
  },
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(
    `/api/sources/pages/${encodeSlug(slug)}`,
    "PUT",
    input,
  );
}

export async function deleteSourcePage(slug: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/pages/${encodeSlug(slug)}`, "DELETE");
}

export async function createSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/folders", "POST", { path });
}

export async function renameSourceFolder(
  path: string,
  nextPath: string,
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "PUT", {
    path: nextPath,
  });
}

export async function deleteSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "DELETE");
}

export async function fetchSourceHistory(slug: string): Promise<SourceHistoryItem[]> {
  const json = await getJson<{ slug: string; items: SourceHistoryItem[] }>(
    `/api/sources/history/${encodeSlug(slug)}`,
  );
  return json.items;
}

export async function fetchSourceDiff(slug: string, from: string, to: string): Promise<string> {
  const json = await getJson<{ diff: string }>(
    `/api/sources/diff/${encodeSlug(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return json.diff;
}

export async function searchSourcePages(query: string): Promise<SourceSearchItem[]> {
  const encoded = encodeURIComponent(query.trim());
  const json = await getJson<{ items: SourceSearchItem[] }>(`/api/sources/search?q=${encoded}`);
  return json.items;
}

export async function runSourceReindex(): Promise<SourceReindexResponse> {
  return requestJson<SourceReindexResponse>("/api/sources/reindex", "POST");
}

export async function queueWebSourceUrl(input: {
  url: string;
  distillationVersion?: string;
}): Promise<{ ok: true; item: WebSourceQueueItem }> {
  return requestJson<{ ok: true; item: WebSourceQueueItem }>("/api/sources/web", "POST", input);
}

export async function queueWebSourceUrlsBulk(input: {
  urls: string[];
  distillationVersion?: string;
}): Promise<QueueWebSourcesBulkResponse> {
  return requestJson<QueueWebSourcesBulkResponse>("/api/sources/web/bulk", "POST", input);
}

export async function queueWebSourceUrlsUpload(input: {
  file: File;
  distillationVersion?: string;
}): Promise<QueueWebSourceUploadResponse> {
  const formData = new FormData();
  formData.set("file", input.file);
  if (input.distillationVersion?.trim()) {
    formData.set("distillationVersion", input.distillationVersion.trim());
  }
  return requestForm<QueueWebSourceUploadResponse>("/api/sources/web/upload", "POST", formData);
}
