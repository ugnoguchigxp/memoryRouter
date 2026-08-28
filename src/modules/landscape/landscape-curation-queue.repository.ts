import { and, desc, eq, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { landscapeCurationJobLinks, landscapeCurationQueue } from "../../db/schema.js";
import {
  type LandscapeCurationDecision,
  type LandscapeCurationDisposition,
  type LandscapeCurationFindingType,
  type LandscapeCurationInputSnapshotV1,
  type LandscapeCurationJob,
  type LandscapeCurationJobLink,
  type LandscapeCurationPhase,
  type LandscapeCurationPolicyResultV1,
  type LandscapeCurationResultV1,
  type LandscapeCurationRollbackStatus,
  landscapeCurationJobLinkSchema,
  landscapeCurationJobSchema,
} from "../../shared/schemas/landscape-curation.schema.js";

type QueueRow = typeof landscapeCurationQueue.$inferSelect;
type LinkRow = typeof landscapeCurationJobLinks.$inferSelect;

export type LandscapeCurationJobDetail = LandscapeCurationJob & {
  repositoryIdentity: Record<string, unknown>;
  fingerprint: string;
  evidenceHash: string;
  inputSnapshot: LandscapeCurationInputSnapshotV1 | Record<string, unknown>;
  result: LandscapeCurationResultV1 | Record<string, unknown>;
  policyResult: LandscapeCurationPolicyResultV1 | Record<string, unknown>;
  mutationPlan: Record<string, unknown>;
  postcheckResult: Record<string, unknown>;
  rollbackSnapshot: Record<string, unknown>;
  rollbackStatus: LandscapeCurationRollbackStatus;
  links: LandscapeCurationJobLink[];
};

export type LandscapeCurationJobCreateInput = {
  reviewItemId?: string | null;
  findingType: LandscapeCurationFindingType;
  subjectKnowledgeId: string;
  candidateKnowledgeIds: string[];
  repositoryIdentity: Record<string, unknown>;
  fingerprint: string;
  idempotencyKey: string;
  evidenceHash: string;
  priority: number;
  provider: string;
  model?: string | null;
  inputSnapshot: LandscapeCurationInputSnapshotV1;
  detectorVersion?: string;
  policyVersion?: string;
  promptVersion?: string;
};

export type LandscapeCurationJobUpdateInput = {
  status?: LandscapeCurationJob["status"];
  phase?: LandscapeCurationPhase;
  decision?: LandscapeCurationDecision | null;
  disposition?: LandscapeCurationDisposition | null;
  nextRunAt?: Date | null;
  attemptCount?: number;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  heartbeatAt?: Date | null;
  lastError?: string | null;
  lastOutcomeKind?: string | null;
  result?: Record<string, unknown>;
  policyResult?: Record<string, unknown>;
  mutationPlan?: Record<string, unknown>;
  postcheckResult?: Record<string, unknown>;
  rollbackSnapshot?: Record<string, unknown>;
  rollbackStatus?: LandscapeCurationRollbackStatus;
  completedAt?: Date | null;
  rollbackAt?: Date | null;
};

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function nullableDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = toDate(value);
  return parsed.getTime() === 0 ? null : parsed;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapJob(row: QueueRow): LandscapeCurationJob {
  return landscapeCurationJobSchema.parse({
    id: row.id,
    reviewItemId: row.reviewItemId ?? null,
    findingType: row.findingType,
    subjectKnowledgeId: row.subjectKnowledgeId,
    candidateKnowledgeIds: parseStringArray(row.candidateKnowledgeIds),
    status: row.status,
    phase: row.phase,
    decision: row.decision ?? null,
    disposition: row.disposition ?? null,
    priority: row.priority,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    provider: row.provider ?? null,
    model: row.model ?? null,
    lastError: row.lastError ?? null,
    lastOutcomeKind: row.lastOutcomeKind ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
    nextRunAt: iso(row.nextRunAt),
  });
}

function mapSqliteJobRow(row: Record<string, unknown>): QueueRow {
  return {
    id: String(row.id),
    reviewItemId: row.review_item_id ? String(row.review_item_id) : null,
    findingType: String(row.finding_type),
    subjectKnowledgeId: String(row.subject_knowledge_id),
    candidateKnowledgeIds: parseStringArray(row.candidate_knowledge_ids),
    repositoryIdentity: parseRecord(row.repository_identity),
    fingerprint: String(row.fingerprint),
    idempotencyKey: String(row.idempotency_key),
    evidenceHash: String(row.evidence_hash),
    status: String(row.status),
    phase: String(row.phase),
    decision: row.decision ? String(row.decision) : null,
    disposition: row.disposition ? String(row.disposition) : null,
    priority: Number(row.priority ?? 50),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    nextRunAt: nullableDate(row.next_run_at),
    lockedBy: row.locked_by ? String(row.locked_by) : null,
    lockedAt: nullableDate(row.locked_at),
    heartbeatAt: nullableDate(row.heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    lastOutcomeKind: row.last_outcome_kind ? String(row.last_outcome_kind) : null,
    provider: String(row.provider ?? "local-llm"),
    model: row.model ? String(row.model) : null,
    inputSnapshot: parseRecord(row.input_snapshot),
    result: parseRecord(row.result),
    policyResult: parseRecord(row.policy_result),
    mutationPlan: parseRecord(row.mutation_plan),
    postcheckResult: parseRecord(row.postcheck_result),
    rollbackSnapshot: parseRecord(row.rollback_snapshot),
    rollbackStatus: String(row.rollback_status ?? "not_requested"),
    schemaVersion: Number(row.schema_version ?? 1),
    detectorVersion: String(row.detector_version ?? "curation-detector-v1"),
    policyVersion: String(row.policy_version ?? "curation-policy-v1"),
    promptVersion: String(row.prompt_version ?? "landscape-curation-v1"),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    completedAt: nullableDate(row.completed_at),
    rollbackAt: nullableDate(row.rollback_at),
  } as QueueRow;
}

function mapLink(row: LinkRow): LandscapeCurationJobLink {
  return landscapeCurationJobLinkSchema.parse({
    id: row.id,
    curationJobId: row.curationJobId,
    role: row.role,
    queueName: row.queueName,
    queueJobId: row.queueJobId,
    status: row.status,
    outcomeKind: row.outcomeKind ?? null,
    metadata: parseRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: iso(row.completedAt),
  });
}

function mapSqliteLinkRow(row: Record<string, unknown>): LinkRow {
  return {
    id: String(row.id),
    curationJobId: String(row.curation_job_id),
    role: String(row.role),
    queueName: String(row.queue_name),
    queueJobId: String(row.queue_job_id),
    status: String(row.status),
    outcomeKind: row.outcome_kind ? String(row.outcome_kind) : null,
    metadata: parseRecord(row.metadata),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    completedAt: nullableDate(row.completed_at),
  } as LinkRow;
}

async function listLinks(curationJobId: string): Promise<LandscapeCurationJobLink[]> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = sqlite.db
      .query(
        "select * from landscape_curation_job_links where curation_job_id = ? order by created_at asc",
      )
      .all(curationJobId) as Record<string, unknown>[];
    return rows.map((row) => mapLink(mapSqliteLinkRow(row)));
  }
  const rows = await db
    .select()
    .from(landscapeCurationJobLinks)
    .where(eq(landscapeCurationJobLinks.curationJobId, curationJobId))
    .orderBy(landscapeCurationJobLinks.createdAt);
  return rows.map(mapLink);
}

