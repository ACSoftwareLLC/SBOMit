# M3 Re-Audit Scheduling — Design Spec

**Status:** Draft for review
**Date:** 2026-09-16
**Implements:** TODO.md Milestone 3; closes AUDIT-PLAN.md §7.3 (re-audit scheduling, v2)
**Branch:** `m3-re-audit-scheduling`

---

## 1. Goal

Re-run audits for watchlisted packages on a schedule and surface what changed
since the previous report. Users watch a package; a Cloudflare Cron Trigger
re-audits each distinct watched target at most once per `minAgeHours`;
consecutive reports are compared and the diff is rendered on the report page.

## 2. Architecture

```
Cron (every 6h) ──► worker scheduled() ──► runReAuditTick (app/lib/re-audit.ts)
                                              │ 1. SELECT eligible targets
                                              │    (distinct source+name, last re-audit > minAgeHours)
                                              │ 2. for each: checkProviderBudget()
                                              │ 3. runAudit({ skipCache: true, providerId })
                                              │ 4. upsert watchlist_targets.last_audited_at
                                              ▼
D1: audit_reports (new row, cache_key NULL) ◄─ saveAuditReport
                                              ▼
GET /api/reports/[id]?diff=1 ──► diffReports(prev, next) ──► ReportDiffCard UI
```

Key decisions (approved in brainstorm):

- **Per-user watchlist + target dedupe.** `watchlist` rows are per-user; the
  cron runner re-audits each distinct `source+name` once per tick regardless
  of how many users watch it. A `watchlist_targets` bookkeeping table holds
  scheduling state.
- **Diff computed on read.** `diffReports(prev, next)` is a pure function of
  two stored `AuditResult`s. No diff storage; works retroactively across
  existing reports. A stored-diff table can be added later if notifications
  land (explicitly out of scope).
- **Cron + admin trigger.** The scheduled handler is the production trigger;
  `POST /api/admin/re-audit` (admin session required) runs the identical
  tick function for manual runs and testability.
- **Runner is plain library code.** `app/lib/re-audit.ts` takes `db`
  explicitly (mirroring `runAudit`) so the raw-Worker `scheduled()` handler,
  the admin endpoint, and vitest can all call it. Route handlers are not
  callable from Workers' scheduled context.

### Worker integration (custom worker pattern)

Per <https://opennext.js.org/cloudflare/howtos/custom-worker> — the generated
`.open-next/worker.js` exports only `fetch`, so a custom entry wraps it:

```ts
// worker.ts (repo root)
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runReAuditTick(env.DB, {
        limit: Number(env.RE_AUDIT_MAX_PER_TICK) || 5,
      }),
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
```

`wrangler.jsonc` changes: `"main": "./worker.ts"`, add
`"triggers": { "crons": ["0 */6 * * *"] }`. The DO re-export noted in the
how-to is NOT needed (no DO Queue / Tag Cache in use). Local test path:
`wrangler dev --test-scheduled` →
`curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"`.

## 3. Data Model

### Migration `migrations/0014_watchlist.sql`

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,             -- 'npm' | 'github'
  name TEXT NOT NULL,               -- package name or owner/repo
  url TEXT NOT NULL,                -- canonical input URL
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, name)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_target ON watchlist(source, name);

