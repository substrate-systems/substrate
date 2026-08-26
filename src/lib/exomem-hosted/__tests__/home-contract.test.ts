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
    // Deliberately NOT `commands/remember`, which this asserted until
    // 2026-08-16. `remember` is the governed-conclusion lane and enforces the
    // semantic contract; routing a person's typed sentence there refused their
    // first memory for having no semantic unit and every memory after it for
    // having no qualifying relation. `capture_source` is the raw-capture lane
    // and takes ordinary prose. The assertion was pinning the defect.
    assert.match(home, /commands\/capture_source/);
    assert.doesNotMatch(home, /commands\/remember/);
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

  it("renders only server-provided connection routes", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const state = source("src/app/exomem/home/home-state.ts");
    const page = source("src/app/exomem/home/page.tsx");
    assert.match(home, /setInstallActions\(parseInstallActions\(response\)\)/);
    assert.match(home, /Install in/);
    assert.doesNotMatch(home, /mcpUrl|tenantId/);
    assert.match(state, /platform !== "claude" && candidate\.platform !== "openai"/);
    assert.match(state, /installUrl\.protocol !== "https:"/);

    // The manual server URL is a route this page now offers, because Codex has
    // no marketplace install action and install actions are additionally gated
    // on a live artifact matching the promoted contract digest — a
    // release-pipeline fact that can legitimately leave a healthy tenant with
    // no one-click route at all. It is still server-provided: the page computes
    // it from `EXOMEM_PUBLIC_BASE_URL` and passes it in, so the client never
    // builds an endpoint of its own, and it is the same public origin for every
    // tenant.
    assert.match(page, /exomemPublicBaseUrlFromEnv\(\)/);
    assert.match(page, /serverUrl=/);
    assert.match(home, /serverUrl: string/);
    assert.doesNotMatch(home, /https:\/\/[a-z]/);
  });

  it("leads the ready view with connecting an assistant, not with a capture box", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const sections = source("src/app/exomem/home/home-sections.ts");
    // The ordering lives in `home-sections.ts` and is asserted directly there;
    // this pins that the component actually renders from it rather than
    // hardcoding an order that could drift from the tested one.
    assert.match(home, /const sections = homeSections\(\)/);
    assert.match(sections, /return \["connect", "capture", "account"\]/);

    // Every assistant is named, whether or not a one-click install exists for
    // it. The first version rendered install actions plus a single fallback
    // headed "Codex, or any other MCP client" — and since install actions
    // require a live artifact matching the promoted contract digest, which is
    // false until a promotion window has run, a newly invited Claude user's
    // only instruction was headed Codex.
    assert.match(home, /CLIENT_GUIDES\.map/);
    assert.doesNotMatch(home, /Codex, or any other MCP client/);

    // Both onboarding steps present and ordered: connect, then instruct.
    assert.ok(
      home.indexOf("Step 1 \u00b7 Your Exomem server address") <
        home.indexOf("Step 2 \u00b7 How involved should it be?"),
      "the address comes before the instructions block"
    );

    // Render order comes from the data, not from where the markup happens to
    // sit in the file — so this asserts the seam rather than the source order,
    // which the restructure deliberately decoupled.
    assert.match(home, /const rendered: Record<HomeSection, ReactNode>/);
    assert.match(
      home,
      /sections\.map\(\(section\) => \(\s*<Fragment key=\{section\}>\{rendered\[section\]\}<\/Fragment>/
    );
    for (const key of ["connect:", "capture:", "account:"]) {
      assert.ok(home.includes(key), `the rendered record must cover ${key}`);
    }
    assert.match(home, /Connect an assistant/);
  });

  it("hands over the instructions block, because no plugin ships skills yet", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const instructions = source("src/app/exomem/home/assistant-instructions.ts");

    // A bare MCP connection gives the assistant tools and no reason to use
    // them. Until a marketplace plugin ships skills, this block is the whole
    // behavioural layer, so the page must actually hand it over.
    assert.match(home, /PROM_LEVELS\.map/);
    assert.match(home, /Copy instructions/);
    assert.match(home, /assistantInstructions\(promLevel\)/);
    assert.match(instructions, /long-term governed knowledge store/);

    // Five flows, each naming where its own instructions live.
    for (const name of ["Claude", "ChatGPT", "Claude Code", "Codex CLI", "Any other MCP client"]) {
      assert.ok(instructions.includes(`"${name}"`), `${name} needs a guide`);
    }
    assert.match(instructions, /claude mcp add --transport http exomem/);
    // Codex is still listed, but carries its blocker instead of commands: it
    // signs in through RFC 7591 dynamic registration, which Exomem does not
    // implement. This used to assert `codex mcp add exomem --url`, pinning a
    // dead end as though it worked.
    //
    // Only the mechanism is asserted here. Whether Codex specifically has a
    // blocker and no commands is a question about values, not file text, so it
    // lives in `assistant-instructions.test.ts` — a `doesNotMatch` on source
    // would be satisfied by the comment explaining the removal.
    assert.match(instructions, /blocked\?: string/);
    assert.match(instructions, /pasteTarget/);
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

  it("lets only the authenticated owner request two-step cleanup while awaiting payment", () => {
    const home = source("src/app/exomem/home/home-client.tsx");
    const requestRoute = source("src/app/api/exomem/deletion/request/route.ts");
    const confirmRoute = source("src/app/api/exomem/deletion/confirm/route.ts");
    const deletePage = source("src/app/exomem/delete/delete-client.tsx");
    const start = home.indexOf('if (lifecycle.state === "awaiting_payment")');
    const end = home.indexOf("\n    return (", start + 1);
    const awaitingPayment = home.slice(start, end);

    assert.ok(start >= 0 && end > start, "the awaiting-payment branch must remain explicit");
    assert.match(awaitingPayment, /onClick=\{requestDeletion\}/);
    assert.match(awaitingPayment, /Delete your data/);
    assert.match(awaitingPayment, /We(?:&apos;|’)ll email you to confirm first/);
    assert.match(awaitingPayment, /styles\.subtleDivider/);
    assert.match(awaitingPayment, /className=\{styles\.quietButton\}/);
    assert.doesNotMatch(awaitingPayment, /styles\.dangerButton/);
    assert.match(awaitingPayment, /deletionRequested \? "Check your email" : "Delete your data"/);
    assert.match(requestRoute, /resolveExomemSession\(request\)/);
    assert.match(requestRoute, /validateMutationRequest\(request, session\)/);
    assert.match(confirmRoute, /resolveExomemSession\(request\)/);
    assert.match(confirmRoute, /validateMutationRequest\(request, session\)/);
    assert.match(deletePage, /onClick=\{confirm\}/);
    assert.match(deletePage, /Permanently delete my Exomem/);
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
