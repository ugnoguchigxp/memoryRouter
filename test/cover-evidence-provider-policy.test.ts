import { describe, expect, test } from "vitest";
import {
  CoverEvidenceProviderPolicyError,
  resolveCloudApiRuntimeRoute,
  resolveCoverEvidenceRouteByPolicy,
} from "../src/modules/coverEvidence/provider-policy.js";
import type {
  RuntimeProviderName,
  RuntimeProviderSetting,
  StaticRuntimeSettingsRoute,
} from "../src/modules/settings/settings.types.js";

function runtimeRoute(
  provider: RuntimeProviderSetting,
  fallback: RuntimeProviderName[],
): StaticRuntimeSettingsRoute {
  return { provider, fallback };
}

describe("coverEvidence provider policy", () => {
  test("keeps only cloud providers from primary and fallback", () => {
    const route = resolveCloudApiRuntimeRoute({
      ...runtimeRoute("local-llm", ["azure-openai"]),
      model: '{"apiBaseUrl":"http://local","model":"qwen"}',
      localLlmModel: '{"apiBaseUrl":"http://local","model":"qwen"}',
    });
    expect(route).toEqual({
      provider: "azure-openai",
      fallback: [],
    });
  });

  test("preserves primary cloud route model when cloud provider is already primary", () => {
    const route = resolveCloudApiRuntimeRoute({
      ...runtimeRoute("azure-openai", ["openai"]),
      model: "gpt-5-4-mini",
      azureDeploymentSlots: [0],
    });
    expect(route).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      azureDeploymentSlots: [0],
      fallback: ["openai"],
    });
  });

  test("preserves cloud fallback order after filtering local providers", () => {
    const route = resolveCloudApiRuntimeRoute(
      runtimeRoute("local-llm", ["openai", "bedrock", "openai"]),
    );
    expect(route).toEqual({
      provider: "openai",
      fallback: ["bedrock"],
    });
  });

  test("allows codex as a cloud provider candidate", () => {
    const route = resolveCloudApiRuntimeRoute(runtimeRoute("local-llm", ["codex", "openai"]));
    expect(route).toEqual({
      provider: "codex",
      fallback: ["openai"],
    });
  });

  test("throws when no cloud providers are available", () => {
    expect(() =>
      resolveCloudApiRuntimeRoute(runtimeRoute("local-llm", []), { routeName: "sourceSupport" }),
    ).toThrowError(CoverEvidenceProviderPolicyError);
  });

  test("excludes auto from cloud candidates", () => {
    const route = resolveCloudApiRuntimeRoute(runtimeRoute("auto", ["local-llm", "openai"]));
    expect(route).toEqual({
      provider: "openai",
      fallback: [],
    });
  });

  test("returns unchanged route when policy is default", () => {
    const input = runtimeRoute("local-llm", ["openai"]);
    const route = resolveCoverEvidenceRouteByPolicy({
      route: input,
      policy: "default",
      routeName: "sourceSupport",
    });
    expect(route).toBe(input);
  });
});
