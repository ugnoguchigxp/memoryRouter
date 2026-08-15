import { desc, eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { foundCandidates, knowledgeItems } from "../../db/schema.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { asRecord, asStringArray } from "../../shared/utils/normalize.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";

export type SecurityIntelligenceShadowItem = {
  knowledgeRef: string;
  knowledgeRevision: number;
  lifecycle: "candidate" | "draft";
};

export type SecurityIntelligenceShadowResult = {
  compileRunRef: string;
  occurredAt: string;
  taskRef: string;
  runRef: string;
  items: SecurityIntelligenceShadowItem[];
};

type CandidateRow = { id: string; metadata: unknown; origin: unknown };
type DraftRow = {
  id: string;
  projectRef: string | null;
  appliesTo: unknown;
  metadata: unknown;
};

function intersects(actual: string[], expected: string[]) {
  return expected.length === 0 || actual.some((value) => expected.includes(value));
}

function candidateProjectMatches(row: CandidateRow, projectRef: string) {
  const metadata = asRecord(row.metadata);
  const origin = asRecord(row.origin);
  if (metadata.source !== "security_intelligence_candidate_ingress") return false;
  const evidenceRefs = Array.isArray(origin.evidenceRefs) ? origin.evidenceRefs.map(asRecord) : [];
  return evidenceRefs.some((evidence) => evidence.sourceProjectRef === projectRef);
}

function candidateMatches(input: {
  row: CandidateRow;
  projectRef: string;
  domains: string[];
  technologies: string[];
  changeTypes: string[];
}) {
  const origin = asRecord(input.row.origin);
  if (!candidateProjectMatches(input.row, input.projectRef)) return false;
  const appliesTo = asRecord(origin.appliesTo);
  return (
    intersects(asStringArray(appliesTo.domains), input.domains) &&
    intersects(asStringArray(appliesTo.technologies), input.technologies) &&
    intersects(asStringArray(appliesTo.changeTypes), input.changeTypes)
  );
}

async function recentCandidateRows(): Promise<CandidateRow[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    return sqlite.db
      .query<{ id: string; metadata: string; origin: string }, []>(
        "select id, metadata, origin from found_candidates order by created_at desc limit 100",
      )
      .all()
      .flatMap((row) => {
        try {
          return [
            {
              id: row.id,
              metadata: JSON.parse(row.metadata),
              origin: JSON.parse(row.origin),
            },
          ];
        } catch {
          return [];
        }
      });
  }
  return db
    .select({
      id: foundCandidates.id,
      metadata: foundCandidates.metadata,
      origin: foundCandidates.origin,
    })
    .from(foundCandidates)
    .orderBy(desc(foundCandidates.createdAt))
    .limit(100);
}

function draftMatches(input: {
  row: DraftRow;
  candidatesById: Map<string, CandidateRow>;
  projectRef: string;
  domains: string[];
  technologies: string[];
  changeTypes: string[];
}) {
  const metadata = asRecord(input.row.metadata);
  const foundCandidateId = metadata.foundCandidateId;
  if (typeof foundCandidateId !== "string") return false;
  const sourceCandidate = input.candidatesById.get(foundCandidateId);
  if (!sourceCandidate || !candidateProjectMatches(sourceCandidate, input.projectRef)) return false;
  const appliesTo = asRecord(input.row.appliesTo);
  return (
    intersects(asStringArray(appliesTo.domains), input.domains) &&
    intersects(asStringArray(appliesTo.technologies), input.technologies) &&
    intersects(asStringArray(appliesTo.changeTypes), input.changeTypes)
  );
}

async function recentDraftRows(): Promise<DraftRow[]> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    return sqlite.db
      .query<
        {
          id: string;
          project_ref: string | null;
          applies_to: string;
          metadata: string;
        },
        []
      >(
        "select id, project_ref, applies_to, metadata from knowledge_items where status = 'draft' order by created_at desc limit 100",
      )
      .all()
      .flatMap((row) => {
        try {
          return [
            {
              id: row.id,
              projectRef: row.project_ref,
              appliesTo: JSON.parse(row.applies_to),
              metadata: JSON.parse(row.metadata),
            },
          ];
        } catch {
          return [];
        }
      });
  }
  return db
    .select({
      id: knowledgeItems.id,
      projectRef: knowledgeItems.projectRef,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.status, "draft"))
    .orderBy(desc(knowledgeItems.createdAt))
    .limit(100);
}

export async function collectSecurityIntelligenceShadowRetrieval(input: {
  compileRunRef: string;
  compileInput: CompileInput;
  retrievalMode: RetrievalMode;
  facets: { domains: string[]; technologies: string[]; changeTypes: string[] };
}): Promise<SecurityIntelligenceShadowResult | undefined> {
  const shadow = input.compileInput.securityIntelligenceShadow;
  if (!shadow?.enabled) return undefined;
  const [drafts, candidates] = await Promise.all([recentDraftRows(), recentCandidateRows()]);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateItems = candidates
    .filter((row) => candidateMatches({ row, projectRef: shadow.projectRef, ...input.facets }))
    .flatMap((row) => {
      const candidateRef = asRecord(row.metadata).candidateRef;
      return typeof candidateRef === "string"
        ? [{ knowledgeRef: candidateRef, knowledgeRevision: 0, lifecycle: "candidate" as const }]
        : [];
    });
  const draftItems = drafts
    .filter((row) =>
      draftMatches({
        row,
        candidatesById,
        projectRef: shadow.projectRef,
        ...input.facets,
      }),
    )
    .map((row) => ({
      knowledgeRef: `knowledge:${row.id}`,
      knowledgeRevision: 0,
      lifecycle: "draft" as const,
    }));
  const items = [
    ...new Map(
      [...candidateItems, ...draftItems].map((item) => [item.knowledgeRef, item]),
    ).values(),
  ]
    .sort((left, right) => left.knowledgeRef.localeCompare(right.knowledgeRef))
    .slice(0, 20);
  const result = {
    compileRunRef: input.compileRunRef,
    occurredAt: new Date().toISOString(),
    taskRef: shadow.taskRef,
    runRef: shadow.runRef,
    items,
  };
  await recordAuditLogSafe({
    eventType: auditEventTypes.securityIntelligenceShadowRetrieval,
    actor: "system",
    payload: result,
  });
  return result;
}
