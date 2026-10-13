import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("private Exomem Home contract", () => {
  it("keeps every token-bearing and authenticated page dynamic and noindex", () => {
    for (const path of [
      "src/app/exomem/invite/page.tsx",
      "src/app/exomem/sign-in/page.tsx",
      "src/app/exomem/home/page.tsx",
      "src/app/exomem/delete/page.tsx",
    ]) {
      const page = source(path);
      assert.match(page, /dynamic = "force-dynamic"/);
      assert.match(page, /revalidate = 0/);
      assert.match(page, /index: false/);
      assert.match(page, /nocache: true/);
      assert.match(page, /referrer: "no-referrer"/);
    }
  });

  it("clears fragment credentials before using invite, sign-in, or deletion flows", () => {
    const browser = source("src/lib/exomem-hosted/hosted-browser.ts");
    assert.match(browser, /window\.history\.replaceState/);
    for (const path of [
      "src/app/exomem/invite/invite-client.tsx",
      "src/app/exomem/sign-in/sign-in-client.tsx",
      "src/app/exomem/delete/delete-client.tsx",
    ]) {
      assert.match(source(path), /takeFragmentToken\(\)/);
    }
  });

  it("requires an explicit user action before redeeming a returning-user link", () => {
    const signIn = source("src/app/exomem/sign-in/sign-in-client.tsx");
    const startupEffect = signIn.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? "";
    assert.doesNotMatch(startupEffect, /magic-link\/redeem/);
    assert.match(signIn, /Continue sign-in/);
    assert.match(signIn, /mode === "confirm"/);
  });

  it("does not mount analytics providers on private Exomem routes", () => {
    const postHog = source("src/app/providers.tsx");
    assert.match(postHog, /usePathname/);
    assert.match(postHog, /shouldMountAnalytics/);
    assert.match(postHog, /if \(!analyticsEnabled\)/);
    // Automatic pageviews stay off so an SDK initialised on a public page cannot
    // observe a later private navigation; ours are emitted explicitly instead.
    assert.match(postHog, /capture_pageview: false/);
    // The load-bearing guarantee is the send-time filter, not any single capture
    // flag: filterPostHogCapture drops an event when either the current URL or
    // the event's own $current_url is a private Exomem path, so enabling further
    // automatic captures (pageleave, autocapture) cannot leak one.
    assert.match(postHog, /before_send:.*filterPostHogCapture\(capture, window\.location\.href\)/);

    const vercel = source("src/app/privacy-safe-analytics.tsx");
    assert.match(vercel, /usePathname/);
    assert.match(vercel, /shouldMountAnalytics/);
    assert.match(vercel, /analyticsWasMountedRef/);
    assert.match(vercel, /shouldReloadAnalyticsDocument/);
    assert.match(vercel, /window\.location\.replace\(window\.location\.href\)/);
    assert.match(vercel, /return null/);
  });

  it("has keyboard focus, narrow-screen, and reduced-motion rules", () => {
    const css = source("src/app/exomem/private-shell.module.css");
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(max-width: 560px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
