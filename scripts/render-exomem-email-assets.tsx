/**
 * Renders the state bands every Evermatter email loads, each in the dark and
 * the light scheme, as 1200 × 240 PNGs. Gmail strips SVG, so emails need PNGs;
 * this keeps them in step with the design.
 *
 * The bands come from the "The band follows the account" row of the R28 board
 * (docs/exomem-design/reference/boards/R28-Emails.dc.html), drawn in the ink
 * and amber tokens of each scheme on the scheme's page ground. They land in the
 * brand kit's email folder (public/evermatter/email). The wordmark PNGs in that
 * folder are not drawn here: the brand kit renders them from its wordmark SVG
 * (docs/exomem-design/brand/evermatter-brand-kit/README.md). Run this after a
 * board or token change, then commit the images:
 *
 *   npx tsx scripts/render-exomem-email-assets.tsx
 *
 * Dev tooling: it needs Playwright's Chromium and is not part of CI.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { chromium } from "@playwright/test";
import { exomemTokens } from "../src/lib/exomem/design-tokens";
import {
  EXOMEM_EMAIL_ASSET_PATH,
  EXOMEM_EMAIL_BANDS,
  exomemEmailBandFile,
  type ExomemEmailBand,
  type ExomemEmailScheme,
} from "../src/lib/email-templates/exomem-email";

const BOARD = path.join(process.cwd(), "docs/exomem-design/reference/boards/R28-Emails.dc.html");
const OUT = path.join(process.cwd(), "public", EXOMEM_EMAIL_ASSET_PATH);
const BAND_ROW_TITLE = "The band follows the account";
// The board draws the bands in its literal dark ink and its {{accent}} hole.
const BOARD_INK = "#ece9e2";
const BOARD_ACCENT = "{{accent}}";
const SCHEMES: readonly ExomemEmailScheme[] = ["dark", "light"];

/** The six band SVGs of the board's band row, keyed by the label under each. */
function boardBands(): Map<ExomemEmailBand, SVGSVGElement> {
  const { document } = new JSDOM(readFileSync(BOARD, "utf8")).window;
  const title = [...document.querySelectorAll("div")].find(
    (element) => element.textContent?.trim() === BAND_ROW_TITLE
  );
  const row = title?.nextElementSibling;
  if (!row) throw new Error(`R28: no "${BAND_ROW_TITLE}" row`);
  const bands = new Map<ExomemEmailBand, SVGSVGElement>();
  for (const column of row.children) {
    const svg = column.querySelector("svg");
    const label = column.querySelector(":scope > span")?.textContent?.trim();
    if (!svg || !label) throw new Error("R28: a band column without its SVG or label");
    if (!(EXOMEM_EMAIL_BANDS as readonly string[]).includes(label)) {
      throw new Error(`R28: unknown band "${label}"`);
    }
    bands.set(label as ExomemEmailBand, svg as unknown as SVGSVGElement);
  }
  const missing = EXOMEM_EMAIL_BANDS.filter((band) => !bands.has(band));
  if (missing.length > 0) throw new Error(`R28: missing bands ${missing.join(", ")}`);
  return bands;
}

/** The band in one scheme's ink and amber, at the email's 600 × 120 CSS size. */
function inScheme(svg: SVGSVGElement, ink: string, amber: string): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", "600");
  copy.setAttribute("height", "120");
  for (const element of [copy, ...copy.querySelectorAll("*")]) {
    for (const attribute of ["stroke", "fill"]) {
      const value = element.getAttribute(attribute)?.trim().toLowerCase();
      if (value === BOARD_INK) element.setAttribute(attribute, ink);
      else if (value === BOARD_ACCENT) element.setAttribute(attribute, amber);
    }
  }
  return copy.outerHTML;
}

function page(ground: string, content: string): string {
  return `<!doctype html><html><body style="margin: 0; background: ${ground};"><div id="shot" style="display: inline-block; line-height: 0;">${content}</div></body></html>`;
}

async function main(): Promise<void> {
  const tokens = exomemTokens();
  const bands = boardBands();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const scheme of SCHEMES) {
      const palette = tokens[scheme];
      const ground = palette["--bg-base"]!;
      const ink = palette["--fg-primary"]!;
      const amber = palette["--exo-amber"]!;

      const bandPage = await browser.newPage({
        viewport: { width: 600, height: 120 },
        deviceScaleFactor: 2,
      });
      for (const [band, svg] of bands) {
        await bandPage.setContent(page(ground, inScheme(svg, ink, amber)));
        const file = path.join(OUT, exomemEmailBandFile(band, scheme));
        writeFileSync(file, await bandPage.locator("#shot").screenshot());
        console.log(`wrote ${path.relative(process.cwd(), file)}`);
      }
      await bandPage.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
