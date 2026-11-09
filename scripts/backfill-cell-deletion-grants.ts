/**
 * Backfills a deletion grant onto every cell deleted before
 * EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY went live
 * (automate-cell-storage-deletion, rollout step 10).
 *
 * Run this only at that rollout step, after the rehearsal, with operator
 * approval. It is a dry run by default and prints counts only; `--commit`
 * signs and stores each missing grant, each in its own transaction. A
 * backfilled grant starts a full 7-day grace.
 *
 *   npx tsx scripts/backfill-cell-deletion-grants.ts
 *   npx tsx scripts/backfill-cell-deletion-grants.ts --commit
 */

import { backfillCellDeletionGrants } from "../src/lib/exomem-hosted/cloud-deletion-grants";

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const result = await backfillCellDeletionGrants({ commit });
  console.log(
    `[cell-deletion-grants] mode=${commit ? "commit" : "dry-run"}; ` +
      `granted=${result.granted} alreadyGranted=${result.alreadyGranted}`
  );
}

main().catch((error) => {
  console.error("[cell-deletion-grants] failed:", error);
  process.exit(1);
});
