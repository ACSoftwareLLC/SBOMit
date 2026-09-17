"use client";

import { ArrowDown, ArrowUp, GitCompareArrows, Minus } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { severityVariant } from "@/app/lib/variants";
import type { ReportDiff } from "@/app/lib/report-diff";

function ScoreDeltaBadge({ delta }: { delta: number }) {
  if (delta > 0) {
    return (
      <Badge variant="success" className="gap-1">
        <ArrowUp className="h-3 w-3" />
        +{delta}
      </Badge>
    );
  }
  if (delta < 0) {
    return (
      <Badge variant="destructive" className="gap-1">
        <ArrowDown className="h-3 w-3" />
        {delta}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Minus className="h-3 w-3" />
      ±0
    </Badge>
  );
}

/**
 * "Since previous audit" comparison card. Renders above the report content.
 * Safe on all-empty diffs (renders nothing visible) and never throws on
 * empty arrays.
 */
export function ReportDiffCard({ diff }: { diff: ReportDiff }) {
  const {
    added,
    removed,
  } = diff.risks;
  const { newCves } = diff.advisories;

  const hasChanges =
    diff.scoreDelta !== 0 ||
    added.length > 0 ||
    removed.length > 0 ||
    diff.risks.severityChanged.length > 0 ||
    newCves.length > 0 ||
    diff.advisories.resolvedCves.length > 0 ||
    diff.licenseChanged ||
    diff.versionChanged;

  if (!hasChanges) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <GitCompareArrows className="h-5 w-5 text-muted-foreground" />
          Since previous audit
          <ScoreDeltaBadge delta={diff.scoreDelta} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {added.length > 0 && (
            <Badge variant="destructive">{added.length} new risks</Badge>
          )}
          {removed.length > 0 && (
            <Badge variant="success">{removed.length} resolved</Badge>
          )}
          {diff.risks.severityChanged.length > 0 && (
            <Badge variant="warning">
              {diff.risks.severityChanged.length} severity changed
            </Badge>
          )}
          {newCves.length > 0 && (
            <Badge variant="destructive">
              {newCves.length} new advisories
            </Badge>
          )}
          {diff.advisories.resolvedCves.length > 0 && (
            <Badge variant="success">
              {diff.advisories.resolvedCves.length} advisories resolved
            </Badge>
          )}
          {diff.licenseChanged && (
            <Badge variant="warning">License changed</Badge>
          )}
          {diff.versionChanged && <Badge variant="outline">New version</Badge>}
        </div>

        {added.length > 0 && (
          <details className="rounded-lg border border-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              Added risks ({added.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {added.map((risk) => (
                <li key={risk.title} className="flex items-start gap-2 text-sm">
                  <Badge variant={severityVariant(risk.severity)}>
                    {risk.severity}
                  </Badge>
                  <span>{risk.title}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {removed.length > 0 && (
          <details className="rounded-lg border border-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              Resolved risks ({removed.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {removed.map((risk) => (
                <li key={risk.title} className="flex items-start gap-2 text-sm">
                  <Badge variant={severityVariant(risk.severity)}>
                    {risk.severity}
                  </Badge>
                  <span>{risk.title}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {newCves.length > 0 && (
          <details className="rounded-lg border border-border px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              New advisories ({newCves.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {newCves.map((cve) => (
                <li key={cve.id} className="flex items-start gap-2 text-sm">
                  <Badge
                    variant={severityVariant(cve.severity ?? "unknown")}
                  >
                    {cve.severity ?? "unknown"}
                  </Badge>
                  <span>{cve.id}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
