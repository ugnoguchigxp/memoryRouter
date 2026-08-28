import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatDateTimeShort, useTimezone } from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  type DeadZoneKnowledgeReviewActionResult,
  type DeadZoneKnowledgeReviewBadge,
  type DeadZoneKnowledgeReviewReason,
  type DeadZoneKnowledgeReviewSortBy,
  type DeadZoneRecommendationAction,
  applyDeadZoneKnowledgeReviewAction,
  fetchDeadZoneKnowledgeReview,
  fetchUnresolvedLandscapeCurationJobs,
  requestDeadZoneMergeReviewJob,
  sendDeadZoneMergeReviewToFinalize,
} from "../repositories/admin.repository";
import { AdminPageHeader } from "./admin-page-header";
import { AdminPaginationFooter } from "./admin-pagination-footer";
import { DeadZoneReviewPanel } from "./deadzone-review-panel";

const badgeOptions: Array<DeadZoneKnowledgeReviewBadge | "all"> = [
  "all",
  "Strong merge candidate",
  "Canonical candidate",
  "Likely duplicate",
  "Scope differs",
  "Evidence thin",
  "Stale",
  "Niche but valid",
  "Needs embedding",
  "Similarity unavailable",
];

export function LandscapePage() {
  const queryClient = useQueryClient();
  const timezone = useTimezone();
  const [reason, setReason] = useState<DeadZoneKnowledgeReviewReason>("all");
  const [badge, setBadge] = useState<DeadZoneKnowledgeReviewBadge | "all">("all");
  const [minSimilarity, setMinSimilarity] = useState(0.9);
  const [sortBy, setSortBy] = useState<DeadZoneKnowledgeReviewSortBy>("deadZoneScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const resetToFirstPage = () => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  };

  const updateSort = (nextSortBy: DeadZoneKnowledgeReviewSortBy) => {
    setSortBy((current) => {
      if (current === nextSortBy) {
        setSortDir((currentDir) => (currentDir === "asc" ? "desc" : "asc"));
        return current;
      }
      setSortDir(nextSortBy === "title" ? "asc" : "desc");
      return nextSortBy;
    });
    resetToFirstPage();
  };

  const deadZoneKnowledgeReview = useQuery({
    queryKey: [
      "landscape-dead-zone-knowledge",
      30,
      pagination.pageSize,
      pagination.pageIndex + 1,
      reason,
      badge,
      minSimilarity,
      sortBy,
      sortDir,
    ],
    queryFn: () =>
      fetchDeadZoneKnowledgeReview({
        windowDays: 30,
        limit: pagination.pageSize,
        page: pagination.pageIndex + 1,
        status: "active",
        reason,
        minSimilarity,
        similarTopK: 5,
        relationAxes: ["session", "project", "source"],
        badge,
        sortBy,
        sortDir,
      }),
    staleTime: 60_000,
  });
  const unresolvedCuration = useQuery({
    queryKey: ["landscape-curation-unresolved"],
    queryFn: fetchUnresolvedLandscapeCurationJobs,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const items = deadZoneKnowledgeReview.data?.items ?? [];
  const total = deadZoneKnowledgeReview.data?.itemCount ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const currentPage = pagination.pageIndex + 1;
  const pageStart = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min(pagination.pageIndex * pagination.pageSize + items.length, total);

  useEffect(() => {
    setPagination((current) => {
      const maxPageIndex = Math.max(0, totalPages - 1);
      return current.pageIndex > maxPageIndex ? { ...current, pageIndex: maxPageIndex } : current;
    });
  }, [totalPages]);

  const maintenance = useMutation({
    mutationFn: (input: {
      action: DeadZoneRecommendationAction;
      deadZoneKnowledgeId: string;
      canonicalKnowledgeId?: string;
      reviewItemId?: string;
    }) => applyDeadZoneKnowledgeReviewAction(input),
    onSuccess: async (result: DeadZoneKnowledgeReviewActionResult) => {
      setActionError(null);
      setActionStatus(result.message);
      await queryClient.invalidateQueries({ queryKey: ["landscape-dead-zone-knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (error) => {
      setActionStatus(null);
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const requestMergeReview = useMutation({
    mutationFn: (input: {
      deadZoneKnowledgeId: string;
      canonicalKnowledgeId: string;
      reviewItemId?: string;
    }) => requestDeadZoneMergeReviewJob(input),
    onSuccess: async () => {
      setActionError(null);
      setActionStatus("Merge review queued.");
      await queryClient.invalidateQueries({ queryKey: ["landscape-dead-zone-knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["queue-v2-stats"] });
      await queryClient.invalidateQueries({ queryKey: ["queue-v2-items"] });
    },
    onError: (error) => {
      setActionStatus(null);
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const applyMergeReview = useMutation({
    mutationFn: (jobId: string) => sendDeadZoneMergeReviewToFinalize(jobId),
    onSuccess: async () => {
      setActionError(null);
      setActionStatus("Reviewed merge sent to Finalize.");
      await queryClient.invalidateQueries({ queryKey: ["landscape-dead-zone-knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["queue-v2-stats"] });
      await queryClient.invalidateQueries({ queryKey: ["queue-v2-items"] });
    },
    onError: (error) => {
      setActionStatus(null);
      setActionError(error instanceof Error ? error.message : String(error));
    },
  });

  const summaryItems = useMemo(
    () => [
      `Showing ${pageStart} to ${pageEnd} of ${total} items | Page ${currentPage} / ${totalPages}`,
    ],
    [currentPage, pageEnd, pageStart, total, totalPages],
  );
  const pendingActionLabel = useMemo(() => {
    if (requestMergeReview.isPending) return "Queueing merge review...";
    if (applyMergeReview.isPending) return "Sending reviewed merge to Finalize...";
    if (!maintenance.isPending) return null;
    switch (maintenance.variables?.action) {
      case "merge_deadzone_into_canonical":
        return "Merging knowledge...";
      case "deprecate_deadzone":
        return "Deprecating knowledge...";
      case "keep_separate":
      case "promote_deadzone":
      case "needs_evidence":
        return "Recording review decision...";
      default:
        return "Recording review decision...";
    }
  }, [
    applyMergeReview.isPending,
    maintenance.isPending,
    maintenance.variables?.action,
    requestMergeReview.isPending,
  ]);

  return (
    <div className="landscape-page">
      <AdminPageHeader
        title="Landscape"
        checkedAtText={
          deadZoneKnowledgeReview.data?.generatedAt
            ? formatDateTimeShort(deadZoneKnowledgeReview.data.generatedAt, timezone)
            : undefined
        }
        refreshDisabled={deadZoneKnowledgeReview.isFetching || unresolvedCuration.isFetching}
        onRefresh={() => {
          void deadZoneKnowledgeReview.refetch();
          void unresolvedCuration.refetch();
        }}
        status={deadZoneKnowledgeReview.error || unresolvedCuration.error ? "failed" : "ok"}
        statusLabel={
          deadZoneKnowledgeReview.error || unresolvedCuration.error
            ? "load failed"
            : "Autonomous curation"
        }
      />

      <section className="mb-4 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Autonomous curation</h2>
            <p className="text-xs text-muted-foreground">
              LLM and policy process findings automatically. Items appear here only while they
              remain unresolved.
            </p>
          </div>
          <Badge variant={unresolvedCuration.data?.length ? "secondary" : "outline"}>
            {unresolvedCuration.data?.length ?? 0} unresolved
          </Badge>
        </div>
        {unresolvedCuration.isLoading ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading curation tasks...</p>
        ) : unresolvedCuration.error ? (
          <p className="mt-3 text-sm text-destructive">
            {unresolvedCuration.error instanceof Error
              ? unresolvedCuration.error.message
              : "Failed to load curation tasks."}
          </p>
        ) : unresolvedCuration.data?.length ? (
          <ul className="mt-3 grid gap-2">
            {unresolvedCuration.data.map((job) => (
              <li key={job.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{job.status}</Badge>
                  <span className="font-medium">{job.findingType.replaceAll("_", " ")}</span>
                  <span className="text-xs text-muted-foreground">phase: {job.phase}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Knowledge {job.subjectKnowledgeId}
                  {job.lastError ? ` · ${job.lastError}` : ""}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No unresolved curation tasks.</p>
        )}
      </section>

      <section className="landscape-toolbar">
        <div className="landscape-toolbar-group">
          <label>
            Reason
            <Select
              value={reason}
              disabled={
                maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
              }
              onChange={(event) => {
                setReason(event.target.value as DeadZoneKnowledgeReviewReason);
                resetToFirstPage();
              }}
            >
              <option value="all">all reasons</option>
              <option value="dead_zone_reachability_risk">reachability risk</option>
              <option value="dead_zone_stale">stale</option>
            </Select>
          </label>
          <label>
            Badge
            <Select
              value={badge}
              disabled={
                maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
              }
              onChange={(event) => {
                setBadge(event.target.value as DeadZoneKnowledgeReviewBadge | "all");
                resetToFirstPage();
              }}
            >
              {badgeOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "all badges" : option}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Similarity
            <Select
              value={String(minSimilarity)}
              disabled={
                maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
              }
              onChange={(event) => {
                setMinSimilarity(Number(event.target.value));
                resetToFirstPage();
              }}
            >
              <option value="0.95">0.95+</option>
              <option value="0.9">0.90+</option>
              <option value="0.85">0.85+</option>
            </Select>
          </label>
        </div>
      </section>

      <section className="landscape-content">
        <div className="landscape-list-header">
          <div>
            <h2>DeadZone Score Queue</h2>
          </div>
          <div className="landscape-list-badges">
            {pendingActionLabel ? (
              <span className="landscape-action-pending">{pendingActionLabel}</span>
            ) : null}
            {actionStatus ? <span className="landscape-action-success">{actionStatus}</span> : null}
            {actionError ? <span className="landscape-action-error">{actionError}</span> : null}
          </div>
        </div>
        <DeadZoneReviewPanel
          data={deadZoneKnowledgeReview.data}
          isLoading={deadZoneKnowledgeReview.isLoading}
          errorMessage={
            deadZoneKnowledgeReview.error instanceof Error
              ? deadZoneKnowledgeReview.error.message
              : null
          }
          sortBy={sortBy}
          sortDir={sortDir}
          onSortChange={updateSort}
          sortDisabled={
            maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
          }
          actionPending={
            maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
          }
          onReviewAction={(input) => maintenance.mutate(input)}
          onRequestMergeReview={(input) => requestMergeReview.mutate(input)}
          onApplyMergeReview={(jobId) => applyMergeReview.mutate(jobId)}
        />
        <AdminPaginationFooter
          keyPrefix="landscape-deadzone"
          currentPage={currentPage}
          totalPages={totalPages}
          canPreviousPage={pagination.pageIndex > 0}
          canNextPage={currentPage < totalPages}
          disabled={
            maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
          }
          onPreviousPage={() =>
            setPagination((current) => ({
              ...current,
              pageIndex: Math.max(0, current.pageIndex - 1),
            }))
          }
          onNextPage={() =>
            setPagination((current) => ({
              ...current,
              pageIndex: Math.min(totalPages - 1, current.pageIndex + 1),
            }))
          }
          onPageSelect={(pageNumber) =>
            setPagination((current) => ({ ...current, pageIndex: pageNumber - 1 }))
          }
          summaryItems={summaryItems}
        />
        <div className="landscape-footer-actions">
          <Button
            variant="outline"
            disabled={
              maintenance.isPending || requestMergeReview.isPending || applyMergeReview.isPending
            }
            onClick={() => void deadZoneKnowledgeReview.refetch()}
          >
            Refresh DeadZone Queue
          </Button>
        </div>
      </section>
    </div>
  );
}
