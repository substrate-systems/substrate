/**
 * Conditional production migration step for Vercel builds.
 *
 * Vercel runs `npm run vercel-build` (when present in package.json) on every
 * deploy. We chain this script in front of `next build` so production deploys
 * apply any pending migrations against the production database, while preview
 * and development deploys skip migration entirely — preview builds must never
 * touch the production schema.
 *
 * Failure mode: a failing migration aborts the build with a non-zero exit
 * code, which Vercel surfaces as a failed deploy. The previous deploy stays
 * live. This is the desired behavior — better to fail loudly than ship code
 * that 500s on the first request to touch a missing table (the gui-v2.8.0 /
 * migration 0015 incident, 2026-05-27).
 *
 * Manual override: set `SKIP_VERCEL_MIGRATE=1` in Vercel project env to
 * temporarily disable. Use sparingly — the whole point of this script is to
 * keep the schema and the deployed code in lockstep.
 */

import { applyMigrations } from './migrate';

const env = process.env.VERCEL_ENV ?? 'unset';
const skip = process.env.SKIP_VERCEL_MIGRATE === '1';

async function main() {
  if (skip) {
    console.log('[vercel-maybe-migrate] SKIP_VERCEL_MIGRATE=1 — skipping');
    return;
  }
  if (env !== 'production') {
    console.log(`[vercel-maybe-migrate] VERCEL_ENV=${env} — skipping (production-only)`);
    return;
  }
  console.log('[vercel-maybe-migrate] VERCEL_ENV=production — applying pending migrations');
  await applyMigrations({ dry: false });
}

main().catch((err) => {
  console.error('[vercel-maybe-migrate] failed:', err);
  process.exit(1);
});
