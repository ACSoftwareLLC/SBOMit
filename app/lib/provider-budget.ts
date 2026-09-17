import { AuditError } from "./errors";
import {
  getProviderLimit,
  getProviderUsage,
  recordProviderUsage,
  incrementCacheHits,
} from "./db";
import type { LlmInteraction } from "./llm";

export interface ProviderUsageMeta {
  cached: boolean;
  reportId: number;
  interactions: LlmInteraction[];
}

export async function checkProviderBudget(
  db: D1Database,
  providerId: string | undefined,
  tokensEstimate = 0,
): Promise<void> {
  if (!providerId) return;
  const limit = await getProviderLimit(db, providerId);
  if (limit?.daily_token_limit == null) return;
  const used = await getProviderUsage(db, providerId);
  if (used + tokensEstimate >= limit.daily_token_limit) {
    throw new AuditError(
      "RATE_LIMIT_EXCEEDED",
      `Provider daily token limit reached (${limit.daily_token_limit}).`,
      429,
    );
  }
}

export async function finalizeProviderUsage(
  db: D1Database,
  providerId: string | undefined,
  meta: ProviderUsageMeta,
): Promise<void> {
  if (meta.cached) {
    await incrementCacheHits(db, meta.reportId);
    return;
  }

  if (providerId && meta.interactions.length > 0) {
    const totalTokens = meta.interactions.reduce(
      (sum, i) => sum + (i.tokensInput ?? 0) + (i.tokensOutput ?? 0),
      0,
    );
    if (totalTokens > 0) {
      await recordProviderUsage(db, providerId, totalTokens);
    }
  }
}
