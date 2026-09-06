import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  loadRepositoryIsolationProducerManifest,
  parseRepositoryIsolationProducerManifest,
} from "../src/modules/context-compiler/repository-isolation-producer-manifest.js";

describe("repository isolation producer manifest", () => {
  test("fixes the resident-local enabled producer set and controlled restart time", () => {
    const manifest = loadRepositoryIsolationProducerManifest();

    expect(manifest).toMatchObject({
      contractVersion: 1,
      profile: "resident-local",
      status: "finalized",
      observationStartedAt: new Date("2026-08-15T16:07:10.000Z"),
    });
    expect(
      manifest.producers
        .filter((producer) => producer.disposition === "enabled")
        .map((producer) => producer.name)
        .sort(),
    ).toEqual(["agent-log-sync.rust", "episode-distiller.rust", "register-candidates.rust"]);
    expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("keeps every enabled producer name aligned with the Rust resident implementation", () => {
    const manifest = loadRepositoryIsolationProducerManifest();
    const sources = [
      "crates/context-stilld/src/domains/agent_log_sync/store.rs",
      "crates/context-stilld/src/domains/queue_lifecycle/episode_executor/persistence.rs",
      "crates/context-stilld/src/domains/mcp_lifecycle/native_knowledge.rs",
    ].map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

    for (const producer of manifest.producers.filter(
      (candidate) => candidate.disposition === "enabled",
    )) {
      expect(sources.some((source) => source.includes(`"producer": "${producer.name}"`))).toBe(
        true,
      );
    }
  });

  test("rejects duplicate producers and an observation before finalization", () => {
    const base = {
      contractVersion: 1,
      profile: "resident-local",
      status: "finalized",
      finalizedAt: "2026-08-15T15:42:29.000Z",
      observationStartedAt: "2026-08-15T15:42:28.000Z",
      producers: [
        {
          name: "agent-log-sync.rust",
          disposition: "enabled",
          runtime: "resident",
          entityKinds: ["vibe_memory"],
          reason: "resident",
        },
        {
          name: "agent-log-sync.rust",
          disposition: "maintenance_only",
          runtime: "typescript",
          entityKinds: ["vibe_memory"],
          reason: "duplicate",
        },
      ],
    };

    expect(() => parseRepositoryIsolationProducerManifest(base)).toThrow(/duplicate producer name/);
    expect(() =>
      parseRepositoryIsolationProducerManifest({
        ...base,
        producers: base.producers.slice(0, 1),
      }),
    ).toThrow(/observation must start at or after manifest finalization/);
  });

  test("rejects a non-resident producer marked enabled in the resident profile", () => {
    expect(() =>
      parseRepositoryIsolationProducerManifest({
        contractVersion: 1,
        profile: "resident-local",
        status: "finalized",
        finalizedAt: "2026-08-15T15:42:29.000Z",
        observationStartedAt: null,
        producers: [
          {
            name: "knowledge.api-create",
            disposition: "enabled",
            runtime: "api",
            entityKinds: ["knowledge"],
            reason: "invalid resident ownership",
          },
        ],
      }),
    ).toThrow(/enabled producers must use the resident runtime/);
  });

  test("rejects unknown fields, duplicate entity kinds, and inconsistent draft timestamps", () => {
    const producer = {
      name: "agent-log-sync.rust",
      disposition: "enabled",
      runtime: "resident",
      entityKinds: ["vibe_memory"],
      reason: "resident",
    };
    const draft = {
      contractVersion: 1,
      profile: "resident-local",
      status: "draft",
      finalizedAt: null,
      observationStartedAt: null,
      producers: [producer],
    };

    expect(() => parseRepositoryIsolationProducerManifest({ ...draft, unexpected: true })).toThrow(
      /Unrecognized key/,
    );
    expect(() =>
      parseRepositoryIsolationProducerManifest({
        ...draft,
        producers: [{ ...producer, entityKinds: ["vibe_memory", "vibe_memory"] }],
      }),
    ).toThrow(/entity kinds must be unique/);
    expect(() =>
      parseRepositoryIsolationProducerManifest({
        ...draft,
        finalizedAt: "2026-08-15T15:42:29.000Z",
      }),
    ).toThrow(/draft manifest must not have finalizedAt/);
    expect(() =>
      parseRepositoryIsolationProducerManifest({
        ...draft,
        status: "finalized",
      }),
    ).toThrow(/finalized manifest requires finalizedAt/);
  });
});
