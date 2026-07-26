import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    const { POST } = await import("../revoke/route");
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
  });
});
