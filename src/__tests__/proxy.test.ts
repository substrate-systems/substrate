import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";

let lookups = 0;
before(() =>
  mock.module("@/lib/exomem-hosted/theme-snapshot", {
    namedExports: {
      refreshExomemThemeSnapshot: async () => {
        lookups += 1;
      },
    },
  })
);
after(() => mock.reset());
beforeEach(() => {
  lookups = 0;
});

describe("optional Exomem HTML theme refresh", () => {
  it("refreshes a document navigation through the existing proxy", async () => {
    const { proxy } = await import("../proxy");
    const response = await proxy(
      new NextRequest("https://example.test/exomem/home", {
        headers: { accept: "text/html", "sec-fetch-dest": "document" },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(lookups, 1);
  });
  const optionalReadCases: { path: string; headers: Record<string, string> }[] = [
    { path: "/api/exomem/account", headers: { accept: "text/html" } },
    { path: "/exomem/email-assets/wordmark.png", headers: { accept: "text/html" } },
    { path: "/exomem/home", headers: { accept: "text/html", "next-router-prefetch": "1" } },
    { path: "/exomem/home", headers: { accept: "text/html", "sec-purpose": "prefetch;prerender" } },
  ];
  for (const input of optionalReadCases) {
    it(`skips optional account reads for ${JSON.stringify(input)}`, async () => {
      const { proxy } = await import("../proxy");
      await proxy(new NextRequest(`https://example.test${input.path}`, { headers: input.headers }));
      assert.equal(lookups, 0);
    });
  }
  it("preserves the existing local developer route rewrite", async () => {
    const { proxy } = await import("../proxy");
    const response = await proxy(new NextRequest("https://example.test/tidewave"));
    assert.equal(response.headers.get("x-middleware-rewrite"), "https://example.test/api/tidewave");
    assert.equal(lookups, 0);
  });
});
