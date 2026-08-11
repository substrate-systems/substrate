import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

const sponsorshipPageUrl = pathToFileURL(
  resolve(process.cwd(), "src/app/endstate/sponsor-an-integration/page.tsx")
).href;
const supportersPageUrl = pathToFileURL(
  resolve(process.cwd(), "src/app/endstate/supporters/page.tsx")
).href;

function renderSponsorshipPage(): string {
  const script = `
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const page = await import(${JSON.stringify(sponsorshipPageUrl)});
    const SponsorshipPage =
      typeof page.default === "function" ? page.default : page.default.default;
    process.stdout.write(renderToStaticMarkup(React.createElement(SponsorshipPage)));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function renderSupportersPage(supportersMarkdown: string): string {
  const script = `
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => ${JSON.stringify(supportersMarkdown)},
    });
    const page = await import(${JSON.stringify(supportersPageUrl)});
    const SupportersPage = typeof page.default === "function" ? page.default : page.default.default;
    process.stdout.write(renderToStaticMarkup(await SupportersPage()));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

describe("Endstate commercial pages", () => {
  it("loads the palette for server pages without crossing the client component boundary", () => {
    for (const page of ["supporters/page.tsx", "sponsor-an-integration/page.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src/app/endstate", page), "utf8");

      assert.match(source, /import\s+\{\s*c\s*\}\s+from\s+["']\.\.\/_palette["']/);
      assert.doesNotMatch(source, /import\s+\{[^}]*\bc\b[^}]*\}\s+from\s+["']\.\.\/_shared["']/);
    }
  });

  it("keeps the shared palette server-safe and concrete", () => {
    const palette = readFileSync(resolve(process.cwd(), "src/app/endstate/_palette.ts"), "utf8");

    assert.doesNotMatch(palette, /^["']use client["'];?$/m);
    assert.match(palette, /export const c = \{/);
    for (const [name, value] of [
      ["bg", "#0c0c0c"],
      ["elevated", "#141414"],
      ["card", "#1a1a1a"],
      ["border", "#2a2a2a"],
      ["borderAccent", "#333"],
      ["text", "#e8e8e8"],
      ["teal", "#2dd4bf"],
    ]) {
      assert.match(palette, new RegExp(`${name}:\\s*["']${value}["']`));
    }
  });

  it("renders concrete palette styles for integration sponsorship", () => {
    const dom = new JSDOM(renderSponsorshipPage());
    try {
      const { document } = dom.window;
      const migrationCard = document.querySelector<HTMLElement>("[data-migration-comparison]");
      const quoteCta = [...document.querySelectorAll<HTMLAnchorElement>("a")].find(
        (link) => link.textContent?.trim() === "Request a quote"
      );

      assert.ok(migrationCard);
      assert.match(migrationCard.getAttribute("style") ?? "", /border:1px solid #2a2a2a/);
      assert.doesNotMatch(migrationCard.getAttribute("style") ?? "", /undefined/);
      assert.ok(quoteCta);
      assert.match(quoteCta.getAttribute("style") ?? "", /background:#e8e8e8/);
      assert.doesNotMatch(quoteCta.getAttribute("style") ?? "", /transparent|undefined/);
    } finally {
      dom.window.close();
    }
  });

  it("renders the canonical supporter feed in order without tier labels", () => {
    const dom = new JSDOM(
      renderSupportersPage(
        [
          "# Endstate supporters",
          "",
          "## Supporters",
          "- James E. Howard",
          "- Ada Lovelace",
          "- Lina Ortiz",
          "",
          "## Recognition",
        ].join("\n")
      )
    );
    try {
      const { document } = dom.window;
      const roster = document.querySelector<HTMLElement>("[data-supporter-roster]");
      const supportCta = document.querySelector<HTMLAnchorElement>("[data-support-primary-cta]");

      assert.ok(roster);
      assert.match(roster.getAttribute("style") ?? "", /background:#1a1a1a/);
      assert.match(roster.getAttribute("style") ?? "", /border:1px solid #2a2a2a/);
      assert.deepEqual(
        [...roster.querySelectorAll("li")].map((item) => item.textContent?.replace("◆", "").trim()),
        ["James E. Howard", "Ada Lovelace", "Lina Ortiz"]
      );
      assert.doesNotMatch(
        roster.textContent ?? "",
        /Founding Supporter|Patron|Project Sponsor|tier|amount|transaction/i
      );

      assert.ok(supportCta);
      assert.equal(supportCta.getAttribute("href"), "#support");
      assert.match(supportCta.getAttribute("style") ?? "", /background:#2dd4bf/);
      assert.doesNotMatch(supportCta.getAttribute("style") ?? "", /transparent|undefined/);
    } finally {
      dom.window.close();
    }
  });

  it("groups integration sponsorship into an outcome hero, comparison, benefits, and quote panel", () => {
    const dom = new JSDOM(renderSponsorshipPage());
    try {
      const { document } = dom.window;

      assert.ok(document.querySelector("[data-commercial-hero]"));
      assert.equal(document.querySelectorAll("[data-migration-comparison]").length, 2);
      assert.equal(document.querySelectorAll("[data-sponsorship-benefit]").length, 3);

      const quoteLinks = [
        ...document.querySelectorAll<HTMLAnchorElement>("a[href^='mailto:']"),
      ].filter(
        (link) =>
          new URL(link.href).searchParams.get("subject") ===
          "Integration sponsorship enquiry — Endstate"
      );
      assert.equal(quoteLinks.length, 2);
      for (const link of quoteLinks) {
        const mailto = new URL(link.href);
        assert.equal(mailto.pathname, "founder@substratesystems.io");
        assert.equal(
          mailto.searchParams.get("subject"),
          "Integration sponsorship enquiry — Endstate"
        );
        const body = mailto.searchParams.get("body") ?? "";
        for (const expected of [
          "Application name:",
          "Vendor and product URL:",
          "Version or edition:",
          "Current operating system:",
          "Installation source or package identity (winget ID, Chocolatey ID, MSI, vendor installer):",
          "Settings or state that must survive migration:",
          "May this integration be public? (yes / no):",
          "Deadline or business context:",
          "Contact name:",
          "Contact email:",
        ]) {
          assert.match(body, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
      }
    } finally {
      dom.window.close();
    }
  });

  it("preserves the canonical supporter feed and existing contribution actions", () => {
    const supportersPage = readFileSync(
      resolve(process.cwd(), "src/app/endstate/supporters/page.tsx"),
      "utf8"
    );
    const tiers = readFileSync(
      resolve(process.cwd(), "src/app/endstate/supporters/SupportTiers.tsx"),
      "utf8"
    );

    assert.match(
      supportersPage,
      /https:\/\/raw\.githubusercontent\.com\/Artexis10\/endstate\/main\/SUPPORTERS\.md/
    );
    assert.match(supportersPage, /m && m\[1\]\.trim\(\)/);
    assert.match(tiers, /openSupportCheckout\(tier\)/);
    assert.match(tiers, /href=\{CUSTOM_SPONSOR_MAILTO\}/);
  });
});
