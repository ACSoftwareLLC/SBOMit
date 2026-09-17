# M3 Re-Audit Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled re-audits of watchlisted packages with on-read diffs between consecutive reports.

**Architecture:** Per-user `watchlist` table + global `watchlist_targets` dedupe table → `runReAuditTick(db)` library function reusing `runAudit` with a new `skipCache` flag → custom worker `scheduled()` handler + admin trigger endpoint → pure `diffReports(prev, next)` rendered via `ReportDiffCard` on `/report/[id]` and a watch-toggle on `/audits`.

**Tech Stack:** Next.js 16 App Router, Cloudflare Workers D1, OpenNext custom worker, Zod, vitest (workers pool), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-re-audit-scheduling-design.md`

## Global Constraints

- D1 access only through `app/lib/db` helpers — new watch queries live in `app/lib/db/watchlist.ts`, exported via the barrel `@/app/lib/db`.
- API input validated with Zod; errors via `AuditError` + `withErrorHandling` (`app/lib/api.ts`).
- Migrations are `NNNN_snake_case.sql`, applied in order; `0014` is next.
- `worker.ts` is built by wrangler separately from Next — it CANNOT use the `@/` alias; import the runner via relative path.
- `runAudit`'s interactive behavior must not change when `skipCache` is unset.
- Test DB comes from `@cloudflare/vitest-pool-workers` (see `vitest.config.mjs`); `db` is passed explicitly to the runner.
- All commits: lint + `tsc --noEmit` + `npm run test` green.

---

### Task 1: Migration — watchlist + watchlist_targets

**Files:**

- Create: `migrations/0014_watchlist.sql`
- Test: `app/lib/db/watchlist.test.ts` (Tasks 2's tests cover the schema too; this task only migrates)

**Interfaces:**

- Consumes: nothing
- Produces: tables `watchlist (id, user_id, source, name, url, created_at, UNIQUE(user_id, source, name))` and `watchlist_targets (source, name, last_audited_at, PRIMARY KEY (source, name))` — Tasks 2, 3, 4 read/write these.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0014_watchlist.sql
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, name)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_target ON watchlist(source, name);

CREATE TABLE IF NOT EXISTS watchlist_targets (
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  last_audited_at TEXT,
  PRIMARY KEY (source, name)
);
```

- [ ] **Step 2: Verify it applies**

Run: `npx wrangler d1 migrations apply sbomit-deps --local`
Expected: `0014_watchlist.sql` applied, no errors.

- [ ] **Step 3: Commit**

```bash
git add migrations/0014_watchlist.sql
git commit -m "feat(m3): add watchlist and watchlist_targets tables"
```

---

### Task 2: DB helpers — watchlist CRUD + eligibility

**Files:**

- Create: `app/lib/db/watchlist.ts`
- Modify: `app/lib/db/index.ts` (add `export * from "./watchlist";`)
- Test: `app/lib/db/watchlist.test.ts`

**Interfaces:**

- Consumes: Task 1 tables; `StoredUser` from `./users`.
- Produces:
  - `export interface StoredWatchlistItem { id: number; user_id: number; source: string; name: string; url: string; created_at: string; }`
  - `export interface WatchlistTargetRow { source: string; name: string; url: string; last_audited_at: string | null; watcher_count: number; }`
  - `export async function addWatchlistItem(db: D1Database, input: { user_id: number; source: string; name: string; url: string }): Promise<StoredWatchlistItem>` — throws on UNIQUE violation (caller maps to 409).
  - `export async function removeWatchlistItem(db: D1Database, userId: number, id: number): Promise<boolean>`
  - `export async function removeWatchlistItemByUrl(db: D1Database, userId: number, source: string, name: string): Promise<boolean>`
  - `export async function listWatchlistForUser(db: D1Database, userId: number): Promise<StoredWatchlistItem[]>`
  - `export async function getEligibleReAuditTargets(db: D1Database, limit: number, minAgeHours: number): Promise<WatchlistTargetRow[]>` — distinct `source+name` with ≥1 watcher, `last_audited_at` NULL or older than cutoff, ordered oldest-first.
  - `export async function markTargetAudited(db: D1Database, source: string, name: string): Promise<void>` — upsert `last_audited_at = CURRENT_TIMESTAMP` (ISO UTC).

- [ ] **Step 1: Write failing tests**

