import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { __setExomemSqlForTests, type ExomemSqlResult } from "../db";
import { ExomemHostedError } from "../errors";

const TOKEN = "1f0c7a2b9d4e6f8a0b1c2d3e4f5a6b7c";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const TRANSITION_ID = "a".repeat(64);

let emailFails = false;

/** The module under test is loaded only after `mock.module` is installed:
 * a static import would bind the real Brevo client before the mock exists. */
let receiver: typeof import("../alert-receiver");

before(async () => {
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async () => {
        if (emailFails) throw new Error("BREVO_API_KEY is not set");
        return { success: true, messageId: "test-message" };
      },
    },
  });
  receiver = await import("../alert-receiver");
});

after(() => mock.reset());

/** The exact object the pinned Python sender serializes. */
function senderBody(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    transition_id: TRANSITION_ID,
    job: "exomem-reconcile",
    alert: "scheduler_missed_run",
    active: true,
    ...overrides,
  };
}

type Recorded = { marker: string; values: unknown[] };
let recorded: Recorded[] = [];
let insertConflicts = false;
let undeliveredRows: Array<Record<string, unknown>> = [];
let failWrites = false;

function markerOf(strings: TemplateStringsArray): string {
  const match = strings[0].match(/\/\* (exomem:[a-z-]+) \*\//);
  return match ? match[1] : "unknown";
}

function installFakeSql(): void {
  __setExomemSqlForTests((strings, ...values): Promise<ExomemSqlResult> => {
    const marker = markerOf(strings);
    recorded.push({ marker, values });
    if (failWrites) return Promise.reject(new Error("database unavailable"));
    if (marker === "exomem:record-alert-transition") {
      return Promise.resolve({ rows: insertConflicts ? [] : [{ transition_id: TRANSITION_ID }] });
    }
    if (marker === "exomem:list-undelivered-alerts") {
      return Promise.resolve({ rows: undeliveredRows });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  recorded = [];
  insertConflicts = false;
  undeliveredRows = [];
  failWrites = false;
  emailFails = false;
  installFakeSql();
  process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = TOKEN_DIGEST;
});

afterEach(() => {
  __setExomemSqlForTests(null);
  delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256;
  delete process.env.EXOMEM_HOSTED_ALERT_RECIPIENT;
});

function expectRejection(fn: () => unknown, code: string, status: number): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ExomemHostedError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

describe("verifyAlertToken", () => {
  it("accepts the exact configured capability", () => {
    assert.doesNotThrow(() => receiver.verifyAlertToken(TOKEN));
  });

  it("answers 404 rather than 401 so the endpoint stays unconfirmable", () => {
    expectRejection(() => receiver.verifyAlertToken("wrong"), "ALERT_ENDPOINT_NOT_FOUND", 404);
  });

  it("fails closed when no digest is configured", () => {
    delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256;
    expectRejection(() => receiver.verifyAlertToken(TOKEN), "ALERT_ENDPOINT_NOT_FOUND", 404);
  });

  it("fails closed on a malformed configured digest", () => {
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = "not-a-digest";
    expectRejection(() => receiver.verifyAlertToken(TOKEN), "ALERT_ENDPOINT_NOT_FOUND", 404);
  });

  it("bounds the segment before hashing", () => {
    expectRejection(
      () => receiver.verifyAlertToken("x".repeat(257)),
      "ALERT_ENDPOINT_NOT_FOUND",
      404
    );
  });

  it("rejects a missing segment", () => {
    expectRejection(() => receiver.verifyAlertToken(undefined), "ALERT_ENDPOINT_NOT_FOUND", 404);
  });
});

describe("parseAlertTransition", () => {
  it("accepts the pinned sender shape", () => {
    const parsed = receiver.parseAlertTransition(senderBody(), TRANSITION_ID);
    assert.deepEqual(parsed, {
      transitionId: TRANSITION_ID,
      job: "exomem-reconcile",
      alert: "scheduler_missed_run",
      active: true,
    });
  });

  it("accepts a resolution transition", () => {
    const parsed = receiver.parseAlertTransition(senderBody({ active: false }), TRANSITION_ID);
    assert.equal(parsed.active, false);
  });

  it("rejects an unknown extra field", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody({ severity: "page" }), TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects a missing field", () => {
    const body = senderBody() as Record<string, unknown>;
    delete body.job;
    expectRejection(
      () => receiver.parseAlertTransition(body, TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects an unsupported schema version", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody({ schema_version: 2 }), TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects a non-digest transition id", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody({ transition_id: "short" }), "short"),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects an unbounded label", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody({ job: "x".repeat(65) }), TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects a label carrying free text", () => {
    expectRejection(
      () =>
        receiver.parseAlertTransition(
          senderBody({ alert: "note: user@example.com" }),
          TRANSITION_ID
        ),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects a truthy non-boolean active", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody({ active: "true" }), TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("requires the header to restate the body transition id", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody(), "b".repeat(64)),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects a missing header", () => {
    expectRejection(
      () => receiver.parseAlertTransition(senderBody(), null),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });

  it("rejects non-object payloads", () => {
    expectRejection(
      () => receiver.parseAlertTransition([senderBody()], TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
    expectRejection(
      () => receiver.parseAlertTransition(null, TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
    expectRejection(
      () => receiver.parseAlertTransition("{}", TRANSITION_ID),
      "ALERT_PAYLOAD_INVALID",
      400
    );
  });
});

const transition = {
  transitionId: TRANSITION_ID,
  job: "exomem-reconcile",
  alert: "scheduler_missed_run",
  active: true,
};

describe("recordAlertTransition", () => {
  it("accepts a first delivery", async () => {
    const result = await receiver.recordAlertTransition(transition);
    assert.equal(result.accepted, true);
    assert.equal(recorded[0].marker, "exomem:record-alert-transition");
  });

  it("reports a replay as not accepted so it is not notified twice", async () => {
    insertConflicts = true;
    const result = await receiver.recordAlertTransition(transition);
    assert.equal(result.accepted, false);
  });
});

describe("deliverAlertNotification", () => {
  it("records a delivered notification", async () => {
    const outcome = await receiver.deliverAlertNotification(transition);
    assert.equal(outcome.delivered, true);
    assert.ok(recorded.some((entry) => entry.marker === "exomem:mark-alert-notified"));
  });

  it("records a stable code instead of the provider failure text", async () => {
    emailFails = true;
    const outcome = await receiver.deliverAlertNotification(transition);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.errorCode, "EMAIL_DELIVERY_UNAVAILABLE");
    const failure = recorded.find(
      (entry) => entry.marker === "exomem:mark-alert-notification-failed"
    );
    assert.ok(failure);
    assert.equal(failure.values[0], "EMAIL_DELIVERY_UNAVAILABLE");
    assert.ok(!JSON.stringify(recorded).includes("BREVO_API_KEY"));
  });

  it("never throws when the state write fails", async () => {
    const outcome = await receiver.deliverAlertNotification(transition);
    assert.equal(outcome.delivered, true);
    failWrites = true;
    const second = await receiver.deliverAlertNotification(transition);
    assert.equal(second.errorCode, "NOTIFICATION_STATE_WRITE_FAILED");
  });
});

describe("listUndeliveredAlerts", () => {
  it("bounds the requested slice", async () => {
    undeliveredRows = [
      { transition_id: TRANSITION_ID, job: "exomem-reconcile", alert: "backup_age", active: true },
    ];
    const rows = await receiver.listUndeliveredAlerts(500);
    assert.equal(rows.length, 1);
    const call = recorded.find((entry) => entry.marker === "exomem:list-undelivered-alerts");
    assert.equal(call?.values[0], 20);
  });
});
