# sbomit roadmap

Sequenced next steps, expanded from AUDIT-PLAN.md §7 (Extension Points).
Each milestone gets its own spec → plan → implementation cycle when it starts.

**Current state:** 1.x (user system) shipped. Milestone 2 (foundation
cleanup) shipped — page extraction, auth consolidation, doc refresh.
Milestone 3 (re-audit scheduling) shipped — watchlist, cron re-audits,
report diffs. Milestone 4 collects optional follow-ups.

---

## Milestone 2 — Foundation cleanup (bounded) — ✅ SHIPPED

Goal: make the audit pages and auth flow cheaper to change before building
re-audit scheduling on top of them. No user-visible behavior change.

### 2.1 Page component extraction

Break the 1,880-line `app/page.tsx` into focused components under
`app/components/`:

- `audit-form.tsx` — hero section form: URL input, npm autocomplete
  suggestions, version select, provider/model pickers, custom prompt
  (currently `app/page.tsx:719-1091`)
- `model-progress-card.tsx` — hoist the existing in-file
  `ModelProgressCard` (`app/page.tsx:268-362`) plus
  `providerLabelFromId` helper (`app/page.tsx:254`)
- `model-picker.tsx` — hoist existing in-file `ModelPicker`
  (`app/page.tsx:363-432`)
- `audit-summary-card.tsx` — the post-run summary card with save-to-D1
  (`app/page.tsx:1154-1387`)
- `audit-result-tabs.tsx` — the report tabs section rendering
  `ReportView` / `CompetitionReadout` (`app/page.tsx:1391-end`)
- `how-it-works.tsx` — the static three-card explainer
  (`app/page.tsx:1094-1150`)

Constraints: state stays lifted in `Home` and is passed down via props;
pure render extraction with zero behavior change. A checkbox test:
`npm run test`, `npm run lint`, `npm run typecheck` all green after each
extraction.

### 2.2 Auth context consolidation

Replace the 10 independent `useAuth()` session fetches (one per page:
`app/page.tsx`, `app/login`, `app/register`, `app/profile`,
`app/settings`, `app/stats`, `app/admin/stats`, `app/admin/settings`,
`app/admin/users`, `app/components/site-header.tsx`) with a single
top-level `AuthProvider` + `useAuthContext` in `app/layout.tsx`.

- One shared session fetch on app mount instead of ten.
- `useAuth` stays as the exported hook; `login`/`register`/`logout`/
  `refresh` invalidate and repopulate shared context.
- Requires making `app/layout.tsx` a client boundary host — the provider
  renders children directly so server-rendered routes stay server-rendered.
- Acceptance: all 10 pages render identically; network tab shows one
  `/api/auth/session` call per page load.

### 2.3 Documentation refresh

- AUDIT-PLAN.md §3.3 enrichment row and §7.2 GitHub manifest fetch are
  stale — both shipped in code (`app/lib/signals.ts`,
  `app/lib/audit.ts:400` `fetchGitHubPackageJson`). Update prose to
  "shipped" and move items between plan sections as needed.
- Add a "2.x roadmap" pointer from README features list if desired.

---

## Milestone 3 — Re-audit scheduling (v2 feature, architectural) — ✅ SHIPPED

Goal: close AUDIT-PLAN.md §7.3 — re-run audits for watchlisted packages on
a schedule and diff against the previous report. Shipped: per-user
watchlist (`0014_watchlist.sql`, `/api/watchlist`), custom-worker Cron
Trigger every 6h (`worker.ts`, `runReAuditTick` in `app/lib/re-audit.ts`,
budget-gated via `app/lib/provider-budget.ts`, fan-out capped by
`RE_AUDIT_MAX_PER_TICK`), on-read report diffs (`app/lib/report-diff.ts`,
`ReportDiffCard` on `/report/[id]`), watch toggle on `/audits`, and admin
trigger `POST /api/admin/re-audit`. Spec:
`docs/superpowers/specs/2026-09-16-re-audit-scheduling-design.md`.

Original shape (all landed, with the resolved decisions):

- **Watchlist table** — `0014_watchlist.sql`: users "watch" a package
  (source+name+version), D1-backed CRUD via `/api/watchlist`.
- **Cron Trigger** — `[triggers] crons = ["0 */6 * * *"]` in
  `wrangler.jsonc` plus a scheduled entry point (OpenNext supports
  exposing the Workers scheduled handler).
- **Re-audit runner** — picks eligible watchlist entries (last audited >
  24h), re-runs the existing `runAudit` pipeline, stores a new
  `audit_reports` row, and computes a structured diff vs. the previous
  report (score delta, new/removed risks, new advisories).
- **Diff surface** — `/report/[id]` gains a "since last audit" comparison
  view; watchlist management UI on the audits history page.
- **Rate-limit interplay** — re-audits must respect provider daily token
  budgets (`app/lib/provider-budget.ts`) so scheduled work cannot starve
  interactive audits.

Open questions resolved during brainstorm/spec:

- Diff granularity: risks/score/advisories diff computed on read (no
  stored diffs).
- Fan-out bound: max 5 targets per cron tick, sequential, budget-gated
  (`RE_AUDIT_MAX_PER_TICK`).
- Watchlist ownership: per-user watch entries with per-target dedupe
  (`watchlist_targets`), one re-audit per package per tick regardless of
  watcher count.

---

## Milestone 4 — Optional follow-ups (backlog)

- **4.1 KV hot cache** (AUDIT-PLAN.md §3.4) — short-TTL cache for trending
  packages ahead of the D1 `audit_reports` cache. Blocked on deciding to
  bind KV in `wrangler.jsonc`; D1-only cache works today.
- **4.2 Source adapters: PyPI / crates.io** (AUDIT-PLAN.md §7.1) — new
  adapters implement the `LibraryContext` contract; enrichment + scoring
  need per-registry signal mappings.
- **4.3 Turnstile gate** (AUDIT-PLAN.md §6) — add Cloudflare
  Turnstile to `/api/audit` if anonymous abuse appears; only after
  rate-limit data justifies it.
- **4.4 Dependency tree for GitHub repos** — `/api/dependencies` parity
  with npm now that `fetchGitHubPackageJson` exists; likely small once
  2.x lands.
- **4.5 Enrichment signal registry** (AUDIT-PLAN.md §7.2 signals) —
  formalize the hardcoded signal list in `app/lib/signals.ts` into a
  registry pattern to make 4.2 cheaper.

\ No newline at end of file
