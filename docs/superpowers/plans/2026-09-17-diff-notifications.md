# M4 Diff Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app notifications for watchers when a re-audit diff is significant — generated in the cron tick, served via API, surfaced as a bell feed.

**Architecture:** `notifications` table → `notifyWatchersOfDiff` (collapse-unread fan-out) called in-tick behind `isDiffSignificant` → `GET/POST /api/notifications` → `NotificationBell` in the site header (60s+focus polling).

**Tech Stack:** Next.js 16 App Router, Cloudflare Workers D1, OpenNext custom worker (M3), vitest (workers pool), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-diff-notifications-design.md`

## Global Constraints

- D1 access only through `app/lib/db` helpers (new notification queries in `app/lib/db/notifications.ts`, barrel-exported).
- API input via Zod; errors via `AuditError` + `withErrorHandling`; auth via `requireAuth`.
- Migrations `NNNN_snake_case.sql`; `0015` is next.
- Notification generation is best-effort: a notify failure NEVER marks a tick target failed; it lands in `details[].notifyError`.
- Interactive audits (`/api/audit`) untouched.
- Test isolation follows the repo pattern (`reset()` + schema recreation — see `app/lib/re-audit.test.ts`).
- All commits: lint + `tsc --noEmit` + `npm run test` green.

---

### Task 1: Migration + DB helpers

**Files:**

- Create: `migrations/0015_notifications.sql`
- Create: `app/lib/db/notifications.ts`
- Modify: `app/lib/db/index.ts` (add `export * from "./notifications";`)
- Test: `app/lib/db/notifications.test.ts`

**Interfaces:**

- Consumes: `users`, `watchlist` tables; `ReportDiff` from `@/app/lib/report-diff` (type-only).
- Produces:
  - `export interface StoredNotification { id: number; user_id: number; type: string; target_source: string; target_name: string; report_id: number; previous_report_id: number; title: string; body: string; read: number; created_at: string; }`
  - `export interface NotificationItem { id: number; type: string; title: string; body: string; read: boolean; createdAt: string; reportPublicId: string | null; previousReportPublicId: string | null; }`
  - `export async function insertNotifications(db, rows: Array<Omit<StoredNotification, "id" | "created_at" | "read">>): Promise<void>` — batched insert.
  - `export async function deleteUnreadForTarget(db, userId: number, source: string, name: string): Promise<void>` — the collapse DELETE.
  - `export async function listNotifications(db, userId: number, opts: { unreadOnly?: boolean; limit: number; offset: number }): Promise<{ items: NotificationItem[]; unreadCount: number; nextOffset: number | null }>` — LEFT JOINs `audit_reports` twice for public ids (null when deleted).
  - `export async function markNotificationsRead(db, userId: number, ids?: number[]): Promise<number>` — returns updated count; ids scoped to caller; omitted → all.

- [ ] **Step 1: Write the migration** (exact SQL from spec §3)

```sql
-- migrations/0015_notifications.sql
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

Apply: `npx wrangler d1 migrations apply sbomit-deps --local`. Commit.