```ts
// app/lib/db/watchlist.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  addWatchlistItem,
  removeWatchlistItem,
  removeWatchlistItemByUrl,
  listWatchlistForUser,
  getEligibleReAuditTargets,
  markTargetAudited,
} from "./watchlist";

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)",
  ).bind(username, `${username}@x.test`, username, "hash", 0).run();
  return res.meta.last_row_id as number;
}

describe("watchlist db helpers", () => {
  it("adds and lists items per user", async () => {
    const uid = await seedUser("wl_a");
    await addWatchlistItem(env.DB, { user_id: uid, source: "npm", name: "lodash", url: "https://www.npmjs.com/package/lodash" });
    const items = await listWatchlistForUser(env.DB, uid);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("lodash");
  });

  it("rejects duplicate (user, source, name)", async () => {
    const uid = await seedUser("wl_b");
    const input = { user_id: uid, source: "npm", name: "express", url: "https://www.npmjs.com/package/express" };
    await addWatchlistItem(env.DB, input);
    await expect(addWatchlistItem(env.DB, input)).rejects.toThrow();
  });

  it("delete enforces ownership", async () => {
    const u1 = await seedUser("wl_c1");
    const u2 = await seedUser("wl_c2");
    const item = await addWatchlistItem(env.DB, { user_id: u1, source: "npm", name: "axios", url: "https://www.npmjs.com/package/axios" });
    expect(await removeWatchlistItem(env.DB, u2, item.id)).toBe(false);
    expect(await removeWatchlistItem(env.DB, u1, item.id)).toBe(true);
    expect(await listWatchlistForUser(env.DB, u1)).toHaveLength(0);
  });

  it("eligible targets dedupe across watchers and respect age + limit", async () => {
    const u1 = await seedUser("wl_d1");
    const u2 = await seedUser("wl_d2");
    await addWatchlistItem(env.DB, { user_id: u1, source: "npm", name: "pkg-old", url: "u1" });
    await addWatchlistItem(env.DB, { user_id: u2, source: "npm", name: "pkg-old", url: "u1" }); // second watcher, same target
    await addWatchlistItem(env.DB, { user_id: u1, source: "npm", name: "pkg-fresh", url: "u2" });
    await markTargetAudited(env.DB, "npm", "pkg-fresh");

    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    const names = targets.map((t) => t.name);
    expect(names).toContain("pkg-old");
    expect(names).not.toContain("pkg-fresh");
    const old = targets.find((t) => t.name === "pkg-old")!;
    expect(old.watcher_count).toBe(2);
    expect(targets.length).toBeLessThanOrEqual(10);
  });

  it("markTargetAudited upserts and makes target ineligible", async () => {
    const uid = await seedUser("wl_e");
    await addWatchlistItem(env.DB, { user_id: uid, source: "npm", name: "marked", url: "u" });
    await markTargetAudited(env.DB, "npm", "marked");
    expect(await getEligibleReAuditTargets(env.DB, 10, 24)).toHaveLength(0);
    // idempotent upsert
    await markTargetAudited(env.DB, "npm", "marked");
  });

  it("removeByUrl only touches the caller's row", async () => {
    const u1 = await seedUser("wl_f1");
    const u2 = await seedUser("wl_f2");
    await addWatchlistItem(env.DB, { user_id: u1, source: "npm", name: "shared", url: "s" });
    await addWatchlistItem(env.DB, { user_id: u2, source: "npm", name: "shared", url: "s" });
    expect(await removeWatchlistItemByUrl(env.DB, u1, "npm", "shared")).toBe(true);
    expect(await listWatchlistForUser(env.DB, u2)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/db/watchlist.test.ts`
Expected: FAIL — module `./watchlist` not found.

- [ ] **Step 3: Implement `app/lib/db/watchlist.ts`**

