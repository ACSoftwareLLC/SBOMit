"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Package,
  Scale,
  Loader2,
  CheckCircle2,
  Info,
  Search,
  FileText,
  Zap,
  Lock,
  Ban,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Progress } from "@/app/components/ui/progress";
import { cn } from "@/app/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import { SiteHeader } from "@/app/components/site-header";
import {
  ElapsedTime,
  Countdown,
  displayUrlLabel,
  useAuditJobs,
} from "@/app/components/audit-jobs";
import { CompetitionReadoutView } from "@/app/components/competition-readout";
import { AuditForm } from "@/app/components/audit-form";
import { HowItWorks } from "@/app/components/how-it-works";
import {
  ModelProgressCard,
  pipelineSteps,
  providerLabelFromId,
} from "@/app/components/model-progress-card";
import type { RunAuditInput } from "@/app/lib/run-audit";
import { useProviderConfigs } from "@/app/lib/use-provider-configs";
import { providerLabels } from "@/app/lib/providers";
import { useAuth } from "@/app/lib/use-auth";
import type { AuditResult } from "@/app/lib/audit";
import { severityVariant, scoreProgressVariant } from "@/app/lib/variants";

function aggregateTokens(
  interactions: Array<{ tokensInput?: number | null; tokensOutput?: number | null }>,
): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const interaction of interactions) {
    if (interaction.tokensInput != null) input += interaction.tokensInput;
    if (interaction.tokensOutput != null) output += interaction.tokensOutput;
  }
  return { input, output };
}

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
          <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6 lg:px-8">
            <Card className="mx-auto max-w-3xl">
              <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
                      <div>
                        <CardTitle className="text-xl">
                          Auditing {displayUrlLabel(activeJob.libraryUrl)}
                        </CardTitle>
                        <CardDescription>
                          {activeJob.source === "npm"
                            ? "npm package"
                            : "GitHub repository"}{" "}
                          · started{" "}
                          {new Date(activeJob.startedAt).toLocaleTimeString()} ·
                          elapsed{" "}
                          <ElapsedTime
                            since={activeJob.startedAt}
                            className="tabular-nums"
                          />
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Badge variant="secondary">{activeJob.source}</Badge>
                      {activeJob.competitionMode && (
                        <Badge variant="outline" className="text-xs">
                          Competition mode
                        </Badge>
                      )}
                    </div>
                  </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {activeJob.prompt && (
                  <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
                    <span className="font-medium">Custom prompt: </span>
                    <span className="text-muted-foreground">
                      {activeJob.prompt}
                    </span>
                  </div>
                )}
                {activeJob.model && !activeJob.competitionMode && (
                  <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
                    <span className="font-medium">Model: </span>
                    <span className="text-muted-foreground">
                      {activeJob.model.providerId ?? activeJob.model.provider}/
                      {activeJob.model.model}
                    </span>
                  </div>
                )}
                {activeJob.competitionMode && (
                  <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
                    <span className="font-medium">Competition mode: </span>
                    <span className="text-muted-foreground">
                      {activeJob.competitionMode.modelA.providerId ??
                        activeJob.competitionMode.modelA.provider}
                      /{activeJob.competitionMode.modelA.model} vs{" "}
                      {activeJob.competitionMode.modelB.providerId ??
                        activeJob.competitionMode.modelB.provider}
                      /{activeJob.competitionMode.modelB.model}, merged by{" "}
                      {activeJob.competitionMode.mergeModel.providerId ??
                        activeJob.competitionMode.mergeModel.provider}
                      /{activeJob.competitionMode.mergeModel.model}
                    </span>
                  </div>
                )}

                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-medium">
                      What&apos;s happening during this audit
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {activeJob.tokensPerSecond !== undefined &&
                        activeJob.tokensPerSecond > 0 && (
                          <span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">
                            {activeJob.tokensPerSecond.toLocaleString()} tok/s
                          </span>
                        )}
                      {(activeJob.tokensInput ?? 0) + (activeJob.tokensOutput ?? 0) > 0 && (
                        <span className="rounded-full bg-muted px-2 py-1">
                          {(
                            (activeJob.tokensInput ?? 0) +
                            (activeJob.tokensOutput ?? 0)
                          ).toLocaleString()}{" "}
                          tokens
                        </span>
                      )}
                      {activeJob.estimatedFinishAt !== undefined && (
                        <span className="rounded-full bg-muted px-2 py-1">
                          ETA{" "}
                          <Countdown
                            to={activeJob.estimatedFinishAt}
                            className="tabular-nums"
                          />
                        </span>
                      )}
                    </div>
                  </div>

                  {activeJob.competitionMode ? (
                    <div className="space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <ModelProgressCard
                          label="Model A"
                          provider={providerLabelFromId(
                            configs,
                            activeJob.competitionMode.modelA.providerId,
                          )}
                          model={activeJob.competitionMode.modelA.model}
                          progress={activeJob.modelAProgress}
                        />
                        <ModelProgressCard
                          label="Model B"
                          provider={providerLabelFromId(
                            configs,
                            activeJob.competitionMode.modelB.providerId,
                          )}
                          model={activeJob.competitionMode.modelB.model}
                          progress={activeJob.modelBProgress}
                        />
                      </div>
                      <div className="mx-auto max-w-sm">
                        <ModelProgressCard
                          label="Judge"
                          provider={providerLabelFromId(
                            configs,
                            activeJob.competitionMode.mergeModel.providerId,
                          )}
                          model={activeJob.competitionMode.mergeModel.model}
                          progress={{
                            currentStep:
                              activeJob.currentStep === "judge"
                                ? "judge"
                                : undefined,
                            completedSteps: activeJob.completedSteps?.includes(
                              "judge",
                            )
                              ? ["judge"]
                              : [],
                          }}
                          steps={[{ step: "judge", label: "Merge findings" }]}
                          isJudge
                        />
                      </div>
                    </div>
                  ) : (
                    <ol className="space-y-3">
                      {pipelineSteps.map((step, index) => {
                        const isMetadataOnlyAudit =
                          activeJob.downloadDetail === "metadata only";
                        const isRelevant =
                          !isMetadataOnlyAudit || step.step !== "deep-dive";
                        if (!isRelevant) return null;

                        const stepMatchesCurrent =
                          activeJob.currentStep === step.step ||
                          (step.step === "investigate" &&
                            activeJob.currentStep === "metadata-only");
                        const stepMatchesCompleted =
                          activeJob.completedSteps?.includes(step.step) ??
                          false;
                        const metadataOnlyCompleted =
                          step.step === "investigate" &&
                          activeJob.completedSteps?.includes("metadata-only");
                        const isCompleted =
                          stepMatchesCompleted || !!metadataOnlyCompleted;
                        const isActive = stepMatchesCurrent;

                        return (
                          <li
                            key={step.label}
                            className={cn(
                              "flex items-start gap-3 transition-opacity",
                              !isActive && !isCompleted && "opacity-50",
                            )}
                          >
                            <div
                              className={cn(
                                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                                isCompleted
                                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                  : isActive
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-primary/10 text-primary",
                              )}
                            >
                              {isCompleted ? (
                                <CheckCircle2 className="h-4 w-4" />
                              ) : isActive ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <step.icon className="h-4 w-4" />
                              )}
                            </div>
                            <div className="flex-1">
                              <p className="text-sm font-medium">
                                {index + 1}. {step.label}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {step.detail}
                                {step.step === "download" &&
                                  activeJob.downloadDetail &&
                                  ` · ${activeJob.downloadDetail}`}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>

                <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    Most audits finish in up to 5 minutes. You can leave this
                    page — the audit keeps running and is tracked on the Audits
                    page.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancelAudit}
                    className="shrink-0"
                  >
                    <Ban className="mr-2 h-4 w-4" />
                    Cancel audit
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {result && (
          <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6 lg:px-8">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                <Lock className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-2xl font-bold tracking-tight">
                  Audit report for {result.name}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {result.competitionReadout ? (
                    <>
                      Competition mode: judged by{" "}
                      {result.competitionReadout.judge.provider} ·{" "}
                      {result.competitionReadout.judge.model}. Model A and B
                      reports are available in the Competition tab.
                    </>
                  ) : (
                    <>
                      Generated by{" "}
                      {activeJob?.interactions?.[0]?.provider
                        ? (providerLabels[activeJob.interactions[0].provider as "openai" | "anthropic" | "google"] ??
                            activeJob.interactions[0].provider)
                        : selectedConfig
                          ? providerLabels[selectedConfig.provider]
                          : "AI"}{" "}
                      {activeJob?.interactions?.[0]?.model || effectiveModel
                        ? `(${activeJob?.interactions?.[0]?.model || effectiveModel})`
                        : ""}{" "}
                      from public library metadata.
                    </>
                  )}
                </p>
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="mb-6 flex-wrap">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {result.competitionReadout && (
                  <TabsTrigger value="competition">
                    Competition
                    <Badge variant="secondary" className="ml-2">
                      A/B
                    </Badge>
                  </TabsTrigger>
                )}
                <TabsTrigger value="investigation">
                  Investigation
                  <Badge variant="secondary" className="ml-2">
                    {result.investigationAreas.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="deep-dive">
                  Deep Dive
                  <Badge variant="secondary" className="ml-2">
                    {result.deepDiveFindings.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="risks">
                  Risks
                  <Badge variant="secondary" className="ml-2">
                    {result.risks.length}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
                <TabsTrigger value="license">License</TabsTrigger>
                <TabsTrigger value="cves">
                  CVEs
                  <Badge variant="secondary" className="ml-2">
                    {result.cves?.length ?? 0}
                  </Badge>
                </TabsTrigger>
              </TabsList>

                <TabsContent value="overview" className="space-y-6">
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>Trust Score</CardDescription>
                      <div className="flex items-end gap-2">
                        <CardTitle className="text-4xl">
                          {result.score}
                        </CardTitle>
                        <span className="text-sm text-muted-foreground">
                          /100
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Progress
                        value={result.score}
                        variant={scoreProgressVariant(result.score)}
                      />
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>Version</CardDescription>
                      <CardTitle className="text-2xl">
                        {result.version}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        Last published {result.lastPublished}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>Weekly Downloads</CardDescription>
                      <CardTitle className="text-2xl">
                        {result.weeklyDownloads}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        npm registry estimate
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>License</CardDescription>
                      <CardTitle className="text-2xl">
                        {result.license.type}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        {result.license.compatible
                          ? "Compatible"
                          : "Review required"}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardDescription>Tokens used</CardDescription>
                      <CardTitle className="text-2xl">
                        {(() => {
                          const fromJob =
                            (activeJob?.tokensInput ?? 0) +
                            (activeJob?.tokensOutput ?? 0);
                          if (fromJob > 0) return fromJob.toLocaleString();
                          const fromInteractions = aggregateTokens(
                            activeJob?.interactions ?? [],
                          );
                          return (
                            fromInteractions.input + fromInteractions.output
                          ).toLocaleString();
                        })()}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        {(() => {
                          const fromJob = {
                            input: activeJob?.tokensInput ?? 0,
                            output: activeJob?.tokensOutput ?? 0,
                          };
                          const fromInteractions = aggregateTokens(
                            activeJob?.interactions ?? [],
                          );
                          const input =
                            fromJob.input > 0
                              ? fromJob.input
                              : fromInteractions.input;
                          const output =
                            fromJob.output > 0
                              ? fromJob.output
                              : fromInteractions.output;
                          if (input === 0 && output === 0) {
                            return "Not reported by provider";
                          }
                          return [
                            input > 0 ? `${input.toLocaleString()} in` : null,
                            output > 0
                              ? `${output.toLocaleString()} out`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" / ");
                        })()}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Info className="h-5 w-5 text-muted-foreground" />
                      AI Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-base leading-7 text-foreground">
                    {result.summary}
                  </CardContent>
                </Card>
              </TabsContent>

              {result.competitionReadout && (
                <TabsContent value="competition" className="space-y-4">
                  <CompetitionReadoutView result={result} />
                </TabsContent>
              )}

              <TabsContent value="investigation" className="space-y-4">
                {result.investigationAreas.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No investigation areas identified. This may happen when
                      the source code was not available for inspection.
                    </CardContent>
                  </Card>
                ) : (
                  result.investigationAreas.map((area, index) => (
                    <Card key={index}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <Search className="h-5 w-5 text-primary" />
                            <CardTitle className="text-lg">
                              {area.area}
                            </CardTitle>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-muted-foreground">
                          {area.rationale}
                        </p>
                        {area.files.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {area.files.map((file) => (
                              <Badge key={file} variant="outline">
                                {file}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </TabsContent>

              <TabsContent value="deep-dive" className="space-y-4">
                {result.deepDiveFindings.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No file-level findings. Either no issues were found or
                      the source code was not inspected.
                    </CardContent>
                  </Card>
                ) : (
                  result.deepDiveFindings.map((finding, index) => (
                    <Card key={index}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <FileText className="h-5 w-5 text-primary" />
                            <CardTitle className="text-lg">
                              {finding.file}
                            </CardTitle>
                          </div>
                          <Badge variant={severityVariant(finding.severity)}>
                            {finding.severity}
                          </Badge>
                        </div>
                        <CardDescription>{finding.area}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="font-medium">{finding.issue}</p>
                        {finding.evidence && (
                          <div className="rounded-lg bg-muted/50 p-3">
                            <p className="mb-1 text-xs font-medium text-muted-foreground">
                              Evidence
                            </p>
                            <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">
                              {finding.evidence}
                            </pre>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </TabsContent>

              <TabsContent value="risks" className="space-y-4">
                {result.risks.map((risk, index) => (
                  <Card key={index}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <AlertTriangle className="h-5 w-5 text-amber-500" />
                          <CardTitle className="text-lg">
                            {risk.title}
                          </CardTitle>
                        </div>
                        <Badge variant={severityVariant(risk.severity)}>
                          {risk.severity}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-muted-foreground">
                        {risk.description}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              <TabsContent value="dependencies">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Package className="h-5 w-5 text-muted-foreground" />
                      Dependency Tree
                    </CardTitle>
                    <CardDescription>
                      Direct and transitive dependencies identified by the
                      audit.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted">
                          <tr>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Package
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Version
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              License
                            </th>
                            <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                              Type
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {result.dependencies.map((dep) => (
                            <tr key={`${dep.name}@${dep.version}`}>
                              <td className="px-4 py-3 font-medium">
                                {dep.name}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {dep.version}
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant="outline">{dep.license}</Badge>
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {dep.transitive ? "Transitive" : "Direct"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="license">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Scale className="h-5 w-5 text-muted-foreground" />
                      License Analysis
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                        <CheckCircle2 className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="text-lg font-semibold">
                          {result.license.type} License
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {result.license.compatible
                            ? "Compatible with most projects"
                            : "May conflict with your project license"}
                        </p>
                      </div>
                    </div>
                    <p className="leading-7 text-muted-foreground">
                      {result.license.note}
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="cves" className="space-y-4">
                {(result.cves?.length ?? 0) === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                      No known CVEs or security advisories were found for this
                      version.
                    </CardContent>
                  </Card>
                ) : (
                  result.cves?.map((cve, index) => (
                    <Card key={index}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <ShieldAlert className="h-5 w-5 text-destructive" />
                            <CardTitle className="text-lg">{cve.id}</CardTitle>
                          </div>
                          {cve.severity && (
                            <Badge variant={severityVariant(cve.severity)}>
                              {cve.severity}
                            </Badge>
                          )}
                        </div>
                        <CardDescription>{cve.title}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-muted-foreground">
                          {cve.description}
                        </p>
                        {cve.fixedVersion && (
                          <p className="text-sm text-muted-foreground">
                            <span className="font-medium">Fixed in:</span>{" "}
                            {cve.fixedVersion}
                          </p>
                        )}
                        {cve.aliases.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {cve.aliases.map((alias) => (
                              <Badge key={alias} variant="outline">
                                {alias}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {cve.references.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">
                              References
                            </p>
                            <ul className="space-y-1">
                              {cve.references.slice(0, 5).map((ref, i) => (
                                <li key={i}>
                                  <a
                                    href={ref.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="break-all text-sm text-primary hover:underline"
                                  >
                                    {ref.url}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </TabsContent>
            </Tabs>
          </section>
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
