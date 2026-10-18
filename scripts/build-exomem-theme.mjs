/**
 * Bundle the synchronous Exomem prepaint entry with its maintained hash implementation.
 * Regenerate: npm run sync:exomem-theme
 * Verify: npm run check:exomem-theme
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../src/lib/exomem/theme-prepaint.ts", import.meta.url);
const target = new URL("../src/lib/exomem/theme-script.generated.ts", import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(source)],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  legalComments: "none",
});
const generated =
  "// Generated from theme-prepaint.ts by scripts/build-exomem-theme.mjs.\n// prettier-ignore\n" +
  `export const exomemThemeScript =\n  ${JSON.stringify(result.outputFiles[0].text.trim())};\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8").catch(() => "")) !== generated) {
    console.error("Exomem prepaint script is stale. Run npm run sync:exomem-theme.");
    process.exitCode = 1;
  }
} else {
  await writeFile(target, generated);
}
