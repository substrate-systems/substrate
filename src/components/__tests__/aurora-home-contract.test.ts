import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("authored aurora homepage contract", () => {
  it("preserves the approved responsive hero hierarchy and Explore control", () => {
    const hero = source("src/components/Hero.tsx");

    assert.match(hero, /A foundational systems company\./);
    assert.match(hero, /Owned machines\. Durable memory\. Source-grounded AI\./);
    assert.match(hero, /aurora-hero-mobile\.jpg/);
    assert.match(hero, /aurora-hero-tablet\.jpg/);
    assert.match(hero, /aurora-hero-desktop\.jpg/);
    assert.match(hero, /<picture>/);
    assert.match(hero, /sm:object-\[44%_50%\]/);
    assert.match(hero, /href="#content"/);
    assert.match(hero, /min-h-11/);
    assert.match(hero, /min-w-11/);
    assert.match(hero, /useReducedMotion/);
    assert.doesNotMatch(hero, /metal-structure-dark\.jpg/);
  });

  it("keeps the photo series and authored OG treatment discoverable", () => {
    const footer = source("src/components/Footer.tsx");
    const work = source("src/app/work/page.tsx");
    const sitemap = source("src/app/sitemap.ts");
    const og = source("src/app/api/og/route.tsx");

    assert.match(footer, /Photography/);
    assert.match(footer, /href: "\/photography"/);
    assert.match(work, /href="\/photography"/);
    assert.match(sitemap, /\/photography`/);
    assert.match(sitemap, /\/photography\/iceland-aurora`/);
    assert.match(og, /aurora-hero-og\.jpg/);
    assert.doesNotMatch(og, /metal-structure-dark\.jpg/);
  });

  it("retains the authored-image provenance and the legacy material credit", () => {
    const layout = source("src/app/layout.tsx");
    const attributions = source("ATTRIBUTIONS.md");
    const designSystem = source("DESIGN_SYSTEM.md");

    assert.doesNotMatch(layout, /Adrien Olichon|Pexels/);
    assert.match(layout, /Hugo Ander Kivi/);
    assert.match(attributions, /Hugo Ander Kivi/);
    assert.match(attributions, /Adrien Olichon/);
    assert.match(attributions, /not the active homepage hero/i);
    assert.match(designSystem, /Authored Photographic Atmosphere/);
    assert.match(designSystem, /product proof/i);
  });
});
