import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const SECURITY_INTELLIGENCE_IDENTITY_FIXTURE_SHA256 =
  "sha256:0c0278ecfd8eca8e6866e3bc8f7ae45b20bd198eb2758ac3b568091d304c98c4";

const rawDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rawRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,247}$/);

export const securityIntelligenceIdentityFixtureSchema = z
  .object({
    contractVersion: z.literal(1),
    identityMappingVersion: z.literal(1),
    project: z
      .object({
        rawRef: rawRefSchema,
        canonicalRef: z.string().regex(/^project:[A-Za-z0-9._:-]{1,247}$/),
      })
      .strict(),
    scanRun: z
      .object({
        rawRef: rawRefSchema,
        canonicalRef: z.string().regex(/^scan-run:[A-Za-z0-9._:-]{1,247}$/),
      })
      .strict(),
    targetDigest: z
      .object({
        rawHex: rawDigestSchema,
        canonicalDigest: canonicalDigestSchema,
      })
      .strict(),
    workingTree: z
      .object({
        scanStartSourceRevision: z.string().min(1).max(128),
        scanStartSourceRevisionRole: z.literal("base_revision"),
        assessmentSourceRevision: z.string().min(1).max(128),
        assessmentSourceRevisionRole: z.literal("assessed_revision"),
      })
      .strict(),
    fullTarget: z
      .object({
        available: z.literal(false),
        reasonCode: z.literal("target_kind_unsupported"),
      })
      .strict(),
    supportedTransports: z.tuple([z.literal("http_service")]),
    unsupportedTransports: z.tuple([z.literal("local_cli")]),
    failureReasonCategories: z.tuple([
      z.literal("absolute_path_forbidden"),
      z.literal("identity_mapping_version_unsupported"),
      z.literal("project_ref_mismatch"),
      z.literal("revision_role_mismatch"),
      z.literal("scan_run_ref_mismatch"),
      z.literal("secret_like_value_forbidden"),
      z.literal("target_digest_mismatch"),
    ]),
    limits: z
      .object({
        assessmentResponseBytes: z.literal(2 * 1024 * 1024),
        candidateBatchBytes: z.literal(256 * 1024),
        feedbackBatchBytes: z.literal(128 * 1024),
        workspaceGrantRequestBytes: z.literal(16 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.project.canonicalRef !== `project:${value.project.rawRef}`) {
      ctx.addIssue({
        code: "custom",
        path: ["project", "canonicalRef"],
        message: "security_intelligence:project_ref_mismatch",
      });
    }
    if (value.scanRun.canonicalRef !== `scan-run:${value.scanRun.rawRef}`) {
      ctx.addIssue({
        code: "custom",
        path: ["scanRun", "canonicalRef"],
        message: "security_intelligence:scan_run_ref_mismatch",
      });
    }
    if (value.targetDigest.canonicalDigest !== `sha256:${value.targetDigest.rawHex}`) {
      ctx.addIssue({
        code: "custom",
        path: ["targetDigest", "canonicalDigest"],
        message: "security_intelligence:target_digest_mismatch",
      });
    }
    if (value.workingTree.scanStartSourceRevision === value.workingTree.assessmentSourceRevision) {
      ctx.addIssue({
        code: "custom",
        path: ["workingTree"],
        message: "security_intelligence:revision_role_fixture_not_distinct",
      });
    }
  });

export type SecurityIntelligenceIdentityFixture = z.infer<
  typeof securityIntelligenceIdentityFixtureSchema
>;

export function canonicalProjectRef(rawRef: string): `project:${string}` {
  return `project:${rawRefSchema.parse(rawRef)}`;
}

export function canonicalScanRunRef(rawRef: string): `scan-run:${string}` {
  return `scan-run:${rawRefSchema.parse(rawRef)}`;
}

export function canonicalTargetDigest(rawDigest: string): `sha256:${string}` {
  return `sha256:${rawDigestSchema.parse(rawDigest)}`;
}

export function equalSecurityIntelligenceDigest(
  rawDigest: string,
  canonicalDigest: string,
): boolean {
  const raw = Buffer.from(rawDigestSchema.parse(rawDigest), "hex");
  const canonical = Buffer.from(
    canonicalDigestSchema.parse(canonicalDigest).slice("sha256:".length),
    "hex",
  );
  return raw.byteLength === canonical.byteLength && timingSafeEqual(raw, canonical);
}
