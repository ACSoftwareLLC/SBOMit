import type { AuditResult, CveReport, Risk } from "./audit";

export interface ReportDiff {
  scoreDelta: number;
  risks: {
    added: Risk[];
    removed: Risk[];
    severityChanged: Array<{
      title: string;
      from: Risk["severity"];
      to: Risk["severity"];
    }>;
  };
  advisories: {
    newCves: CveReport[];
    resolvedCves: CveReport[];
  };
  licenseChanged: boolean;
  versionChanged: boolean;
}

/**
 * Pure structural comparison of two audit reports.
 *
 * Matching keys: risk `title` (the same dedupe key the competition judge
 * uses) and CVE `id`. No DB access, no clock, no randomness — deterministic
 * for any pair of inputs.
 */
export function diffReports(prev: AuditResult, next: AuditResult): ReportDiff {
  const prevRisks = new Map(prev.risks.map((r) => [r.title, r]));
  const nextRisks = new Map(next.risks.map((r) => [r.title, r]));

  const added: Risk[] = [];
  const removed: Risk[] = [];
  const severityChanged: ReportDiff["risks"]["severityChanged"] = [];

  for (const [title, nextRisk] of nextRisks) {
    const prevRisk = prevRisks.get(title);
    if (!prevRisk) {
      added.push(nextRisk);
    } else if (prevRisk.severity !== nextRisk.severity) {
      severityChanged.push({
        title,
        from: prevRisk.severity,
        to: nextRisk.severity,
      });
    }
  }
  for (const [title, prevRisk] of prevRisks) {
    if (!nextRisks.has(title)) {
      removed.push(prevRisk);
    }
  }

  const prevCves = new Set(prev.cves.map((c) => c.id));
  const nextCves = new Set(next.cves.map((c) => c.id));
  const newCves = next.cves.filter((c) => !prevCves.has(c.id));
  const resolvedCves = prev.cves.filter((c) => !nextCves.has(c.id));

  return {
    scoreDelta: next.score - prev.score,
    risks: { added, removed, severityChanged },
    advisories: { newCves, resolvedCves },
    licenseChanged: prev.license.type !== next.license.type,
    versionChanged: prev.version !== next.version,
  };
}
