import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

/**
 * The analytics substrate's one hard invariant: it degrades to a no-op rather
 * than throwing into the flow it observes. Every boundary case below depends on
 * that, and the checkout path is why it matters — a throwing capture must never
 * cost a purchase, and a throwing webhook capture must never cost the
 * acknowledgement that stops Paddle redelivering.
 */

const ORIGINAL_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const ORIGINAL_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

before(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
  // A refused connection, so the server client is real and its delivery fails
  // for real. Both are read at module scope, so they must be set before the
  // first dynamic import below.
  process.env.NEXT_PUBLIC_POSTHOG_HOST = "http://127.0.0.1:1";

  // posthog-js is a browser SDK; in Node it must not be touched before init.
  mock.module("posthog-js", {
    defaultExport: {
      capture: () => {
        throw new Error("posthog-js called before init");
      },
      identify: () => {
        throw new Error("posthog-js called before init");
      },
      get_distinct_id: () => {
        throw new Error("posthog-js called before init");
      },
      reset: () => {
        throw new Error("posthog-js called before init");
      },
    },
  });
});

after(() => {
  mock.reset();
  if (ORIGINAL_KEY === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = ORIGINAL_KEY;
  if (ORIGINAL_HOST === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  else process.env.NEXT_PUBLIC_POSTHOG_HOST = ORIGINAL_HOST;
});

describe("client analytics degrade to no-ops before init", () => {
  it("currentDistinctId returns null when the SDK never initialised", async () => {
    const { currentDistinctId } = await import("../analytics");
    // Blocked or uninitialised is the normal case, not the exceptional one:
    // ad blockers skew hardest among Windows power users.
    assert.equal(currentDistinctId(), null);
  });

  it("capture does not throw when the SDK never initialised", async () => {
    const { capture, AnalyticsEvent } = await import("../analytics");
    assert.doesNotThrow(() => capture(AnalyticsEvent.CheckoutStarted, { product: "supporter" }));
  });

  it("identify does not throw when the SDK never initialised", async () => {
    const { identify } = await import("../analytics");
    assert.doesNotThrow(() => identify("user-1"));
  });

  it("identify ignores an empty id rather than creating a blank person", async () => {
    const { identify } = await import("../analytics");
    assert.doesNotThrow(() => identify(""));
  });

  it("resetIdentity does not throw when the SDK never initialised", async () => {
    const { resetIdentity } = await import("../analytics");
    assert.doesNotThrow(() => resetIdentity());
  });
});

describe("server capture never throws into the request it observes", () => {
  it("resolves even when PostHog delivery fails outright", async () => {
    const { captureServer, ServerEvent } = await import("../analytics-server");

    // The invariant behind task 4.5: the Paddle webhook captures after the state
    // is persisted and before it acknowledges, so a rejecting capture would cost
    // the acknowledgement and trigger a redelivery of an already-applied event.
    // The host here refuses connections, so this is a real delivery failure.
    await assert.doesNotReject(() =>
      captureServer({
        event: ServerEvent.SubscriptionChanged,
        distinctId: null,
        properties: { event_type: "subscription.created" },
      })
    );
  });

  it("returns within the flush timeout so it cannot stall a response", async () => {
    const { captureServer, ServerEvent } = await import("../analytics-server");

    const started = process.hrtime.bigint();
    await captureServer({
      event: ServerEvent.UpdateChecked,
      distinctId: null,
      properties: { outcome: "served" },
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // FLUSH_TIMEOUT_MS is 800; allow generous headroom for a loaded CI box while
    // still failing loudly if the race guard is ever removed.
    assert.ok(
      elapsedMs < 5000,
      `captureServer took ${Math.round(elapsedMs)}ms — the flush race must bound it`
    );
  });
});

describe("distinctIdFromRequest degrades cleanly", () => {
  async function subject() {
    const { distinctIdFromRequest } = await import("../analytics-server");
    return distinctIdFromRequest;
  }

  it("returns null when there is no cookie header at all", async () => {
    const fn = await subject();
    assert.equal(fn(new Request("https://substratesystems.io/")), null);
  });

  it("returns null when the PostHog cookie is absent", async () => {
    const fn = await subject();
    const req = new Request("https://substratesystems.io/", {
      headers: { cookie: "other=1; another=2" },
    });
    assert.equal(fn(req), null);
  });

  it("returns null for a malformed cookie rather than throwing", async () => {
    const fn = await subject();
    const req = new Request("https://substratesystems.io/", {
      headers: { cookie: "ph_phc_test_key_posthog=not-json" },
    });
    assert.equal(fn(req), null);
  });

  it("returns null when the cookie has no distinct_id", async () => {
    const fn = await subject();
    const value = encodeURIComponent(JSON.stringify({ something_else: "x" }));
    const req = new Request("https://substratesystems.io/", {
      headers: { cookie: `ph_phc_test_key_posthog=${value}` },
    });
    assert.equal(fn(req), null);
  });

  it("reads the distinct_id when the cookie is well formed", async () => {
    const fn = await subject();
    const value = encodeURIComponent(JSON.stringify({ distinct_id: "abc-123" }));
    const req = new Request("https://substratesystems.io/", {
      headers: { cookie: `ph_phc_test_key_posthog=${value}` },
    });
    assert.equal(fn(req), "abc-123");
  });
});
