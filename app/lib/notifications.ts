import type { ReportDiff } from "./report-diff";
import type { Risk } from "./audit";
import {
  insertNotifications,
  deleteUnreadForTarget,
} from "./db/notifications";
import { listWatchersForTarget } from "./db/watchlist";

export interface DiffSignificanceThresholds {
  minScoreDrop: number;
  riskSeverities: Risk["severity"][];
}

export const DEFAULT_DIFF_THRESHOLDS: DiffSignificanceThresholds = {
  minScoreDrop: 10,
  riskSeverities: ["critical", "high"],
};

/**
 * A diff is significant when it carries any signal a watcher would act on:
 * a score drop of at least minScoreDrop points, any new advisory, or any
 * newly added risk at one of the watched severities.
 */
export function isDiffSignificant(
  diff: ReportDiff,
  t?: Partial<DiffSignificanceThresholds>,
): boolean {
  const minScoreDrop =
    t?.minScoreDrop ?? DEFAULT_DIFF_THRESHOLDS.minScoreDrop;
  const severities =
    t?.riskSeverities ?? DEFAULT_DIFF_THRESHOLDS.riskSeverities;
  if (diff.scoreDelta <= -minScoreDrop) return true;
  if (diff.advisories.newCves.length > 0) return true;
  return diff.risks.added.some((r) => severities.includes(r.severity));
}

/**
 * Build the stored title/body pair for a notification. The title chip picks
 * the most severe signal: new critical risks > new advisory count > score
 * drop. The body enumerates the significant entries.
 */
export function buildDiffMessages(
  target: { source: string; name: string },
  diff: ReportDiff,
): { title: string; body: string } {
  const newCritical = diff.risks.added.filter(
    (r) => r.severity === "critical",
  );
  const newHigh = diff.risks.added.filter((r) => r.severity === "high");
  const newCveCount = diff.advisories.newCves.length;

  let chip: string;
  if (newCritical.length > 0) {
    chip = `${newCritical.length} new critical risk${
      newCritical.length === 1 ? "" : "s"
    }`;
  } else if (newCveCount > 0) {
    chip = `${newCveCount} new ${newCveCount === 1 ? "advisory" : "advisories"}`;
  } else if (diff.scoreDelta < 0) {
    chip = `score dropped ${Math.abs(diff.scoreDelta)} points`;
  } else {
    chip = "new high risks";
  }

  const title = `${target.name}: ${chip}`;

  const parts: string[] = [];
  for (const r of newCritical) parts.push(`New critical risk: ${r.title}`);
  for (const r of newHigh) parts.push(`New high risk: ${r.title}`);
  if (newCveCount > 0) {
    parts.push(
      `New advisories: ${diff.advisories.newCves.map((c) => c.id).join(", ")}`,
    );
  }
  if (diff.scoreDelta < 0) {
    parts.push(`Score dropped ${Math.abs(diff.scoreDelta)} points`);
  }
  return { title, body: parts.join(". ") };
}

/**
 * Notify every watcher of a target that a significant diff exists.
 *
 * Collapse semantics: each watcher's UNREAD notifications for this same
 * target are deleted before inserting the new row, so the feed holds one
 * line per package pointing at the newest report pair. Read rows survive.
 *
 * Throws on D1 errors — callers (the re-audit tick) wrap this best-effort.
 */
export async function notifyWatchersOfDiff(
  db: D1Database,
  target: { source: string; name: string },
  diff: ReportDiff,
  reportId: number,
  previousReportId: number,
): Promise<void> {
  const watchers = await listWatchersForTarget(db, target.source, target.name);
  if (watchers.length === 0) return;

  const { title, body } = buildDiffMessages(target, diff);
  for (const watcher of watchers) {
    await deleteUnreadForTarget(db, watcher.user_id, target.source, target.name);
  }
  await insertNotifications(
    db,
    watchers.map((w) => ({
      user_id: w.user_id,
      type: "re_audit_diff",
      target_source: target.source,
      target_name: target.name,
      report_id: reportId,
      previous_report_id: previousReportId,
      title,
      body,
    })),
  );
}
