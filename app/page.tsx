"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Zap } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { SiteHeader } from "@/app/components/site-header";
import { useAuditJobs } from "@/app/components/audit-jobs";
import { AuditForm } from "@/app/components/audit-form";
import { HowItWorks } from "@/app/components/how-it-works";
import { AuditProgress } from "@/app/components/audit-progress";
import { AuditResultTabs } from "@/app/components/audit-result-tabs";
import type { RunAuditInput } from "@/app/lib/run-audit";
import { useProviderConfigs } from "@/app/lib/use-provider-configs";
import { useAuth } from "@/app/lib/use-auth";
import type { AuditResult } from "@/app/lib/audit";

export default function Home() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { jobs, startAudit, cancelAudit } = useAuditJobs();
  const { configs, selectedConfig, selectedId, setSelectedId } =
    useProviderConfigs();

  React.useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  const [model, setModel] = React.useState("");
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<AuditResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelled, setCancelled] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("overview");

  const activeJob = activeJobId
    ? jobs.find((job) => job.id === activeJobId)
    : undefined;
  const loading = activeJob?.status === "running";

  const effectiveModel =
    model && selectedConfig?.models.includes(model)
      ? model
      : (selectedConfig?.models[0] ?? "");

  const handleAuditSubmit = React.useCallback(
    async (input: RunAuditInput) => {
      setResult(null);
      setError(null);
      setCancelled(false);

      const { jobId, done } = startAudit(input);
      setActiveJobId(jobId);

      const outcome = await done;

      if (outcome.status === "completed") {
        setResult(outcome.result);
        setActiveTab("overview");
      } else if (outcome.status === "cancelled") {
        setCancelled(true);
      } else {
        setError(outcome.error);
      }
      setActiveJobId(null);
    },
    [startAudit],
  );

  const handleCancelAudit = React.useCallback(() => {
    if (activeJobId) {
      cancelAudit(activeJobId);
    }
  }, [activeJobId, cancelAudit]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-background">
      <SiteHeader />

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-muted via-background to-background" />
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8">
            <div className="mx-auto max-w-3xl text-center">
              <Badge variant="secondary" className="mb-6">
                <Zap className="mr-1 h-3 w-3" />
                AI-Powered Security Audits
              </Badge>
              <h1 className="text-4xl font-extrabold tracking-tight text-foreground sm:text-6xl">
                Audit npm libraries
                <span className="block text-muted-foreground">
                  before you ship.
                </span>
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
                Paste a package URL, add an optional prompt, and get an instant
                AI audit covering security, license risk, and dependency health.
              </p>

              <AuditForm
                configs={configs}
                selectedConfig={selectedConfig}
                selectedId={selectedId}
                setSelectedId={setSelectedId}
                setModel={setModel}
                effectiveModel={effectiveModel}
                loading={loading}
                error={error}
                cancelled={cancelled}
                onSubmit={handleAuditSubmit}
              />
            </div>
          </div>
        </section>

        {!result && !loading && <HowItWorks />}

        {loading && activeJob && (
          <AuditProgress
            job={activeJob}
            configs={configs}
            onCancel={handleCancelAudit}
          />
        )}


        {result && (
          <AuditResultTabs
            result={result}
            activeJob={activeJob}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            selectedConfig={selectedConfig}
            effectiveModel={effectiveModel}
          />
        )}
      </main>

      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-6xl px-4 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
          sbomit — AI-powered npm audits. Built for safer dependencies.
        </div>
      </footer>
    </div>
  );
}
