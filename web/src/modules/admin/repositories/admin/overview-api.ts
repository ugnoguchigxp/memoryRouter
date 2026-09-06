import { getJson } from "./http";
import type {
  DoctorAiServiceToolsDomain,
  DoctorCoreInfrastructureDomain,
  DoctorPipelineAutomationDomain,
  DoctorReport,
  OverviewDashboard,
  OverviewKnowledgeAssetsDomain,
  OverviewLandscapeHealthDomain,
  OverviewLlmResourcesDomain,
  OverviewSystemQualityDomain,
} from "./overview-contracts";

export async function fetchDoctorReport(): Promise<DoctorReport> {
  return getJson<DoctorReport>("/api/doctor");
}

export async function fetchDoctorCoreInfrastructureDomain(): Promise<DoctorCoreInfrastructureDomain> {
  return getJson<DoctorCoreInfrastructureDomain>("/api/doctor/domains/core-infrastructure");
}

export async function fetchDoctorAiServiceToolsDomain(): Promise<DoctorAiServiceToolsDomain> {
  return getJson<DoctorAiServiceToolsDomain>("/api/doctor/domains/ai-service-tools");
}

export async function fetchDoctorPipelineAutomationDomain(): Promise<DoctorPipelineAutomationDomain> {
  return getJson<DoctorPipelineAutomationDomain>("/api/doctor/domains/pipeline-automation");
}

export function withTimezoneQuery(path: string, timezone?: string): string {
  if (!timezone) return path;
  const params = new URLSearchParams({ timezone });
  return `${path}?${params.toString()}`;
}

export async function fetchOverviewDashboard(timezone?: string): Promise<OverviewDashboard> {
  return getJson<OverviewDashboard>(withTimezoneQuery("/api/overview", timezone));
}

export async function fetchOverviewKnowledgeAssetsDomain(
  timezone?: string,
): Promise<OverviewKnowledgeAssetsDomain> {
  return getJson<OverviewKnowledgeAssetsDomain>(
    withTimezoneQuery("/api/overview/domains/knowledge-assets", timezone),
  );
}

export async function fetchOverviewLandscapeHealthDomain(
  timezone?: string,
): Promise<OverviewLandscapeHealthDomain> {
  return getJson<OverviewLandscapeHealthDomain>(
    withTimezoneQuery("/api/overview/domains/landscape-health", timezone),
  );
}

export async function fetchOverviewSystemQualityDomain(
  timezone?: string,
): Promise<OverviewSystemQualityDomain> {
  return getJson<OverviewSystemQualityDomain>(
    withTimezoneQuery("/api/overview/domains/system-quality", timezone),
  );
}

export async function fetchOverviewLlmResourcesDomain(
  timezone?: string,
): Promise<OverviewLlmResourcesDomain> {
  return getJson<OverviewLlmResourcesDomain>(
    withTimezoneQuery("/api/overview/domains/llm-resources", timezone),
  );
}
