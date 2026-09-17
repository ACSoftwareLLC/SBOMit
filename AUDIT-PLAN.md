# Auditor System Design

Technical design for sbomit's auditing pipeline: how a library URL becomes a
structured, persisted, AI-generated audit report.

---

## 1. Purpose

The auditor takes a single input — an npm package URL, an npm package name, or
a GitHub repository URL — plus an optional user prompt, and produces a
structured audit covering security posture, license compatibility, maintenance
health, and dependency risk. Results are deterministic in shape (Zod-validated
JSON) but probabilistic in content (LLM-generated), so the design emphasizes
guardrails: strict schemas, bounded inputs, deterministic enrichment, caching,
and typed errors.

---

## 2. System Overview

```
        ┌──────────────────────────────────────────────────────────┐
        │                        Client                             │
        │  app/page.tsx — URL/name input, prompt, report tabs       │
        └──────────────────────────┬───────────────────────────────┘
                                   │ POST /api/audit
                                   ▼
        ┌──────────────────────────────────────────────────────────┐
        │                    Pipeline (per request)                 │
        │                                                           │
        │  1. Intake        validate + normalize input              │
        │  2. Resolve       fetch npm/GitHub metadata               │
        │  3. Enrich        (planned) deterministic signals           │
        │  4. Cache check   (planned) dedupe identical audits         │
        │  5. Prompt build  assemble bounded context + user prompt    │
        │  6. LLM audit     OpenAI structured output (Zod schema)     │
        │  7. Validate      parse, clamp, sanity-check                │
        │  8. Persist       store audit + report in D1                │
        │  9. Respond       typed JSON or typed error                 │
        └──────────────────────────┬───────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        npm registry         GitHub REST API      OpenAI API
        (metadata,           (repo stats,         (structured
         advisories)          license, activity)   completion)
                                   │
                                   ▼
                           Cloudflare D1
                   (package_audits, package_dependencies,
                    audit_reports, llm_interactions, findings,
                    rate_limits, providers, users, sessions,
                    password_reset_tokens, provider_limits, provider_usage)
```

---

## 3. Pipeline Stages

### 3.1 Intake & Validation

**Owner:** `app/api/audit/route.ts`

- Accept `{ libraryUrl: string, prompt?: string }`.
- Reject missing/empty `libraryUrl` with `400`.
- Normalize on the client (`normalizeUrl`): bare package names become
  `https://www.npmjs.com/package/<name>`; URLs pass through trimmed.
- Server re-validates: only npm package URLs and `github.com` URLs are
  supported; anything else → typed `UnsupportedSourceError` (422 with code).
- Prompt is optional, trimmed, and length-capped to 1,000 chars
  (`MAX_PROMPT_LENGTH` in `app/lib/audit.ts`) to bound token spend.

### 3.2 Library Resolution

**Owner:** `app/lib/audit.ts` (`resolveLibrary`)

Two source adapters produce a uniform `LibraryContext`:

```ts
interface LibraryContext {
  source: "npm" | "github";
  url: string;          // canonical input URL
  name: string;         // package name or owner/repo
  version: string;      // npm version, or "latest" for GitHub
  metadata: NpmMetadata | GitHubRepo;
}
```

- **npm adapter** — parses `/package/<name>` (scoped packages supported),
  fetches `https://registry.npmjs.org/<name>`, `revalidate: 0` (no Next data
  cache). 404 → `PackageNotFoundError`.
- **GitHub adapter** — parses `/<owner>/<repo>`, fetches
  `https://api.github.com/repos/<owner>/<repo>` with a `User-Agent` header.
  404 → `RepoNotFoundError`; 403/429 → `UpstreamRateLimitError` with optional
  `Retry-After` header. The adapter also fetches the repo's `package.json`
  from `raw.githubusercontent.com` so GitHub audits include dependency data
  (see §3.3).

### 3.3 Enrichment (Shipped)

