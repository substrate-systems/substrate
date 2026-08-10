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

  it("offers retry-safe capture, immediate recall, and progressive owner actions", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    assert.match(home, /commands\/remember/);
    assert.match(home, /idempotencyKey: retryKeyRef\.current/);
    assert.match(home, /commands\/ask_memory/);
    assert.match(home, /commands\/browse_memory/);
    assert.match(home, /commands\/review_memory/);
    assert.match(home, /postPrivateFile/);
    assert.match(home, /uploadRetryRef/);
    assert.match(home, /exportRetryKeyRef/);
    assert.match(home, /api\/exomem\/exports/);
    assert.match(home, /api\/exomem\/deletion\/request/);
    assert.doesNotMatch(home, /tenantId|cellId|vaultRoot|privateEndpoint/);
  });

  it("renders only server-provided native install actions", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const state = source("src/app/exomem/home/home-state.ts");
    assert.match(home, /setInstallActions\(parseInstallActions\(response\)\)/);
    assert.match(home, /installActions\.map/);
    assert.match(home, /Install in/);
    assert.doesNotMatch(home, /mcpUrl|manual connector|tenantId/);
    assert.match(state, /platform !== "claude" && candidate\.platform !== "openai"/);
    assert.match(state, /installUrl\.protocol !== "https:"/);
  });

  it("opens a server-created Paddle transaction on the private Exomem return page", () => {
    const page = source("src/app/exomem/home/page.tsx");
    const opener = source("src/components/PaddleTransactionOpener.tsx");
    assert.match(page, /validationEndpoint="\/api\/exomem\/billing\/checkout"/);
    assert.match(opener, /_ptxn/);
    assert.match(opener, /openTransactionCheckout/);
    assert.match(opener, /postPrivateJson\(validationEndpoint/);
    assert.match(opener, /transactionId: candidate/);
    assert.match(opener, /window\.history\.replaceState/);
    assert.match(opener, /response\.state === "settled"/);
    assert.match(opener, /response\.redirectUrl === "\/exomem\/home"/);
    assert.match(opener, /window\.location\.replace\(response\.redirectUrl\)/);
    assert.match(opener, /window\.sessionStorage\.setItem/);
    assert.match(opener, /window\.sessionStorage\.getItem/);
    assert.match(opener, /window\.sessionStorage\.removeItem/);
    assert.match(opener, /setValidationFailed\(true\)/);
    assert.match(
      opener,
      /const \{ ready, error, openTransactionCheckout \} = usePaddle\("transaction"\)/
    );
    assert.match(opener, /if \(error\) onFailure\?\.\(\)/);
    assert.match(opener, /const opened = await openTransactionCheckout\(transactionId\)/);
    assert.match(opener, /opened \? onOpened\(\) : onFailure\?\.\(\)/);
    assert.match(opener, /window\.location\.reload\(\)/);
    assert.match(opener, /Try again/);
    assert.match(opener, /Not now/);
    assert.match(opener, /function OpenPaddleTransaction/);
    assert.match(opener, /if \(!transactionId\) return null/);
    assert.match(opener, /transactionId=\{transactionId\}/);
    assert.match(opener, /\^txn_\[a-z0-9\]/);
  });

  it("keeps non-ready Home useful and polls with cleanup until a terminal state", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    assert.match(home, /lifecycle\.requestId/);
    assert.match(home, /Support reference/);
    assert.match(home, /nextStatusPollDelayMs/);
    assert.match(home, /window\.setTimeout/);
    assert.match(home, /window\.clearTimeout/);
    assert.match(home, /createSingleFlight/);
    assert.match(home, /mountedRef/);

    const nonReady = home.match(/if \(lifecycle\.state !== "ready"\) \{[\s\S]*?^  }/m)?.[0] ?? "";
    assert.match(nonReady, /Sign out/);
    assert.match(nonReady, /Check again/);
  });

  it("does not claim sign-out succeeded when revocation fails", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const signOut = home.match(/async function signOut\(\)[\s\S]*?\n  }/)?.[0] ?? "";
    assert.match(signOut, /catch/);
    assert.match(signOut, /session is still active/i);
    assert.doesNotMatch(signOut, /finally/);
    assert.match(signOut, /window\.location\.replace/);
  });

  it("retains a failed file for an explicit retry and resets file selection", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    assert.match(home, /failedUpload/);
    assert.match(home, /Retry upload/);
    assert.match(home, /currentTarget\.value = ""/);
    assert.match(home, /uploadInFlightRef/);
    assert.match(home, /file: File/);
    assert.doesNotMatch(home, /fingerprint/);
    assert.match(home, /upload\(file, "selection"\)/);
    assert.match(home, /upload\(failedUpload, "retry"\)/);
    assert.match(home, /disabled=\{uploading\}/);
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

  it("keeps upload bodies out of the Vercel ticket route", () => {
    const route = source("src/app/api/exomem/upload/route.ts");
    assert.match(route, /createDirectTransferTicket/);
    assert.match(route, /MAX_TICKET_REQUEST_BYTES/);
    assert.doesNotMatch(route, /multipart\/form-data/);
    assert.doesNotMatch(route, /body: boundedBody/);
  });

  it("has keyboard focus, narrow-screen, and reduced-motion rules", () => {
    const css = source("src/app/exomem/private-shell.module.css");
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media \(max-width: 560px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
