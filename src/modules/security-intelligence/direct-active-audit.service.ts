import { eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";

type DirectRegistrationMetadata = {
  source?: unknown;
  sqliteDirectRegistration?: unknown;
  rustDirectRegistration?: unknown;
};

export async function auditDirectActiveKnowledge() {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const rows = sqlite.db
      .query<{ status: string; metadata: string }, []>(
        `select status, metadata from knowledge_items
         where status = 'active'
           and case when json_valid(metadata) then (
             coalesce(json_extract(metadata, '$.sqliteDirectRegistration'), 0) = 1
             or coalesce(json_extract(metadata, '$.rustDirectRegistration'), 0) = 1
           ) else 0 end`,
      )
      .all();
    return summarize(
      rows.map((row) => ({ status: row.status, metadata: JSON.parse(row.metadata) })),
    );
  }
  const rows = await db
    .select({ status: knowledgeItems.status, metadata: knowledgeItems.metadata })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.status, "active"));
  return summarize(
    rows.filter((row) => {
      const metadata = row.metadata as DirectRegistrationMetadata;
      return metadata.sqliteDirectRegistration === true || metadata.rustDirectRegistration === true;
    }),
  );
}

function summarize(rows: Array<{ status: string; metadata: unknown }>) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as DirectRegistrationMetadata;
    const runtime = metadata.rustDirectRegistration === true ? "rust_native" : "typescript_sqlite";
    const source = typeof metadata.source === "string" ? metadata.source : "unknown";
    const key = `${runtime}\u0000${source}\u0000${row.status}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    version: 1 as const,
    total: rows.length,
    groups: [...groups.entries()]
      .map(([key, count]) => {
        const [runtime, source, status] = key.split("\u0000");
        return { runtime, source, status, count };
      })
      .sort((left, right) =>
        `${left.runtime}:${left.source}:${left.status}`.localeCompare(
          `${right.runtime}:${right.source}:${right.status}`,
        ),
      ),
  };
}