```ts
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

export interface StoredWatchlistItem {
  id: number;
  user_id: number;
  source: string;
  name: string;
  url: string;
  created_at: string;
}

export interface WatchlistTargetRow {
  source: string;
  name: string;
  url: string;
  last_audited_at: string | null;
  watcher_count: number;
}

export async function addWatchlistItem(
  db: D1Database,
  input: { user_id: number; source: string; name: string; url: string },
): Promise<StoredWatchlistItem> {
  const res = await db
    .prepare(
      `INSERT INTO watchlist (user_id, source, name, url) VALUES (?, ?, ?, ?)`,
    )
    .bind(input.user_id, input.source, input.name, input.url)
    .run();
  const id = res.meta?.last_row_id as number;
  const row = await db
    .prepare(`SELECT * FROM watchlist WHERE id = ?`)
    .bind(id)
    .first<StoredWatchlistItem>();
  if (!row) throw new Error("Failed to load watchlist item.");
  return row;
}

export async function removeWatchlistItem(
  db: D1Database,
  userId: number,
  id: number,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM watchlist WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function removeWatchlistItemByUrl(
  db: D1Database,
  userId: number,
  source: string,
  name: string,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM watchlist WHERE user_id = ? AND source = ? AND name = ?`)
    .bind(userId, source, name)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listWatchlistForUser(
  db: D1Database,
  userId: number,
): Promise<StoredWatchlistItem[]> {
  const { results } = await db
    .prepare(`SELECT * FROM watchlist WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all<StoredWatchlistItem>();
  return results ?? [];
}

export async function getEligibleReAuditTargets(
  db: D1Database,
  limit: number,
  minAgeHours: number,
): Promise<WatchlistTargetRow[]> {
  const { results } = await db
    .prepare(
      `SELECT w.source, w.name, w.url, t.last_audited_at, COUNT(*) as watcher_count
       FROM watchlist w
       LEFT JOIN watchlist_targets t ON t.source = w.source AND t.name = w.name
       GROUP BY w.source, w.name
       HAVING t.last_audited_at IS NULL
          OR t.last_audited_at <= datetime('now', '-' || ? || ' hours')
       ORDER BY t.last_audited_at IS NOT NULL, t.last_audited_at ASC
       LIMIT ?`,
    )
    .bind(minAgeHours, limit)
    .all<WatchlistTargetRow>();
  return results ?? [];
}

export async function markTargetAudited(
  db: D1Database,
  source: string,
  name: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watchlist_targets (source, name, last_audited_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (source, name) DO UPDATE SET last_audited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(source, name)
    .run();
}
```

Then add to `app/lib/db/index.ts`:

```ts
export * from "./watchlist";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/db/watchlist.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/db/watchlist.ts app/lib/db/watchlist.test.ts app/lib/db/index.ts
git commit -m "feat(m3): watchlist db helpers with target dedupe and eligibility"
```

---

### Task 3: `skipCache` in runAudit

**Files:**

- Modify: `app/lib/run-audit.ts` (add `skipCache` to `RunAuditInput`; guard the cache lookup; null the `cacheKey` when skipping)
- Test: extend `app/lib/run-audit.test.ts`

**Interfaces:**

- Consumes: existing `RunAuditInput`, `getCachedAuditReport`, `saveAuditReport`.
- Produces: `RunAuditInput.skipCache?: boolean` — when true, no cache read, and `saveAuditReport` receives `cacheKey: undefined` (persists NULL).

- [ ] **Step 1: Write failing tests** (add to `app/lib/run-audit.test.ts`, inside the existing mocks harness)

```ts
describe("runAudit skipCache", () => {
  it("bypasses the cache lookup when skipCache is true", async () => {
    const cachedReport = makeStoredReport({ id: 99, audit_id: 9 }); // existing helper or minimal stub
    getCachedAuditReportMock.mockResolvedValue(cachedReport);

    const { meta } = await runAudit({ libraryUrl: "https://www.npmjs.com/package/lodash", skipCache: true });
    expect(getCachedAuditReportMock).not.toHaveBeenCalled();
    expect(meta.cached).toBe(false);
  });

  it("persists with cache_key NULL when skipCache is true", async () => {
    await runAudit({ libraryUrl: "https://www.npmjs.com/package/lodash", skipCache: true });
    const saved = saveAuditReportMock.mock.calls[0][1];
    expect(saved.cacheKey).toBeUndefined();
  });

  it("still uses the cache when skipCache is unset", async () => {
    const cachedReport = makeStoredReport({ id: 99, audit_id: 9 });
    getCachedAuditReportMock.mockResolvedValue(cachedReport);
    const { meta } = await runAudit({ libraryUrl: "https://www.npmjs.com/package/lodash" });
    expect(meta.cached).toBe(true);
  });
});
```

(Adapt mock names/helpers to the file's existing structure — the suite already mocks `./cache` with a `getCachedAuditReport` spy and `./db` with `saveAuditReport`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/lib/run-audit.test.ts`
Expected: FAIL — `skipCache` not a known property → cache still consulted.

- [ ] **Step 3: Implement**

In `RunAuditInput`:

```ts
export interface RunAuditInput {
  // ... existing fields ...
  /** Re-audit mode: skip cache reads and persist without a cache key. */
  skipCache?: boolean;
}
```

In `runAudit`, guard the cache path:

```ts
const cached = input.skipCache
  ? null
  : await getCachedAuditReport(dbInstance, cacheKey, fullContext.version);
```

And in the `saveAuditReport` call, replace `cacheKey` with:

```ts
cacheKey: input.skipCache ? undefined : cacheKey,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/run-audit.test.ts`
Expected: all PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add app/lib/run-audit.ts app/lib/run-audit.test.ts
git commit -m "feat(m3): runAudit skipCache flag for historical re-audits"
```

---

### Task 4: Re-audit runner

**Files:**

- Create: `app/lib/re-audit.ts`
- Test: `app/lib/re-audit.test.ts`

**Interfaces:**

- Consumes: Task 2's `getEligibleReAuditTargets`/`markTargetAudited`; `runAudit` (Task 3 `skipCache`); `checkProviderBudget`/`finalizeProviderUsage` from `@/app/lib/provider-budget`; `getProviderById`/`listProviders` from `@/app/lib/db`.
- Produces:
  - `export interface ReAuditTickResult { attempted: number; succeeded: number; failed: number; stoppedReason?: "budget"; details: Array<{ source: string; name: string; status: "ok" | "error"; error?: string }>; }`
  - `export async function runReAuditTick(db: D1Database, opts?: { limit?: number; minAgeHours?: number; providerId?: string }): Promise<ReAuditTickResult>`

- [ ] **Step 1: Write failing tests**

```ts
// app/lib/re-audit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";

vi.mock("./run-audit", () => ({ runAudit: vi.fn() }));
vi.mock("./provider-budget", () => ({
  checkProviderBudget: vi.fn(),
  finalizeProviderUsage: vi.fn(),
}));

import { runAudit } from "./run-audit";
import { checkProviderBudget } from "./provider-budget";
import { runReAuditTick } from "./re-audit";
import { addWatchlistItem, markTargetAudited } from "./db/watchlist";

const runAuditMock = vi.mocked(runAudit);

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)",
  ).bind(username, `${username}@x.test`, username, "hash", 0).run();
  return res.meta.last_row_id as number;
}

