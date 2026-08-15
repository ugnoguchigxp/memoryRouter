import { describe, expect, test } from "vitest";
import type { RepositoryIsolationProducerManifest } from "../src/modules/context-compiler/repository-isolation-producer-manifest.js";
import { buildRepositoryIsolationReport } from "../src/modules/context-compiler/repository-isolation-report.js";

const now = new Date("2026-08-15T12:00:00.000Z");
const observationStartedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

function producerManifest(
  enabledProducers = ["source.markdown-import", "episode-distiller.rust"],
  startedAt: Date | null = observationStartedAt,
  maintenanceProducers: string[] = [],
): RepositoryIsolationProducerManifest {
  const producer = (name: string, disposition: "enabled" | "maintenance_only") => ({
    name,
    disposition,
    runtime: disposition === "enabled" ? ("resident" as const) : ("typescript" as const),
    entityKinds: [
      name.startsWith("source")
        ? ("source" as const)
        : name.startsWith("knowledge")
          ? ("knowledge" as const)
          : ("episode" as const),
    ],
  });
  return {
    contractVersion: 1,
    profile: "resident-local",
    status: "finalized",
    finalizedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
    observationStartedAt: startedAt,
    fingerprint: "f".repeat(64),
    producers: [
      ...enabledProducers.map((name) => producer(name, "enabled")),
      ...maintenanceProducers.map((name) => producer(name, "maintenance_only")),
    ],
    enabledProducers,
  };
}

function identityBearingEvents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED" as const,
    createdAt:
      index === 0
        ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() - index * 60_000),
    payload: {
      producer: index % 2 === 0 ? "source.markdown-import" : "episode-distiller.rust",
      entityKind: index % 2 === 0 ? "source" : "episode",
      scope: "repo",
      matchBasis: "repo_path",
      identityFingerprint: "a".repeat(64),
      bindingStatus: "unverified",
    },
  }));
}

