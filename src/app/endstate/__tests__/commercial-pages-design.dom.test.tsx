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

describe("Endstate commercial pages", () => {
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
