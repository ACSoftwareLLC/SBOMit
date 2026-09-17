// Custom worker entry per https://opennext.js.org/cloudflare/howtos/custom-worker
// The generated `.open-next/worker.js` exports only `fetch`; this wrapper adds
// the scheduled (cron) handler for re-audit ticks.
//
// IMPORTANT: this file is bundled by wrangler's esbuild separately from the
// Next.js app — no `@/` path aliases here. All imports are relative, and any
// module pulled in transitively must also avoid alias specifiers.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore `.open-next/worker.js` is generated at build time (present for
// typecheck in CI, absent on fresh checkouts) — ts-expect-error would be
// brittle in exactly one of those two states.
import { default as handler } from "./.open-next/worker.js";
import { runReAuditTick } from "./app/lib/re-audit";

export default {
  fetch: handler.fetch,

  async scheduled(
    event: ScheduledController,
    env: Cloudflare.Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      runReAuditTick(env.DB, {
        limit: Number(env.RE_AUDIT_MAX_PER_TICK) || 5,
      }),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;
