import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "../proxy";

// A matcher that misses an Exomem page silently drops its theme refresh; one that
// matches assets bills a function for every file a page loads.
describe("proxy matcher", () => {
  const cases: { path: string; headers?: Record<string, string>; runs: boolean }[] = [
    { path: "/exomem", runs: true },
    { path: "/exomem/home", runs: true },
    { path: "/exomem/account/settings", runs: true },
    { path: "/tidewave", runs: true },
    { path: "/", runs: false },
    { path: "/blog/some-post", runs: false },
    { path: "/api/exomem/account", runs: false },
    { path: "/_next/static/chunks/app.js", runs: false },
    { path: "/exomem/email-assets/wordmark.png", runs: false },
    { path: "/exomem/home", headers: { rsc: "1" }, runs: false },
    { path: "/exomem/home", headers: { "next-router-prefetch": "1" }, runs: false },
    { path: "/exomem/home", headers: { purpose: "prefetch" }, runs: false },
  ];
  for (const { path, headers, runs } of cases) {
    it(`${runs ? "starts" : "never starts"} the proxy for ${path} ${JSON.stringify(headers ?? {})}`, () => {
      assert.equal(
        unstable_doesMiddlewareMatch({ config, url: `https://example.test${path}`, headers }),
        runs
      );
    });
  }
});
