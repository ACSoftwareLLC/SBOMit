import {
  getEligibleReAuditTargets,
  listProviders,
  markTargetAudited,
} from "./db";
import { runAudit } from "./run-audit";
import { checkProviderBudget, finalizeProviderUsage } from "./provider-budget";
import {
  getAuditReportById,
  getPreviousAuditReport,
} from "./db";
import { auditResultSchema } from "./audit";
import { diffReports } from "./report-diff";
import { isDiffSignificant, notifyWatchersOfDiff } from "./notifications";

export interface ReAuditTickResult {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedReason?: "budget";
  details: Array<{
    source: string;
    name: string;
    status: "ok" | "error";
    error?: string;
    /** Set when post-audit notification generation failed (best-effort). */
    notifyError?: string;
  }>;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_AGE_HOURS = 24;

async function resolveProviderId(db: D1Database): Promise<string | undefined> {
  const providers = await listProviders(db);
  return providers.find((p) => p.is_default === 1)?.id ?? providers[0]?.id;
}

export async function runReAuditTick(
  db: D1Database,
  opts?: {
    limit?: number;
    minAgeHours?: number;
    providerId?: string;
  },
): Promise<ReAuditTickResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const minAgeHours = opts?.minAgeHours ?? DEFAULT_MIN_AGE_HOURS;
  const providerId = opts?.providerId ?? (await resolveProviderId(db));

  const targets = await getEligibleReAuditTargets(db, limit, minAgeHours);
  const result: ReAuditTickResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    details: [],
  };

  for (const target of targets) {
    try {
      await checkProviderBudget(db, providerId);
    } catch {
      result.stoppedReason = "budget";
      break;
    }

    result.attempted += 1;
    try {
      const run = await runAudit(
        {
          libraryUrl: target.url,
          skipCache: true,
          ...(providerId ? { providerId } : {}),
        },
        undefined,
        db,
      );
      await finalizeProviderUsage(db, providerId, {
        cached: run.meta.cached,
        reportId: run.meta.reportId,
        interactions: run.meta.interactions,
      });
      await markTargetAudited(db, target.source, target.name);
      // Best-effort notification generation (M4): a failure here must never
      // fail the target — the audit and its token spend already succeeded.
      let notifyError: string | undefined;
      try {
        const newReport = await getAuditReportById(db, run.meta.reportId);
        const previous = newReport
          ? await getPreviousAuditReport(
              db,
              target.name,
              target.source,
              newReport.created_at,
            )
          : null;
        if (previous && previous.id !== newReport?.id) {
          let diff;
          try {
            const previousResult = auditResultSchema.parse(
              JSON.parse(previous.result_json),
            );
            diff = diffReports(previousResult, run.result);
          } catch {
            // Corrupted previous report — skip notification rather than fail.
            diff = null;
          }
          if (diff && isDiffSignificant(diff)) {
            await notifyWatchersOfDiff(
              db,
              target,
              diff,
              run.meta.reportId,
              previous.id,
            );
          }
        }
      } catch (notifyErr) {
        notifyError =
          notifyErr instanceof Error
            ? notifyErr.message
            : String(notifyErr);
      }
      result.succeeded += 1;
      result.details.push({
        source: target.source,
        name: target.name,
        status: "ok",
        ...(notifyError !== undefined ? { notifyError } : {}),
      });
    } catch (err) {
      result.failed += 1;
      result.details.push({
        source: target.source,
        name: target.name,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
