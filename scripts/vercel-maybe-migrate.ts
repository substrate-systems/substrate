/**
 * Conditional production and staging migration step for Vercel builds.
 *
 * Vercel runs `npm run vercel-build` (when present in package.json) on every
 * deploy. We chain this script in front of `next build` so production deploys
 * apply any pending migrations against the production database, and deploys of
 * the `staging` branch apply them against the staging database. Every other
 * preview and development deploy skips migration entirely — those builds must
 * never touch a database.
 *
 * Why staging is safe: production's `DATABASE_URL` and `DATABASE_MIGRATION_URL`
 * are scoped to Vercel's production target only. A preview build of `staging`
 * sees only the values scoped to branch `staging`, which name the staging
 * database. The control-plane key check below catches a staging deploy that
 * has no environment at all.
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

import { fileURLToPath } from 'node:url';
import { controlPlaneKeyFromEnv } from '../src/lib/exomem-hosted/security';
import { applyMigrations } from './migrate';

type BuildEnv = Record<string, string | undefined>;

/** The database a build may migrate: `production`, `staging`, or none. */
export function migrationTarget(env: BuildEnv): 'production' | 'staging' | null {
  if (env.VERCEL_ENV === 'production') return 'production';
  if (env.VERCEL_ENV === 'preview' && env.VERCEL_GIT_COMMIT_REF === 'staging') return 'staging';
  return null;
}

async function main() {
  if (process.env.SKIP_VERCEL_MIGRATE === '1') {
    console.log('[vercel-maybe-migrate] SKIP_VERCEL_MIGRATE=1 — skipping');
    return;
  }
  const target = migrationTarget(process.env);
  if (!target) {
    const env = process.env.VERCEL_ENV ?? 'unset';
    console.log(`[vercel-maybe-migrate] VERCEL_ENV=${env} — skipping (production and staging only)`);
    return;
  }
  if (target === 'staging') {
    // Throws when the staging environment is missing or malformed.
    controlPlaneKeyFromEnv();
  }
  console.log(`[vercel-maybe-migrate] ${target} build — applying pending migrations`);
  await applyMigrations({ dry: false });
}

// Only runs when invoked directly, so the test can import migrationTarget.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[vercel-maybe-migrate] failed:', err);
    process.exit(1);
  });
}
