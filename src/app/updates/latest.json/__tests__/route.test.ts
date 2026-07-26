import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { ServerEvent } from "@/lib/analytics-events";

/**
 * The updater endpoint is the one seam where an aggregate count could quietly
 * become install telemetry. Endstate's local product carries no telemetry as a
 * published, inviolable commitment, so the guarantee is pinned here rather than
 * left to review.
 */

type Capture = { event: string; distinctId: string | null; properties?: Record<string, unknown> };

const captures: Capture[] = [];
const originalFetch = globalThis.fetch;

before(() => {
  mock.module("@/lib/analytics-server", {
    namedExports: {
      ServerEvent,
      captureServer: async (params: Capture) => {
        captures.push(params);
      },
    },
  });
});

after(() => {
  mock.reset();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  captures.length = 0;
  globalThis.fetch = originalFetch;
});

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
}

async function loadRoute() {
  return import("../route");
}

describe("updates/latest.json update-check counting", () => {
  it("counts a served manifest without any identifier", async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }));

    const { GET } = await loadRoute();
    const res = await GET();

    assert.equal(res.status, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].event, ServerEvent.UpdateChecked);
    assert.equal(captures[0].distinctId, null);
    assert.deepEqual(captures[0].properties, { outcome: "served" });
  });

  it("counts an unavailable manifest so silent update breakage is visible", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));

    const { GET } = await loadRoute();
    const res = await GET();

    assert.equal(res.status, 503);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].properties?.outcome, "unavailable");
    assert.equal(captures[0].distinctId, null);
  });

  it("counts an upstream throw", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });

    const { GET } = await loadRoute();
    await GET();

    assert.equal(captures.length, 1);
    assert.equal(captures[0].properties?.outcome, "unavailable");
  });

  it("carries no per-install identifier of any kind", async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }));

    const { GET } = await loadRoute();
    await GET();

    // Named explicitly so adding one has to delete an assertion rather than
    // slip past a generic shape check.
    const forbidden = [
      "distinct_id",
      "ph_distinct_id",
      "install_id",
      "installation_id",
      "machine_id",
      "device_id",
      "device",
      "user_id",
      "session",
      "session_id",
      "ip",
      "ip_address",
      "user_agent",
      "userAgent",
      "hostname",
      "email",
      "anonymous_id",
    ];
    const props = captures[0].properties ?? {};
    for (const key of Object.keys(props)) {
      assert.equal(
        forbidden.includes(key),
        false,
        `update check must not carry "${key}" — the local product has no telemetry`
      );
    }
    // Whitelist rather than blacklist: only `outcome` may ever be present.
    assert.deepEqual(Object.keys(props), ["outcome"]);
    assert.equal(captures[0].distinctId, null);
  });

  it("takes no Request parameter, so no request data is even in scope", async () => {
    const { GET } = await loadRoute();
    // This is the structural guarantee behind the assertions above: with no
    // Request in scope, a future change cannot casually reach for a header, a
    // cookie or an IP. Adding a parameter here should fail this test loudly.
    assert.equal(
      GET.length,
      0,
      "GET must take no parameters — a Request in scope is how an aggregate count becomes telemetry"
    );
  });
});