export async function findLandscapeCurationJobLinkByQueueJob(params: {
  queueName: string;
  queueJobId: string;
  role?: LandscapeCurationJobLink["role"];
}): Promise<LandscapeCurationJobLink | null> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = params.role
      ? (sqlite.db
          .query(
            `select * from landscape_curation_job_links
             where queue_name = ? and queue_job_id = ? and role = ? limit 1`,
          )
          .get(params.queueName, params.queueJobId, params.role) as Record<string, unknown> | null)
      : (sqlite.db
          .query(
            `select * from landscape_curation_job_links
             where queue_name = ? and queue_job_id = ? limit 1`,
          )
          .get(params.queueName, params.queueJobId) as Record<string, unknown> | null);
    return row ? mapLink(mapSqliteLinkRow(row)) : null;
  }
  const conditions = [
    eq(landscapeCurationJobLinks.queueName, params.queueName),
    eq(landscapeCurationJobLinks.queueJobId, params.queueJobId),
  ];
  if (params.role) conditions.push(eq(landscapeCurationJobLinks.role, params.role));
  const [row] = await db
    .select()
    .from(landscapeCurationJobLinks)
    .where(and(...conditions))
    .limit(1);
  return row ? mapLink(row) : null;
}

export async function enqueueLandscapeCurationJob(
  input: LandscapeCurationJobCreateInput,
): Promise<LandscapeCurationJob> {
  const candidateKnowledgeIds = [...new Set(input.candidateKnowledgeIds)].filter(
    (id) => id && id !== input.subjectKnowledgeId,
  );
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const now = new Date().toISOString();
    const existing = sqlite.db
      .query(
        `select * from landscape_curation_queue
         where idempotency_key = ?
            or (fingerprint = ? and (status in ('pending', 'running', 'paused') or phase = 'awaiting_downstream'))
         order by case when idempotency_key = ? then 0 else 1 end
         limit 1`,
      )
      .get(input.idempotencyKey, input.fingerprint, input.idempotencyKey) as Record<
      string,
      unknown
    > | null;
    const id = existing?.id ? String(existing.id) : crypto.randomUUID();
    if (existing) {
      sqlite.db
        .query("update landscape_curation_queue set updated_at = ? where id = ?")
        .run(now, id);
    } else {
      sqlite.db
        .query(
          `
          insert or ignore into landscape_curation_queue (
            id, review_item_id, finding_type, subject_knowledge_id, candidate_knowledge_ids,
            repository_identity, fingerprint, idempotency_key, evidence_hash, status, phase,
            priority, attempt_count, max_attempts, provider, model, input_snapshot,
            detector_version, policy_version, prompt_version, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'evaluate', ?, 0, 3, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          id,
          input.reviewItemId ?? null,
          input.findingType,
          input.subjectKnowledgeId,
          JSON.stringify(candidateKnowledgeIds),
          JSON.stringify(input.repositoryIdentity),
          input.fingerprint,
          input.idempotencyKey,
          input.evidenceHash,
          input.priority,
          input.provider,
          input.model ?? null,
          JSON.stringify(input.inputSnapshot),
          input.detectorVersion ?? "curation-detector-v1",
          input.policyVersion ?? "curation-policy-v1",
          input.promptVersion ?? "landscape-curation-v1",
          now,
          now,
        );
    }
    const rowById = sqlite.db
      .query("select * from landscape_curation_queue where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    const row =
      rowById ??
      (sqlite.db
        .query(
          `select * from landscape_curation_queue
           where idempotency_key = ?
              or (fingerprint = ? and (status in ('pending', 'running', 'paused') or phase = 'awaiting_downstream'))
           order by updated_at desc
           limit 1`,
        )
        .get(input.idempotencyKey, input.fingerprint) as Record<string, unknown> | null);
    if (!row) throw new Error("failed to enqueue landscape curation job");
    return mapJob(mapSqliteJobRow(row));
  }

  const [inserted] = await db
    .insert(landscapeCurationQueue)
    .values({
      reviewItemId: input.reviewItemId ?? null,
      findingType: input.findingType,
      subjectKnowledgeId: input.subjectKnowledgeId,
      candidateKnowledgeIds,
      repositoryIdentity: input.repositoryIdentity,
      fingerprint: input.fingerprint,
      idempotencyKey: input.idempotencyKey,
      evidenceHash: input.evidenceHash,
      priority: input.priority,
      provider: input.provider,
      model: input.model ?? null,
      inputSnapshot: input.inputSnapshot,
      detectorVersion: input.detectorVersion ?? "curation-detector-v1",
      policyVersion: input.policyVersion ?? "curation-policy-v1",
      promptVersion: input.promptVersion ?? "landscape-curation-v1",
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return mapJob(inserted);
  const [existing] = await db
    .select()
    .from(landscapeCurationQueue)
    .where(
      or(
        eq(landscapeCurationQueue.idempotencyKey, input.idempotencyKey),
        and(
          eq(landscapeCurationQueue.fingerprint, input.fingerprint),
          sql`(${landscapeCurationQueue.status} in ('pending', 'running', 'paused') or ${landscapeCurationQueue.phase} = 'awaiting_downstream')`,
        ),
      ),
    )
    .orderBy(desc(landscapeCurationQueue.updatedAt))
    .limit(1);
  if (!existing) throw new Error("failed to resolve landscape curation enqueue conflict");
  return mapJob(existing);
}

export async function getLandscapeCurationJob(
  id: string,
): Promise<LandscapeCurationJobDetail | null> {
  const row = isSqliteBackend()
    ? await (async () => {
        const sqlite = await getSqliteCoreDatabase();
        const result = sqlite.db
          .query("select * from landscape_curation_queue where id = ? limit 1")
          .get(id) as Record<string, unknown> | null;
        return result ? mapSqliteJobRow(result) : null;
      })()
    : await (async () => {
        const [result] = await db
          .select()
          .from(landscapeCurationQueue)
          .where(eq(landscapeCurationQueue.id, id))
          .limit(1);
        return result ?? null;
      })();
  if (!row) return null;
  return {
    ...mapJob(row),
    repositoryIdentity: parseRecord(row.repositoryIdentity),
    fingerprint: row.fingerprint,
    evidenceHash: row.evidenceHash,
    inputSnapshot: parseRecord(row.inputSnapshot),
    result: parseRecord(row.result),
    policyResult: parseRecord(row.policyResult),
    mutationPlan: parseRecord(row.mutationPlan),
    postcheckResult: parseRecord(row.postcheckResult),
    rollbackSnapshot: parseRecord(row.rollbackSnapshot),
    rollbackStatus: row.rollbackStatus as LandscapeCurationRollbackStatus,
    links: await listLinks(row.id),
  };
}

export async function listLandscapeCurationJobs(params: {
  knowledgeId?: string;
  status?: LandscapeCurationJob["status"] | "unresolved" | "all";
  findingType?: LandscapeCurationFindingType | "all";
  limit?: number;
}): Promise<LandscapeCurationJob[]> {
  const limit = Math.max(1, Math.min(100, params.limit ?? 50));
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.knowledgeId) {
      where.push("subject_knowledge_id = ?");
      values.push(params.knowledgeId);
    }
    if (params.status === "unresolved") {
      where.push("(status not in ('completed', 'skipped') or phase = 'awaiting_downstream')");
    } else if (params.status && params.status !== "all") {
      where.push("status = ?");
      values.push(params.status);
    }
    if (params.findingType && params.findingType !== "all") {
      where.push("finding_type = ?");
      values.push(params.findingType);
    }
    const rows = sqlite.db
      .query(
        `select * from landscape_curation_queue ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit ?`,
      )
      .all(...values, limit) as Record<string, unknown>[];
    return rows.map((row) => mapJob(mapSqliteJobRow(row)));
  }
  const conditions = [];
  if (params.knowledgeId)
    conditions.push(eq(landscapeCurationQueue.subjectKnowledgeId, params.knowledgeId));
  if (params.status === "unresolved") {
    conditions.push(
      sql`(${landscapeCurationQueue.status} not in ('completed', 'skipped') or ${landscapeCurationQueue.phase} = 'awaiting_downstream')`,
    );
  } else if (params.status && params.status !== "all") {
    conditions.push(eq(landscapeCurationQueue.status, params.status));
  }
  if (params.findingType && params.findingType !== "all") {
    conditions.push(eq(landscapeCurationQueue.findingType, params.findingType));
  }
  const rows = await db
    .select()
    .from(landscapeCurationQueue)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(landscapeCurationQueue.updatedAt))
    .limit(limit);
  return rows.map(mapJob);
}

export async function updateLandscapeCurationJob(
  id: string,
  input: LandscapeCurationJobUpdateInput,
): Promise<LandscapeCurationJob | null> {
  const now = new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const fields: Array<[string, unknown]> = [["updated_at", now.toISOString()]];
    const add = (column: string, value: unknown) => {
      if (value !== undefined) fields.push([column, value]);
    };
    add("status", input.status);
    add("phase", input.phase);
    add("decision", input.decision);
    add("disposition", input.disposition);
    add(
      "next_run_at",
      input.nextRunAt === undefined ? undefined : (input.nextRunAt?.toISOString() ?? null),
    );
    add("attempt_count", input.attemptCount);
    add("locked_by", input.lockedBy);
    add(
      "locked_at",
      input.lockedAt === undefined ? undefined : (input.lockedAt?.toISOString() ?? null),
    );
    add(
      "heartbeat_at",
      input.heartbeatAt === undefined ? undefined : (input.heartbeatAt?.toISOString() ?? null),
    );
    add("last_error", input.lastError);
    add("last_outcome_kind", input.lastOutcomeKind);
    add("result", input.result === undefined ? undefined : JSON.stringify(input.result));
    add(
      "policy_result",
      input.policyResult === undefined ? undefined : JSON.stringify(input.policyResult),
    );
    add(
      "mutation_plan",
      input.mutationPlan === undefined ? undefined : JSON.stringify(input.mutationPlan),
    );
    add(
      "postcheck_result",
      input.postcheckResult === undefined ? undefined : JSON.stringify(input.postcheckResult),
    );
    add(
      "rollback_snapshot",
      input.rollbackSnapshot === undefined ? undefined : JSON.stringify(input.rollbackSnapshot),
    );
    add("rollback_status", input.rollbackStatus);
    add(
      "completed_at",
      input.completedAt === undefined ? undefined : (input.completedAt?.toISOString() ?? null),
    );
    add(
      "rollback_at",
      input.rollbackAt === undefined ? undefined : (input.rollbackAt?.toISOString() ?? null),
    );
    const result = sqlite.db
      .query(
        `update landscape_curation_queue set ${fields.map(([column]) => `${column} = ?`).join(", ")} where id = ? returning *`,
      )
      .get(...fields.map(([, value]) => value), id) as Record<string, unknown> | null;
    return result ? mapJob(mapSqliteJobRow(result)) : null;
  }

  const [row] = await db
    .update(landscapeCurationQueue)
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
      ...(input.nextRunAt !== undefined ? { nextRunAt: input.nextRunAt } : {}),
      ...(input.attemptCount !== undefined ? { attemptCount: input.attemptCount } : {}),
      ...(input.lockedBy !== undefined ? { lockedBy: input.lockedBy } : {}),
      ...(input.lockedAt !== undefined ? { lockedAt: input.lockedAt } : {}),
      ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
      ...(input.lastOutcomeKind !== undefined ? { lastOutcomeKind: input.lastOutcomeKind } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.policyResult !== undefined ? { policyResult: input.policyResult } : {}),
      ...(input.mutationPlan !== undefined ? { mutationPlan: input.mutationPlan } : {}),
      ...(input.postcheckResult !== undefined ? { postcheckResult: input.postcheckResult } : {}),
      ...(input.rollbackSnapshot !== undefined ? { rollbackSnapshot: input.rollbackSnapshot } : {}),
      ...(input.rollbackStatus !== undefined ? { rollbackStatus: input.rollbackStatus } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      ...(input.rollbackAt !== undefined ? { rollbackAt: input.rollbackAt } : {}),
      updatedAt: now,
    })
    .where(eq(landscapeCurationQueue.id, id))
    .returning();
  return row ? mapJob(row) : null;
}

export async function upsertLandscapeCurationJobLink(input: {
  curationJobId: string;
  role: LandscapeCurationJobLink["role"];
  queueName: string;
  queueJobId: string;
  status: string;
  outcomeKind?: string | null;
  metadata?: Record<string, unknown>;
  completedAt?: Date | null;
}): Promise<LandscapeCurationJobLink> {
  const now = new Date();
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const existing = sqlite.db
      .query(
        "select * from landscape_curation_job_links where curation_job_id = ? and role = ? limit 1",
      )
      .get(input.curationJobId, input.role) as Record<string, unknown> | null;
    const id = existing?.id ? String(existing.id) : crypto.randomUUID();
    if (existing) {
      sqlite.db
        .query(
          `update landscape_curation_job_links
           set queue_name = ?, queue_job_id = ?, status = ?, outcome_kind = ?, metadata = ?, updated_at = ?, completed_at = ?
           where id = ?`,
        )
        .run(
          input.queueName,
          input.queueJobId,
          input.status,
          input.outcomeKind ?? null,
          JSON.stringify(input.metadata ?? {}),
          now.toISOString(),
          input.completedAt?.toISOString() ?? null,
          id,
        );
    } else {
      sqlite.db
        .query(
          `insert into landscape_curation_job_links
           (id, curation_job_id, role, queue_name, queue_job_id, status, outcome_kind, metadata, created_at, updated_at, completed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.curationJobId,
          input.role,
          input.queueName,
          input.queueJobId,
          input.status,
          input.outcomeKind ?? null,
          JSON.stringify(input.metadata ?? {}),
          now.toISOString(),
          now.toISOString(),
          input.completedAt?.toISOString() ?? null,
        );
    }
    const row = sqlite.db
      .query("select * from landscape_curation_job_links where id = ? limit 1")
      .get(id) as Record<string, unknown> | null;
    if (!row) throw new Error("failed to upsert landscape curation job link");
    return mapLink(mapSqliteLinkRow(row));
  }
  const [row] = await db
    .insert(landscapeCurationJobLinks)
    .values({
      curationJobId: input.curationJobId,
      role: input.role,
      queueName: input.queueName,
      queueJobId: input.queueJobId,
      status: input.status,
      outcomeKind: input.outcomeKind ?? null,
      metadata: input.metadata ?? {},
      completedAt: input.completedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [landscapeCurationJobLinks.curationJobId, landscapeCurationJobLinks.role],
      set: {
        queueName: input.queueName,
        queueJobId: input.queueJobId,
        status: input.status,
        outcomeKind: input.outcomeKind ?? null,
        metadata: input.metadata ?? {},
        completedAt: input.completedAt ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return mapLink(row);
}

export async function countLandscapeCurationDailyDownstreamUsage(params: {
  since: Date;
  repositoryIdentity?: string;
}): Promise<number> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = params.repositoryIdentity
      ? sqlite.db
          .query(
            `select count(*) as count from landscape_curation_queue
             where created_at >= ?
               and disposition = 'enqueue_downstream'
               and exists (
                 select 1 from landscape_curation_job_links link
                 where link.curation_job_id = landscape_curation_queue.id
                   and link.role = 'merge_review'
               )
               and coalesce(
                 json_extract(repository_identity, '$.key'),
                 json_extract(repository_identity, '$.path'),
                 json_extract(repository_identity, '$.projectRef')
               ) = ?`,
          )
          .get(params.since.toISOString(), params.repositoryIdentity)
      : sqlite.db
          .query(
            `select count(*) as count from landscape_curation_queue
             where created_at >= ?
               and disposition = 'enqueue_downstream'
               and exists (
                 select 1 from landscape_curation_job_links link
                 where link.curation_job_id = landscape_curation_queue.id
                   and link.role = 'merge_review'
               )`,
          )
          .get(params.since.toISOString());
    return Number((row as { count?: number } | null)?.count ?? 0);
  }
  const repositoryCondition = params.repositoryIdentity
    ? sql`coalesce(
        ${landscapeCurationQueue.repositoryIdentity} ->> 'key',
        ${landscapeCurationQueue.repositoryIdentity} ->> 'path',
        ${landscapeCurationQueue.repositoryIdentity} ->> 'projectRef'
      ) = ${params.repositoryIdentity}`
    : undefined;
  const result = await db.execute(sql`
    select count(*)::int as count
    from ${landscapeCurationQueue}
    where ${landscapeCurationQueue.createdAt} >= ${params.since}
      and ${landscapeCurationQueue.disposition} = 'enqueue_downstream'
      and exists (
        select 1
        from ${landscapeCurationJobLinks} link
        where link.curation_job_id = ${landscapeCurationQueue.id}
          and link.role = 'merge_review'
      )
      ${repositoryCondition ? sql`and ${repositoryCondition}` : sql``}
  `);
  return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
}

export async function hasRecentLandscapeCurationFingerprint(params: {
  fingerprint: string;
  since: Date;
}): Promise<boolean> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const row = sqlite.db
      .query(
        "select id from landscape_curation_queue where fingerprint = ? and created_at >= ? limit 1",
      )
      .get(params.fingerprint, params.since.toISOString());
    return Boolean(row);
  }
  const [row] = await db
    .select({ id: landscapeCurationQueue.id })
    .from(landscapeCurationQueue)
    .where(
      and(
        eq(landscapeCurationQueue.fingerprint, params.fingerprint),
        sql`${landscapeCurationQueue.createdAt} >= ${params.since}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}
