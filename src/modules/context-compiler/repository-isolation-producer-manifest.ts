import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

export const repositoryIsolationProducerEntityKindValues = [
  "knowledge",
  "source",
  "episode",
  "candidate",
  "vibe_memory",
] as const;
export type RepositoryIsolationProducerEntityKind =
  (typeof repositoryIsolationProducerEntityKindValues)[number];

const producerEntityKindSchema = z.enum(repositoryIsolationProducerEntityKindValues);

const producerManifestSchema = z
  .object({
    contractVersion: z.literal(1),
    profile: z.literal("resident-local"),
    status: z.enum(["draft", "finalized"]),
    finalizedAt: z.string().datetime({ offset: true }),
    observationStartedAt: z.string().datetime({ offset: true }).nullable(),
    producers: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(120),
          disposition: z.enum(["enabled", "maintenance_only", "disabled"]),
          runtime: z.enum(["resident", "typescript", "api"]),
          entityKinds: z.array(producerEntityKindSchema).min(1),
          reason: z.string().trim().min(1),
        }),
      )
      .min(1),
  })
  .superRefine((manifest, context) => {
    const names = new Set<string>();
    for (const [index, producer] of manifest.producers.entries()) {
      if (names.has(producer.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["producers", index, "name"],
          message: `duplicate producer name: ${producer.name}`,
        });
      }
      names.add(producer.name);
    }
    if (!manifest.producers.some((producer) => producer.disposition === "enabled")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["producers"],
        message: "manifest must contain at least one enabled producer",
      });
    }
    for (const [index, producer] of manifest.producers.entries()) {
      if (producer.disposition === "enabled" && producer.runtime !== "resident") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["producers", index, "runtime"],
          message: "resident-local enabled producers must use the resident runtime",
        });
      }
    }
    if (
      manifest.observationStartedAt &&
      new Date(manifest.observationStartedAt).getTime() < new Date(manifest.finalizedAt).getTime()
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observationStartedAt"],
        message: "observation must start at or after manifest finalization",
      });
    }
    if (manifest.status !== "finalized" && manifest.observationStartedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observationStartedAt"],
        message: "draft manifest cannot start producer observation",
      });
    }
  });

export type RepositoryIsolationProducerManifestDocument = z.infer<typeof producerManifestSchema>;

export type RepositoryIsolationProducerManifest = {
  contractVersion: 1;
  profile: "resident-local";
  status: "draft" | "finalized";
  finalizedAt: Date;
  observationStartedAt: Date | null;
  fingerprint: string;
  producers: Array<{
    name: string;
    disposition: "enabled" | "maintenance_only" | "disabled";
    runtime: "resident" | "typescript" | "api";
    entityKinds: RepositoryIsolationProducerEntityKind[];
  }>;
  enabledProducers: string[];
};

const manifestUrl = new URL(
  "../../../shared/fixtures/repository-isolation-producer-manifest-v1.json",
  import.meta.url,
);

export function parseRepositoryIsolationProducerManifest(
  rawDocument: unknown,
): RepositoryIsolationProducerManifest {
  const document = producerManifestSchema.parse(rawDocument);
  const canonicalJson = JSON.stringify(document);
  return {
    contractVersion: document.contractVersion,
    profile: document.profile,
    status: document.status,
    finalizedAt: new Date(document.finalizedAt),
    observationStartedAt: document.observationStartedAt
      ? new Date(document.observationStartedAt)
      : null,
    fingerprint: createHash("sha256").update(canonicalJson).digest("hex"),
    producers: document.producers.map((producer) => ({
      name: producer.name,
      disposition: producer.disposition,
      runtime: producer.runtime,
      entityKinds: producer.entityKinds,
    })),
    enabledProducers: document.producers
      .filter((producer) => producer.disposition === "enabled")
      .map((producer) => producer.name)
      .sort(),
  };
}

export function loadRepositoryIsolationProducerManifest(): RepositoryIsolationProducerManifest {
  return parseRepositoryIsolationProducerManifest(
    JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown,
  );
}
