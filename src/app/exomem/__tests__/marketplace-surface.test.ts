import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sitemap from "../../sitemap";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Exomem marketplace public surface", () => {
  it("keeps self-hosted and invite-only Hosted honest on the public page", () => {
    const page = source("src/app/exomem/page.tsx");

    assert.match(page, /self-hosted/i);
    assert.match(page, /Hosted private alpha/i);
    assert.match(page, /sign in once/i);
    assert.match(page, /plaintext.*search/i);
    assert.doesNotMatch(page, /managed tier is on the table/i);
    assert.doesNotMatch(page, /end-to-end encrypted/i);
    assert.doesNotMatch(page, /claude\.ai\/plugins\/exomem-hosted/i);
    assert.doesNotMatch(page, /chatgpt\.com\/plugins\/exomem-hosted/i);
  });

  it("keeps the imported friends-cohort form aligned with the live private alpha", () => {
    const form = source("src/app/exomem/hosted-interest-form.tsx");

    assert.match(form, /private alpha/i);
    assert.match(form, /friends cohort/i);
    assert.match(form, /request an invite/i);
    assert.doesNotMatch(form, /Nothing gets built until it clears a threshold/i);
    assert.doesNotMatch(form, /If a hosted tier existed/i);
  });

  it("confirms an invite request only after the server accepts it", () => {
    const form = source("src/app/exomem/hosted-interest-form.tsx");

    assert.match(form, /const response = await fetch\("\/api\/exomem\/interest"/);
    assert.match(form, /if \(!response\.ok\) \{/);
    assert.match(form, /setHint\("We couldn’t submit your request\. Please try again\."\)/);
    assert.match(form, /if \(!response\.ok\) \{[\s\S]*?return;[\s\S]*?}\s*setSubmitted\(true\);/);
    assert.doesNotMatch(form, /catch \{\s*\/\* swallow/);
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
    assert.match(terms, /invite-only/i);
    assert.match(terms, /export/i);
    assert.match(terms, /Substrate Systems OÜ/i);
    assert.match(terms, /consumer rights/i);
    assert.match(support, /founder@substratesystems\.io/);
    assert.match(setup, /sign in once/i);
    assert.match(setup, /custom instructions.*fallback/i);
    assert.match(setup, /native memory.*short-term/i);
  });
});
