import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatCheckedAt, formatNumber } from "@/lib/admin-formatters";
import { parseTimestamp, useTimezone } from "@/lib/timezone";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, Database } from "lucide-react";
import type { ReactNode } from "react";
import {
  type DoctorAiServiceToolsDomain,
  type DoctorCoreInfrastructureDomain,
  type DoctorPipelineAutomationDomain,
  fetchDoctorAiServiceToolsDomain,
  fetchDoctorCoreInfrastructureDomain,
  fetchDoctorPipelineAutomationDomain,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import {
  EmergencyBanner,
  SlimDoctorReasonList,
  getDoctorReasonDetails,
  getDomainNextActions,
  getDomainSignals,
  getEmergencySignals,
} from "./doctor-signals";

type DoctorDomainReport =
  | DoctorCoreInfrastructureDomain
  | DoctorAiServiceToolsDomain
  | DoctorPipelineAutomationDomain;

type DoctorStatus = DoctorDomainReport["status"];
type Accent = "emerald" | "violet" | "cyan";
type HealthTone = "safe" | "warning" | "danger" | "muted";

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

function durationTone(
  value: number | null | undefined,
  thresholds: { warningMs: number; dangerMs: number },
): HealthTone {
  if (typeof value !== "number" || !Number.isFinite(value)) return "muted";
  if (value >= thresholds.dangerMs) return "danger";
  if (value >= thresholds.warningMs) return "warning";
  return "safe";
}

function healthTextClass(tone: HealthTone): string {
  if (tone === "safe") return "text-emerald-600";
  if (tone === "warning") return "text-amber-600";
  if (tone === "danger") return "text-red-600";
  return "text-slate-400";
}

function healthBadgeClass(tone: HealthTone): string {
  if (tone === "safe") return "border-emerald-500/20 text-emerald-700 bg-emerald-50/60";
  if (tone === "warning") return "border-amber-500/25 text-amber-700 bg-amber-50/70";
  if (tone === "danger") return "border-red-500/25 text-red-700 bg-red-50/70";
  return "border-slate-200 text-slate-500 bg-slate-50";
}

function formatAgeMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 60 * 48) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 60 / 24).toFixed(1)} d`;
}

function llmProviderLabel(provider: string): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "azure-openai":
      return "Azure OpenAI";
    case "bedrock":
      return "Bedrock";
    case "local-llm":
      return "Local LLM";
    default:
      return provider || "Unknown";
  }
}

function llmHealthLabel(provider: {
  configured: boolean;
  reachable: boolean;
  error?: string;
}): string {
  if (!provider.configured) return "Unconfigured";
  if (provider.reachable) return "Reachable";
  return provider.error ? "Offline" : "Unknown";
}

function llmHealthClass(provider: { configured: boolean; reachable: boolean }): string {
  if (!provider.configured) return "text-slate-400";
  if (provider.reachable) return "text-emerald-600";
  return "text-amber-600";
}

function launchAgentLabel(agent: { loaded: boolean; installed: boolean }): string {
  if (agent.loaded) return "loaded";
  if (agent.installed) return "installed";
  return "not installed";
}

function accentClasses(accent: Accent) {
  if (accent === "emerald") {
    return {
      section: "overview-domain-section accent-emerald",
      headerBorder: "border-emerald-500/10",
      iconBg: "bg-emerald-50",
      iconColor: "text-emerald-500",
      badge:
        "text-[12px] font-bold border-emerald-500/20 text-emerald-700 bg-emerald-50/50 py-0.5 px-2",
    };
  }
  if (accent === "violet") {
    return {
      section: "overview-domain-section accent-violet",
      headerBorder: "border-violet-500/10",
      iconBg: "bg-violet-50",
      iconColor: "text-violet-500",
      badge:
        "text-[12px] font-bold border-violet-500/20 text-violet-700 bg-violet-50/50 py-0.5 px-2",
    };
  }
  return {
    section: "overview-domain-section accent-cyan",
    headerBorder: "border-cyan-500/10",
    iconBg: "bg-cyan-50",
    iconColor: "text-cyan-500",
    badge: "text-[12px] font-bold border-cyan-500/20 text-cyan-700 bg-cyan-50/50 py-0.5 px-2",
  };
}

function DomainShell({
  accent,
  title,
  subtitle,
  icon,
  badge,
  badgeTone,
  children,
}: {
  accent: Accent;
  title: string;
  subtitle: string;
  icon: ReactNode;
  badge: ReactNode;
  badgeTone?: HealthTone;
  children: ReactNode;
}) {
  const classes = accentClasses(accent);
  const badgeClass = badgeTone
    ? `text-[12px] font-bold py-0.5 px-2 ${healthBadgeClass(badgeTone)}`
    : classes.badge;
  return (
    <section className={classes.section}>
      <div
        className={`overview-domain-header justify-between items-center border-b ${classes.headerBorder} pb-3`}
      >
        <div className="flex items-center gap-2">
          <div className={`p-1.5 ${classes.iconBg} rounded-lg`}>
            <span className={`overview-domain-icon ${classes.iconColor} w-4 h-4 flex`}>{icon}</span>
          </div>
          <div className="flex flex-col">
            <h2 className="overview-domain-title text-[16px] font-bold text-slate-800 leading-none">
              {title}
            </h2>
            <span className="text-[12.5px] text-slate-400 font-medium mt-1">{subtitle}</span>
          </div>
        </div>
        <Badge variant="outline" className={badgeClass}>
          {badge}
        </Badge>
      </div>
      {children}
    </section>
  );
}

function DoctorDomainPlaceholder({
  accent,
  title,
  subtitle,
  icon,
}: {
  accent: Accent;
  title: string;
  subtitle: string;
  icon: ReactNode;
}) {
  return (
    <DomainShell accent={accent} title={title} subtitle={subtitle} icon={icon} badge="Loading">
      <div className="flex flex-col justify-between h-full py-1 gap-4 animate-pulse">
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex flex-col gap-2">
              <div className="h-3 w-20 rounded bg-slate-100" />
              <div className="h-7 w-24 rounded bg-slate-200" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2.5 pb-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center justify-between">
              <div className="h-3 w-32 rounded bg-slate-100" />
              <div className="h-3 w-16 rounded bg-slate-200" />
            </div>
          ))}
        </div>
      </div>
    </DomainShell>
  );
}

function DoctorDomainError({
  accent,
  title,
  subtitle,
  icon,
}: {
  accent: Accent;
  title: string;
  subtitle: string;
  icon: ReactNode;
}) {
  return (
    <DomainShell accent={accent} title={title} subtitle={subtitle} icon={icon} badge="Error">
      <Card className="mt-4 border-red-100 bg-red-50/40">
        <CardContent className="metric-card">
          <span className="metric-label text-red-600">Doctor API Error</span>
          <strong className="metric-value">{title} could not be loaded.</strong>
        </CardContent>
      </Card>
    </DomainShell>
  );
}

function uniqueReasonDetails(reports: DoctorDomainReport[]) {
  const seen = new Set<string>();
  return reports
    .flatMap((report) => getDoctorReasonDetails(report))
    .filter((reason) => {
      const key = reason.code;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function combineDoctorStatus(reports: DoctorDomainReport[], hasError: boolean): DoctorStatus {
  if (hasError || reports.some((report) => report.status === "failed")) return "failed";
  if (reports.length === 0 || reports.some((report) => report.status === "degraded")) {
    return "degraded";
  }
  return "ok";
}

function latestCheckedAt(reports: DoctorDomainReport[]): string | undefined {
  return reports
    .flatMap((report) => {
      const parsed = parseTimestamp(report.checkedAt);
      return parsed ? [parsed] : [];
    })
    .sort((a, b) => b.getTime() - a.getTime())[0]
    ?.toISOString();
}

function CoreInfrastructureDomain({ data }: { data: DoctorCoreInfrastructureDomain }) {
  const infraSignals = getDomainSignals(getDoctorReasonDetails(data), "infrastructure");
  const missingTables = data.tables?.missing.length ?? 0;
  const desktopReadiness = data.desktopReadiness;
  const dbResponseMs = data.db.responseMs ?? data.db.durationMs;
  const dbResponseTone = data.db.reachable
    ? durationTone(dbResponseMs, { warningMs: 50, dangerMs: 250 })
    : "danger";
  const dbQueryTone = durationTone(data.db.queryMs, { warningMs: 100, dangerMs: 750 });
  const vectorTone = data.vector.installed
    ? durationTone(data.vector.healthMs, { warningMs: 750, dangerMs: 2000 })
    : "danger";
  const doctorTotalTone = durationTone(data.totalDurationMs, { warningMs: 5000, dangerMs: 15000 });
  const requiredTablesTone: HealthTone = missingTables > 0 ? "danger" : "safe";
  const embeddingDaemonTone: HealthTone = data.embedding?.daemon.reachable ? "safe" : "warning";
  const embeddingCliTone: HealthTone = data.embedding?.cli.usable ? "safe" : "warning";

  return (
    <DomainShell
      accent="emerald"
      title="Core Infrastructure"
      subtitle="Database & Vector Engine Health"
      icon={<Database className="w-4 h-4" style={{ color: "#10b981" }} />}
      badge={`DB response: ${formatDurationMs(dbResponseMs)}`}
      badgeTone={dbResponseTone}
    >
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              DB Status
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${healthTextClass(
                data.db.reachable ? "safe" : "danger",
              )}`}
            >
              {data.db.reachable ? "Online" : "Offline"}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              DB Response
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${healthTextClass(
                dbResponseTone,
              )}`}
            >
              {formatDurationMs(dbResponseMs)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              DB Queries
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${healthTextClass(
                dbQueryTone,
              )}`}
            >
              {formatDurationMs(data.db.queryMs)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Vector
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${healthTextClass(vectorTone)}`}
            >
              {formatDurationMs(data.vector.healthMs)}
            </strong>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
          {desktopReadiness && (
            <div className="flex items-center justify-between">
              <span>Desktop Readiness</span>
              <strong
                className={
                  desktopReadiness.status === "Ready"
                    ? "text-emerald-600"
                    : desktopReadiness.status === "Needs setup"
                      ? "text-red-600"
                      : "text-amber-600"
                }
              >
                {desktopReadiness.status}
              </strong>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>Required Tables</span>
            <strong className={healthTextClass(requiredTablesTone)}>
              {missingTables > 0 ? `Missing ${missingTables}` : "OK"}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Vector engine</span>
            <strong className={healthTextClass(vectorTone)}>
              {data.vector.installed ? `installed via ${data.vector.source}` : "missing"}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Doctor total</span>
            <strong className={healthTextClass(doctorTotalTone)}>
              {formatDurationMs(data.totalDurationMs)}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Embedding Daemon</span>
            <strong className={healthTextClass(embeddingDaemonTone)}>
              {data.embedding?.daemon.reachable ? "Reachable" : "Offline"}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Embedding CLI</span>
            <strong className={healthTextClass(embeddingCliTone)}>
              {data.embedding?.cli.usable ? "Usable" : "Unavailable"}
            </strong>
          </div>
        </div>

        {desktopReadiness && (
          <div className="flex flex-col gap-1.5 border-t border-slate-100 pt-3 text-[12px]">
            {desktopReadiness.items.slice(0, 4).map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-slate-500" title={item.label}>
                  {item.label}
                </span>
                <strong className="shrink-0 text-slate-700">{item.state}</strong>
              </div>
            ))}
          </div>
        )}

        <SlimDoctorReasonList reasons={infraSignals} />
      </div>
    </DomainShell>
  );
}

function AiServiceToolsDomain({ data }: { data: DoctorAiServiceToolsDomain }) {
  const aiSignals = getDomainSignals(getDoctorReasonDetails(data), "ai");
  const aiNextActions = getDomainNextActions(data, "ai");
  const providerHealth = data.agenticLlm?.providerHealth ?? [];
  const reachableProviderCount = providerHealth.filter(
    (provider) => provider.configured && provider.reachable,
  ).length;
  const configuredProviderCount = providerHealth.filter((provider) => provider.configured).length;

  return (
    <DomainShell
      accent="violet"
      title="AI & Service Tools"
      subtitle="LLM & MCP Tool Integrations"
      icon={<Cpu className="w-4 h-4" style={{ color: "#8b5cf6" }} />}
      badge={`Tools: ${data.mcp.exposedTools.length} Exposed`}
    >
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              LLM Health
            </span>
            <strong
              className={`text-[19px] font-extrabold mt-1 leading-none ${
                data.agenticLlm?.reachable ? "text-violet-600" : "text-amber-600"
              }`}
            >
              {providerHealth.length > 0
                ? `${reachableProviderCount}/${providerHealth.length}`
                : data.agenticLlm?.reachable
                  ? "Reachable"
                  : data.agenticLlm?.configured
                    ? "Offline"
                    : "Unconfigured"}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              MCP Tools
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${
                data.mcp.missingPrimaryTools.length > 0 ? "text-amber-600" : "text-violet-600"
              }`}
            >
              {data.mcp.missingPrimaryTools.length > 0
                ? `Missing ${data.mcp.missingPrimaryTools.length}`
                : "OK"}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Configured
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {providerHealth.length > 0
                ? configuredProviderCount
                : data.agenticLlm?.configured
                  ? 1
                  : 0}
            </strong>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
          <div className="flex items-center justify-between">
            <span>LLM Provider</span>
            <strong className="text-slate-700 capitalize">
              {data.agenticLlm?.provider || "None"}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>LLM Model</span>
            <strong
              className="text-slate-700 text-xs truncate max-w-[150px]"
              title={data.agenticLlm?.model}
            >
              {data.agenticLlm?.model || "None"}
            </strong>
          </div>
          <div className="flex items-center justify-between">
            <span>Required MCP Tools</span>
            <strong className="text-slate-700">
              {data.mcp.requiredPrimaryTools.length} loaded
            </strong>
          </div>
        </div>

        {providerHealth.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-slate-400 font-bold uppercase tracking-wider">
                Provider Health
              </span>
              <span className="min-w-0 truncate text-slate-500 font-medium">
                Route: {data.agenticLlm?.fallbackOrder.map(llmProviderLabel).join(" -> ") || "-"}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {providerHealth.map((provider) => (
                <div
                  key={provider.id ?? `${provider.provider}:${provider.endpoint}:${provider.model}`}
                  className="min-w-0 rounded-md border border-slate-100 bg-slate-50/50 px-2.5 py-2"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0 flex items-center gap-1.5">
                      <span className="font-bold text-slate-700 text-[12.5px] truncate">
                        {provider.label || llmProviderLabel(provider.provider)}
                      </span>
                      {provider.selected && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1.5 py-0 border-violet-200 text-violet-700 bg-violet-50"
                        >
                          selected
                        </Badge>
                      )}
                    </div>
                    <strong className={`text-[12px] ${llmHealthClass(provider)}`}>
                      {llmHealthLabel(provider)}
                    </strong>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span className="truncate" title={provider.model || provider.endpoint || ""}>
                      {provider.model || provider.endpoint || "-"}
                    </span>
                    <span className="shrink-0">
                      {provider.routeOrder === null || provider.routeOrder === undefined
                        ? "standby"
                        : `route #${provider.routeOrder + 1}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <SlimDoctorReasonList reasons={aiSignals} />

        {aiNextActions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-1.5">
            <div className="text-[12px] font-bold text-violet-600 uppercase tracking-wider">
              AI 推奨アクション:
            </div>
            {aiNextActions.map((action) => (
              <div
                key={action}
                className="text-[12px] text-slate-600 bg-violet-50/30 border border-violet-100 rounded p-2"
              >
                {action}
              </div>
            ))}
          </div>
        )}
      </div>
    </DomainShell>
  );
}

function PipelineAutomationDomain({ data }: { data: DoctorPipelineAutomationDomain }) {
  const pipelineSignals = getDomainSignals(getDoctorReasonDetails(data), "pipeline");
  const pipelineNextActions = getDomainNextActions(data, "pipeline");
  const totalFinishedTargets =
    data.vibeDistillation.runs.totalRuns + data.sourceDistillation.runs.totalRuns;
  const staleTrackedJobs =
    data.vibeDistillation.queueHealth.staleRunning +
    data.sourceDistillation.queueHealth.staleRunning;
  const maxSyncAge =
    data.agentLogSync.states.length > 0
      ? Math.max(
          ...data.agentLogSync.states.map(
            (item) => item.lastCheckedAgeMinutes ?? item.lastSyncedAgeMinutes ?? 0,
          ),
        )
      : null;
  const syncStaleThresholdMinutes = data.runs.freshnessThresholdMinutes ?? 720;
  const staleSyncCount = data.agentLogSync.states.filter(
    (state) =>
      (state.lastCheckedAgeMinutes ?? state.lastSyncedAgeMinutes ?? 0) > syncStaleThresholdMinutes,
  ).length;

  return (
    <DomainShell
      accent="cyan"
      title="Pipeline & Automation"
      subtitle="Log Sync & Distillation Pipelines"
      icon={<Activity className="w-4 h-4" style={{ color: "#06b6d4" }} />}
      badge={`Sync Freshness: ${formatAgeMinutes(maxSyncAge)}`}
    >
      <div className="flex flex-col justify-between h-full py-1 gap-4">
        <div className="grid grid-cols-3 gap-2 border-b border-slate-100 pb-3 mb-1 text-center md:text-left">
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Sync Status
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${
                staleSyncCount > 0 ? "text-amber-600" : "text-cyan-600"
              }`}
            >
              {staleSyncCount > 0 ? "Stale" : "Fresh"}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Finished Targets
            </span>
            <strong className="text-slate-800 text-2xl font-extrabold mt-1 leading-none">
              {formatNumber(totalFinishedTargets)}
            </strong>
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] text-slate-400 font-semibold tracking-wide uppercase">
              Stale Running
            </span>
            <strong
              className={`text-2xl font-extrabold mt-1 leading-none ${
                staleTrackedJobs > 0 ? "text-amber-600" : "text-slate-800"
              }`}
            >
              {formatNumber(staleTrackedJobs)}
            </strong>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 pb-2 text-[13px] text-slate-500 font-medium">
          <div className="flex justify-between items-center">
            <span>Log Sync Agent</span>
            <strong className="capitalize">
              {launchAgentLabel(data.agentLogSync.launchAgent)}
            </strong>
          </div>
          <div className="flex justify-between items-center">
            <span>Vibe Distill Agent</span>
            <strong className="capitalize">
              {launchAgentLabel(data.vibeDistillation.launchAgent)}
            </strong>
          </div>
          <div className="flex justify-between items-center">
            <span>Source Distill Agent</span>
            <strong className="capitalize">
              {launchAgentLabel(data.sourceDistillation.launchAgent)}
            </strong>
          </div>
          <div className="flex justify-between items-center">
            <span>Vibe/Source Locks</span>
            <strong className="text-slate-700">
              Vibe: {data.vibeDistillation.queueHealth.lock.exists ? "Held" : "Clear"} / Source:{" "}
              {data.sourceDistillation.queueHealth.lock.exists ? "Held" : "Clear"}
            </strong>
          </div>
        </div>

        <SlimDoctorReasonList reasons={pipelineSignals} />

        {pipelineNextActions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col gap-1.5">
            <div className="text-[12px] font-bold text-cyan-600 uppercase tracking-wider">
              パイプライン推奨アクション:
            </div>
            {pipelineNextActions.map((action) => (
              <div
                key={action}
                className="text-[12px] text-slate-600 bg-cyan-50/30 border border-cyan-100 rounded p-2"
              >
                {action}
              </div>
            ))}
          </div>
        )}
      </div>
    </DomainShell>
  );
}

