# sbomit

AI-powered security audits for npm libraries and GitHub repositories. Paste a package URL or name, add an optional prompt, and get a structured report covering security posture, license compatibility, maintenance health, and dependency risk.

## Features

- **Instant audits** — Analyze any npm package or GitHub repo with a single request.
- **Streaming audits** — Watch the audit pipeline progress in real time via `/api/audit/stream`.
- **AI-generated reports** — Uses structured outputs (Zod schema) for consistent, machine-readable results.
- **Competition mode** — Pit two models against each other and merge the results.
- **Trust score** — 0–100 score with severity-ranked risks.
- **Dependency tree** — Save direct, dev, peer, and optional dependencies to a Cloudflare D1 database.
- **Transitive dependency resolution** — Walk the npm dependency graph depth-capped up to 3 levels.
- **CVE enrichment** — Pulls security advisory data into the audit context.
- **Codebase inspection** — Downloads and inspects package tarballs when available.
- **Persisted reports** — Every audit is stored in D1 and gets a shareable `/report/[id]` URL.
- **Rate limiting** — Per-IP token bucket on API routes.
- **npm autocomplete** — Search the npm registry as you type.
- **Custom prompts** — Tailor the audit to your product context (e.g. fintech supply-chain risks).
- **Report export** — Download audit results as Markdown or JSON.
- **User accounts** — Registration, login, password reset, and profile management.
- **Admin console** — Manage users, block emails/usernames, configure providers, and set per-provider daily token budgets.
- **Usage statistics** — Per-user and overall token use, audit counts, and score distributions.
- **Watchlist re-audits** — Watch a package on the audits page; a Cloudflare Cron Trigger re-audits watched packages every 6 hours and diffs consecutive reports.
- **Report diffs** — Score delta plus new/resolved risks and advisories between consecutive audits of the same package.
- **Watch notifications** — In-app bell feed: watchers get notified when a scheduled re-audit surfaces a significant change (new critical/high risk, new CVE, or a score drop ≥ 10).
- **Health check** — `GET /api/health` verifies D1 and OpenAI bindings.

## Tech Stack