describe("repository isolation producer observation", () => {
  test("does not count validation-only events as durable producer writes", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: identityBearingEvents(200).map((event) => ({
        ...event,
        eventType: "PROJECT_IDENTITY_PRODUCER_VALIDATED" as const,
      })),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      producerManifest: producerManifest(),
      now,
    });

    expect(report.producerObservation).toMatchObject({
      validatedCount: 200,
      persistedCount: 0,
      identityBearingPersistedCount: 0,
      hasMinimumIdentityBearingEvents: false,
      completionCriteriaMet: false,
    });
  });

  test("does not count global or malformed persisted events as identity-bearing", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: [
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: { producer: "source.markdown-import", matchBasis: "none" },
        },
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: { producer: "episode-distiller.rust" },
        },
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: {
            producer: "knowledge.api-create",
            entityKind: "knowledge",
            scope: "global",
            matchBasis: "none",
            identityFingerprint: null,
            bindingStatus: "not_applicable",
          },
        },
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: {
            producer: "source.markdown-import",
            entityKind: "source",
            scope: "global",
            matchBasis: "repo_path",
            identityFingerprint: "a".repeat(64),
            bindingStatus: "unverified",
          },
        },
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: {
            producer: "source.markdown-import",
            entityKind: "source",
            scope: "repo",
            matchBasis: "repo_path",
            bindingStatus: "unverified",
          },
        },
      ],
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      producerManifest: producerManifest(undefined, undefined, ["knowledge.api-create"]),
      now,
    });

    expect(report.producerObservation).toMatchObject({
      persistedCount: 5,
      identityBearingPersistedCount: 0,
      globalPersistedCount: 1,
      malformedPersistedCount: 4,
      observedEnabledProducers: [],
      enabledProducerCoverageRate: 0,
      hasCompleteEnabledProducerCoverage: false,
      completionCriteriaMet: false,
    });
  });

  test("passes only after the full 7-day, 200-event, zero-unresolved gate", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: identityBearingEvents(200),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      producerManifest: producerManifest(),
      now,
    });

    expect(report.producerObservation).toMatchObject({
      observationStartedAt: observationStartedAt.toISOString(),
      identityBearingPersistedCount: 200,
      malformedPersistedCount: 0,
      newUnresolvedCount: 0,
      hasFullWindow: true,
      hasMinimumIdentityBearingEvents: true,
      hasCompleteEnabledProducerCoverage: true,
      enabledProducerCoverageRate: 1,
      completionCriteriaMet: true,
    });
  });

  test("keeps the gate closed when a persisted audit payload is malformed", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: [
        ...identityBearingEvents(200),
        {
          eventType: "PROJECT_IDENTITY_PRODUCER_PERSISTED",
          createdAt: now,
          payload: {
            producer: "source.markdown-import",
            entityKind: "source",
            scope: "repo",
            matchBasis: "repo_path",
            identityFingerprint: "invalid",
            bindingStatus: "unverified",
          },
        },
      ],
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      producerManifest: producerManifest(),
      now,
    });

    expect(report.producerObservation).toMatchObject({
      identityBearingPersistedCount: 200,
      malformedPersistedCount: 1,
      hasFullWindow: true,
      hasMinimumIdentityBearingEvents: true,
      hasCompleteEnabledProducerCoverage: true,
      completionCriteriaMet: false,
    });
  });

  test("does not infer the observation window from event timestamps", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: identityBearingEvents(200),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      producerManifest: producerManifest(undefined, null),
      now,
    });

    expect(report.producerObservation).toMatchObject({
      observationStartedAt: null,
      observedDays: 0,
      hasFullWindow: false,
      hasMinimumIdentityBearingEvents: true,
      completionCriteriaMet: false,
    });
  });

  test("keeps the gate closed when a new unresolved row exists", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: identityBearingEvents(200),
      newUnresolvedByEntity: { knowledge: 1, source: 0, episode: 0 },
      producerManifest: producerManifest(),
      now,
    });

    expect(report.producerObservation.completionCriteriaMet).toBe(false);
    expect(report.producerObservation.newUnresolvedByEntity.knowledge).toBe(1);
  });

  test("keeps the gate closed until every enabled producer has persisted", () => {
    const producerEvents = identityBearingEvents(200).map((event) => ({
      ...event,
      payload: { ...event.payload, producer: "source.markdown-import" },
    }));
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents,
      producerManifest: producerManifest(["source.markdown-import", "episode-distiller.rust"]),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      now,
    });

    expect(report.producerObservation).toMatchObject({
      observedEnabledProducers: ["source.markdown-import"],
      missingEnabledProducers: ["episode-distiller.rust"],
      enabledProducerCoverageRate: 0.5,
      hasCompleteEnabledProducerCoverage: false,
      completionCriteriaMet: false,
    });
  });

  test("fails closed when the enabled producer manifest is omitted", () => {
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: identityBearingEvents(200),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      now,
    });

    expect(report.producerObservation).toMatchObject({
      enabledProducers: [],
      manifestStatus: "missing",
      hasFinalizedManifest: false,
      enabledProducerCoverageRate: 0,
      hasCompleteEnabledProducerCoverage: false,
      completionCriteriaMet: false,
    });
  });

  test("does not let maintenance-only events satisfy the enabled event minimum", () => {
    const producerEvents = identityBearingEvents(200).map((event, index) => ({
      ...event,
      payload: {
        ...event.payload,
        producer: index === 0 ? "source.markdown-import" : "episode.maintenance",
        entityKind: index === 0 ? "source" : "episode",
      },
    }));
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents,
      producerManifest: producerManifest(["source.markdown-import"], observationStartedAt, [
        "episode.maintenance",
      ]),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      now,
    });

    expect(report.producerObservation).toMatchObject({
      persistedCount: 200,
      identityBearingPersistedCount: 1,
      malformedPersistedCount: 0,
      hasMinimumIdentityBearingEvents: false,
      completionCriteriaMet: false,
    });
  });

  test("fails closed for unknown producers and producer/entity contract mismatches", () => {
    const [baseEvent] = identityBearingEvents(1);
    if (!baseEvent) throw new Error("missing fixture event");
    const report = buildRepositoryIsolationReport({
      backend: "fixture",
      candidates: [],
      producerEvents: [
        {
          ...baseEvent,
          payload: { ...baseEvent.payload, producer: "unknown.rust" },
        },
        {
          ...baseEvent,
          payload: {
            ...baseEvent.payload,
            producer: "source.markdown-import",
            entityKind: "episode",
          },
        },
      ],
      producerManifest: producerManifest(["source.markdown-import"]),
      newUnresolvedByEntity: { knowledge: 0, source: 0, episode: 0 },
      now,
    });

    expect(report.producerObservation).toMatchObject({
      persistedCount: 2,
      identityBearingPersistedCount: 0,
      malformedPersistedCount: 2,
      completionCriteriaMet: false,
    });
  });
});
