/**
 * Final Release-A switch. This command is deliberately not a migration or a
 * cron task: an operator must run the reconciliation first and explicitly
 * acknowledge the irreversible visibility/rollback boundary.
 */

import {
  enableStrictGenerationVisibility,
  getGenerationVisibilityPolicy,
} from "../src/lib/hosted-backup/db";

async function main(): Promise<void> {
  if (process.env.CONFIRM_STRICT_GENERATION_VISIBILITY !== "yes") {
    throw new Error("set CONFIRM_STRICT_GENERATION_VISIBILITY=yes to run strict cutover");
  }
  const before = await getGenerationVisibilityPolicy();
  const result = await enableStrictGenerationVisibility();
  if (result === "blocked_pending_legacy") {
    throw new Error(
      `strict cutover refused: ${before.pendingPreCutoffLegacyVersions} pre-cutoff legacy generation(s) remain pending`
    );
  }
  console.log(
    `[generation-cutover] ${result}; cutoff=${before.legacyCutoff}; pending=${before.pendingPreCutoffLegacyVersions}`
  );
}

main().catch((error) => {
  console.error("[generation-cutover] failed:", error);
  process.exit(1);
});
