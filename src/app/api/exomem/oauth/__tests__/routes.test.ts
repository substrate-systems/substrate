import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOAuthForm } from "@/lib/exomem-hosted/oauth-http";

describe("Exomem OAuth routes", () => {
  it("rejects oversized and non-form token requests without reflecting credentials", async () => {
    const { POST } = await import("../token/route");
    const secret = "oauth-route-content-sentinel";
    const response = await POST(
      new Request("https://hosted.example.test/api/exomem/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: secret }),
      })
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes(secret), false);
  });

  it("accepts revocation requests for unknown form tokens without disclosure", async () => {
    const { __setRevokeOAuthTokenForClientForTests, POST } = await import("../revoke/route");
    let called = false;
    __setRevokeOAuthTokenForClientForTests(async () => {
      called = true;
    });
    const response = await POST(
      new Request("https://hosted.example.test/api/exomem/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "client_id=https%3A%2F%2Fclient.example.test%2Fmetadata&token=unknown",
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
    assert.equal(called, true);
    __setRevokeOAuthTokenForClientForTests(null);
  });

  it("rejects unexpected and duplicate token form fields before token handling", async () => {
    await assert.rejects(
      () =>
        readOAuthForm(
          new Request("https://hosted.example.test/api/exomem/oauth/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=refresh_token&client_id=client&refresh_token=one&scope=exomem.read",
          }),
          ["grant_type", "client_id", "refresh_token", "resource"]
        ),
      /EXOMEM_INVALID_REQUEST/
    );
  });
});
