import type { CandidateListRequest, CandidateListResponse } from "./candidate-contracts";
import { getJson } from "./http";
import type { AuditLogActor, AuditLogsResponse } from "./source-contracts";

export async function fetchAuditLogs(input?: {
  page?: number;
  limit?: number;
  eventType?: string;
  actor?: AuditLogActor | "all";
}): Promise<AuditLogsResponse> {
  const query = new URLSearchParams();
  if (input?.page !== undefined) query.set("page", String(input.page));
  if (input?.limit !== undefined) query.set("limit", String(input.limit));
  if (input?.eventType) query.set("eventType", input.eventType);
  if (input?.actor && input.actor !== "all") query.set("actor", input.actor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson<AuditLogsResponse>(`/api/audit-logs${suffix}`);
}

export async function fetchCandidateItems(
  input: CandidateListRequest = {},
): Promise<CandidateListResponse> {
  const query = new URLSearchParams();
  query.set("page", String(input.page ?? 1));
  query.set("limit", String(input.limit ?? 50));
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.targetKind && input.targetKind !== "all") query.set("targetKind", input.targetKind);
  if (input.outcome && input.outcome !== "all") query.set("outcome", input.outcome);
  if (input.hasKnowledge && input.hasKnowledge !== "all") {
    query.set("hasKnowledge", input.hasKnowledge);
  }
  if (input.includeStored) query.set("includeStored", "true");
  if (input.targetStateId?.trim()) query.set("targetStateId", input.targetStateId.trim());
  if (input.sortBy) query.set("sortBy", input.sortBy);
  if (input.sortDir) query.set("sortDir", input.sortDir);
  return getJson<CandidateListResponse>(`/api/candidates?${query.toString()}`);
}
