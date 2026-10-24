import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientNetworkKey } from "../oauth-http";

describe("clientNetworkKey", () => {
  it("keys an IPv6 caller by its /64, so one host cannot rotate through its own addresses", () => {
    assert.equal(clientNetworkKey("2001:db8:1:2::1"), clientNetworkKey("2001:0db8:1:2:ffff:0:0:9"));
    assert.equal(clientNetworkKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
    assert.notEqual(clientNetworkKey("2001:db8:1:2::1"), clientNetworkKey("2001:db8:1:3::1"));
    assert.equal(clientNetworkKey("::1"), "0:0:0:0::/64");
  });

  it("keeps one key per IPv4 host, including an IPv4-mapped IPv6 address", () => {
    assert.equal(clientNetworkKey("192.0.2.7"), "192.0.2.7");
    assert.notEqual(clientNetworkKey("::ffff:192.0.2.7"), clientNetworkKey("::ffff:192.0.2.8"));
    assert.equal(clientNetworkKey("unavailable"), "unavailable");
  });
});
