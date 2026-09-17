import {
  getEligibleReAuditTargets,
  listProviders,
  markTargetAudited,
} from "./db";
import { runAudit } from "./run-audit";
import { checkProviderBudget, finalizeProviderUsage } from "./provider-budget";

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
      result.succeeded += 1;
      result.details.push({
        source: target.source,
        name: target.name,
        status: "ok",
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
