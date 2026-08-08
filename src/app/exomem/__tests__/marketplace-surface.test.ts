import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sitemap from "../../sitemap";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Exomem marketplace public surface", () => {
  it("presents Hosted as honestly purchasable at a stated price", () => {
    const page = source("src/app/exomem/page.tsx");

    assert.match(page, /self-hosted/i);
    assert.match(page, /sign in once/i);
    assert.match(page, /plaintext.*search/i);
    // A publicly listed product may not be described as a trial, demo, or
    // invite-only alpha — the plugin directories reject that framing outright.
    assert.doesNotMatch(page, /private alpha/i);
    assert.doesNotMatch(page, /invite-only/i);
    assert.doesNotMatch(page, /\bfree trial\b/i);
    // The price is stated, and the structured data agrees with the copy.
    assert.match(page, /€12 a month/);
    assert.match(page, /EXOMEM_HOSTED_PRICE_EUR = "12"/);
    assert.match(page, /priceCurrency: "EUR"/);
    // A time-limited price must say so, and say what happens to existing subs.
    assert.match(page, /founder price/i);
    assert.match(page, /time-limited/i);
    assert.match(page, /stays €12 for as long as/i);
    // Capacity is disclosed before payment, not discovered after it.
    assert.match(page, /waitlist/i);
    assert.doesNotMatch(page, /managed tier is on the table/i);
    assert.doesNotMatch(page, /end-to-end encrypted/i);
    assert.doesNotMatch(page, /claude\.ai\/plugins\/exomem-hosted/i);
    assert.doesNotMatch(page, /chatgpt\.com\/plugins\/exomem-hosted/i);
  });

  it("asks for admission before offering any payment surface", () => {
    const form = source("src/app/exomem/hosted-access-form.tsx");

    assert.match(form, /const response = await fetch\("\/api\/exomem\/access\/request"/);
    // Admission is settled first. A rendered price or a checkout call here would
    // let a visitor who cannot be provisioned reach a charge.
    assert.doesNotMatch(form, /€\d/);
    assert.doesNotMatch(form, /fetch\("\/api\/exomem\/billing/);
    assert.doesNotMatch(form, /Paddle\./);
    assert.doesNotMatch(form, /private alpha|friends cohort/i);
  });

  it("reports the real outcome rather than a blanket acknowledgement", () => {
    const form = source("src/app/exomem/hosted-access-form.tsx");

    // A waitlisted visitor must be told they are waiting, and told their place.
    assert.match(form, /body\.status === "waitlisted"/);
    assert.match(form, /setOutcome\(\{ kind: "waitlisted", position: body\.position \?\? 1 \}\)/);
    assert.match(form, /you’re number \$\{/);
    assert.match(form, /haven’t been charged/);
    // Success is claimed only once the server has actually accepted.
    assert.match(form, /if \(!response\.ok \|\| !body\) \{[\s\S]*?return;/);
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
    // The terms are read by directory reviewers alongside a public price.
    assert.doesNotMatch(terms, /invite-only|private alpha/i);
    assert.match(terms, /€12 per month/);
    assert.match(terms, /merchant of record/i);
    assert.match(terms, /right\s+of\s+withdrawal/i);
    assert.match(terms, /export/i);
    assert.match(terms, /Substrate Systems OÜ/i);
    assert.match(terms, /consumer rights/i);
    assert.match(support, /founder@substratesystems\.io/);
    assert.match(setup, /sign in once/i);
    assert.match(setup, /custom instructions.*fallback/i);
    assert.match(setup, /native memory.*short-term/i);
  });
});