- [Next.js](https://nextjs.org) 16 (App Router)
- [React](https://react.dev) 19 + TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4
- [Cloudflare Workers](https://workers.cloudflare.com) + [D1](https://developers.cloudflare.com/d1/)
- LLM provider abstraction (OpenAI-compatible, Anthropic Claude, Google Gemini)

## Project Structure

```
app/
  api/
    audit/                    POST → run an AI audit and persist report
    audit/stream/             POST → streaming audit events (NDJSON)
    audits/                   GET → audit history; /[id] → single audit
    auth/                     login, logout, register, session, change-password, password-reset
    admin/                    users, blocked-emails/usernames, provider-limits, stats, re-audit
    dependencies/             POST → save direct dependency tree to D1
    dependencies/transitive/  POST → walk transitive deps depth-capped
    health/                   GET → liveness + binding check
    models/                   POST → list available models for a provider
    providers/                provider CRUD + /[id]/models
    reports/[id]/             GET → fetch a stored report
    watchlist/                GET/POST/DELETE → per-user watched packages
    notifications/            GET → user notification feed; /read → mark read
    search/                   GET → npm package autocomplete
    users/me/                 GET/PUT current user; /stats, /reports
    versions/                 GET → npm package versions
  components/
    ui/                       Tailwind/shadcn-style UI primitives
    alert.tsx, stat-card.tsx, page-shell.tsx
    audit-jobs.tsx            Global audit job state
    report-view.tsx           Reusable report renderer + export
    competition-readout.tsx   Competition-mode results
    audit-form.tsx            Audit input form (URL, version, provider, prompt)
    audit-progress.tsx        In-flight audit progress card
    audit-result-tabs.tsx     Result report tabs (overview, risks, CVEs, …)
    model-picker.tsx          Provider + model selection control
    model-progress-card.tsx   Per-model progress steps
    how-it-works.tsx          Landing explainer section
    notification-bell.tsx     Unread-count bell + dropdown feed in the header
    site-header.tsx
  lib/
    api.ts                    Route helpers (parseJsonBody, withErrorHandling)
    audit.ts                  Library resolution (npm/GitHub) + Zod schemas
    auth.ts                   Session/auth helpers
    cache.ts                  Cached-report lookup
    codebase.ts               Tarball inspection
    cve.ts                    CVE enrichment
    db/                       D1 helpers split by domain (incl. notifications)
    dependencies.ts           Transitive dependency walker
    errors.ts                 Typed API error helpers
    format.ts                 Timestamp / duration / token formatters
    llm/                      LLM client split by domain
    providers.ts              Provider config utilities
    rate-limit.ts             Per-IP token bucket
    re-audit.ts               Scheduled watchlist re-audit tick runner
    notifications.ts          Diff-significance gate + watcher fan-out
    report-diff.ts            Pure diff between consecutive audit reports
    run-audit.ts              Audit pipeline orchestration
    score.ts                  Deterministic scoring rubric
    signals.ts                Enrichment signals
    variants.ts               Severity / score / provider label variants
  admin/                      Admin pages (users, settings, stats)
  audits/                     Audit history page
  login/, register/, profile/, reset-password/  Auth pages
  settings/                   Provider/user settings
  stats/                      Personal usage statistics
  report/[id]/                Shareable persisted report page
migrations/                   D1 SQL migrations
scripts/
  apply-migrations.sh         Apply local/remote D1 migrations + regenerate types
worker.ts                     Custom Worker entry: wraps the OpenNext fetch handler and adds the cron scheduled handler
wrangler.jsonc                Cloudflare Worker + D1 configuration
wrangler.test.jsonc           Test-mode Wrangler config (excludes worker.ts from the vitest entry)
.dev.vars.example             Local secrets template
```

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- npm
- A Cloudflare account
- API keys for at least one supported LLM provider:
  - [OpenAI](https://platform.openai.com/api-keys) or any OpenAI-compatible endpoint
  - [Anthropic](https://console.anthropic.com/settings/keys) (Claude)
  - [Google AI Studio](https://aistudio.google.com/app/apikey) (Gemini)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the local secrets template:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Edit `.dev.vars` and add your credentials:

   ```bash
   # Required: OpenAI API key (or the provider you configure)
   OPENAI_API_KEY=sk-your-openai-api-key-here

   # Required: secret used to sign session cookies
   AUTH_SECRET=replace-with-a-long-random-secret

   # Optional: GitHub token (raises rate limits and enables deeper signals)
   GITHUB_TOKEN=ghp-your-github-token-here
   ```

3. Configure your D1 database in `wrangler.jsonc`:

   ```jsonc
   {
     "d1_databases": [
       {
         "binding": "DB",
         "database_name": "sbomit-deps",
         "database_id": "<your-database-id>",
         "migrations_dir": "./migrations"
       }
     ]
   }
   ```

4. Apply migrations locally:

   ```bash
   npm run db:migrate
   ```

## Development

Run the Next.js dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To test D1-bound routes locally, use Wrangler:

```bash
npx wrangler dev
```

### Tests

Tests run inside the Cloudflare Workers runtime using `@cloudflare/vitest-pool-workers`:

```bash
npm run test
```

This applies D1 migrations to an isolated local database and runs unit/integration tests for library resolution, rate limiting, error handling, dependency walking, D1 helpers, auth, watchlist, the re-audit runner, report diffing, notifications, and LLM orchestration.

End-to-end tests run against a local dev server with Playwright:

```bash
npm run test:e2e
```

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

Make sure remote D1 migrations are applied before deploying:

```bash
npx wrangler d1 migrations apply sbomit-deps --remote
```

> `next start` / `next build` alone are **not** the deploy path. Use the OpenNext-based `preview`/`deploy` scripts.

### Scheduled re-audits

A Cloudflare Cron Trigger (`0 */6 * * *`, every 6 hours) re-runs audits for watched packages. The schedule and fan-out live in `wrangler.jsonc`: adjust `triggers.crons` to change the cadence, and `vars.RE_AUDIT_MAX_PER_TICK` (default 5) to cap how many targets are re-audited per tick. Admins can also trigger a tick immediately via `POST /api/admin/re-audit`.

## API

### `POST /api/audit`

Run an AI audit on a library. Persists the package metadata, dependency tree, and full report to D1.

```json
{
  "libraryUrl": "https://www.npmjs.com/package/lodash",
  "prompt": "Focus on supply-chain risks for a fintech product."
}
```

Returns a structured `AuditResult`, `reportId`, and a `cached` flag. Identical URLs within 24 hours return a cached report.

### `POST /api/audit/stream`

Same input as `/api/audit`, but streams NDJSON progress events (`step`, `llm`, `eta`) and a final `complete` or `error` event.

### `POST /api/dependencies`

Resolve and persist a direct dependency tree to D1.

```json
{
  "libraryUrl": "https://www.npmjs.com/package/express"
}
```

### `POST /api/dependencies/transitive`

Walk the npm dependency graph depth-capped (default depth 2, max 3).

```json
{
  "libraryUrl": "https://www.npmjs.com/package/express",
  "maxDepth": 2,
  "includeDev": false
}
```

### `GET /api/audits` and `GET /api/audits/[id]`

List or fetch a persisted audit. Add `?diff=1` to `[id]` to include `{ diff, previousReportId, previousReportPublicId }` comparing this report against the newest earlier default-prompt report for the same package.

### `GET /api/reports/[id]`

Fetch a stored audit report by its public ID. Add `?diff=1` for the same comparison payload as above (`diff` is `null` when no earlier report exists).

### `GET /api/health`

Liveness check. Returns `ok`/`degraded` and binding status.

### `GET /api/search?q=<query>`

Search npm packages for autocomplete.

### `GET /api/notifications`

List the current user's notifications (newest first). Query params: `?unread=1` (only unread), `?limit=` (1–100, default 20), `?offset=`. Returns `{ items, unreadCount, nextOffset? }`; `items` carry resolved `reportPublicId` / `previousReportPublicId` (`null` if the report was deleted).

### `POST /api/notifications/read`

Mark notifications read: `{ ids: [1, 2] }` (max 99, empty array is a no-op) or `{}` (mark all). Returns `{ updated }`.

### Auth endpoints

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- `GET /api/auth/session`, `POST /api/auth/change-password`
- `POST /api/auth/password-reset`, `POST /api/auth/password-reset/confirm`
- `GET/PUT /api/users/me`, `GET /api/users/me/stats`, `GET /api/users/me/reports`

### Watchlist endpoints

- `GET /api/watchlist` — list the current user's watched packages
- `POST /api/watchlist` — `{ libraryUrl }` watch a package (npm or GitHub URL; duplicate → 409)
- `DELETE /api/watchlist` — `{ libraryUrl }` or `{ id }` unwatch

### Admin endpoints

- `GET/POST /api/admin/users`, `GET/PUT/DELETE /api/admin/users/[id]`
- `POST /api/admin/users/[id]/set-password`, `POST /api/admin/users/[id]/reset-password`
- `GET/POST/DELETE /api/admin/blocked-emails`
- `GET/POST/DELETE /api/admin/blocked-usernames`
- `GET/POST /api/admin/provider-limits`
- `GET /api/admin/stats`
- `POST /api/admin/re-audit` — `{ limit? }` (1–20, default 5) re-audit eligible watched packages now

## License

MIT
