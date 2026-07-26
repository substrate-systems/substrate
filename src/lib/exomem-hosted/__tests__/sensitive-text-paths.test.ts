import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  autocaptureUrlIgnorelist,
  isSensitiveTextPath,
  sensitiveTextPaths,
  shouldMountAnalytics,
  isPrivateExomemPath,
} from "../privacy";

const ORIGIN = "https://substratesystems.io";

function ignored(url: string): boolean {
  return autocaptureUrlIgnorelist.some((re) => re.test(url));
}

/**
 * `/endstate/claim/[token]` renders a live claim token and `/account` renders the
 * account holder's email. Neither is an `/exomem/*` route, so neither was covered
 * by the only exclusion the app had.
 *
 * The decision taken was deliberately narrow: keep pageviews and the deliberate
 * events these pages fire — those are audited to carry no secret, and the claim
 * handoff events are the only measurement of that flow — and turn off
 * `autocapture`, which is the one mechanism that could lift a rendered value
 * without anyone choosing to send it.
 */
describe("sensitive text surfaces", () => {
  test("the claim page and the account page are recognised", () => {
    assert.equal(isSensitiveTextPath("/account"), true);
    assert.equal(isSensitiveTextPath("/account/"), true);
    assert.equal(isSensitiveTextPath("/endstate/claim"), true);
    assert.equal(isSensitiveTextPath("/endstate/claim/abc123"), true);
    assert.equal(isSensitiveTextPath(`${ORIGIN}/endstate/claim/abc123`), true);
  });

  test("neighbouring routes are not swept up", () => {
    // Prefix confusion is the obvious way a path list like this goes wrong.
    assert.equal(isSensitiveTextPath("/accounts"), false);
    assert.equal(isSensitiveTextPath("/endstate"), false);
    assert.equal(isSensitiveTextPath("/endstate/apps"), false);
    assert.equal(isSensitiveTextPath("/endstate/claims-info"), false);
    assert.equal(isSensitiveTextPath("/blog"), false);
  });

  test("analytics still mounts on them — this is the whole point of the decision", () => {
    // Excluding these routes outright would have deleted the claim handoff
    // instrumentation. Pageviews and deliberate events must survive.
    assert.equal(shouldMountAnalytics("/account"), true);
    assert.equal(shouldMountAnalytics("/endstate/claim/abc123"), true);
    // They are separately not Exomem private routes.
    assert.equal(isPrivateExomemPath("/account"), false);
    assert.equal(isPrivateExomemPath("/endstate/claim/abc123"), false);
  });
});

describe("autocapture url_ignorelist", () => {
  test("matches the sensitive routes on a real URL", () => {
    assert.equal(ignored(`${ORIGIN}/account`), true);
    assert.equal(ignored(`${ORIGIN}/account?from=email`), true);
    assert.equal(ignored(`${ORIGIN}/account#billing`), true);
    assert.equal(ignored(`${ORIGIN}/endstate/claim/abc123`), true);
  });

  test("does not match neighbouring or nested lookalike paths", () => {
    assert.equal(ignored(`${ORIGIN}/accounts`), false);
    assert.equal(ignored(`${ORIGIN}/endstate`), false);
    assert.equal(ignored(`${ORIGIN}/endstate/apps`), false);
    assert.equal(ignored(`${ORIGIN}/blog`), false);
    // Anchored on the //host boundary, so a nested path cannot impersonate one.
    assert.equal(ignored(`${ORIGIN}/blog/account`), false);
    assert.equal(ignored(`${ORIGIN}/blog/endstate/claim/x`), false);
  });

  test("has an entry for every sensitive path", () => {
    assert.equal(autocaptureUrlIgnorelist.length, sensitiveTextPaths.length);
    assert.ok(sensitiveTextPaths.length > 0, "expected at least one sensitive path");
    for (const path of sensitiveTextPaths) {
      assert.equal(
        ignored(`${ORIGIN}${path}`),
        true,
        `${path} is listed as sensitive but no ignorelist entry matches it`
      );
    }
  });
});