beforeEach(() => {
  vi.clearAllMocks();
  runAuditMock.mockResolvedValue({ result: {}, meta: { cached: false, auditId: 1, reportId: 1, interactions: [] } } as any);
});

describe("runReAuditTick", () => {
  it("runs one audit per distinct target and marks it audited", async () => {
    const u1 = await seedUser("ra_a1");
    const u2 = await seedUser("ra_a2");
    await addWatchlistItem(env.DB, { user_id: u1, source: "npm", name: "one", url: "https://www.npmjs.com/package/one" });
    await addWatchlistItem(env.DB, { user_id: u2, source: "npm", name: "one", url: "https://www.npmjs.com/package/one" });

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock.mock.calls[0][0].skipCache).toBe(true);
    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    expect(targets.filter((t) => t.name === "one")).toHaveLength(0);
  });

  it("a failing target is recorded and does not kill the tick", async () => {
    const u = await seedUser("ra_b");
    await addWatchlistItem(env.DB, { user_id: u, source: "npm", name: "bad", url: "u" });
    await addWatchlistItem(env.DB, { user_id: u, source: "npm", name: "good", url: "g" });
    runAuditMock.mockImplementation(async (input: any) => {
      if (input.libraryUrl === "u") throw new Error("boom");
      return { result: {}, meta: { cached: false, auditId: 1, reportId: 1, interactions: [] } } as any;
    });

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details.find((d) => d.name === "bad")?.status).toBe("error");
  });

  it("budget exhaustion stops the tick with stoppedReason", async () => {
    const u = await seedUser("ra_c");
    await addWatchlistItem(env.DB, { user_id: u, source: "npm", name: "x", url: "x" });
    vi.mocked(checkProviderBudget).mockRejectedValueOnce(new Error("RATE_LIMIT_EXCEEDED"));

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.stoppedReason).toBe("budget");
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("failed targets are not marked audited (retry next tick)", async () => {
    const u = await seedUser("ra_d");
    await addWatchlistItem(env.DB, { user_id: u, source: "npm", name: "flaky", url: "f" });
    runAuditMock.mockRejectedValueOnce(new Error("boom"));
    await runReAuditTick(env.DB, { limit: 5 });
    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    expect(targets.map((t) => t.name)).toContain("flaky");
  });
});
```

(Import `getEligibleReAuditTargets` from `./db/watchlist` in the test file as well.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/lib/re-audit.test.ts`
Expected: FAIL — `./re-audit` not found.