LLM inference over raw metadata hallucinates risk details. The enrichment
layer injects **deterministic, verifiable signals** into the context before
the LLM call and feeds the scoring rubric:

| Signal                    | Source                              | Use                          |
| ------------------------- | ----------------------------------- | ---------------------------- |
| Security advisories       | npm audit endpoint / GitHub Advisories API | Verified CVE/GHSA list |
| Publish recency           | npm `time` field                    | Maintenance health           |
| Weekly downloads          | npm downloads API                   | Popularity baseline          |
| Repo activity             | GitHub `pushed_at`, open issues     | Maintenance health           |
| License SPDX id           | npm `license` / GitHub license API  | Compatibility verdict        |
| Maintainer count          | npm `maintainers` / GitHub collabs  | Bus-factor risk              |

Enrichment runs in parallel (`Promise.all`), each signal independently
failure-tolerant: a failed signal is omitted, never fatal.

### 3.4 Cache Check

Key: `sha256(source + name + version + normalizedPrompt)` — or without the
prompt when using the default. Lookups:

1. **D1 `audit_reports`** — durable dedupe; hit returns stored report with
   `meta.cached: true` metadata.
2. **KV (optional)** — short-TTL hot cache for trending packages (planned).

TTL policy: 24h for `latest`-version audits, effectively permanent for pinned
versions (`pkg@1.2.3`). Cache writes happen after validation (§3.7).

### 3.5 Prompt Assembly

**Owner:** `app/lib/audit.ts` (`buildPrompt`)

- System prompt fixes the persona ("software supply-chain auditor") and the
  behavioral constraints (factual, conservative, mark uncertainty as lower
  severity).
