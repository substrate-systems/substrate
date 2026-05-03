import { describe, it } from "node:test";
import assert from "node:assert/strict";

import nextConfig from "../../../../next.config";

describe("OIDC discovery URL (RFC 8414 §3 / OIDC Discovery 1.0 §3)", () => {
  it("rewrites /.well-known/* to /api/.well-known/* so the discovery doc lives at the issuer URL", async () => {
    assert.equal(typeof nextConfig.rewrites, "function");
    const rewrites = await nextConfig.rewrites!();
    const list = Array.isArray(rewrites) ? rewrites : (rewrites.beforeFiles ?? []);
    const wellKnown = list.find((r) => r.source === "/.well-known/:path*");
    assert.ok(
      wellKnown,
      "expected a rewrite from /.well-known/:path* — without it the discovery doc URL does not match the issuer claim"
    );
    assert.equal(wellKnown!.destination, "/api/.well-known/:path*");
  });
});