CREATE TABLE IF NOT EXISTS watchlist_targets (
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  last_audited_at TEXT,             -- ISO timestamp of last re-audit
  PRIMARY KEY (source, name)
);
```

- Deleting a watch entry never loses history — reports live in
  `audit_reports` keyed to `package_audits`.
- Eligibility: target has ≥1 watchlist row AND (`last_audited_at` IS NULL OR
  older than `minAgeHours`, default 24).

## 4. API Surface

All watchlist endpoints require an authenticated session; users may only
read/mutate their own rows. The admin endpoint requires an admin session.

| Method + Path            | Body / Query                          | Returns |
| ------------------------ | ------------------------------------- | ------- |
| `GET /api/watchlist`     | —                                     | `{ items: WatchlistItem[] }` — joined with latest report score per target |
| `POST /api/watchlist`    | `{ libraryUrl: string }`              | `{ item }` — URL validated/normalized via the same npm/GitHub resolvers the audit route uses; duplicate → 409 |
| `DELETE /api/watchlist`  | `{ libraryUrl }` or `{ id }`          | `{ ok: true }` — ownership enforced |
| `POST /api/admin/re-audit` | `{ limit?: number }` (default 5, max 20) | `{ attempted, succeeded, failed, details[] }` |

## 5. Runner (`app/lib/re-audit.ts`)

```ts
export async function runReAuditTick(
  db: D1Database,
  opts?: {
    limit?: number;        // max targets per tick, default 5
    minAgeHours?: number;  // default 24
    providerId?: string;   // default: providers.is_default row, else env fallback
  },
): Promise<ReAuditTickResult>;
```

Per target:

1. `checkProviderBudget(db, providerId, estimate)` — if the provider daily
   token budget is exhausted (`RATE_LIMIT_EXCEEDED`), the **tick stops**
   (scheduled work must not starve; next tick retries remaining targets).
2. `runAudit({ libraryUrl, skipCache: true, providerId })` — reuses the full
   pipeline (resolve → enrich → LLM → validate → persist).
3. `finalizeProviderUsage(db, providerId, meta)` — record token spend.
4. Upsert `watchlist_targets.last_audited_at = now` (even on success-only;
   failed targets are NOT marked, so they retry next tick).

Per-target failures are caught and recorded in `ReAuditTickResult.details`;
one bad package cannot kill the tick.

### `skipCache` semantics (the one backward-compat-sensitive edit)

`RunAuditInput` gains `skipCache?: boolean`. When `true`:

- Bypass the `getCachedAuditReport` lookup entirely.
- Persist with `cacheKey = null` — the re-audit row is a historical record,
  never a cache entry. This avoids the UNIQUE `cache_key` collision that a
  re-audit of an unchanged package+prompt+model would otherwise hit, and
  prevents re-audit rows from shadowing the interactive-audit cache.

Interactive audits (`skipCache` unset) behave exactly as today.

### Cron fan-out bound

Workers' scheduled handlers allow generous wall-clock but bounded CPU; 5
sequential audits × ~30–60s each fits the 6h window with margin. Override
with `RE_AUDIT_MAX_PER_TICK` env var. The runner processes targets
sequentially (not in parallel) to keep budget accounting deterministic.

## 6. Diff Logic (`app/lib/report-diff.ts`)

```ts
export interface ReportDiff {
  scoreDelta: number;                      // next.score - prev.score
  risks: {
    added: Risk[];                         // title present in next, not prev
    removed: Risk[];                       // title present in prev, not next
    severityChanged: Array<{
      title: string;
      from: Risk["severity"];
      to: Risk["severity"];
    }>;
  };
  advisories: {
    newCves: CveReport[];                  // id in next, not prev
    resolvedCves: CveReport[];             // id in prev, not next
  };
  licenseChanged: boolean;                 // license.type differs
  versionChanged: boolean;
}

export function diffReports(prev: AuditResult, next: AuditResult): ReportDiff;
```

Matching keys: risk `title` (the same dedupe key the competition judge
uses), CVE `id`. Pure and deterministic.

### Previous-report lookup

`GET /api/reports/[id]` gains an optional `?diff=1` query param. When set:

1. Load the report's `package_audits` row (`name`, `source`).
2. Find the newest report with the same `name` + `source`, `prompt` IS NULL
   (same default prompt family), `created_at` earlier than this report's.
3. Response gains `{ diff: ReportDiff | null, previousReportId: number | null }`
   — `null` when this is the first audit.

## 7. UI

- `app/report/[id]/page.tsx` — when `diff` is present, render a
  `ReportDiffCard` (`app/components/report-diff-card.tsx`) above the report:
  score-delta badge (colored by direction), "N new risks / N resolved" and
  "M new advisories" summary chips, expandable lists for added/removed risks
  and new CVEs.
- `app/audits/page.tsx` — history table gains a "Watch" star-toggle column
  (`POST`/`DELETE /api/watchlist` behind it); toggling reflects immediately
  from the local `GET /api/watchlist` state.
- No other new pages — watchlist management is just the toggle (scope guard).

## 8. Testing

| Test file | Covers |
| --------------------------------- | ------ |
| `app/lib/report-diff.test.ts` | identical reports → zero delta; added/removed/severity-changed risks; new/resolved CVEs; license/version change |
| `app/lib/re-audit.test.ts` | eligibility (age filter, dedupe across watchers); budget-exceeded stops tick; per-target failure isolation; `last_audited_at` upsert; failed targets not marked |
| `app/api/watchlist/route.test.ts` | auth required; ownership; duplicate → 409; malformed URL → 422 |
| extend `app/lib/run-audit.test.ts` | `skipCache` bypasses cache lookup; persisted row `cache_key` IS NULL |
| `e2e/` | authenticated user sees watch toggle on audits page |

## 9. Out of Scope

- Notifications (email/webhook) on diff
- Persisted diff storage (`audit_report_diffs`)
- Per-watcher re-audits (dedupe is global per target)
- Watchlist management UI beyond the audits-page toggle
- Re-audit of pinned historical versions (targets track `latest`; version is
  resolved fresh each run)

## 10. Rollout Notes

- Migration `0014` is additive; no existing-table changes.
- `worker.ts` + `wrangler.jsonc` main switch must deploy together.
- The cron trigger activates on deploy; the admin endpoint allows immediate
  verification before waiting on the schedule.
- If budget exhaustion repeatedly stops ticks, tune `RE_AUDIT_MAX_PER_TICK`
  down or raise provider daily limits (admin settings).