- User message = resolved prompt (user's or `DEFAULT_PROMPT`) + `LibraryContext`
  fields + metadata as a fenced JSON block.
- **Bounding:** metadata is truncated to ~8KB (`MAX_METADATA_BYTES`) before
  assembly — npm `readme` fields in particular can be megabytes. Prefer
  curated fields over the raw registry document.

### 3.6 LLM Audit

**Owner:** `app/lib/llm` (`runLibraryAudit` in `llm/audit.ts`) and
`app/lib/run-audit.ts`

- Model: configurable per provider; default is `gpt-4o-mini` via the OpenAI
  adapter. Supports OpenAI-compatible, Anthropic Claude, and Google Gemini.
- Mechanism: provider-specific structured-output adapters in
  `app/lib/llm/structured.ts` produce Zod-validated JSON.
- One call per audit in standard mode; competition mode runs two audits plus
  a merge judge.
- Streaming: `POST /api/audit/stream` emits NDJSON progress events.
- Failure modes: refusal / unparsed completion → `AuditParseError`
  (one retry with a stricter system reminder, then 502).

### 3.7 Validation & Post-Processing

The Zod schema is the contract:

```ts
auditResultSchema = {
  name, version,
  score: number (0–100),
  summary: string,
  risks: [{ severity: critical|high|medium|low, title, description }],
  dependencies: [{ name, version, license, transitive }],
  license: { type, compatible, note },
  maintainers: string[],
  lastPublished: string,
  weeklyDownloads: string,
}
```

Post-parse checks (shipped in `postProcessAuditResult`):

- Clamp/dedupe risks; cap list lengths (risks ≤ 20, dependencies ≤ 500).
- Cross-check `name`/`version` against resolved context; override if the
  model drifted.
- When enrichment is live: recompute `score` deterministically from signals
  and use the LLM score only as a fallback (see §5).

### 3.8 Persistence

**Owner:** `app/lib/db.ts`, `migrations/`

Current schema spans migrations `0001_initial.sql` through `0013_audit_meta_columns.sql`:

- `package_audits` — one row per audited library URL.
- `package_dependencies` — dependency rows keyed by `audit_id`
  (populated by `/api/dependencies`, not by `/api/audit`).
- `audit_reports` (shipped in `0002_audit_reports.sql`):

```sql
CREATE TABLE audit_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id INTEGER NOT NULL REFERENCES package_audits(id) ON DELETE CASCADE,
  prompt TEXT,                 -- NULL when default
  model TEXT NOT NULL,         -- e.g. "gpt-4o-mini"
  score INTEGER NOT NULL,
  result_json TEXT NOT NULL,   -- full validated AuditResult
  cache_key TEXT UNIQUE,       -- §3.4 dedupe key
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Write path: insert `package_audits` row → insert `audit_reports` row →
insert normalized finding/dependency rows in one `db.batch` (matching the
existing `saveDependencyTree` pattern). Additional tables include
`llm_interactions`, `audit_risks`, `audit_cves`, `audit_findings`,
`audit_investigation_areas`, `rate_limits`, `providers`, `users`, `sessions`,
`password_reset_tokens`, `provider_limits`, and `provider_usage`.

### 3.9 Response

- Success: `{ result: AuditResult, meta: { cached: boolean, auditId } }`.
- Errors: `{ error: string, code: ErrorCode }` with appropriate status
  (400 input, 404 not found, 429 rate-limited, 502 upstream/LLM).

---

## 4. Error Taxonomy

| Error                    | Where raised            | Status | Client message intent            |
| ------------------------ | ----------------------- | ------ | -------------------------------- |
| `MissingInputError`      | intake                  | 400    | "libraryUrl is required"         |
| `UnsupportedSourceError` | resolve                 | 422    | supported URL formats            |
| `PackageNotFoundError`   | npm adapter             | 404    | package not found                |
| `RepoNotFoundError`      | GitHub adapter          | 404    | repo not found / private         |
| `UpstreamRateLimitError` | adapters / OpenAI       | 429    | retry after N seconds            |
| `RateLimitExceededError` | `/api/audit`, `/api/audit/stream` | 429    | retry after N seconds            |
| `EnrichmentUnavailable`  | enrichment              | —      | non-fatal; signal omitted        |
| `AuditParseError`        | LLM stage               | 502    | audit failed, safe to retry      |
| `DbUnavailableError`     | `getDb()` (no binding)  | 500    | misconfiguration (already exist) |
| `UNAUTHORIZED`           | auth routes             | 401    | invalid credentials / no session |
| `FORBIDDEN`              | admin routes            | 403    | admin access required            |
| `CONFLICT`               | user registration/update| 409    | duplicate email/username         |

Rule: expected upstream failures never surface as bare 500s.

---

## 5. Scoring Model (Shipped)

The 0–100 trust score is computed by a deterministic rubric in
`app/lib/score.ts` (`computeScore`), using enrichment signals from
`app/lib/signals.ts`. The LLM score is still produced and stored, but the
rubric score takes precedence when signals are available.

```
score = 100
      - Σ severityWeights[advisory severity]   (verified advisories)
      - maintenancePenalty                     (staleness, low activity)
      - busFactorPenalty                       (single maintainer)
      - licensePenalty                         (unknown/copyleft vs policy)
      + popularityBonus (capped)               (downloads, stars)
clamp(0, 100)
```

Severity bands: ≥80 healthy, 60–79 caution, <60 review required — matches the
existing `scoreVariant` thresholds in `app/page.tsx`.

---

## 6. Cross-Cutting Concerns

### Rate Limiting

Per-IP token bucket on `/api/audit` (the only OpenAI-cost route). Workers-
compatible implementation (D1 counter or KV), e.g. 10 audits/IP/hour
anonymous. Turnstile gate if abuse appears (see TODO §4.4).

### Cost Guardrails

- One OpenAI call per audit; bounded context (~8KB metadata cap).
- Cache hits cost zero.
- Track `tokens_total` per audit in `audit_reports` (`0007_audit_report_tokens_total.sql`)
  for spend monitoring.

### Security

- `OPENAI_API_KEY` only via env/Wrangler secrets; never client-side.
- Outbound fetches restricted to npm registry, GitHub API, and
  `raw.githubusercontent.com` — no user-controlled URLs fetched directly
  (SSRF guard: resolution parses and rebuilds URLs; it never fetches the
  raw user input).
- All API input validated server-side regardless of client normalization.

### Performance Budget

- Cached audit: < 500ms p50.
- Fresh audit: < 15s p50 (LLM-bound); enrichment adds ≤ 1s (parallel).
- Streaming is available via `POST /api/audit/stream`; if standard audit
  latency becomes a UX issue, the stream progressively emits sections.

---

## 7. Extension Points

1. **Source adapters** — new sources (PyPI, crates.io) implement the
   `LibraryContext` adapter contract; the rest of the pipeline is unchanged.
2. **Signals** — new enrichment signals register in the enrichment registry
   and optionally extend the scoring rubric.
3. **Re-audit scheduling** — **shipped**: per-user watchlist, custom-worker
   Cron Trigger (`worker.ts` + `wrangler.jsonc` triggers) re-runs watched
   packages every 6h via `runReAuditTick` (`app/lib/re-audit.ts`), respecting
   provider daily budgets; `diffReports` (`app/lib/report-diff.ts`) computes
   on-read diffs surfaced on `/report/[id]`. Admin trigger:
   `POST /api/admin/re-audit`.
4. **Auth context consolidation** — **shipped**: `useAuth` is a top-level
   `AuthProvider` in `app/layout.tsx` (single shared session fetch).
5. **Page component extraction** — **shipped**: `app/page.tsx` is pure
   orchestration (~156 lines); the form, progress card, result tabs,
   model picker, and explainer live in `app/components/`.
6. **Diff notifications** — **shipped**: `runReAuditTick` fans out an
   in-app notification to each watcher when a re-audit diff is
   significant (new critical/high risk, new CVE, or score drop ≥ 10);
   unread same-target rows collapse; served by `/api/notifications`
   and the header bell feed. Spec:
   `docs/superpowers/specs/2026-09-17-diff-notifications-design.md`.

---

## 8. Implementation Map

| Stage             | File                                              | State    |
| ----------------- | ------------------------------------------------- | -------- |
| Intake            | `app/api/audit/route.ts`, `app/api/audit/stream/route.ts` | shipped  |
| Resolution        | `app/lib/audit.ts`                                | shipped  |
| Enrichment        | `app/lib/signals.ts`                              | shipped  |
| Cache             | `app/lib/cache.ts`                                | shipped  |
| LLM audit         | `app/lib/llm/`                                    | shipped  |
| Audit pipeline    | `app/lib/run-audit.ts`                            | shipped  |
| Validation        | `app/lib/audit.ts` (schema + post-processing)     | shipped  |
| Persistence       | `app/lib/db/`, `migrations/`                      | shipped  |
| Rate limiting     | `app/lib/rate-limit.ts`                           | shipped  |
| Scoring rubric    | `app/lib/score.ts`                                | shipped  |
| CVE enrichment    | `app/lib/cve.ts`                                  | shipped  |
| Codebase inspection | `app/lib/codebase.ts`                           | shipped  |
| Provider config   | `app/lib/providers.ts`, `app/api/providers/`      | shipped  |
| Auth / users      | `app/lib/auth.ts`, `app/api/auth/`, `app/api/users/` | shipped  |
| Admin             | `app/api/admin/`, `app/admin/`                    | shipped  |
| Route helpers     | `app/lib/api.ts`                                  | shipped  |
| Watchlist         | `app/lib/db/watchlist.ts`, `app/api/watchlist/`   | shipped  |
| Re-audit runner   | `app/lib/re-audit.ts`, `worker.ts`                | shipped  |
| Report diffing    | `app/lib/report-diff.ts`, `app/components/report-diff-card.tsx` | shipped  |
