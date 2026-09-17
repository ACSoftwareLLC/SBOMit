"use client";

import * as React from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  History,
  Loader2,
  MessageSquare,
  Package,
  RefreshCw,
  Star,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { SiteHeader } from "@/app/components/site-header";
import {
  ElapsedTime,
  displayUrlLabel,
  useAuditJobs,
  type AuditJob,
} from "@/app/components/audit-jobs";
import { ReportView } from "@/app/components/report-view";
import { CompetitionReadoutView } from "@/app/components/competition-readout";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import type { LlmInteraction } from "@/app/lib/llm";
import type { AuditResult } from "@/app/lib/audit";

interface AuditHistoryItem {
  id: number;
  audit_id: number;
  prompt: string | null;
  model: string;
  score: number;
  created_at: string;
  name: string;
  version: string;
  source: string;
  url: string;
  provider: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  started_at: string | null;
  finished_at: string | null;
  codebase_inspected: number;
}

interface WatchlistItem {
  id: number;
  user_id: number;
  source: string;
  name: string;
  url: string;
  created_at: string;
}

interface LoadedReport {
  reportId: number;
  result: AuditResult;
  interactions: LlmInteraction[];
}

const scoreBadgeVariant = (score: number) => {
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "destructive";
};

/** Stable watchlist key — same uniqueness domain as the watchlist table. */
function watchKey(source: string, name: string): string {
  return `${source}:${name}`;
}

const jobStatusBadge: Record<
  AuditJob["status"],
  { variant: "secondary" | "success" | "destructive" | "outline"; label: string }
> = {
  running: { variant: "secondary", label: "Running" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "destructive", label: "Failed" },
  cancelled: { variant: "outline", label: "Cancelled" },
};