- [ ] **Step 2: Write failing tests** (`app/lib/db/notifications.test.ts`) covering: insert + list roundtrip; unreadOnly filter; pagination + nextOffset (seed 25, limit 10 → nextOffset 10, final page → null); unreadCount accuracy; mark-one scoped to caller (other user's id with same numeric value untouched — use two users); mark-all; deleted-report → reportPublicId null (delete the audit row, keep notification); collapse DELETE removes only unread same-target rows (read rows + other targets + other users survive). Verify failure.

- [ ] **Step 3: Implement `app/lib/db/notifications.ts`** — plain D1 helpers per the interfaces above; `listNotifications` builds `NotificationItem` from the LEFT JOIN result (COALESCE public ids to null). Add barrel export. Verify tests pass; full `npm run test`.

- [ ] **Step 4: Commit** — "feat(m4): notifications table and db helpers"

---

### Task 2: Significance gate + fan-out

**Files:**

- Create: `app/lib/notifications.ts`
- Test: `app/lib/notifications.test.ts`

**Interfaces:**

- Consumes: `ReportDiff` (from `./report-diff`), `Risk["severity"]` (from `./audit`), Task 1's `insertNotifications`/`deleteUnreadForTarget`, `watchlist` table for watcher lookup.
- Produces:
  - `export interface DiffSignificanceThresholds { minScoreDrop: number; riskSeverities: Risk["severity"][]; }`
  - `export const DEFAULT_DIFF_THRESHOLDS: DiffSignificanceThresholds` — `{ minScoreDrop: 10, riskSeverities: ["critical", "high"] }`
  - `export function isDiffSignificant(diff: ReportDiff, t?: Partial<DiffSignificanceThresholds>): boolean`
  - `export function buildDiffMessages(target: { source: string; name: string }, diff: ReportDiff): { title: string; body: string }` — title `"{name}: {chip}"` where chip picks the most severe signal (new critical risk > new CVE count > score drop); body lists new critical/high risk titles, new CVE ids, score delta. Pure.
  - `export async function notifyWatchersOfDiff(db: D1Database, target: { source: string; name: string }, diff: ReportDiff, reportId: number, previousReportId: number): Promise<void>` — SELECT user_id FROM watchlist WHERE source+name; per watcher: `deleteUnreadForTarget` then row via `insertNotifications` (batch all rows in one insert AFTER the deletes). Throws on D1 errors (caller wraps).

- [ ] **Step 1: Failing tests**: `isDiffSignificant` boundaries — scoreDelta -10 → true, -9 → false; added risk severity high → true, medium only → false; newCves non-empty → true; severity-list override `{ riskSeverities: ["medium"] }` flips medium to true; minScoreDrop override. `buildDiffMessages` shape for each chip case. `notifyWatchersOfDiff` (real D1): 2 watchers → 2 rows with correct title/body/report ids; collapse — pre-existing UNREAD row for same target+user replaced (old gone, new present), READ row survives alongside new; watcher of different target untouched; zero watchers → no-op, no throw.
- [ ] **Step 2: Implement.** Note: `notifyWatchersOfDiff` needs a watcher lookup — add `export async function listWatchersForTarget(db, source, name): Promise<Array<{ user_id: number }>>` to `app/lib/db/watchlist.ts` (one query, barrel-exported) rather than reaching into the table from notifications.ts.
- [ ] **Step 3: Verify + commit** — "feat(m4): significance gate and watcher fan-out"

---

### Task 3: Tick integration

**Files:**

- Modify: `app/lib/re-audit.ts`
- Test: extend `app/lib/re-audit.test.ts`

**Interfaces:**

- Consumes: Task 2 (`isDiffSignificant`, `notifyWatchersOfDiff`, `buildDiffMessages`), `getPreviousAuditReport` + `auditResultSchema` + `diffReports` (existing chain).
- Produces: `ReAuditTickResult.details[]` gains `notifyError?: string`.

- [ ] **Step 1: Failing tests** (extend the existing mocked-runAudit harness): significant diff (control via mocked `getPreviousAuditReport` — mock `./db`'s export or seed real D1 rows for the target's reports; pick whichever matches the existing harness and note it) → `notifyWatchersOfDiff` called (mock `./notifications`); insignificant diff → NOT called; corrupted previous result_json → NOT called; notify throws → target still `status: "ok"`, `succeeded` counted, `details[0].notifyError` set.
- [ ] **Step 2: Implement** — in the success path after `markTargetAudited`: fetch previous (before = new report's `created_at` — `runAudit` returns `meta.reportId`; fetch the report row's created_at via existing db helper or add `getAuditReportById` if missing — check first), schema-parse inside try/catch (corrupted → skip), `diffReports`, `isDiffSignificant` → `notifyWatchersOfDiff` in its own try/catch → `notifyError`.
- [ ] **Step 3: Verify + commit** — "feat(m4): generate notifications in the re-audit tick"

---

### Task 4: API routes

**Files:**

- Create: `app/api/notifications/route.ts`
- Create: `app/api/notifications/read/route.ts`
- Test: `app/api/notifications/route.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers; `requireAuth`; `parseJsonBody`/`withErrorHandling`; Zod.
- Produces: exactly the spec §6 contract (GET with unread/limit/offset → `{items, unreadCount, nextOffset?}`; POST read `{ids?}` → `{updated}`; limit clamped 1–100 default 20).

- [ ] **Step 1: Failing tests**: 401 without session (GET + POST); GET returns seeded items + unreadCount; unread=1 filters; limit/offset pass-through + nextOffset; POST mark-one (own id) + ownership (other user's id numeric-collision case → their row stays unread, updated count 0); POST omitted ids → mark all; malformed body → 400 typed error.
- [ ] **Step 2: Implement** both routes (mirror watchlist route patterns — auth-first ordering).
- [ ] **Step 3: Verify + commit** — "feat(m4): notifications api with read marking"

---

### Task 5: NotificationBell UI

**Files:**

- Create: `app/components/notification-bell.tsx`
- Modify: `app/components/site-header.tsx` (render bell for logged-in users, between nav links and account menu)
- Test: `e2e/notifications.spec.ts`

**Interfaces:**

- Consumes: Task 4 API; `useAuth` (visibility); lucide `Bell`; existing header dropdown pattern (menuRef click-outside).
- Produces: `NotificationBell()` client component per spec §7.

- [ ] **Step 1: Failing e2e**: register+login → `/` shows bell (no badge); seed notification via direct API is NOT possible (no write endpoint) → seed via `page.request.post` to `/api/admin/re-audit` is also indirect — instead seed via the WATCHLIST + tick is not deterministic in e2e → **seed via DB is unavailable in e2e** → add a minimal test-only seeding path: the e2e inserts a notification row through the existing vitest-style API is unavailable — THEREFORE: assert bell + empty state in e2e, and badge/dropdown/navigate behavior in route-tested + component-level vitest where the API can be called with a seeded D1 (see Task 4 tests + a small `app/components/notification-bell.test.ts`? — repo has no component-test harness). RESOLUTION: e2e covers bell render + empty dropdown + "no notifications" state; badge/count/navigation are covered by the Task 4 route tests (API contract) and a Storybook-style manual check is NOT available — accept the coverage gap and note it in the report. Bell visible only when logged in (anonymous → absent).
- [ ] **Step 2: Implement** — polling (mount + visibilitychange + 60s interval cleared on hidden), dropdown list (max 10 latest fetched with limit=10), mark-all button, item click → POST read `{ids:[id]}` then `router.push(/report/{reportPublicId})` when non-null (title-only otherwise, no navigation), unread dot, relative time via `app/lib/format.ts` helpers if present (check — else inline).
- [ ] **Step 3: e2e + full gates; commit** — "feat(m4): notification bell in site header"

---

### Task 6: Docs + roadmap

**Files:**

- Modify: `README.md` (features + API section + structure entries)
- Modify: `TODO.md` (Milestone 4 → ✅ SHIPPED with summary)
- Modify: `AUDIT-PLAN.md` (§7 extension points — add shipped notifications line if a natural spot exists; else skip)

- [ ] **Step 1:** Update docs to shipped state (ground-truth against the tree, exactly what exists — no aspirational claims).
- [ ] **Step 2:** Full gates: `npm run lint && npx tsc --noEmit && npm run test && npm run test:e2e`.
- [ ] **Step 3: Commit** — "docs(m4): mark diff notifications shipped"

---

## Task Dependencies

Task 1 → Task 2 (uses db helpers + watcher lookup) → Task 3 (uses gate + fan-out) → Task 4 (uses db helpers; independent of 3) → Task 5 (uses API) → Task 6 (last). Tasks 3 and 4 can run in either order after 2; keep sequential per the one-implementer-at-a-time rule.
