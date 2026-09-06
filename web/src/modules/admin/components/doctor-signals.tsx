import { Badge } from "@/components/ui/badge";
import {
  type DoctorReasonDetail,
  formatDoctorReasonDetail as formatDoctorReason,
} from "../../../../../src/shared/doctor/doctor-reasons";
import type {
  DoctorAiServiceToolsDomain,
  DoctorPipelineAutomationDomain,
  DoctorReport,
} from "../repositories/admin.repository";

function reasonBadgeVariant(
  severity: DoctorReasonDetail["severity"],
): "destructive" | "warning" | "secondary" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "secondary";
}

function impactBadgeVariant(
  impactLevel: DoctorReasonDetail["impactLevel"],
): "destructive" | "warning" | "secondary" {
  if (impactLevel === "blocking") return "destructive";
  if (impactLevel === "degraded") return "warning";
  return "secondary";
}

function uniqueNonEmpty(items: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

export function getDoctorReasonDetails(
  report: Pick<DoctorReport, "reasonDetails" | "reasons"> | null | undefined,
): DoctorReasonDetail[] {
  if (!report) return [];
  if (Array.isArray(report.reasonDetails) && report.reasonDetails.length > 0) {
    return report.reasonDetails;
  }
  return report.reasons.map((reason) => formatDoctorReason(reason));
}

// 🚨 緊急シグナル（critical / blocking）の抽出
export function getEmergencySignals(reasons: DoctorReasonDetail[]): DoctorReasonDetail[] {
  return reasons.filter((r) => r.severity === "critical" || r.impactLevel === "blocking");
}

// 🟢🟣🔵 各ドメイン別に診断理由（シグナル）をフィルタリング
export function getDomainSignals(
  reasons: DoctorReasonDetail[],
  domain: "infrastructure" | "ai" | "pipeline",
): DoctorReasonDetail[] {
  return reasons.filter((r) => {
    if (domain === "infrastructure") {
      return (
        (r.area === "Runtime" && !r.code.startsWith("AGENTIC_LLM_")) ||
        r.area === "Knowledge" ||
        r.area === "Other"
      );
    }
    if (domain === "ai") {
      return r.area === "MCP" || r.code.startsWith("AGENTIC_LLM_");
    }
    if (domain === "pipeline") {
      return r.area === "Distillation" || r.area === "Sync";
    }
    return false;
  });
}

// 🟢🟣🔵 各ドメイン別にNext Actionsを抽出
export function getDomainNextActions(
  report:
    | DoctorReport
    | DoctorAiServiceToolsDomain
    | DoctorPipelineAutomationDomain
    | null
    | undefined,
  domain: "infrastructure" | "ai" | "pipeline",
): string[] {
  if (!report) return [];
  if (domain === "infrastructure") {
    return [];
  }
  if (domain === "ai") {
    return uniqueNonEmpty("mcp" in report ? (report.mcp?.nextActions ?? []) : []);
  }
  if (domain === "pipeline") {
    return uniqueNonEmpty(
      "agentLogSync" in report
        ? [
            ...(report.agentLogSync?.nextActions ?? []),
            ...(report.vibeDistillation?.nextActions ?? []),
            ...(report.sourceDistillation?.nextActions ?? []),
          ]
        : [],
    );
  }
  return [];
}

// 🟢🟣🔵 各ドメインカード用のスリムな警告リスト表示コンポーネント (ノイズを最小限に)
export function SlimDoctorReasonList({ reasons }: { reasons: DoctorReasonDetail[] }) {
  if (reasons.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5 mt-4 pt-4 border-t border-slate-100">
      <div className="text-[11.5px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
        領域の警告・シグナル:
      </div>
      {reasons.map((reason, index) => {
        const isCritical = reason.severity === "critical" || reason.impactLevel === "blocking";
        return (
          <div
            key={`${reason.code}-${index}`}
            className={`text-[12.5px] border-l-2 pl-2.5 py-1 flex flex-col gap-0.5 rounded-r transition-all ${
              isCritical ? "border-red-500 bg-red-50/10" : "border-amber-400 bg-amber-50/5"
            }`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`font-semibold ${isCritical ? "text-red-950" : "text-slate-700"}`}>
                {reason.label}
              </span>
              <Badge
                variant={reasonBadgeVariant(reason.severity)}
                className="h-3.5 text-[9px] px-1 py-0 uppercase font-semibold"
              >
                {reason.severity}
              </Badge>
              {reason.impactLevel ? (
                <Badge
                  variant={impactBadgeVariant(reason.impactLevel)}
                  className="h-3.5 text-[9px] px-1 py-0 uppercase font-semibold"
                >
                  {reason.impactLevel}
                </Badge>
              ) : null}
            </div>
            <p className="text-slate-500 text-[11.5px] leading-relaxed">{reason.description}</p>
            {reason.action && (
              <div
                className={`text-[11.5px] font-medium px-2 py-0.5 rounded border mt-1.5 w-fit ${
                  isCritical
                    ? "text-red-700 bg-red-50/50 border-red-200/30"
                    : "text-amber-800 bg-amber-50/50 border-amber-200/30"
                }`}
              >
                対応: {reason.action}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 🚨 画面最上部に表示される緊急アラートバナー (点滅等の過剰な演出を廃止し、静的に美しく警告)
export function EmergencyBanner({ reasons }: { reasons: DoctorReasonDetail[] }) {
  if (reasons.length === 0) return null;

  return (
    <div className="mb-6 p-4 bg-red-50/80 border border-red-200/60 rounded-xl flex flex-col gap-3 shadow-3xs">
      <div className="flex items-center gap-2 text-red-800 font-extrabold text-[14px] tracking-wide">
        <span className="w-2 h-2 rounded-full bg-red-600 inline-block" />🚨 システム緊急警告 (
        {reasons.length}件)
      </div>
      <div className="flex flex-col gap-2">
        {reasons.map((reason, index) => (
          <div
            key={`${reason.code}-${index}`}
            className="text-[13px] text-red-900 bg-white/90 border border-red-100/80 rounded-lg p-3 flex flex-col gap-1 shadow-4xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[13.5px] text-red-950">{reason.label}</strong>
              <Badge
                variant="destructive"
                className="h-4 text-[9px] uppercase font-bold py-0 px-1.5"
              >
                {reason.severity}
              </Badge>
              {reason.impactLevel && (
                <Badge
                  variant="outline"
                  className="h-4 text-[9px] border-red-200 text-red-700 bg-red-50/50 py-0 px-1.5 uppercase font-bold"
                >
                  {reason.impactLevel}
                </Badge>
              )}
            </div>
            <p className="text-slate-600 text-[12.5px] leading-relaxed">{reason.description}</p>
            <div className="mt-1.5 text-[12px] text-red-950 font-bold bg-red-50 border border-red-200/30 px-2 py-0.5 rounded w-fit">
              推奨アクション: {reason.action}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