function formatTimestamp(createdAt: string): string {
  // SQLite CURRENT_TIMESTAMP is UTC ("YYYY-MM-DD HH:MM:SS").
  const date = new Date(`${createdAt.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString();
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

function formatDuration(startedAt: number, finishedAt?: number): string {
  if (!finishedAt) return "";
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatIsoDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string {
  if (!startedAt || !finishedAt) return "";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const ms = Math.max(0, end - start);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function providerLabel(provider: string | null): string {
  if (!provider) return "unknown";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  return provider;
}

function codebaseStatusLabel(inspected?: boolean): string {
  return inspected ? "Source inspected" : "Metadata only";
}

function CodeBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <pre className="max-h-96 overflow-auto p-3 text-xs">{children}</pre>
    </div>
  );
}

function aggregateTokens(interactions: LlmInteraction[]): {
  input: number | undefined;
  output: number | undefined;
} {
  let input = 0;
  let output = 0;
  let hasInput = false;
  let hasOutput = false;
  for (const interaction of interactions) {
    if (interaction.tokensInput != null) {
      input += interaction.tokensInput;
      hasInput = true;
    }
    if (interaction.tokensOutput != null) {
      output += interaction.tokensOutput;
      hasOutput = true;
    }
  }
  return {
    input: hasInput ? input : undefined,
    output: hasOutput ? output : undefined,
  };
}

function InteractionsLogView({
  interactions,
}: {
  interactions: LlmInteraction[];
}) {
  return (
    <div className="space-y-6">
      {interactions.map((interaction, idx) => (
        <div key={idx}>
          <div className="mb-2 text-sm font-medium text-muted-foreground">
            Phase {idx + 1}
          </div>
          <InteractionLogView interaction={interaction} />
        </div>
      ))}
    </div>
  );
}

function InteractionLogView({
  interaction,
}: {
  interaction: LlmInteraction;
}) {
  const duration = formatIsoDuration(
    interaction.startedAt,
    interaction.finishedAt,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{providerLabel(interaction.provider)}</Badge>
        <span className="text-muted-foreground">{interaction.model}</span>
        {duration && (
          <span className="text-muted-foreground">· {duration}</span>
        )}
        {interaction.tokensInput != null && (
          <span className="text-muted-foreground">
            · {interaction.tokensInput} tokens in
          </span>
        )}
        {interaction.tokensOutput != null && (
          <span className="text-muted-foreground">
            · {interaction.tokensOutput} tokens out
          </span>
        )}
      </div>

      <CodeBlock title="System prompt">{interaction.systemPrompt}</CodeBlock>
      <CodeBlock title="User prompt">{interaction.userPrompt}</CodeBlock>
      <CodeBlock title="Request">
        {formatJson(interaction.request)}
      </CodeBlock>
      {interaction.response != null && (
        <CodeBlock title="Response">
          {formatJson(interaction.response)}
        </CodeBlock>
      )}
      {interaction.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Error: {interaction.error}
        </div>
      )}
    </div>
  );
}

export default function AuditsPage() {
  const { jobs, cancelAudit, dismissJob } = useAuditJobs();
  const [history, setHistory] = React.useState<AuditHistoryItem[] | null>(
    null,
  );
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<number | null>(
    null,
  );
  const [deletingId, setDeletingId] = React.useState<number | null>(null);
  const [expandedId, setExpandedId] = React.useState<number | null>(null);
  const [activeTab, setActiveTab] = React.useState<
    "report" | "competition" | "log"
  >("report");
  const [loadedReport, setLoadedReport] = React.useState<LoadedReport | null>(
    null,
  );
  const [loadingReportId, setLoadingReportId] = React.useState<number | null>(
    null,
  );
  const [expandedJobId, setExpandedJobId] = React.useState<string | null>(null);
  const [watchedKeys, setWatchedKeys] = React.useState<Set<string>>(new Set());
  const [watchPendingKeys, setWatchPendingKeys] = React.useState<Set<string>>(
    new Set(),
  );

  const completedCount = jobs.filter(
    (job) => job.status === "completed",
  ).length;

  const fetchHistory = React.useCallback(async () => {
    try {
      const res = await fetch("/api/audits", { cache: "no-store" });
      const data = (await res.json()) as {
        audits?: AuditHistoryItem[];
        error?: string;
      };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to load audit history.");
      }
      setHistory(data.audits ?? []);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Failed to load audit history.",
      );
    }
  }, []);

  // Load on mount and reload whenever a running audit completes.
  React.useEffect(() => {
    const timer = setTimeout(() => void fetchHistory(), 0);
    return () => clearTimeout(timer);
  }, [fetchHistory, completedCount]);

  const fetchWatchlist = React.useCallback(async () => {
    try {
      const res = await fetch("/api/watchlist", { cache: "no-store" });
      const data = (await res.json()) as {
        items?: WatchlistItem[];
        error?: string;
      };
      if (!res.ok || data.error) {
        // Anonymous visitors simply have no watchlist state.
        if (res.status === 401) {
          setWatchedKeys(new Set());
          return;
        }
        throw new Error(data.error || "Failed to load watchlist.");
      }
      setWatchedKeys(
        new Set((data.items ?? []).map((i) => watchKey(i.source, i.name))),
      );
    } catch {
      setWatchedKeys(new Set());
    }
  }, []);

  // Load watch state on mount.
  React.useEffect(() => {
    const timer = setTimeout(() => void fetchWatchlist(), 0);
    return () => clearTimeout(timer);
  }, [fetchWatchlist]);

  const toggleWatch = React.useCallback(
    async (item: AuditHistoryItem) => {
      const key = watchKey(item.source, item.name);
      const currentlyWatched = watchedKeys.has(key);

      // Optimistic update; refetch on error to resync.
      const nextKeys = new Set(watchedKeys);
      if (currentlyWatched) {
        nextKeys.delete(key);
      } else {
        nextKeys.add(key);
      }
      setWatchedKeys(nextKeys);
      setWatchPendingKeys((prev) => new Set(prev).add(key));

      try {
        const res = await fetch("/api/watchlist", {
          method: currentlyWatched ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ libraryUrl: item.url }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok || data.error) {
          throw new Error(data.error || "Failed to update watchlist.");
        }
      } catch (error) {
        await fetchWatchlist();
        setHistoryError(
          error instanceof Error ? error.message : "Failed to update watchlist.",
        );
      } finally {
        setWatchPendingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [watchedKeys, fetchWatchlist],
  );

  // Auto-reset the delete confirmation after a few seconds.
  React.useEffect(() => {
    if (confirmDeleteId === null) return;
    const timer = setTimeout(() => setConfirmDeleteId(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  const loadReport = React.useCallback(async (reportId: number) => {
    setLoadingReportId(reportId);
    try {
      const res = await fetch(`/api/audits/${reportId}`, { cache: "no-store" });
      const data = (await res.json()) as {
        result?: AuditResult;
        interactions?: LlmInteraction[];
        error?: string;
      };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to load audit report.");
      }
      if (data.result) {
        setLoadedReport({
          reportId,
          result: data.result,
          interactions: data.interactions ?? [],
        });
      }
      setHistoryError(null);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Failed to load audit report.",
      );
    } finally {
      setLoadingReportId(null);
    }
  }, []);

  const toggleExpanded = React.useCallback(
    (reportId: number) => {
      if (expandedId === reportId) {
        setExpandedId(null);
        return;
      }
      setExpandedId(reportId);
      setActiveTab("report");
      if (!loadedReport || loadedReport.reportId !== reportId) {
        void loadReport(reportId);
      }
    },
    [expandedId, loadedReport, loadReport],
  );

  const handleDelete = React.useCallback(
    async (reportId: number) => {
      if (confirmDeleteId !== reportId) {
        setConfirmDeleteId(reportId);
        return;
      }
      setDeletingId(reportId);
      try {
        const res = await fetch(`/api/audits/${reportId}`, {
          method: "DELETE",
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok || data.error) {
          throw new Error(data.error || "Failed to delete audit.");
        }
        setHistory((prev) =>
          prev ? prev.filter((item) => item.id !== reportId) : prev,
        );
      } catch (error) {
        setHistoryError(
          error instanceof Error ? error.message : "Failed to delete audit.",
        );
      } finally {
        setDeletingId(null);
        setConfirmDeleteId(null);
      }
    },
    [confirmDeleteId],
  );

  return (
    <div className="flex min-h-full flex-col bg-background">
      <SiteHeader />

      <main className="flex-1">
        <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight">Audits</h1>
            <p className="mt-2 text-muted-foreground">
              Track audits in progress and browse or remove past audit reports.
            </p>
          </div>

          <div className="mb-10">
            <div className="mb-4 flex items-center gap-2">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-xl font-semibold">In progress</h2>
            </div>

            {jobs.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No audits running in this session. Start one from the home
                  page — it keeps running even if you navigate away.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => {
                  const status = jobStatusBadge[job.status];
                  const isJobExpanded = expandedJobId === job.id;
                  const duration =
                    job.status !== "running"
                      ? formatDuration(job.startedAt, job.finishedAt)
                      : null;

                  return (
                    <Card key={job.id}>
                      <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {job.status === "running" && (
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            )}
                            <span className="truncate font-medium">
                              {displayUrlLabel(job.libraryUrl)}
                            </span>
                            <Badge variant="outline">{job.source}</Badge>
                            <Badge variant={status.variant}>
                              {status.label}
                            </Badge>
                            {job.status === "completed" && (
                              <Badge
                                variant={
                                  job.codebaseInspected ? "success" : "outline"
                                }
                              >
                                {codebaseStatusLabel(job.codebaseInspected)}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            Started {formatTime(job.startedAt)}
                            {job.status === "running" ? (
                              <>
                                {" "}
                                · elapsed{" "}
                                <ElapsedTime
                                  since={job.startedAt}
                                  className="tabular-nums"
                                />
                              </>
                            ) : (
                              <> · took {duration}</>
                            )}
                          </div>
                          {job.status === "completed" && job.interactions && (
                            <div className="mt-1 text-sm text-muted-foreground">
                              {providerLabel(job.interactions[0]?.provider)} ·{" "}
                              {job.interactions[0]?.model}
                              {(() => {
                                const tokens = aggregateTokens(job.interactions);
                                return (
                                  <>
                                    {tokens.input != null &&
                                      ` · ${tokens.input} in`}
                                    {tokens.output != null &&
                                      ` / ${tokens.output} out`}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                          {job.prompt && (
                            <div className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span className="line-clamp-1">{job.prompt}</span>
                            </div>
                          )}
                          {job.status === "failed" && job.error && (
                            <div className="mt-1 text-sm text-red-600 dark:text-red-400">
                              {job.error}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {job.status === "running" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => cancelAudit(job.id)}
                            >
                              <XCircle className="mr-1.5 h-4 w-4" />
                              Cancel
                            </Button>
                          ) : (
                            <>
                              {job.status === "completed" && job.interactions && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setExpandedJobId(
                                      isJobExpanded ? null : job.id,
                                    )
                                  }
                                  aria-expanded={isJobExpanded}
                                  aria-label="Toggle LLM interaction log"
                                >
                                  <Terminal className="mr-1.5 h-4 w-4" />
                                  {isJobExpanded ? "Hide log" : "View log"}
                                  {isJobExpanded ? (
                                    <ChevronUp className="ml-1.5 h-4 w-4" />
                                  ) : (
                                    <ChevronDown className="ml-1.5 h-4 w-4" />
                                  )}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => dismissJob(job.id)}
                                aria-label="Dismiss"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </CardContent>
                      {isJobExpanded && job.interactions && (
                        <CardContent className="border-t bg-muted/30 px-4 py-4">
                          <InteractionsLogView interactions={job.interactions} />
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-xl font-semibold">History</h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void fetchHistory()}
              >
                <RefreshCw className="mr-1.5 h-4 w-4" />
                Refresh
              </Button>
            </div>

            {historyError && (
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{historyError}</p>
              </div>
            )}

            {history === null && !historyError && (
              <Card>
                <CardContent className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading audit history...
                </CardContent>
              </Card>
            )}

            {history !== null && history.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No audit reports stored yet. Completed audits are saved to D1
                  and listed here.
                </CardContent>
              </Card>
            )}

            {history !== null && history.length > 0 && (
              <>
                <Card className="mb-4">
                  <CardContent className="py-4">
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Audits
                        </div>
                        <div className="text-xl font-semibold">
                          {history.length}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Total tokens
                        </div>
                        <div className="text-xl font-semibold">
                          {history
                            .reduce(
                              (sum, item) => sum + (item.tokens_total ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Input tokens
                        </div>
                        <div className="text-xl font-semibold">
                          {history
                            .reduce(
                              (sum, item) => sum + (item.tokens_input ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">
                          Output tokens
                        </div>
                        <div className="text-xl font-semibold">
                          {history
                            .reduce(
                              (sum, item) => sum + (item.tokens_output ?? 0),
                              0,
                            )
                            .toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="space-y-3">
                  {history.map((item) => {
                  const isExpanded = expandedId === item.id;
                  const report =
                    loadedReport?.reportId === item.id
                      ? loadedReport
                      : undefined;
                  const duration = formatIsoDuration(
                    item.started_at,
                    item.finished_at,
                  );
                  const tokenHint =
                    item.tokens_input != null || item.tokens_output != null
                      ? `${item.tokens_input ?? "-"} in / ${item.tokens_output ?? "-"} out${item.tokens_total != null ? ` · ${item.tokens_total.toLocaleString()} total` : ""}`
                      : item.tokens_total != null
                        ? `${item.tokens_total.toLocaleString()} tokens`
                        : null;

                  return (
                    <Card key={item.id}>
                      <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Package className="h-4 w-4 text-muted-foreground" />
                            <span className="truncate font-medium">
                              {item.name}
                              <span className="font-normal text-muted-foreground">
                                @{item.version}
                              </span>
                            </span>
                            <Badge variant="outline">{item.source}</Badge>
                            <Badge variant={scoreBadgeVariant(item.score)}>
                              score {item.score}
                            </Badge>
                            <Badge
                              variant={
                                item.codebase_inspected === 1
                                  ? "success"
                                  : "outline"
                              }
                            >
                              {codebaseStatusLabel(
                                item.codebase_inspected === 1,
                              )}
                            </Badge>
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {formatTimestamp(item.created_at)} · {item.model} ·
                            report #{item.id}
                            {item.provider && (
                              <> · {providerLabel(item.provider)}</>
                            )}
                            {duration && <> · {duration}</>}
                            {tokenHint && <> · {tokenHint}</>}
                          </div>
                          {item.prompt && (
                            <div className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                              <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                              <span className="line-clamp-1">{item.prompt}</span>
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-pressed={watchedKeys.has(
                              watchKey(item.source, item.name),
                            )}
                            aria-label={
                              watchedKeys.has(watchKey(item.source, item.name))
                                ? `Stop watching ${item.name}`
                                : `Watch ${item.name}`
                            }
                            title={
                              watchedKeys.has(watchKey(item.source, item.name))
                                ? "Watching — click to stop"
                                : "Watch for scheduled re-audits"
                            }
                            disabled={watchPendingKeys.has(
                              watchKey(item.source, item.name),
                            )}
                            onClick={() => void toggleWatch(item)}
                          >
                            <Star
                              className={
                                watchedKeys.has(
                                  watchKey(item.source, item.name),
                                )
                                  ? "h-4 w-4 fill-yellow-400 text-yellow-500"
                                  : "h-4 w-4 text-muted-foreground"
                              }
                            />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggleExpanded(item.id)}
                            aria-expanded={isExpanded}
                            aria-label="Toggle audit report details"
                          >
                            <Terminal className="mr-1.5 h-4 w-4" />
                            {isExpanded ? "Hide details" : "View details"}
                            {isExpanded ? (
                              <ChevronUp className="ml-1.5 h-4 w-4" />
                            ) : (
                              <ChevronDown className="ml-1.5 h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            asChild
                          >
                            <a href={`/report/${item.id}`}>
                              <ExternalLink className="mr-1.5 h-4 w-4" />
                              Open
                            </a>
                          </Button>
                          <Button
                            variant={
                              confirmDeleteId === item.id
                                ? "destructive"
                                : "outline"
                            }
                            size="sm"
                            disabled={deletingId === item.id}
                            onClick={() => void handleDelete(item.id)}
                          >
                            {deletingId === item.id ? (
                              <>
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                                Deleting
                              </>
                            ) : confirmDeleteId === item.id ? (
                              <>
                                <AlertTriangle className="mr-1.5 h-4 w-4" />
                                Confirm delete
                              </>
                            ) : (
                              <>
                                <Trash2 className="mr-1.5 h-4 w-4" />
                                Delete
                              </>
                            )}
                          </Button>
                        </div>
                      </CardContent>
                      {isExpanded && (
                        <CardContent className="border-t bg-muted/30 px-4 py-4">
                          {loadingReportId === item.id ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading audit report…
                            </div>
                          ) : !report ? (
                            <div className="text-sm text-muted-foreground">
                              No report available for this audit.
                            </div>
                          ) : (
                            <div className="space-y-4">
                              <div className="flex items-center gap-2 border-b pb-2">
                                <Button
                                  variant={
                                    activeTab === "report" ? "default" : "ghost"
                                  }
                                  size="sm"
                                  onClick={() => setActiveTab("report")}
                                >
                                  Report
                                </Button>
                                {report.result.competitionReadout && (
                                  <Button
                                    variant={
                                      activeTab === "competition"
                                        ? "default"
                                        : "ghost"
                                    }
                                    size="sm"
                                    onClick={() => setActiveTab("competition")}
                                  >
                                    Competition
                                  </Button>
                                )}
                                <Button
                                  variant={
                                    activeTab === "log" ? "default" : "ghost"
                                  }
                                  size="sm"
                                  onClick={() => setActiveTab("log")}
                                >
                                  LLM log
                                </Button>
                              </div>
                              {activeTab === "report" ? (
                                <ReportView result={report.result} />
                              ) : activeTab === "competition" ? (
                                <CompetitionReadoutView result={report.result} />
                              ) : report.interactions.length > 0 ? (
                                <InteractionsLogView
                                  interactions={report.interactions}
                                />
                              ) : (
                                <div className="text-sm text-muted-foreground">
                                  No interaction log available for this report.
                                </div>
                              )}
                            </div>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-6xl px-4 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
          sbomit — AI-powered npm audits. Built for safer dependencies.
        </div>
      </footer>
    </div>
  );
}
