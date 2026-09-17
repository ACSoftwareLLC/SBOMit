import { describe, it, expect } from "vitest";
import { diffReports, type ReportDiff } from "./report-diff";
import type { AuditResult, CveReport, Risk } from "./audit";

function risk(title: string, severity: Risk["severity"]): Risk {
  return { severity, title, description: `${title} description` };
}

function cve(id: string): CveReport {
  return {
    id,
    aliases: [],
    severity: "high",
    title: `${id} title`,
    description: `${id} description`,
    published: null,
    modified: null,
    fixedVersion: null,
    references: [],
  };
}

function makeResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    name: "pkg",
    version: "1.0.0",
    score: 80,
    summary: "Fine overall.",
    risks: [],
    investigationAreas: [],
    deepDiveFindings: [],
    dependencies: [],
    license: { type: "MIT", compatible: true, note: "" },
    maintainers: [],
    lastPublished: "2026-01-01",
    weeklyDownloads: "1000",
    cves: [],
    ...overrides,
  };
}

describe("diffReports", () => {
  it("returns a zero delta for identical reports", () => {
    const a = makeResult();
    const b = makeResult({ score: 80 });
    const diff = diffReports(a, b);
    expect(diff.scoreDelta).toBe(0);
    expect(diff.risks.added).toEqual([]);
    expect(diff.risks.removed).toEqual([]);
    expect(diff.risks.severityChanged).toEqual([]);
    expect(diff.advisories.newCves).toEqual([]);
    expect(diff.advisories.resolvedCves).toEqual([]);
    expect(diff.licenseChanged).toBe(false);
    expect(diff.versionChanged).toBe(false);
  });

  it("computes the score delta with sign", () => {
    const diff = diffReports(makeResult({ score: 75 }), makeResult({ score: 88 }));
    expect(diff.scoreDelta).toBe(13);
    expect(diffReports(makeResult({ score: 90 }), makeResult({ score: 60 })).scoreDelta).toBe(-30);
  });

  it("reports added and removed risks by title", () => {
    const prev = makeResult({
      risks: [risk("Stale dependency", "medium"), risk("Low bus factor", "low")],
    });
    const next = makeResult({
      risks: [risk("Stale dependency", "medium"), risk("Prototype pollution", "high")],
    });
    const diff = diffReports(prev, next);
    expect(diff.risks.added.map((r) => r.title)).toEqual(["Prototype pollution"]);
    expect(diff.risks.removed.map((r) => r.title)).toEqual(["Low bus factor"]);
  });

  it("reports severity changes for matching titles", () => {
    const prev = makeResult({ risks: [risk("Risky thing", "low")] });
    const next = makeResult({ risks: [risk("Risky thing", "critical")] });
    const diff = diffReports(prev, next);
    expect(diff.risks.severityChanged).toEqual([
      { title: "Risky thing", from: "low", to: "critical" },
    ]);
  });

  it("keeps severity-unchanged risks out of severityChanged", () => {
    const prev = makeResult({ risks: [risk("Same", "medium")] });
    const next = makeResult({ risks: [risk("Same", "medium")] });
    expect(diffReports(prev, next).risks.severityChanged).toEqual([]);
  });

  it("reports new and resolved CVEs by id", () => {
    const prev = makeResult({ cves: [cve("CVE-2024-1111"), cve("CVE-2024-2222")] });
    const next = makeResult({ cves: [cve("CVE-2024-2222"), cve("CVE-2025-3333")] });
    const diff = diffReports(prev, next);
    expect(diff.advisories.newCves.map((c) => c.id)).toEqual(["CVE-2025-3333"]);
    expect(diff.advisories.resolvedCves.map((c) => c.id)).toEqual(["CVE-2024-1111"]);
  });

  it("flags license and version changes", () => {
    const prev = makeResult();
    const next = makeResult({
      version: "2.0.0",
      license: { type: "GPL-3.0", compatible: false, note: "Strong copyleft." },
    });
    const diff = diffReports(prev, next);
    expect(diff.licenseChanged).toBe(true);
    expect(diff.versionChanged).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const prev = makeResult({ risks: [risk("A", "low")], cves: [cve("CVE-1")] });
    const next = makeResult({ risks: [risk("B", "high")], cves: [cve("CVE-2")] });
    const prevSnapshot = JSON.stringify(prev);
    const nextSnapshot = JSON.stringify(next);
    const diff: ReportDiff = diffReports(prev, next);
    expect(diff.risks.added).toHaveLength(1);
    expect(JSON.stringify(prev)).toBe(prevSnapshot);
    expect(JSON.stringify(next)).toBe(nextSnapshot);
  });
});
