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
 * keep the schema and the deployed code in lockstep. The override skips the
 * migrations only: a production deploy still needs a valid control-plane key.
 */

import { applyMigrations } from './migrate';
import { controlPlaneKeyFromEnv } from '../src/lib/exomem-hosted/security';

const env = process.env.VERCEL_ENV ?? 'unset';
const skip = process.env.SKIP_VERCEL_MIGRATE === '1';

/**
 * The Paddle webhook seals the payment-failed email, and the start, sign-in
 * and OAuth routes seal or key their state, with EXOMEM_CONTROL_PLANE_KEY.
 * Without a valid key each of them fails on every request, and Paddle only
 * retries its webhook. Refusing the production deploy costs one blocked
 * deploy (the previous one stays live) until the operator sets the key.
 */
function assertControlPlaneKey(): void {
  try {
    controlPlaneKeyFromEnv();
  } catch {
    throw new Error('EXOMEM_CONTROL_PLANE_KEY is missing or not 32 bytes of base64url');
  }
}

async function main() {
  if (env === 'production') assertControlPlaneKey();
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
