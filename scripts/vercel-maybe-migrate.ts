/**
 * Conditional production/staging migration step for Vercel builds.
 *
 * Vercel runs `npm run vercel-build` (when present in package.json) on every
 * deploy. We chain this script in front of `next build` so production deploys
 * apply pending migrations against production. The exact branch-bound staging
 * Preview may also migrate its named isolated database; every other preview
 * skips migration entirely.
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

import { applyMigrations } from "./migrate";
import { resolveVercelMigrationTarget } from "./vercel-migration-target";

const skip = process.env.SKIP_VERCEL_MIGRATE === "1";

async function main() {
  if (skip) {
    console.log("[vercel-maybe-migrate] SKIP_VERCEL_MIGRATE=1 — skipping");
    return;
  }
  const target = resolveVercelMigrationTarget(process.env);
  if (target.action === "skip") {
    console.log("[vercel-maybe-migrate] skipping (not production or staging)");
    return;
  }
  console.log(`[vercel-maybe-migrate] target=${target.target} — applying pending migrations`);
  await applyMigrations({
    dry: false,
    ...(target.target === "staging" ? { expectedSchema: target.expectedSchema } : {}),
  });
}

main().catch((err) => {
  console.error("[vercel-maybe-migrate] failed:", err);
  process.exit(1);
});