- [ ] **Step 3: Implement `app/lib/re-audit.ts`**

```ts
import { getDb, getEligibleReAuditTargets, getProviderById, listProviders, markTargetAudited } from "./db";
import { runAudit } from "./run-audit";
import { checkProviderBudget, finalizeProviderUsage } from "./provider-budget";

export interface ReAuditTickResult {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedReason?: "budget";
  details: Array<{ source: string; name: string; status: "ok" | "error"; error?: string }>;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_AGE_HOURS = 24;

async function resolveProviderId(db: D1Database): Promise<string | undefined> {
  const providers = await listProviders(db);
  return providers.find((p) => p.is_default === 1)?.id ?? providers[0]?.id;
}

export async function runReAuditTick(
  db: D1Database,
  opts?: { limit?: number; minAgeHours?: number; providerId?: string },
): Promise<ReAuditTickResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const minAgeHours = opts?.minAgeHours ?? DEFAULT_MIN_AGE_HOURS;
  const providerId = opts?.providerId ?? (await resolveProviderId(db));

  const targets = await getEligibleReAuditTargets(db, limit, minAgeHours);
  const result: ReAuditTickResult = { attempted: 0, succeeded: 0, failed: 0, details: [] };

  for (const target of targets) {
    try {
      await checkProviderBudget(db, providerId);
    } catch {
      result.stoppedReason = "budget";
      break;
    }

    result.attempted += 1;
    try {
      const run = await runAudit({
        libraryUrl: target.url,
        skipCache: true,
        ...(providerId ? { providerId } : {}),
      });
      await finalizeProviderUsage(db, providerId, {
        cached: run.meta.cached,
        reportId: run.meta.reportId,
        interactions: run.meta.interactions,
      });
      await markTargetAudited(db, target.source, target.name);
      result.succeeded += 1;
      result.details.push({ source: target.source, name: target.name, status: "ok" });
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/re-audit.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/re-audit.ts app/lib/re-audit.test.ts
git commit -m "feat(m3): re-audit tick runner with budget gate and failure isolation"
```

---

### Task 5: Watchlist API routes

**Files:**

- Create: `app/api/watchlist/route.ts`
- Test: `app/api/watchlist/route.test.ts`

**Interfaces:**

- Consumes: `requireAuth` from `@/app/lib/auth`; Task 2 helpers; `parseJsonBody`/`withErrorHandling` from `@/app/lib/api`; `normalizeLibraryUrl` + `parseGitHubUrl` from `@/app/lib/audit`.
- Produces: `GET/POST/DELETE /api/watchlist` per spec §4. Duplicate → 409 `AuditError("CONFLICT", ...)`; malformed URL → 422 `AuditError("UNSUPPORTED_SOURCE", ...)`.

- [ ] **Step 1: Write failing tests** — auth required (401 without session), POST valid npm URL creates item, POST duplicate → 409, POST garbage → 422, DELETE by id enforces ownership. Follow the existing harness in `app/api/auth/route.test.ts` (session cookie helper).

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/api/watchlist/route.test.ts` (module not found).

- [ ] **Step 3: Implement**

```ts
// app/api/watchlist/route.ts
import { z } from "zod";
import { getDb, addWatchlistItem, listWatchlistForUser, removeWatchlistItem, removeWatchlistItemByUrl } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { parseJsonBody, withErrorHandling } from "@/app/lib/api";
import { AuditError } from "@/app/lib/errors";
import { normalizeLibraryUrl, parseGitHubUrl } from "@/app/lib/audit";

const postSchema = z.object({ libraryUrl: z.string().min(1) });

function resolveTarget(input: string): { source: string; name: string; url: string } {
  const normalized = normalizeLibraryUrl(input);
  const github = parseGitHubUrl(normalized);
  if (github) {
    return { source: "github", name: `${github.owner}/${github.repo}`, url: normalized };
  }
  // npm: normalizeLibraryUrl already produced /package/<name>
  const match = normalized.match(/npmjs\.com\/package\/(.+?)(?:\/|$)/);
  if (match) {
    return { source: "npm", name: decodeURIComponent(match[1]), url: normalized };
  }
  throw new AuditError("UNSUPPORTED_SOURCE", "Only npm package and GitHub repository URLs are supported.", 422);
}

