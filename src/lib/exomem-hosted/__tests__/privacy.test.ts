import assert from "node:assert/strict";
import test from "node:test";
import {
  filterPostHogCapture,
  filterVercelAnalyticsEvent,
  isPrivateExomemPath,
  shouldReloadAnalyticsDocument,
  shouldMountAnalytics,
} from "../privacy";

test("private hosted pages are excluded without hiding the public Exomem page", () => {
  assert.equal(isPrivateExomemPath("https://substratesystems.io/exomem"), false);
  assert.equal(isPrivateExomemPath("/exomem/home"), true);
  assert.equal(isPrivateExomemPath("/exomem/home/memory?query=private#fragment"), true);
  assert.equal(isPrivateExomemPath("/exomem/invite"), true);
  assert.equal(isPrivateExomemPath("/exomem/sign-in"), true);
  assert.equal(isPrivateExomemPath("/exomem/delete/confirm"), true);
  assert.equal(isPrivateExomemPath("/exomem/homepage"), false);
  assert.equal(shouldMountAnalytics("/exomem/home"), false);
  assert.equal(shouldMountAnalytics("/exomem"), true);
  assert.equal(shouldReloadAnalyticsDocument(false, "/exomem/home"), false);
  assert.equal(shouldReloadAnalyticsDocument(true, "/exomem/home"), true);
  assert.equal(shouldReloadAnalyticsDocument(true, "/exomem"), false);
});

test("Vercel and PostHog filters drop private events", () => {
  const vercelEvent = { type: "pageview", url: "https://example.test/exomem/home" };
  assert.equal(filterVercelAnalyticsEvent(vercelEvent), null);

  const capture = {
    event: "$pageview",
    properties: { $current_url: "https://example.test/exomem/invite#secret" },
  };
  assert.equal(filterPostHogCapture(capture, "https://example.test/"), null);
  assert.equal(
    filterPostHogCapture(
      { event: "custom", properties: {} },
      "https://example.test/exomem/sign-in#secret"
    ),
    null
  );
});

test("public analytics events pass through unchanged", () => {
  const vercelEvent = { type: "pageview", url: "https://example.test/exomem" };
  assert.equal(filterVercelAnalyticsEvent(vercelEvent), vercelEvent);

  const capture = {
    event: "$pageview",
    properties: { $current_url: "https://example.test/exomem" },
  };
  assert.equal(filterPostHogCapture(capture, "https://example.test/exomem"), capture);
});
