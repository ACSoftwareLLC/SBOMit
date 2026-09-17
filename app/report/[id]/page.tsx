"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Loader2, Package } from "lucide-react";
import { SiteHeader } from "@/app/components/site-header";
import { ReportDiffCard } from "@/app/components/report-diff-card";
import { ReportView } from "@/app/components/report-view";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent } from "@/app/components/ui/card";
import type { AuditResult } from "@/app/lib/audit";
import type { ReportDiff } from "@/app/lib/report-diff";
import type { LlmInteraction } from "@/app/lib/llm";

interface ReportPageData {
  audit: {
    id: number;
    name: string;
    version: string;
    source: string;
    url: string;
    audited_at: string;
  };
  report: {
    id: number;
    prompt: string | null;
    model: string;
    score: number;
    created_at: string;
    /** Present only when fetched with ?diff=1. */
    diff?: ReportDiff | null;
    previousReportId?: number | null;
    previousReportPublicId?: string | null;
  };
  result: AuditResult;
  interactions?: LlmInteraction[];
}

function formatTimestamp(createdAt: string): string {
  const date = new Date(`${createdAt.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString();
}

const scoreBadgeVariant = (score: number) => {
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "destructive";
};

export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const reportId = params.id;
  const [data, setData] = React.useState<ReportPageData | null>(null);
  const [error, setError] = React.useState<string | null>(
    reportId ? null : "Report ID is required.",
  );
  const [loading, setLoading] = React.useState(Boolean(reportId));

  React.useEffect(() => {
    if (!reportId) return;

    async function load() {
      try {
        const res = await fetch(`/api/audits/${reportId}?diff=1`, {
          cache: "no-store",
        });
        const payload = (await res.json()) as ReportPageData & {
          error?: string;
          code?: string;
        };
        if (!res.ok || payload.error) {
          throw new Error(payload.error || "Failed to load report.");
        }
        setData(payload);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load report.",
        );
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [reportId]);

  return (
    <div className="flex min-h-full flex-col bg-background">
      <SiteHeader />

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
          {loading ? (
            <Card>
              <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading report…
              </CardContent>
            </Card>
          ) : error ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                {error}
              </CardContent>
            </Card>
          ) : data ? (
            <div className="space-y-6">
              {data.report.diff && (
                <ReportDiffCard diff={data.report.diff} />
              )}
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Package className="h-5 w-5 text-muted-foreground" />
                    <h1 className="text-2xl font-bold">
                      {data.audit.name}
                      <span className="font-normal text-muted-foreground">
                        @{data.audit.version}
                      </span>
                    </h1>
                    <Badge variant="outline">{data.audit.source}</Badge>
                    <Badge variant={scoreBadgeVariant(data.report.score)}>
                      score {data.report.score}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Report #{data.report.id} · {data.report.model} ·{" "}
                    {formatTimestamp(data.report.created_at)}
                  </p>
                  {data.report.prompt && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Prompt: {data.report.prompt}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <a href={data.audit.url} target="_blank" rel="noreferrer">
                      Open source
                    </a>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/audits">View all audits</a>
                  </Button>
                </div>
              </div>

              <ReportView result={data.result} />
            </div>
          ) : null}
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-5xl px-4 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
          sbomit — AI-powered npm audits. Built for safer dependencies.
        </div>
      </footer>
    </div>
  );
}