export function DoctorPage() {
  const timezone = useTimezone();
  const coreInfrastructure = useQuery({
    queryKey: ["doctor", "domain", "core-infrastructure"],
    queryFn: () => fetchDoctorCoreInfrastructureDomain(),
  });
  const aiServiceTools = useQuery({
    queryKey: ["doctor", "domain", "ai-service-tools"],
    queryFn: () => fetchDoctorAiServiceToolsDomain(),
  });
  const pipelineAutomation = useQuery({
    queryKey: ["doctor", "domain", "pipeline-automation"],
    queryFn: () => fetchDoctorPipelineAutomationDomain(),
  });

  const loadedReports = [
    coreInfrastructure.data,
    aiServiceTools.data,
    pipelineAutomation.data,
  ].filter((report): report is DoctorDomainReport => Boolean(report));
  const hasDomainError =
    coreInfrastructure.isError || aiServiceTools.isError || pipelineAutomation.isError;
  const isFetching =
    coreInfrastructure.isFetching || aiServiceTools.isFetching || pipelineAutomation.isFetching;
  const status = combineDoctorStatus(loadedReports, hasDomainError);
  const emergencySignals = getEmergencySignals(uniqueReasonDetails(loadedReports));

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Doctor"
        checkedAtText={formatCheckedAt(latestCheckedAt(loadedReports), timezone)}
        onRefresh={() => {
          void Promise.all([
            coreInfrastructure.refetch(),
            aiServiceTools.refetch(),
            pipelineAutomation.refetch(),
          ]);
        }}
        refreshDisabled={isFetching}
        status={status}
      />

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
        <EmergencyBanner reasons={emergencySignals} />

        <div className="overview-domain-layout">
          <div className="flex flex-col gap-6 w-full">
            {coreInfrastructure.isError ? (
              <DoctorDomainError
                accent="emerald"
                title="Core Infrastructure"
                subtitle="Database & Vector Engine Health"
                icon={<Database className="w-4 h-4" style={{ color: "#10b981" }} />}
              />
            ) : coreInfrastructure.data ? (
              <CoreInfrastructureDomain data={coreInfrastructure.data} />
            ) : (
              <DoctorDomainPlaceholder
                accent="emerald"
                title="Core Infrastructure"
                subtitle="Database & Vector Engine Health"
                icon={<Database className="w-4 h-4" style={{ color: "#10b981" }} />}
              />
            )}
          </div>

          <div className="flex flex-col gap-6 w-full">
            {aiServiceTools.isError ? (
              <DoctorDomainError
                accent="violet"
                title="AI & Service Tools"
                subtitle="LLM & MCP Tool Integrations"
                icon={<Cpu className="w-4 h-4" style={{ color: "#8b5cf6" }} />}
              />
            ) : aiServiceTools.data ? (
              <AiServiceToolsDomain data={aiServiceTools.data} />
            ) : (
              <DoctorDomainPlaceholder
                accent="violet"
                title="AI & Service Tools"
                subtitle="LLM & MCP Tool Integrations"
                icon={<Cpu className="w-4 h-4" style={{ color: "#8b5cf6" }} />}
              />
            )}

            {pipelineAutomation.isError ? (
              <DoctorDomainError
                accent="cyan"
                title="Pipeline & Automation"
                subtitle="Log Sync & Distillation Pipelines"
                icon={<Activity className="w-4 h-4" style={{ color: "#06b6d4" }} />}
              />
            ) : pipelineAutomation.data ? (
              <PipelineAutomationDomain data={pipelineAutomation.data} />
            ) : (
              <DoctorDomainPlaceholder
                accent="cyan"
                title="Pipeline & Automation"
                subtitle="Log Sync & Distillation Pipelines"
                icon={<Activity className="w-4 h-4" style={{ color: "#06b6d4" }} />}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
