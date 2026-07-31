import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { __setExomemSqlForTests, type ExomemSqlResult } from "@/lib/exomem-hosted/db";
import { setOperationalEventSinkForTests } from "@/lib/exomem-hosted/observability";

const TOKEN = "1f0c7a2b9d4e6f8a0b1c2d3e4f5a6b7c";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const TRANSITION_ID = "c3d4".repeat(16);

let sent: Array<{ to: string; subject: string }> = [];

before(() => {
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async (input: { to: string; subject: string }) => {
        sent.push(input);
        return { success: true, messageId: "test-message" };
      },
    },
  });
});

after(() => mock.reset());

let recorded: string[] = [];
let logLines: string[] = [];
let insertConflicts = false;
let storeFails = false;

function markerOf(strings: TemplateStringsArray): string {
  const match = strings[0].match(/\/\* (exomem:[a-z-]+) \*\//);
  return match ? match[1] : "unknown";
}

beforeEach(() => {
  sent = [];
  recorded = [];
  logLines = [];
  insertConflicts = false;
  storeFails = false;
  process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = TOKEN_DIGEST;
  setOperationalEventSinkForTests((line) => logLines.push(line));
  __setExomemSqlForTests((strings, ...values): Promise<ExomemSqlResult> => {
    const marker = markerOf(strings);
    recorded.push(marker);
    if (marker === "exomem:record-alert-transition") {
      if (storeFails) return Promise.reject(new Error("database unavailable"));
      return Promise.resolve({ rows: insertConflicts ? [] : [{ transition_id: values[0] }] });
    }
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  __setExomemSqlForTests(null);
  setOperationalEventSinkForTests(null);
  delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256;
});

/** Byte-identical to `json.dumps(..., separators=(",", ":"), sort_keys=True)`
 * in `infra/helm/platform/files/scheduler_runtime.py`. */
function senderBytes(active = true, transitionId = TRANSITION_ID): string {
  return `{"active":${active},"alert":"scheduler_missed_run","job":"exomem-reconcile","schema_version":1,"transition_id":"${transitionId}"}`;
}

/** Mirrors the sender's exact request construction. */
function senderRequest(options: {
  token?: string;
  body?: string;
  transitionHeader?: string | null;
  contentLength?: string;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const header = options.transitionHeader === undefined ? TRANSITION_ID : options.transitionHeader;
  if (header !== null) headers["x-exomem-alert-transition"] = header;
  if (options.contentLength) headers["content-length"] = options.contentLength;
  return new Request(`https://substratesystems.io/api/exomem/alerts/${options.token ?? TOKEN}`, {
    method: "POST",
    headers,
    body: options.body ?? senderBytes(),
  }) as unknown as import("next/server").NextRequest;
}

function params(token = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

describe("POST /api/exomem/alerts/[token]", () => {
  it("acknowledges the pinned sender request once the transition is durable", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, accepted: true });
    assert.ok(recorded.includes("exomem:record-alert-transition"));
  });

  it("answers before notifying, so a slow mail provider cannot spend the sender budget", async () => {
    const { POST } = await import("../route");
    await POST(senderRequest({}), params());
    // Notification is scheduled in `after()`; nothing may be sent inline.
    assert.equal(sent.length, 0, "email must not run inside the acknowledgement path");
  });

  it("acknowledges a redelivery rather than rejecting it", async () => {
    insertConflicts = true;
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, accepted: false });
  });

  it("answers 404 for a wrong capability and never touches the store", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({ token: "wrong" }), params("wrong"));
    assert.equal(response.status, 404);
    assert.equal(recorded.length, 0);
  });

  it("answers 404 rather than 405 for every other method", async () => {
    // A 405 with an Allow header would confirm the endpoint exists to an
    // unauthenticated prober, defeating the 404-not-401 choice.
    const route = await import("../route");
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const response = route[method]();
      assert.equal(response.status, 404, `${method} must not reveal the route`);
      assert.equal(response.headers.get("allow"), null);
    }
  });

  it("rejects a body whose declared length exceeds the bound", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({ contentLength: "99999" }), params());
    assert.equal(response.status, 413);
    assert.equal(recorded.length, 0);
  });

  it("rejects an oversized streamed body", async () => {
    const { POST } = await import("../route");
    const padded = `{"active":true,"alert":"${"a".repeat(5000)}","job":"j","schema_version":1,"transition_id":"${TRANSITION_ID}"}`;
    const response = await POST(senderRequest({ body: padded }), params());
    assert.equal(response.status, 413);
    assert.equal(recorded.length, 0);
  });

  it("rejects a header that does not restate the body transition id", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({ transitionHeader: "d".repeat(64) }), params());
    assert.equal(response.status, 400);
    assert.equal(recorded.length, 0);
  });

  it("asks the sender to retry when the transition is not yet durable", async () => {
    storeFails = true;
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "ALERT_STORE_UNAVAILABLE");
    assert.equal(body.error.retryable, true);
  });

  it("distinguishes a store outage from a denial in the log stream", async () => {
    storeFails = true;
    const { POST } = await import("../route");
    await POST(senderRequest({}), params());
    const events = logLines.map(
      (line) => JSON.parse(line) as { event: string; errorCode?: string }
    );
    assert.ok(events.some((event) => event.event === "alerts.transition.unavailable"));
    assert.ok(!events.some((event) => event.event === "alerts.transition.denied"));
  });

  it("labels a denial with its cause so probing is visible", async () => {
    const { POST } = await import("../route");
    await POST(senderRequest({ token: "wrong" }), params("wrong"));
    const events = logLines.map(
      (line) => JSON.parse(line) as { event: string; errorCode?: string }
    );
    const denial = events.find((event) => event.event === "alerts.transition.denied");
    assert.equal(denial?.errorCode, "ALERT_ENDPOINT_NOT_FOUND");
  });

  it("never writes the capability into logs or the response", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    const body = JSON.stringify(await response.json());
    assert.ok(!body.includes(TOKEN));
    assert.ok(logLines.length > 0, "the accepted transition must be logged at all");
    for (const line of logLines) {
      assert.ok(!line.includes(TOKEN), `capability leaked into a log line: ${line}`);
      assert.ok(!line.includes("founder@"), `recipient leaked into a log line: ${line}`);
    }
  });

  it("emits only allowlisted content-free fields for an accepted transition", async () => {
    const { POST } = await import("../route");
    await POST(senderRequest({}), params());
    const accepted = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.event === "alerts.transition.accepted");
    assert.ok(accepted);
    assert.deepEqual(Object.keys(accepted).sort(), [
      "alertJob",
      "alertName",
      "event",
      "outcome",
      "requestId",
      "timestamp",
      "transitionHash",
    ]);
    assert.equal(accepted.alertJob, "exomem-reconcile");
    assert.equal(accepted.transitionHash, TRANSITION_ID);
  });

  it("never redirects", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
