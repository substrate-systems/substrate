import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sitemap from "../../sitemap";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Exomem marketplace public surface", () => {
  it("presents Hosted as a friends-only alpha rather than a public offer", () => {
    const page = source("src/app/exomem/page.tsx");

    assert.match(page, /self-hosted/i);
    assert.match(page, /friends-only private alpha/i);
    assert.match(page, /express interest/i);
    assert.doesNotMatch(page, /EXOMEM_HOSTED_PRICE_EUR/);
    assert.doesNotMatch(page, /€12 a month/);
  });

  it("sends public Hosted interest only to the interest endpoint", () => {
    const form = source("src/app/exomem/hosted-access-form.tsx");

    assert.match(form, /const response = await fetch\("\/api\/exomem\/interest"/);
    assert.doesNotMatch(form, /\/api\/exomem\/access\/request/);
    assert.doesNotMatch(form, /fetch\("\/api\/exomem\/billing/);
    assert.doesNotMatch(form, /Paddle\./);
    assert.match(form, /automatic invitation/i);
  });

  it("acknowledges interest without claiming admission or a queue position", () => {
    const form = source("src/app/exomem/hosted-access-form.tsx");

    assert.match(form, /We’ll be in touch if there’s a fit/i);
    assert.match(form, /if \(!response\.ok \|\| !body\) \{[\s\S]*?return;/);
    assert.doesNotMatch(form, /admitted|waitlisted|number \$\{/i);
  });

  it("keeps checkout private to authenticated Home", () => {
    const home = source("src/app/exomem/home/home-client.tsx");

    assert.match(home, /Subscribe and prepare Exomem/);
    assert.match(home, /openBilling\("checkout"\)/);
    assert.doesNotMatch(home, /disabled=\{!billing\?\.checkoutAvailable\}/);
    assert.doesNotMatch(source("src/app/exomem/page.tsx"), /Subscribe and prepare Exomem/);
  });

  it("publishes the stable policy and setup routes in the sitemap", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((entry) => entry.url));

    for (const path of ["privacy", "terms", "support", "setup"]) {
      assert.ok(urls.has(`https://substratesystems.io/exomem/${path}`));
      assert.match(source(`src/app/exomem/${path}/page.tsx`), /Exomem/);
    }
  });

  it("describes the actual Hosted privacy boundary and support route", () => {
    const privacy = source("src/app/exomem/privacy/page.tsx");
    const terms = source("src/app/exomem/terms/page.tsx");
    const support = source("src/app/exomem/support/page.tsx");
    const setup = source("src/app/exomem/setup/page.tsx");

    assert.match(privacy, /plaintext.*search/i);
    assert.match(privacy, /encrypted in transit and at rest/i);
    assert.match(privacy, /founder@substratesystems\.io/);
    assert.match(privacy, /registry code\s*17394552/i);
    assert.match(privacy, /legitimate interests/i);
    assert.match(privacy, /Estonian Data Protection Inspectorate/i);
    assert.doesNotMatch(privacy, /Draft|Owner review required/i);
    assert.match(terms, /friends-only private alpha/i);
    assert.match(terms, /invitation/i);
    assert.doesNotMatch(terms, /€12 per month/);
    assert.doesNotMatch(terms, /checkout/i);
    assert.match(terms, /export/i);
    assert.match(terms, /Substrate Systems OÜ/i);
    assert.match(terms, /consumer rights/i);
    assert.match(support, /founder@substratesystems\.io/);
    assert.match(setup, /sign in once/i);
    assert.match(setup, /custom instructions.*fallback/i);
    assert.match(setup, /native memory.*short-term/i);
  });
});