export const GET = withErrorHandling(async (request: Request): Promise<Response> => {
  const db = await getDb();
  const user = await requireAuth(db, request);
  const items = await listWatchlistForUser(db, user.id);
  return Response.json({ items });
});

export const POST = withErrorHandling(async (request: Request): Promise<Response> => {
  const body = await parseJsonBody(request);
  const { libraryUrl } = postSchema.parse(body);
  const db = await getDb();
  const user = await requireAuth(db, request);
  const target = resolveTarget(libraryUrl);
  try {
    const item = await addWatchlistItem(db, { user_id: user.id, ...target });
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new AuditError("CONFLICT", "Already watching this package.", 409);
    }
    throw err;
  }
});

export const DELETE = withErrorHandling(async (request: Request): Promise<Response> => {
  const body = await parseJsonBody(request);
  const db = await getDb();
  const user = await requireAuth(db, request);
  if (typeof body.id === "number") {
    const ok = await removeWatchlistItem(db, user.id, body.id);
    if (!ok) throw new AuditError("NOT_FOUND", "Watchlist item not found.", 404);
    return Response.json({ ok: true });
  }
  if (typeof body.libraryUrl === "string") {
    const target = resolveTarget(body.libraryUrl);
    const ok = await removeWatchlistItemByUrl(db, user.id, target.source, target.name);
    if (!ok) throw new AuditError("NOT_FOUND", "Watchlist item not found.", 404);
    return Response.json({ ok: true });
  }
  throw new AuditError("MISSING_INPUT", "Provide id or libraryUrl.", 400);
});
```

- [ ] **Step 4: Run tests** — `npx vitest run app/api/watchlist/route.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/watchlist/route.ts app/api/watchlist/route.test.ts
git commit -m "feat(m3): watchlist API with ownership and URL resolution"
```

---

### Task 6: Diff logic + report endpoint

**Files:**

- Create: `app/lib/report-diff.ts`
- Modify: `app/api/reports/[id]/route.ts` — add `?diff=1`
- Test: `app/lib/report-diff.test.ts`

**Interfaces:**

- Consumes: `AuditResult`, `Risk`, `CveReport` types from `./audit`.
- Produces: `ReportDiff` + `diffReports(prev, next)` exactly per spec §6; report route response gains optional `diff`/`previousReportId`.

- [ ] **Step 1: Write failing tests** — identical reports → all-empty diff, scoreDelta 0; added/removed/severity-changed risks; new/resolved CVEs; license/version flags. Use minimal `AuditResult` fixtures.

- [ ] **Step 2: Verify failure** — module not found.

- [ ] **Step 3: Implement `diffReports`** — Map risks/CVEs by `title`/`id`, compute set differences + severity comparison; simple boolean flags for license/version.

- [ ] **Step 4: Modify the reports route** — when `diff=1`: fetch the current report's `package_audits` row, find the newest earlier report (same name+source, `prompt IS NULL`, `created_at` earlier), parse both `result_json`s, return `{ ...existing, diff, previousReportId }`. No earlier report → `diff: null`.

- [ ] **Step 5: Run tests + full suite; Commit**

```bash
git add app/lib/report-diff.ts app/lib/report-diff.test.ts app/api/reports/[id]/route.ts
git commit -m "feat(m3): on-read report diffing with previous-report lookup"
```

---

### Task 7: Custom worker + admin trigger

**Files:**

- Create: `worker.ts` (repo root — NO `@/` alias, relative import only)
- Create: `app/api/admin/re-audit/route.ts`
- Modify: `wrangler.jsonc` — `"main": "./worker.ts"`, `"triggers": { "crons": ["0 */6 * * *"] }`
- Test: `app/api/admin/re-audit/route.test.ts`

**Interfaces:**

- Consumes: Task 4 `runReAuditTick` (imported relatively in worker.ts as `import { runReAuditTick } from "./app/lib/re-audit"`); `requireAdmin`.
- Produces: scheduled cron handler; `POST /api/admin/re-audit { limit?: number }` → `{ attempted, succeeded, failed, details }`, limit clamped 1–20 (default 5).

- [ ] **Step 1: Write `worker.ts`**

```ts
// @ts-ignore `.open-next/worker.js` is generated at build time
import { default as handler } from "./.open-next/worker.js";
import { runReAuditTick } from "./app/lib/re-audit";

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runReAuditTick(env.DB, { limit: Number(env.RE_AUDIT_MAX_PER_TICK) || 5 }),
    );
  },
} satisfies ExportedHandler<CloudflareEnv>;
```

Note: verify the relative import of `app/lib/re-audit` resolves under wrangler's esbuild — `re-audit.ts` must not import anything using the `@/` alias internally. If it does, change its internal imports to relative (it imports only `./db`, `./run-audit`, `./provider-budget` — all safe).

- [ ] **Step 2: Admin route (failing test first, then implement)** — mirror `app/api/admin/stats/route.ts` structure: `requireAdmin`, parse optional `limit`, clamp 1–20, `runReAuditTick`, return JSON.

- [ ] **Step 3: Update `wrangler.jsonc`** — main + triggers. Run `npx wrangler types` to regenerate bindings (adds `RE_AUDIT_MAX_PER_TICK` typing if configured as a var).

- [ ] **Step 4: Verify build** — `npx opennextjs-cloudflare build` must pass with the new main entry; also `wrangler dev --test-scheduled` boots and `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` returns 200 (run the tick against local D1 with a seeded watchlist row).

- [ ] **Step 5: Commit**

```bash
git add worker.ts app/api/admin/re-audit/ wrangler.jsonc worker-configuration.d.ts
git commit -m "feat(m3): custom worker scheduled handler + admin re-audit trigger"
```

---

### Task 8: UI — watch toggle + diff card

**Files:**

- Create: `app/components/report-diff-card.tsx`
- Modify: `app/audits/page.tsx` — watch toggle column
- Modify: `app/report/[id]/page.tsx` — fetch `?diff=1`, render `ReportDiffCard`
- Test: extend `e2e/` — `e2e/watchlist.spec.ts`

**Interfaces:**

- Consumes: Task 5 API; Task 6 `diff` response shape (`ReportDiff` JSON).
- Produces: `ReportDiffCard({ diff }: { diff: ReportDiff })` client component; audits-table star toggle (`isWatched` map from `GET /api/watchlist`).

- [ ] **Step 1: e2e failing test** — authenticated user visits `/audits`, star column renders (header + one cell per row); clicking toggles and persists after reload.

- [ ] **Step 2: Implement toggle** — in `app/audits/page.tsx`: load watchlist on mount, star button per row calls POST/DELETE with the row's URL, optimistic update + refetch on error.

- [ ] **Step 3: Implement `ReportDiffCard`** — score-delta badge (emerald ▲ / red ▼ / muted =), summary chips ("2 new risks", "1 resolved", "3 new advisories"), expandable `<details>` lists for added/removed risks and new CVEs. Import `type ReportDiff` from `@/app/lib/report-diff`.

- [ ] **Step 4: Wire report page** — `app/report/[id]/page.tsx` fetches `/api/reports/[id]?diff=1`; when `diff` non-null renders `<ReportDiffCard diff={diff} />` above the existing content.

- [ ] **Step 5: Run e2e + full gates; Commit**

```bash
git add app/components/report-diff-card.tsx app/audits/page.tsx app/report/[id]/page.tsx e2e/watchlist.spec.ts
git commit -m "feat(m3): watch toggle on audits page and report diff card"
```

---

### Task 9: Docs + roadmap

**Files:**

- Modify: `README.md` (API section: watchlist + admin re-audit endpoints; project structure additions)
- Modify: `AUDIT-PLAN.md` (§7.3 → shipped)
- Modify: `TODO.md` (Milestone 3 → shipped)

- [ ] **Step 1: Update the three docs** to reflect shipped state, matching existing tone/structure.

- [ ] **Step 2: Full gate** — `npm run lint && npx tsc --noEmit && npm run test && npm run test:e2e`.

- [ ] **Step 3: Commit**

```bash
git add README.md AUDIT-PLAN.md TODO.md
git commit -m "docs(m3): mark re-audit scheduling shipped"
```

---

## Task Dependencies

Task 1 → Task 2 → {Task 3 (independent of 1–2), Task 4 (needs 2+3)} → Task 5 (needs 2) → Task 6 (independent of 1–5, needs only types) → Task 7 (needs 4) → Task 8 (needs 5+6) → Task 9 (last).
