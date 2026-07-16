import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("authored aurora homepage contract", () => {
  it("states the approved hero hierarchy", () => {
    const hero = source("src/components/Hero.tsx");

    assert.match(hero, /A foundational systems company\./);
    assert.match(hero, /Owned machines\. Durable memory\. Source-grounded AI\./);
    assert.doesNotMatch(hero, /Software infrastructure for durable systems\./);
  });

  it("reveals the approved two-part thesis through a reduced-motion-safe clip mask", () => {
    const hook = source("src/components/Hook.tsx");
    const normalizedHook = hook.replace(/\s+/g, " ");

    assert.match(hook, /Software should leave you with more control, not less\./);
    assert.match(
      normalizedHook,
      /Substrate builds systems for continuity—across machines, knowledge, and the memory our tools carry forward\./
    );
    assert.match(hook, /overflow-hidden/);
    assert.match(hook, /clipPath/);
    assert.match(hook, /useReducedMotion/);
  });

  it("connects the thesis to the statement spine across aligned section boundaries", () => {
    const hook = source("src/components/Hook.tsx");
    const philosophy = source("src/components/Philosophy.tsx");

    assert.match(hook, /<div\s+data-narrative-connector-base="hook"/);
    assert.match(hook, /data-narrative-connector-signal="hook"/);
    assert.match(hook, /max-w-3xl/);
    assert.match(hook, /pb-0/);
    assert.match(philosophy, /<div\s+data-narrative-connector-base="philosophy"/);
    assert.match(philosophy, /data-narrative-connector-signal="philosophy"/);
    assert.match(philosophy, /max-w-3xl/);
    assert.match(philosophy, /top-0/);
    assert.match(philosophy, /pt-32/);
    assert.doesNotMatch(hook, /<motion\.div\s+data-narrative-connector-base=/);
    assert.doesNotMatch(philosophy, /<motion\.div\s+data-narrative-connector-base=/);
    assert.match(hook, /data-narrative-connector-signal="hook"[\s\S]*?scaleY/);
    assert.match(philosophy, /data-narrative-connector-signal="philosophy"[\s\S]*?scaleY/);
  });

  it("renders the approved philosophy sequence in normal flow with a structural spine", () => {
    const philosophy = source("src/components/Philosophy.tsx");
    const statements = [
      "Your setup should survive the machine.",
      "Your memory should outlive the session.",
      "Your AI should show its sources.",
    ];

    statements.forEach((statement) =>
      assert.match(philosophy, new RegExp(statement.replace(".", "\\.")))
    );
    assert.ok(
      statements.every(
        (statement, index) =>
          index === 0 || philosophy.indexOf(statements[index - 1]) < philosophy.indexOf(statement)
      ),
      "philosophy statements should remain in the approved order"
    );
    assert.doesNotMatch(
      philosophy,
      /Systems precede products|Constraints enable clarity|Foundations compound|Simplicity is not reduction/
    );
    assert.match(philosophy, /aria-hidden="true"/);
    assert.match(philosophy, /useReducedMotion/);
    assert.doesNotMatch(philosophy, /\bsticky\b|\bfixed\b/);
  });

  it("uses the approved product descriptions and restrained interaction semantics", () => {
    const products = source("src/components/Products.tsx");

    assert.match(
      products,
      /Source-grounded AI for content libraries\. Turn original material into a branded knowledge system with answers that cite their sources\./
    );
    assert.match(
      products,
      /Local-first Windows setup and restore\. Capture your apps and settings once, then rebuild a fresh machine in minutes\./
    );
    assert.match(
      products,
      /Durable memory for AI agents, built on Markdown you own\. Carry context across sessions without surrendering the source\./
    );
    assert.match(products, /group-focus-visible:/);
    assert.match(products, /motion-reduce:/);
    assert.match(products, /focus-visible:outline-2/);
    assert.match(products, /focus-visible:outline-border-strong/);
  });

  it("uses responsive authored hero images and no longer references the stock hero", () => {
    const hero = source("src/components/Hero.tsx");

    assert.match(hero, /aurora-hero-mobile\.jpg/);
    assert.match(hero, /aurora-hero-tablet\.jpg/);
    assert.match(hero, /aurora-hero-desktop\.jpg/);
    assert.match(hero, /<picture>/);
    assert.match(hero, /media="\(max-width: 639px\)"/);
    assert.match(
      hero,
      /media="\(min-width: 640px\) and \(max-width: 1023px\) and \(orientation: portrait\)"/
    );
    assert.match(hero, /sm:object-\[44%_50%\]/);
    assert.match(hero, /lg:object-\[50%_50%\]/);
    assert.doesNotMatch(hero, /metal-structure-dark\.jpg/);
  });

  it("provides a clear, keyboard-sized Explore link to the first content section", () => {
    const hero = source("src/components/Hero.tsx");
    const hook = source("src/components/Hook.tsx");

    assert.match(hero, /href="#content"/);
    assert.match(hero, /Explore/);
    assert.match(hero, /min-h-11/);
    assert.match(hero, /min-w-11/);
    assert.match(hero, /focus-visible:/);
    assert.match(hook, /id="content"/);
    assert.match(hook, /scroll-mt-/);
  });

  it("shows Explore immediately when reduced motion is requested", () => {
    const globals = source("src/app/globals.css");
    const reducedMotionBlock =
      globals.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] ?? "";

    assert.match(reducedMotionBlock, /\.animate-scroll-indicator/);
    assert.match(reducedMotionBlock, /opacity: 1/);
    assert.match(reducedMotionBlock, /animation: none !important/);
  });

  it("keeps photography discoverable through quiet secondary navigation", () => {
    const footer = source("src/components/Footer.tsx");
    const work = source("src/app/work/page.tsx");
    const sitemap = source("src/app/sitemap.ts");

    assert.match(footer, /Photography/);
    assert.match(footer, /href: "\/photography"/);
    assert.match(work, /href="\/photography"/);
    assert.match(sitemap, /\/photography`/);
    assert.match(sitemap, /\/photography\/iceland-aurora`/);
  });

  it("uses the authored aurora for the default OG treatment", () => {
    const og = source("src/app/api/og/route.tsx");

    assert.match(og, /aurora-hero-og\.jpg/);
    assert.doesNotMatch(og, /metal-structure-dark\.jpg/);
    assert.match(og, /linear-gradient/);
  });

  it("records authored hero provenance and retains the legacy material credit", () => {
    const layout = source("src/app/layout.tsx");
    const attributions = source("ATTRIBUTIONS.md");
    const designSystem = source("DESIGN_SYSTEM.md");

    assert.doesNotMatch(layout, /Adrien Olichon|Pexels/);
    assert.match(layout, /Hugo Ander Kivi/);
    assert.match(layout, /original/i);

    assert.match(attributions, /Hugo Ander Kivi/);
    assert.match(attributions, /original/i);
    assert.match(attributions, /no third-party attribution required/i);
    assert.match(attributions, /Adrien Olichon/);
    assert.match(attributions, /Pexels/);
    assert.match(attributions, /legacy|retired/i);
    assert.match(attributions, /not the active homepage hero/i);
    assert.match(designSystem, /Authored Photographic Atmosphere/);
    assert.match(designSystem, /composition and emotion/i);
    assert.match(designSystem, /product proof/i);
  });
});
