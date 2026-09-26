import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { unnormalizedRequestUrl } from "../oauth-http";

const RAW =
  "https://hosted.example.test/api/exomem/oauth/authorize?redirect_uri=" +
  encodeURIComponent("http://127.0.0.1:33418/callback") +
  "&state=a";

describe("unnormalizedRequestUrl", () => {
  it("reads past NextRequest's loopback-to-localhost rewrite", () => {
    const request = new NextRequest(new URL(RAW));
    assert.match(request.url, /localhost%3A33418/);
    assert.equal(unnormalizedRequestUrl(request).href, RAW);
  });

  it("returns a plain Request's URL unchanged", () => {
    assert.equal(unnormalizedRequestUrl(new Request(RAW)).href, RAW);
  });

  it("falls back to the normalised URL for a proxied request instead of failing", () => {
    const proxied = new Proxy(new NextRequest(new URL(RAW)), {
      get: (target, property) => Reflect.get(target, property, target),
    });
    assert.match(unnormalizedRequestUrl(proxied).href, /localhost%3A33418/);
  });
});
