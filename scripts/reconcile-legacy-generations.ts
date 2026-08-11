/**
 * Manual Release-A generation backfill. Dry-run is the default; --apply is
 * intentionally required before it changes publication or quarantine state.
 * Run this repeatedly in bounded batches until strict cutover reports zero
 * pending pre-cutoff legacy rows.
 */

import {
  findLegacyUnverifiedVersionsNewestFirst,
  listChunksForVersion,
  markLegacyVerificationFailed,
  publishVerifiedLegacyVersion,
  quarantineLegacyVersion,
} from "../src/lib/hosted-backup/db";
import { HostedBackupError, errors } from "../src/lib/hosted-backup/errors";
import { headObject } from "../src/lib/hosted-backup/r2";

function option(name: string, fallback: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!value) return fallback;
  const parsed = Number(value.slice(name.length + 1));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error(`${name} must be an integer from 1 to 1000`);
  }
  return parsed;
}

async function verifyLengths(objects: Array<{ key: string; size: number }>): Promise<void> {
  for (let index = 0; index < objects.length; index += 4) {
    await Promise.all(
      objects.slice(index, index + 4).map(async (object) => {
        const result = await headObject(object.key);
        if (result.state !== "present" || result.contentLength !== object.size) {
          throw errors.uploadIncomplete({
            object: object.key,
            expectedBytes: object.size,
            actualBytes: result.contentLength ?? null,
          });
        }
      })
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = option("--limit", 250);
  const candidates = await findLegacyUnverifiedVersionsNewestFirst(limit);
  let verified = 0;
  let failed = 0;

  console.log(
    `[legacy-reconcile] ${apply ? "apply" : "dry-run"}; ${candidates.length} newest-first candidate(s)`
  );
  for (const version of candidates) {
    try {
      const chunks = await listChunksForVersion(version.id);
      await verifyLengths([
        { key: version.manifest_object_key, size: Number(version.manifest_size_bytes) },
        ...chunks.map((chunk) => ({ key: chunk.object_key, size: Number(chunk.size_bytes) })),
      ]);
      if (apply) await publishVerifiedLegacyVersion(version.id);
      verified += 1;
    } catch (error) {
      if (apply) {
        if (error instanceof HostedBackupError && error.code === "UPLOAD_INCOMPLETE") {
          await quarantineLegacyVersion(version.id, String(error));
        } else {
          await markLegacyVerificationFailed(version.id, String(error));
        }
      }
      failed += 1;
      console.error(`[legacy-reconcile] ${version.id}: ${String(error)}`);
    }
  }
  console.log(
    `[legacy-reconcile] checked=${candidates.length} verified=${verified} failed=${failed} mode=${apply ? "apply" : "dry-run"}`
  );
}

main().catch((error) => {
  console.error("[legacy-reconcile] failed:", error);
  process.exit(1);
});
