import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, before, describe, it, mock } from "node:test";
import type { ExomemPaddleDispatchResult } from "../paddle-webhook";

const SECRET = "shared-paddle-webhook-secret";

type Dispatch = (event: unknown) => Promise<ExomemPaddleDispatchResult>;

let dispatch: Dispatch = async () => ({ kind: "not_exomem" });
let POST: typeof import("../../../app/api/webhooks/paddle/route").POST;

before(async () => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  mock.module("@/lib/exomem-hosted/paddle-webhook", {
    namedExports: {
      dispatchVerifiedExomemPaddleEvent: (event: unknown) => dispatch(event),
    },
  });
  ({ POST } = await import("../../../app/api/webhooks/paddle/route"));
});

afterEach(() => {
  dispatch = async () => ({ kind: "not_exomem" });
});

function request(body: object, validSignature = true): Request {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}:${rawBody}`).digest("hex");
  return new Request("https://test.local/api/webhooks/paddle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paddle-signature": validSignature
        ? `ts=${timestamp};h1=${signature}`
        : `ts=${timestamp};h1=invalid`,
    },
    body: rawBody,
  });
}

function candidate(eventId: string): object {
  return {
    event_id: eventId,
    event_type: "subscription.created",
    occurred_at: "2026-07-12T15:00:00.000Z",
    data: {
      id: "sub_sensitive",
      customer_id: "ctm_sensitive",
      custom_data: {
        product_key: "exomem-hosted",
        user_id: "user-internal",
        tenant_id: "tenant-internal",
      },
    },
  };
}

describe("shared Paddle webhook Exomem dispatch hook", () => {
  it("never dispatches an event before shared signature verification", async () => {
    let dispatchCalls = 0;
    dispatch = async () => {
      dispatchCalls += 1;
      return { kind: "handled", outcome: "applied" };
    };

    const response = await POST(
      request(candidate("evt_bad_signature"), false) as unknown as import("next/server").NextRequest
    );

    assert.equal(response.status, 401);
    assert.equal(dispatchCalls, 0);
  });

  it("returns handled Exomem events before legacy Endstate idempotency", async () => {
    dispatch = async () => ({ kind: "handled", outcome: "applied" });
    const response = await POST(
      request(candidate("evt_routed")) as unknown as import("next/server").NextRequest
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Endstate-API-Version"), "2.1");
    assert.deepEqual(await response.json(), {
      ok: true,
      product: "exomem-hosted",
      outcome: "applied",
    });
  });

  it("invokes dispatch again after a transient first attempt", async () => {
    let calls = 0;
    dispatch = async () => {
      calls += 1;
      return calls === 1
        ? {
            kind: "rejected",
            code: "EXOMEM_PADDLE_TRANSIENT_FAILURE",
            status: 503,
          }
        : { kind: "handled", outcome: "applied" };
    };

    const first = await POST(
      request(candidate("evt_retryable")) as unknown as import("next/server").NextRequest
    );
    const retry = await POST(
      request(candidate("evt_retryable")) as unknown as import("next/server").NextRequest
    );

    assert.equal(first.status, 503);
    assert.equal(retry.status, 200);
    assert.equal(calls, 2);
  });

  it("returns safe 200 responses for every terminal Exomem outcome", async () => {
    const outcomes: Array<Extract<ExomemPaddleDispatchResult, { kind: "handled" }>["outcome"]> = [
      "applied",
      "duplicate",
      "stale",
      "ignored",
    ];
    let index = 0;
    dispatch = async () => ({
      kind: "handled",
      outcome: outcomes[index++],
    });

    for (const outcome of outcomes) {
      const response = await POST(
        request(candidate(`evt_${outcome}`)) as unknown as import("next/server").NextRequest
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).outcome, outcome);
    }
  });

  it("does not expose a thrown Paddle body or provider identifiers", async () => {
    const sentinel = "RAW_PADDLE_BODY sub_sensitive ctm_sensitive";
    dispatch = async () => {
      throw new Error(sentinel);
    };
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    try {
      const response = await POST(
        request(candidate("evt_sensitive")) as unknown as import("next/server").NextRequest
      );
      const responseText = await response.text();

      assert.equal(response.status, 503);
      assert.equal(responseText.includes(sentinel), false);
      assert.equal(responseText.includes("sub_sensitive"), false);
      assert.equal(logged.join(" ").includes(sentinel), false);
    } finally {
      console.error = originalError;
    }
  });
});
