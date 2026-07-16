import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("approved Fable landing contract", () => {
  it("keeps the homepage server-rendered and isolates the two enhancement islands", () => {
    const page = source("src/app/page.tsx");

    assert.doesNotMatch(page, /[\"']use client[\"']/);
    assert.match(page, /LandingNarrative/);
    assert.match(page, /<Hero\s*\/>/);
    assert.match(page, /<LandingNarrative\s*\/>/);
    assert.match(page, /<Footer\s*\/>/);
    assert.ok(existsSync(resolve(root, "src/components/LandingSpine.tsx")));
    assert.ok(existsSync(resolve(root, "src/components/LandingRevealManager.tsx")));
  });

  it("ports the approved editorial copy, order, mapping, and exact link ownership", () => {
    const rawLanding = source("src/components/LandingNarrative.tsx");
    const landing = rawLanding.replace(/[\t\r\n ]+/g, " ");
    const principles = [
      "Your AI should show its sources.",
      "Your setup should survive the machine.",
      "Your memory should outlive the session.",
    ];

    assert.match(landing, /<ol/);
    assert.match(rawLanding, /not\u00a0less/);
    assert.ok(
      principles.every(
        (principle, index) =>
          index === 0 || landing.indexOf(principles[index - 1]) < landing.indexOf(principle)
      )
    );
    assert.match(landing, /id: "q", name: "Q", principle: principles\[0\]/);
    assert.match(landing, /id: "endstate", name: "Endstate", principle: principles\[1\]/);
    assert.match(landing, /id: "exomem", name: "Exomem", principle: principles\[2\]/);
    assert.match(landing, /href: "https:\/\/useq\.ai", external: true/);
    assert.match(landing, /href: "\/endstate", external: false/);
    assert.match(landing, /href: "\/exomem", external: false/);
    assert.match(
      landing,
      /Source-grounded AI for content libraries\. Turn original material into a branded knowledge system with answers that cite their sources\./
    );
    assert.match(
      landing,
      /Local-first Windows setup and restore\. Capture your apps and settings once, then rebuild a fresh machine in minutes\./
    );
    assert.match(
      landing,
      /Durable memory for AI agents, built on Markdown you own\. Carry context across sessions without surrendering the source\./
    );
    assert.match(landing, /Systems precede products\./);
  });

  it("adds the linked photo credit, in-hero dissolve, and lightweight lazy afterglow", () => {
    const hero = source("src/components/Hero.tsx");
    const landing = source("src/components/LandingNarrative.tsx");
    const css = source("src/app/globals.css");
    const afterglow = resolve(root, "public/brand/materials/aurora-afterglow.jpg");

    assert.match(hero, /href="\/photography"/);
    assert.match(hero, /Iceland · March 2026/);
    assert.match(hero, /landing-hero-dissolve/);
    assert.match(hero, /animate-photo-credit/);
    assert.match(css, /\.animate-photo-credit[\s\S]*?1\.4s/);
    assert.match(landing, /aurora-afterglow\.jpg/);
    assert.match(landing, /loading="lazy"/);
    assert.match(landing, /decoding="async"/);
    assert.ok(existsSync(afterglow));
    assert.ok(statSync(afterglow).size <= 180_000);
  });

  it("declares the converge spine, progressive reveal, no-JS, and reduced-motion states", () => {
    const spine = source("src/components/LandingSpine.tsx");
    const reveals = source("src/components/LandingRevealManager.tsx");
    const css = source("src/app/globals.css");

    assert.match(spine, /requestAnimationFrame/);
    assert.match(spine, /ResizeObserver/);
    assert.match(spine, /0\.55/);
    assert.match(spine, /150/);
    assert.match(spine, /340/);
    assert.match(spine, /2\.1/);
    assert.match(spine, /4\.4/);
    assert.match(spine, /cancelAnimationFrame/);
    assert.match(spine, /removeEventListener/);
    assert.match(reveals, /IntersectionObserver/);
    assert.match(reveals, /0\.92/);
    assert.match(reveals, /0\.2/);
    assert.match(reveals, /-32px/);
    assert.match(reveals, /disconnect/);
    assert.match(css, /\[data-spine-static\]/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /\[data-reveal\]/);
    const beadRule = css.match(/\.landing-spine-bead\s*\{[\s\S]*?\}/)?.[0] ?? "";
    assert.match(beadRule, /width: 15px/);
    assert.match(beadRule, /height: 15px/);
    assert.match(beadRule, /radial-gradient/);
    assert.match(beadRule, /0 0 22px 6px rgba\(250, 250, 250, 0\.16\)/);
  });

  it("renders all eight restrained footer destinations without reveal targeting", () => {
    const footer = source("src/components/Footer.tsx");
    for (const label of [
      "Work",
      "Writing",
      "Photography",
      "Q",
      "Endstate",
      "Exomem",
      "GitHub",
      "LinkedIn",
    ]) {
      assert.match(footer, new RegExp(`label: "${label}"`));
    }
    assert.doesNotMatch(footer, /data-reveal/);
    assert.match(footer, /max-w-\[880px\]/);
    for (const href of [
      "/work",
      "/blog",
      "/photography",
      "https://useq.ai",
      "/endstate",
      "/exomem",
      "https://github.com/Artexis10",
      "https://www.linkedin.com/company/substratesystems/",
    ]) {
      assert.match(footer, new RegExp(`href: "${href.replace(/[./]/g, "\\$&")}"`));
    }
  });
});
