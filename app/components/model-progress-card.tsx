"use client";

import { type ElementType } from "react";
import {
  Bot,
  Scale,
  CheckCircle2,
  Loader2,
  Search,
  Database,
  MessageSquare,
  Zap,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import type { AuditStep } from "@/app/lib/run-audit";
import type { ProviderConfig } from "@/app/lib/providers";
import type { CompetitionModelProgress } from "@/app/components/audit-jobs";

type ProgressStep = {
  step: string;
  label: string;
  detail?: string;
};

const competitionModelSteps: ProgressStep[] = [
  {
    step: "investigate",
    label: "Investigate",
    detail: "Pinpoint files and patterns worth scrutinizing.",
  },
  {
    step: "deep-dive",
    label: "Deep-dive",
    detail: "Analyze selected files and produce a structured report.",
  },
];

export function providerLabelFromId(
  configs: ProviderConfig[],
  providerId?: string,
): string {
  if (!providerId) return "unknown";
  const config = configs.find((c) => c.id === providerId);
  return config?.name ?? providerId;
}

export const pipelineSteps: {
  step: AuditStep;
  icon: ElementType;
  label: string;
  detail: string;
}[] = [
  {
    step: "resolve",
    icon: Search,
    label: "Resolving package metadata",
    detail: "Fetching package data from the npm registry or GitHub API.",
  },
  {
    step: "download",
    icon: Database,
    label: "Fetching source code",
    detail: "Downloading and unpacking the package tarball for code inspection.",
  },
  {
    step: "investigate",
    icon: MessageSquare,
    label: "Identifying investigation areas",
    detail: "First AI pass: pinpoint the files and patterns worth scrutinizing.",
  },
  {
    step: "deep-dive",
    icon: Zap,
    label: "Deep-diving into code",
    detail: "Second AI pass: analyze the selected files and produce a structured report.",
  },
  {
    step: "judge",
    icon: Scale,
    label: "Judge merging findings",
    detail: "Third AI pass: compare both audits, remove duplicates, and combine unique findings.",
  },
  {
    step: "validate",
    icon: CheckCircle2,
    label: "Validating the result",
    detail: "Parsing, clamping, and cross-checking the structured output.",
  },
  {
    step: "persist",
    icon: Database,
    label: "Saving the report",
    detail: "Persisting the audit to D1 so it appears in your audit history.",
  },
];

export function ModelProgressCard({
  label,
  provider,
  model,
  progress,
  isJudge,
  steps = competitionModelSteps,
}: {
  label: string;
  provider?: string;
  model?: string;
  progress?: CompetitionModelProgress;
  isJudge?: boolean;
  steps?: ProgressStep[];
}) {
  const currentStep = progress?.currentStep;
  const completedSteps = progress?.completedSteps ?? [];

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4",
        isJudge && "border-primary/30 bg-primary/5",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg",
            isJudge
              ? "bg-primary text-primary-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {isJudge ? (
            <Scale className="h-4 w-4" />
          ) : (
            <Bot className="h-4 w-4" />
          )}
        </div>
        <div>
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs text-muted-foreground">
            {provider ? `${provider} · ` : ""}
            {model ?? "default"}
          </p>
        </div>
      </div>
      <ol className="space-y-2">
        {steps.map((s) => {
          const isCompleted = completedSteps.includes(s.step);
          const isActive = currentStep === s.step;
          return (
            <li key={s.step} className="flex items-center gap-2">
              <div
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs",
                  isCompleted
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : isActive ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                )}
              </div>
              <span
                className={cn(
                  "text-xs",
                  isCompleted || isActive
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
