"use client";

import { Loader2, CheckCircle2, Ban } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import {
  ElapsedTime,
  Countdown,
  displayUrlLabel,
  type AuditJob,
} from "@/app/components/audit-jobs";
import {
  ModelProgressCard,
  pipelineSteps,
  providerLabelFromId,
} from "@/app/components/model-progress-card";
import type { ProviderConfig } from "@/app/lib/providers";

export function AuditProgress({
  job,
  configs,
  onCancel,
}: {
  job: AuditJob;
  configs: ProviderConfig[];
  onCancel: () => void;
}) {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6 lg:px-8">
      <Card className="mx-auto max-w-3xl">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
              <div>
                <CardTitle className="text-xl">
                  Auditing {displayUrlLabel(job.libraryUrl)}
                </CardTitle>
                <CardDescription>
                  {job.source === "npm" ? "npm package" : "GitHub repository"} ·
                  started {new Date(job.startedAt).toLocaleTimeString()} ·
                  elapsed{" "}
                  <ElapsedTime since={job.startedAt} className="tabular-nums" />
                </CardDescription>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Badge variant="secondary">{job.source}</Badge>
              {job.competitionMode && (
                <Badge variant="outline" className="text-xs">
                  Competition mode
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {job.prompt && (
            <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <span className="font-medium">Custom prompt: </span>
              <span className="text-muted-foreground">{job.prompt}</span>
            </div>
          )}
          {job.model && !job.competitionMode && (
            <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <span className="font-medium">Model: </span>
              <span className="text-muted-foreground">
                {job.model.providerId ?? job.model.provider}/{job.model.model}
              </span>
            </div>
          )}
          {job.competitionMode && (
            <div className="rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <span className="font-medium">Competition mode: </span>
              <span className="text-muted-foreground">
                {job.competitionMode.modelA.providerId ??
                  job.competitionMode.modelA.provider}
                /{job.competitionMode.modelA.model} vs{" "}
                {job.competitionMode.modelB.providerId ??
                  job.competitionMode.modelB.provider}
                /{job.competitionMode.modelB.model}, merged by{" "}
                {job.competitionMode.mergeModel.providerId ??
                  job.competitionMode.mergeModel.provider}
                /{job.competitionMode.mergeModel.model}
              </span>
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">
                What&apos;s happening during this audit
              </p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {job.tokensPerSecond !== undefined &&
                  job.tokensPerSecond > 0 && (
                    <span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">
                      {job.tokensPerSecond.toLocaleString()} tok/s
                    </span>
                  )}
                {(job.tokensInput ?? 0) + (job.tokensOutput ?? 0) > 0 && (
                  <span className="rounded-full bg-muted px-2 py-1">
                    {(
                      (job.tokensInput ?? 0) + (job.tokensOutput ?? 0)
                    ).toLocaleString()}{" "}
                    tokens
                  </span>
                )}
                {job.estimatedFinishAt !== undefined && (
                  <span className="rounded-full bg-muted px-2 py-1">
                    ETA{" "}
                    <Countdown
                      to={job.estimatedFinishAt}
                      className="tabular-nums"
                    />
                  </span>
                )}
              </div>
            </div>

            {job.competitionMode ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <ModelProgressCard
                    label="Model A"
                    provider={providerLabelFromId(
                      configs,
                      job.competitionMode.modelA.providerId,
                    )}
                    model={job.competitionMode.modelA.model}
                    progress={job.modelAProgress}
                  />
                  <ModelProgressCard
                    label="Model B"
                    provider={providerLabelFromId(
                      configs,
                      job.competitionMode.modelB.providerId,
                    )}
                    model={job.competitionMode.modelB.model}
                    progress={job.modelBProgress}
                  />
                </div>
                <div className="mx-auto max-w-sm">
                  <ModelProgressCard
                    label="Judge"
                    provider={providerLabelFromId(
                      configs,
                      job.competitionMode.mergeModel.providerId,
                    )}
                    model={job.competitionMode.mergeModel.model}
                    progress={{
                      currentStep:
                        job.currentStep === "judge" ? "judge" : undefined,
                      completedSteps: job.completedSteps?.includes("judge")
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
                    job.downloadDetail === "metadata only";
                  const isRelevant =
                    !isMetadataOnlyAudit || step.step !== "deep-dive";
                  if (!isRelevant) return null;

                  const stepMatchesCurrent =
                    job.currentStep === step.step ||
                    (step.step === "investigate" &&
                      job.currentStep === "metadata-only");
                  const stepMatchesCompleted =
                    job.completedSteps?.includes(step.step) ?? false;
                  const metadataOnlyCompleted =
                    step.step === "investigate" &&
                    job.completedSteps?.includes("metadata-only");
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
                            job.downloadDetail &&
                            ` · ${job.downloadDetail}`}
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
              Most audits finish in up to 5 minutes. You can leave this page —
              the audit keeps running and is tracked on the Audits page.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              className="shrink-0"
            >
              <Ban className="mr-2 h-4 w-4" />
              Cancel audit
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
