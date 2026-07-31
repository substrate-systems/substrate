import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { __setExomemSqlForTests, type ExomemSqlResult } from "@/lib/exomem-hosted/db";

const TOKEN = "1f0c7a2b9d4e6f8a0b1c2d3e4f5a6b7c";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const TRANSITION_ID = "c3d4".repeat(16);

type SentEmail = { to: string; subject: string; textContent: string; htmlContent: string };
let sent: SentEmail[] = [];
let emailFails = false;

before(async () => {
  const { mock } = await import("node:test");
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async (input: SentEmail) => {
        if (emailFails) throw new Error("BREVO_API_KEY is not set");
        sent.push(input);
        return { success: true, messageId: "test-message" };
      },
    },
  });
});

after(async () => {
  const { mock } = await import("node:test");
  mock.reset();
});

let recorded: string[] = [];
let insertConflicts = false;
let storeFails = false;

function markerOf(strings: TemplateStringsArray): string {
  const match = strings[0].match(/\/\* (exomem:[a-z-]+) \*\//);
  return match ? match[1] : "unknown";
}

beforeEach(() => {
  sent = [];
  recorded = [];
  insertConflicts = false;
  storeFails = false;
  emailFails = false;
  process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = TOKEN_DIGEST;
  __setExomemSqlForTests((strings, ...values): Promise<ExomemSqlResult> => {
    const marker = markerOf(strings);
    recorded.push(marker);
    if (marker === "exomem:record-alert-transition") {
      if (storeFails) return Promise.reject(new Error("database unavailable"));
      return Promise.resolve({ rows: insertConflicts ? [] : [{ transition_id: values[0] }] });
    }
    if (marker === "exomem:list-undelivered-alerts") return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  __setExomemSqlForTests(null);
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
  const body = options.body ?? senderBytes();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const header = options.transitionHeader === undefined ? TRANSITION_ID : options.transitionHeader;
  if (header !== null) headers["x-exomem-alert-transition"] = header;
  if (options.contentLength) headers["content-length"] = options.contentLength;
  const url = `https://substratesystems.io/api/exomem/alerts/${options.token ?? TOKEN}`;
  return new Request(url, {
    method: "POST",
    headers,
    body,
  }) as unknown as import("next/server").NextRequest;
}

function params(token = TOKEN) {
  return { params: Promise.resolve({ token }) };
}

describe("POST /api/exomem/alerts/[token]", () => {
  it("accepts the pinned sender request and notifies the founder", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, accepted: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "founder@substratesystems.io");
    assert.match(sent[0].subject, /FIRING: scheduler_missed_run \(exomem-reconcile\)/);
    assert.ok(recorded.includes("exomem:record-alert-transition"));
    assert.ok(recorded.includes("exomem:mark-alert-notified"));
  });

  it("reports a resolution transition distinctly", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({ body: senderBytes(false) }), params());
    assert.equal(response.status, 200);
    assert.match(sent[0].subject, /RESOLVED: scheduler_missed_run/);
  });

  it("commits before answering, so the row is written even when email fails", async () => {
    emailFails = true;
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    // The sender only retries twice; a delivery failure must not cost the
    // transition, so the acknowledgement stays 2xx once the row is durable.
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, accepted: true });
    assert.ok(recorded.includes("exomem:record-alert-transition"));
    assert.ok(recorded.includes("exomem:mark-alert-notification-failed"));
    assert.equal(sent.length, 0);
  });

  it("deduplicates a redelivered transition without notifying twice", async () => {
    insertConflicts = true;
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, accepted: false });
    assert.equal(sent.length, 0);
  });

  it("answers 404 for a wrong capability and never touches the store", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({ token: "wrong" }), params("wrong"));
    assert.equal(response.status, 404);
    assert.equal(recorded.length, 0);
    assert.equal(sent.length, 0);
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
    const body = (await response.json()) as { error: { retryable: boolean } };
    assert.equal(body.error.retryable, true);
    assert.equal(sent.length, 0);
  });

  it("never puts the capability or a redirect in the response", async () => {
    const { POST } = await import("../route");
    const response = await POST(senderRequest({}), params());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(await response.json()).includes(TOKEN));
  });
});
