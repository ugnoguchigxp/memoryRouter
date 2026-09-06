import { getJson, requestJson } from "./http";
import type {
  AgentDiffEntry,
  EpisodeCard,
  EpisodeCardCreateInput,
  EpisodeListRequest,
  KnowledgeBulkStatusRequest,
  KnowledgeBulkStatusResponse,
  KnowledgeFeedback,
  KnowledgeListRequest,
  KnowledgeListResponse,
  KnowledgeUpdateInput,
  KnowledgeWriteInput,
  VibeMemory,
} from "./knowledge-contracts";

export async function fetchKnowledgeItems(
  input: number | KnowledgeListRequest = 80,
): Promise<KnowledgeListResponse> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 80));
    params.set("page", String(input.page ?? 1));
    if (input.status) params.set("status", input.status);
    if (input.query) params.set("query", input.query);
    if (input.displayFilter) params.set("displayFilter", input.displayFilter);
    if (input.minQuality !== undefined) params.set("minQuality", String(input.minQuality));
    if (input.sortBy) params.set("sortBy", input.sortBy);
    if (input.sortDir) params.set("sortDir", input.sortDir);
    if (input.polarities && input.polarities.length > 0)
      params.set("polarities", input.polarities.join(","));
    if (input.intentTags && input.intentTags.length > 0)
      params.set("intentTags", input.intentTags.join(","));
  }
  const json = await getJson<KnowledgeListResponse>(`/api/knowledge?${params.toString()}`);
  return json;
}

export async function createKnowledgeItem(input: KnowledgeWriteInput): Promise<void> {
  await requestJson("/api/knowledge", "POST", input);
}

export async function updateKnowledgeItem(id: string, input: KnowledgeUpdateInput): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "PUT", input);
}

export async function deleteKnowledgeItem(id: string): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "DELETE");
}

export async function bulkUpdateKnowledgeStatus(
  input: KnowledgeBulkStatusRequest,
): Promise<KnowledgeBulkStatusResponse> {
  return requestJson<KnowledgeBulkStatusResponse>("/api/knowledge/bulk-status", "POST", input);
}

export async function sendKnowledgeFeedback(
  id: string,
  input: { direction: "up" | "down"; reason?: string },
): Promise<KnowledgeFeedback> {
  const json = await requestJson<{ feedback: KnowledgeFeedback }>(
    `/api/knowledge/${id}/feedback`,
    "POST",
    input,
  );
  return json.feedback;
}

export async function fetchVibeMemories(limit = 120): Promise<VibeMemory[]> {
  const json = await getJson<{ memories: VibeMemory[] }>(`/api/vibe-memory?limit=${limit}`);
  return json.memories;
}

export async function deleteVibeMemory(id: string): Promise<void> {
  await requestJson(`/api/vibe-memory/${id}`, "DELETE");
}

export async function fetchAgentDiffEntries(
  limit = 120,
  params?: { id?: string; vibeMemoryId?: string; vibeMemoryIds?: string[] },
): Promise<AgentDiffEntry[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (params?.id) query.set("id", params.id);
  if (params?.vibeMemoryId) query.set("vibeMemoryId", params.vibeMemoryId);
  if (params?.vibeMemoryIds?.length) query.set("vibeMemoryIds", params.vibeMemoryIds.join(","));
  const json = await getJson<{ entries: AgentDiffEntry[] }>(`/api/agent-diffs?${query}`);
  return json.entries;
}

export async function fetchEpisodes(input: EpisodeListRequest = {}): Promise<EpisodeCard[]> {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit ?? 50));
  if (input.query?.trim()) query.set("q", input.query.trim());
  if (input.status) query.set("status", input.status);
  if (input.technologies?.length) query.set("technologies", input.technologies.join(","));
  if (input.changeTypes?.length) query.set("changeTypes", input.changeTypes.join(","));
  if (input.domains?.length) query.set("domains", input.domains.join(","));
  if (input.tools?.length) query.set("tools", input.tools.join(","));
  const json = await getJson<{ items: EpisodeCard[] }>(`/api/episodes?${query}`);
  return json.items;
}

export async function fetchEpisode(id: string): Promise<EpisodeCard> {
  const json = await getJson<{ episode: EpisodeCard }>(`/api/episodes/${encodeURIComponent(id)}`);
  return json.episode;
}

export async function createEpisode(input: EpisodeCardCreateInput): Promise<EpisodeCard> {
  const json = await requestJson<{ episode: EpisodeCard }>("/api/episodes", "POST", input);
  return json.episode;
}
