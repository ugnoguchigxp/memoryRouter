import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { resolveProjectScopedWriteIdentity } from "../modules/context-compiler/project-scoped-write.js";
import { redactSecretRecord, redactSecretsFromValue } from "../shared/utils/secret-redaction.js";
import { closeDbPool, db } from "./index.js";
import {
  knowledgeCommunityLabels,
  knowledgeItems,
  knowledgeSourceLinks,
  knowledgeTagDefinitions,
  sourceFragments,
  sources,
} from "./schema.js";

type JsonRecord = Record<string, unknown>;

export type SeedPayload = {
  schemaVersion: number;
  generatedAt: string;
  knowledgeItems: JsonRecord[];
  sources: JsonRecord[];
  sourceFragments: JsonRecord[];
  knowledgeSourceLinks: JsonRecord[];
  knowledgeTagDefinitions: JsonRecord[];
  knowledgeCommunityLabels: JsonRecord[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactSeedRecord(row: JsonRecord): JsonRecord {
  return redactSecretRecord(row);
}

export function sanitizeSeedPayloadForPersistence(payload: SeedPayload): SeedPayload {
  return {
    ...payload,
    knowledgeItems: payload.knowledgeItems.map(redactSeedRecord),
    sources: payload.sources.map(redactSeedRecord),
    sourceFragments: payload.sourceFragments.map(redactSeedRecord),
    knowledgeSourceLinks: payload.knowledgeSourceLinks.map(redactSeedRecord),
    knowledgeTagDefinitions: payload.knowledgeTagDefinitions.map(
      (row) => redactSecretsFromValue(row) as JsonRecord,
    ),
    knowledgeCommunityLabels: payload.knowledgeCommunityLabels.map(
      (row) => redactSecretsFromValue(row) as JsonRecord,
    ),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveSeedProjectIdentity(
  row: JsonRecord,
  fallback: { repoKey?: unknown; repoPath?: unknown },
) {
  const rawScope = asString(row.scope) ?? "repo";
  if (rawScope !== "repo" && rawScope !== "global") {
    throw new Error(`Invalid seed project identity scope for row ${asString(row.id) ?? "unknown"}`);
  }
  return resolveProjectScopedWriteIdentity({
    scope: rawScope,
    projectRef: asString(row.project_ref),
    repoKey: asString(row.repo_key) ?? asString(fallback.repoKey),
    repoPath: asString(row.repo_path) ?? asString(fallback.repoPath),
  });
}

function asSeedPayload(value: unknown): SeedPayload {
  const record = asRecord(value);
  return {
    schemaVersion: asNumber(record.schemaVersion, 0),
    generatedAt: asString(record.generatedAt) ?? "",
    knowledgeItems: asArray(record.knowledgeItems).map(asRecord),
    sources: asArray(record.sources).map(asRecord),
    sourceFragments: asArray(record.sourceFragments).map(asRecord),
    knowledgeSourceLinks: asArray(record.knowledgeSourceLinks).map(asRecord),
    knowledgeTagDefinitions: asArray(record.knowledgeTagDefinitions).map(asRecord),
    knowledgeCommunityLabels: asArray(record.knowledgeCommunityLabels).map(asRecord),
  };
}

async function upsertInChunks<T>(
  rows: T[],
  chunkSize: number,
  runner: (chunk: T[]) => Promise<void>,
): Promise<void> {
  if (rows.length === 0) return;
  for (let index = 0; index < rows.length; index += chunkSize) {
    await runner(rows.slice(index, index + chunkSize));
  }
}

async function main(): Promise<void> {
  const seedFile = process.env.KNOWLEDGE_SEED_FILE
    ? path.resolve(process.cwd(), process.env.KNOWLEDGE_SEED_FILE)
    : path.resolve(process.cwd(), "src/db/seeds/knowledge-seed.json");
  const raw = await readFile(seedFile, "utf-8");
  const payload = sanitizeSeedPayloadForPersistence(asSeedPayload(JSON.parse(raw)));

  if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported seed schemaVersion: ${payload.schemaVersion}`);
  }

  const mappedSources = payload.sources.map((row) => {
    const metadata = asRecord(row.metadata);
    const identity = resolveSeedProjectIdentity(row, {
      repoKey: metadata.repoKey,
      repoPath: metadata.repoPath,
    });
    return {
      id: asString(row.id) ?? "",
      sourceKind: asString(row.source_kind) ?? "wiki",
      classificationStatus: identity.classificationStatus,
      scope: identity.scope,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      uri: asString(row.uri) ?? "",
      title: asString(row.title),
      body: asString(row.body) ?? "",
      metadata,
      createdAt: asDate(row.created_at) ?? new Date(),
      updatedAt: asDate(row.updated_at) ?? new Date(),
      lastIndexedAt: asDate(row.last_indexed_at),
    };
  });

  const mappedSourceFragments = payload.sourceFragments.map((row) => ({
    id: asString(row.id) ?? "",
    sourceId: asString(row.source_id) ?? "",
    locator: asString(row.locator) ?? "full",
    heading: asString(row.heading),
    content: asString(row.content) ?? "",
    metadata: asRecord(row.metadata),
    createdAt: asDate(row.created_at) ?? new Date(),
  }));

  const mappedKnowledgeItems = payload.knowledgeItems.map((row) => {
    const appliesTo = asRecord(row.applies_to);
    const identity = resolveSeedProjectIdentity(row, {
      repoKey: appliesTo.repoKey,
      repoPath: appliesTo.repoPath,
    });
    return {
      id: asString(row.id) ?? "",
      type: asString(row.type) ?? "rule",
      status: asString(row.status) ?? "active",
      classificationStatus: identity.classificationStatus,
      scope: identity.scope,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: asString(row.polarity) ?? "positive",
      intentTags: asArray(row.intent_tags ?? row.intentTags).map(String),
      title: asString(row.title) ?? "",
      body: asString(row.body) ?? "",
      appliesTo,
      confidence: asNumber(row.confidence, 70),
      importance: asNumber(row.importance, 70),
      compileSelectCount: Math.max(0, Math.floor(asNumber(row.compile_select_count, 0))),
      lastCompiledAt: asDate(row.last_compiled_at),
      agenticAcceptCount: Math.max(0, Math.floor(asNumber(row.agentic_accept_count, 0))),
      explicitUpvoteCount: Math.max(0, Math.floor(asNumber(row.explicit_upvote_count, 0))),
      explicitDownvoteCount: Math.max(0, Math.floor(asNumber(row.explicit_downvote_count, 0))),
      dynamicScore: asNumber(row.dynamic_score, 0),
      metadata: asRecord(row.metadata),
      createdAt: asDate(row.created_at) ?? new Date(),
      updatedAt: asDate(row.updated_at) ?? new Date(),
      lastVerifiedAt: asDate(row.last_verified_at),
    };
  });

  const mappedKnowledgeSourceLinks = payload.knowledgeSourceLinks.map((row) => ({
    id: asString(row.id) ?? "",
    knowledgeId: asString(row.knowledge_id) ?? "",
    sourceFragmentId: asString(row.source_fragment_id) ?? "",
    linkType: asString(row.link_type) ?? "derived_from",
    confidence: asNumber(row.confidence, 0.5),
    metadata: asRecord(row.metadata),
    createdAt: asDate(row.created_at) ?? new Date(),
  }));

  const mappedKnowledgeTagDefinitions = payload.knowledgeTagDefinitions.map((row) => ({
    id: asString(row.id) ?? "",
    kind: asString(row.kind) ?? "technology",
    slug: asString(row.slug) ?? "",
    label: asString(row.label) ?? "",
    description: asString(row.description),
    aliases: asArray(row.aliases),
    status: asString(row.status) ?? "active",
    sortOrder: Math.max(0, Math.floor(asNumber(row.sort_order, 1000))),
    createdAt: asDate(row.created_at) ?? new Date(),
    updatedAt: asDate(row.updated_at) ?? new Date(),
  }));

  const mappedKnowledgeCommunityLabels = payload.knowledgeCommunityLabels.map((row) => ({
    communityKey: asString(row.community_key) ?? "",
    label: asString(row.label) ?? "",
    note: asString(row.note),
    updatedAt: asDate(row.updated_at) ?? new Date(),
  }));

  await db.transaction(async (tx) => {
    await upsertInChunks(mappedSources, 100, async (chunk) => {
      await tx
        .insert(sources)
        .values(chunk)
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            sourceKind: sql`excluded.source_kind`,
            classificationStatus: sql`excluded.classification_status`,
            scope: sql`excluded.scope`,
            projectRef: sql`excluded.project_ref`,
            repoKey: sql`excluded.repo_key`,
            repoPath: sql`excluded.repo_path`,
            uri: sql`excluded.uri`,
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            metadata: sql`excluded.metadata`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
            lastIndexedAt: sql`excluded.last_indexed_at`,
          },
        });
    });

    await upsertInChunks(mappedSourceFragments, 100, async (chunk) => {
      await tx
        .insert(sourceFragments)
        .values(chunk)
        .onConflictDoUpdate({
          target: sourceFragments.id,
          set: {
            sourceId: sql`excluded.source_id`,
            locator: sql`excluded.locator`,
            heading: sql`excluded.heading`,
            content: sql`excluded.content`,
            metadata: sql`excluded.metadata`,
            createdAt: sql`excluded.created_at`,
          },
        });
    });

    await upsertInChunks(mappedKnowledgeItems, 100, async (chunk) => {
      await tx
        .insert(knowledgeItems)
        .values(chunk)
        .onConflictDoUpdate({
          target: knowledgeItems.id,
          set: {
            type: sql`excluded.type`,
            status: sql`excluded.status`,
            scope: sql`excluded.scope`,
            classificationStatus: sql`excluded.classification_status`,
            projectRef: sql`excluded.project_ref`,
            repoKey: sql`excluded.repo_key`,
            repoPath: sql`excluded.repo_path`,
            polarity: sql`excluded.polarity`,
            intentTags: sql`excluded.intent_tags`,
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            appliesTo: sql`excluded.applies_to`,
            confidence: sql`excluded.confidence`,
            importance: sql`excluded.importance`,
            compileSelectCount: sql`excluded.compile_select_count`,
            lastCompiledAt: sql`excluded.last_compiled_at`,
            agenticAcceptCount: sql`excluded.agentic_accept_count`,
            explicitUpvoteCount: sql`excluded.explicit_upvote_count`,
            explicitDownvoteCount: sql`excluded.explicit_downvote_count`,
            dynamicScore: sql`excluded.dynamic_score`,
            metadata: sql`excluded.metadata`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
            lastVerifiedAt: sql`excluded.last_verified_at`,
          },
        });
    });

    await upsertInChunks(mappedKnowledgeSourceLinks, 100, async (chunk) => {
      await tx
        .insert(knowledgeSourceLinks)
        .values(chunk)
        .onConflictDoUpdate({
          target: knowledgeSourceLinks.id,
          set: {
            knowledgeId: sql`excluded.knowledge_id`,
            sourceFragmentId: sql`excluded.source_fragment_id`,
            linkType: sql`excluded.link_type`,
            confidence: sql`excluded.confidence`,
            metadata: sql`excluded.metadata`,
            createdAt: sql`excluded.created_at`,
          },
        });
    });

    await upsertInChunks(mappedKnowledgeTagDefinitions, 100, async (chunk) => {
      await tx
        .insert(knowledgeTagDefinitions)
        .values(chunk)
        .onConflictDoUpdate({
          target: knowledgeTagDefinitions.id,
          set: {
            kind: sql`excluded.kind`,
            slug: sql`excluded.slug`,
            label: sql`excluded.label`,
            description: sql`excluded.description`,
            aliases: sql`excluded.aliases`,
            status: sql`excluded.status`,
            sortOrder: sql`excluded.sort_order`,
            createdAt: sql`excluded.created_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    });

    await upsertInChunks(mappedKnowledgeCommunityLabels, 100, async (chunk) => {
      await tx
        .insert(knowledgeCommunityLabels)
        .values(chunk)
        .onConflictDoUpdate({
          target: knowledgeCommunityLabels.communityKey,
          set: {
            label: sql`excluded.label`,
            note: sql`excluded.note`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    });
  });

  console.log(
    [
      `[seed] schemaVersion=${payload.schemaVersion}`,
      `[seed] generatedAt=${payload.generatedAt}`,
      `[seed] knowledgeItems=${mappedKnowledgeItems.length}`,
      `[seed] knowledgeSourceLinks=${mappedKnowledgeSourceLinks.length}`,
      `[seed] sources=${mappedSources.length}`,
      `[seed] sourceFragments=${mappedSourceFragments.length}`,
      `[seed] knowledgeTagDefinitions=${mappedKnowledgeTagDefinitions.length}`,
      `[seed] knowledgeCommunityLabels=${mappedKnowledgeCommunityLabels.length}`,
      "[seed] completed (audit/candidate tables are excluded)",
    ].join("\n"),
  );
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  main()
    .catch((error) => {
      console.error("[seed] failed:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDbPool();
    });
}
