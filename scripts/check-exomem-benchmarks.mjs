// Keeps the landing's recall figures in step with the Exomem repo's docs/benchmarks.md.
//
//   node scripts/check-exomem-benchmarks.mjs <path-to-benchmarks.md>
//     Hashes the doc as git does (its blob hash) and exits 1 when the hash differs
//     from `sourceBlob` in src/app/exomem/landing/recall-benchmarks.json. The weekly
//     drift workflow runs this against Exomem main.
//
// The figures are read from the doc's prose by a person, not parsed, so the check
// pins the whole doc: any edit to it fails the run. A failure costs one re-read of
// the doc; a stale figure would put a number on the public page that the
// measurements no longer show.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const JSON_PATH = fileURLToPath(
  new URL("../src/app/exomem/landing/recall-benchmarks.json", import.meta.url)
);

/** The hash `git hash-object` gives a file: sha1 of "blob <bytes>\0" and the bytes. */
function gitBlobHash(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function main([docFile]) {
  if (!docFile) throw new Error("usage: check-exomem-benchmarks.mjs <path-to-benchmarks.md>");
  const { source, sourceBlob } = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const actual = gitBlobHash(readFileSync(docFile));
  if (actual !== sourceBlob) {
    throw new Error(
      `docs/benchmarks.md changed since the landing copied its figures.\n` +
        `  copied from: ${source} (blob ${sourceBlob})\n` +
        `  now:         blob ${actual}\n` +
        `  refresh src/app/exomem/landing/recall-benchmarks.json: re-read the doc, update the\n` +
        `  figures, "source" (the Exomem commit) and "sourceBlob" (${actual}).`
    );
  }
  console.log(`recall figures match ${docFile} (blob ${actual})`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
