/**
 * Seeds the Exomem Cloud image history (automate-cloud-releases D1, migration
 * steps 1 and 6) from a list of published releases and the live Cloud tables.
 *
 * The list is a JSON array of `{ "release": "vX.Y.Z", "image": "<repository>@sha256:<hex>" }`,
 * one entry for each published release's cell image. The runbook builds it.
 * It is a dry run by default and prints counts only; `--commit` writes. A
 * second run adds nothing.
 *
 *   npx tsx scripts/seed-cloud-image-history.ts --releases releases.json
 *   npx tsx scripts/seed-cloud-image-history.ts --releases releases.json --commit
 */

import { readFileSync } from "node:fs";
import {
  seedCloudImageHistory,
  type PublishedCloudRelease,
} from "../src/lib/exomem-hosted/cloud-release";

function releasesFrom(path: string): PublishedCloudRelease[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("the releases file must hold a JSON array");
  return parsed.map((entry: unknown) => {
    const { release, image } = (entry ?? {}) as Record<string, unknown>;
    if (typeof release !== "string" || typeof image !== "string") {
      throw new Error("each release needs a string release and image");
    }
    return { release, image };
  });
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--releases");
  const path = index === -1 ? undefined : process.argv[index + 1];
  if (!path) throw new Error("pass --releases <file>");
  const commit = process.argv.includes("--commit");
  const releases = releasesFrom(path);
  const result = await seedCloudImageHistory(releases, { commit });
  console.log(
    `[cloud-image-history] mode=${commit ? "commit" : "dry-run"}; releases=${releases.length} ` +
      `added_from_releases=${result.addedReleases} added_from_live=${result.addedLive}`
  );
}

main().catch((error) => {
  console.error("[cloud-image-history] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
