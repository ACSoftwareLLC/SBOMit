# M4 Diff Notifications — Design Spec

**Status:** Draft for review
**Date:** 2026-09-17
**Implements:** TODO.md Milestone 4
**Branch:** `m4-diff-notifications` (forked from `m3-re-audit-scheduling`)

---

## 1. Goal

Close the loop M3 opened: watchlisted packages are re-audited on the cron
schedule and diffs are computed, but watchers must rediscover them manually.
M4 generates an in-app notification for each watcher when a re-audit of
their watched package produces a **significant** diff, surfaced through a
bell feed in the site header.

Out of scope (per brainstorm): email, webhooks, any external delivery.

## 2. Architecture

```text
worker cron (6h) ─► runReAuditTick (unchanged shape)
                       │ per target, on success:
                       │   previous = getPreviousAuditReport(name, source, before=now)
                       │   diff = diffReports(prev.result, new.result)
                       │   if isDiffSignificant(diff):
                       │     notifyWatchersOfDiff(db, target, diff, newReport)
                       │       ├─ DELETE unread re_audit_diff rows for this
                       │       │  target's watchers (collapse)          ┐ best-effort:
                       │       └─ INSERT one row per watcher            ┘ failures logged,
                       │                                                   never fail the audit
                       ▼
D1 notifications ─► GET /api/notifications ─► NotificationBell (site-header)
                    POST /api/notifications/read   mount + focus + 60s-visible
                                                 badge → dropdown → /report/[publicId]
```

Approved decisions:

- **In-app feed only.** D1-backed; works for every user; no external deps.
- **Generated in the cron tick.** No separate scheduling pass; the tick
  self-contains the feature.
- **Collapse unread.** Before inserting, `notifyWatchersOfDiff` deletes each
  watcher's unread `re_audit_diff` rows for the same target — one feed line
  per package, always pointing at the newest report pair.
- **Best-effort generation.** Notification logic runs in the tick's per-target
  success path but any D1 failure is caught and logged
  (`details[].notifyError`); it never marks the target failed (the audit and
  its token spend already succeeded).
- **60s + focus badge.** Fetch unread count on mount, on
  `visibilitychange`/focus, and a 60s interval that pauses while hidden.

## 3. Data Model

### Migration `migrations/0015_notifications.sql`

```sql
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 're_audit_diff',
  target_source TEXT NOT NULL,
  target_name TEXT NOT NULL,
  report_id INTEGER NOT NULL,
  previous_report_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_target
  ON notifications(target_source, target_name, user_id, read);
```

- `target_source` + `target_name` use the watchlist key (the collapse DELETE
  needs no joins).
- `report_id`/`previous_report_id` are numeric `audit_reports.id`, NOT
  FK-constrained: users can delete reports; the feed then renders the row
  without a live link (body text still tells the story).
- Title/body are stored denormalized (feed renders without re-deriving
  diffs). Title = `"{target_name}: {summary chip}"`
  (e.g. `lodash: score dropped 14 points`, `lodash: 2 new advisories`);
  body lists the significant entries (new critical/high risk titles, new
  CVE ids, score delta).

## 4. Significance Gate (`app/lib/notifications.ts`)

```ts
export interface DiffSignificanceThresholds {
  minScoreDrop: number;                    // default 10
  riskSeverities: Risk["severity"][];      // default ["critical", "high"]
}

export function isDiffSignificant(
  diff: ReportDiff,
  t?: Partial<DiffSignificanceThresholds>,
): boolean;
// true when: any risks.added entry with severity in riskSeverities,
//            OR any advisories.newCves entry,
//            OR scoreDelta <= -minScoreDrop
```

Pure function; thresholds are constants overridable per call (tests) but
not env-configurable in v1.

### Fan-out

```ts
export async function notifyWatchersOfDiff(
  db: D1Database,
  target: { source: string; name: string },
  diff: ReportDiff,
  reportId: number,
  previousReportId: number,
): Promise<void>;
```

For each user with a `watchlist` row for the target: DELETE their unread
same-target `re_audit_diff` rows, then INSERT one new row. Throws on D1
errors — the CALLER (tick) wraps it.

## 5. Tick Integration (only change to `app/lib/re-audit.ts`)

After `markTargetAudited`, in the success path:

1. `previous = getPreviousAuditReport(db, name, source, before = new report's created_at)`
2. Parse + `diffReports` (same chain the API routes use; corrupted previous
   → treat as insignificant, skip)
3. `if (isDiffSignificant(diff))` → `notifyWatchersOfDiff(...)` inside its
   own try/catch → `details.push({ ..., notifyError })` on failure

`ReAuditTickResult.details[]` gains optional `notifyError?: string`.
Interactive audits (`/api/audit`) are untouched — notifications are
exclusively a re-audit artifact.

## 6. API

| Method + Path | Input | Returns |
| --- | --- | --- |
| `GET /api/notifications` | `?unread=1` `?limit=` (default 20, max 100) `?offset=` | `{ items, unreadCount, nextOffset? }` |
| `POST /api/notifications/read` | `{ ids?: number[] }` | `{ updated: number }` — ids scoped to caller; omitted → mark all |

- Auth required on both; `user_id` scoping everywhere (ownership implicit).
- `NotificationItem = { id, type, title, body, read, createdAt,
  reportPublicId | null, previousReportPublicId | null }` — public ids
  resolved at read time by joining `report_id`/`previous_report_id` against
  `audit_reports`; deleted reports yield `null`.
- `nextOffset` present only when more rows exist.

## 7. UI (`app/components/notification-bell.tsx`)

Rendered in `site-header.tsx` for logged-in users only:

- Bell icon + unread-count badge (hidden when 0).
- Dropdown: latest items (title, relative time, unread dot), "Mark all
  read", item click → mark that id read + navigate to
  `/report/[reportPublicId]` (skipped when null).
- Polling: mount + `visibilitychange`/focus + 60s interval paused while
  `document.hidden`.
- Follows the header's existing dropdown pattern (click-outside ref guard,
  `lucide-react` icons — `Bell`).

## 8. Testing

| Test | Covers |
| --- | --- |
| `app/lib/notifications.test.ts` | `isDiffSignificant` boundaries (score -10 in/out, medium-only risks, new CVE, severity list override); fan-out N watchers → N rows; collapse deletes only unread same-target rows for the SAME user; read rows survive; other targets untouched; title/body shape |
| `app/lib/re-audit.test.ts` (extend) | tick calls notify only on significant diff; notify failure → target still `ok` with `notifyError`; corrupted previous → no notify |
| `app/api/notifications/route.test.ts` | auth required; unread filter; pagination + nextOffset; mark-one (ownership: other user's id untouched); mark-all; deleted-report → null public ids |
| `e2e/notifications.spec.ts` | bell renders (no badge) when empty; badge shows count after seeding via API; dropdown lists item; click marks read + navigates |

## 9. Rollout Notes

- Migration `0015` is additive.
- The tick change is behavior-additive: `details[]` shape only grows.
- Deploy consideration: notifications begin generating on the first cron
  tick after deploy; the admin re-audit endpoint can trigger one
  immediately for verification (same pre-deploy smoke pattern as M3).
- Deferred follow-ups (non-blocking): per-user notification preferences,
  digest batching, `created_at`-based retention pruning (old read rows).

## 10. Out of Scope

- Email / webhook delivery
- Per-user thresholds or channel preferences
- Real-time push (SSE/WS)
- Notification retention/GC jobs
- Non-re-audit notification types (the `type` column exists for them)
