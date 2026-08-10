import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { __setExomemSqlForTests, type ExomemSqlResult } from "../db";
import { ExomemHostedError } from "../errors";

const TOKEN = "1f0c7a2b9d4e6f8a0b1c2d3e4f5a6b7c";
const TOKEN_DIGEST = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const TRANSITION_ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

type Sent = { to: string; senderName?: string; subject: string; textContent: string };
let sent: Sent[] = [];
/** "throw" models a transport/config failure, "reject" models Brevo answering
 * with success:false — two different branches in notifyAlertTransition. */
let emailMode: "ok" | "throw" | "reject" = "ok";
/** Fails sends for one alert name only, so a pass can contain both a failing
 * and a succeeding row. */
let failForAlert: string | null = null;

/** The module under test is loaded only after `mock.module` is installed:
 * a static import would bind the real Brevo client before the mock exists. */
let receiver: typeof import("../alert-receiver");

before(async () => {
  mock.module("@/lib/brevo", {
    namedExports: {
      sendTransactionalEmail: async (input: Sent) => {
        if (failForAlert && input.subject.includes(failForAlert)) {
          throw new Error("BREVO_API_KEY is not set");
        }
        if (emailMode === "throw") throw new Error("BREVO_API_KEY is not set");
        if (emailMode === "reject") return { success: false, error: "brevo rejected sender" };
        sent.push(input);
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

type Row = {
  transition_id: string;
  job: string;
  alert: string;
  active: boolean;
  received_at: number;
  notification_state: "pending" | "delivered" | "failed";
  notification_attempts: number;
  claimed_until: number | null;
  notified_at: number | null;
  last_error_code: string | null;
};

/** A small in-memory stand-in for the table, faithful enough to exercise the
 * claim predicate, the attempt ceiling, and the ordering. Statement-level
 * behaviour is modelled; SQL text is not parsed. */
let table: Map<string, Row>;
let clock = 1_000_000;
let sequence = 0;
let failMarkers: Set<string>;

function markerOf(strings: TemplateStringsArray): string {
  const match = strings[0].match(/\/\* (exomem:[a-z-]+) \*\//);
  return match ? match[1] : "unknown";
}

/** Mirrors the migration's CHECK ((state='delivered') = (notified_at IS NOT NULL)). */
function assertRowInvariants(row: Row): void {
  assert.equal(
    row.notification_state === "delivered",
    row.notified_at !== null,
    `notified_at invariant violated for ${row.transition_id} in state ${row.notification_state}`
  );
  assert.ok(row.notification_attempts >= 0);
  if (row.last_error_code !== null) assert.match(row.last_error_code, /^[A-Z0-9_]{1,64}$/);
}

function installFakeSql(): void {
  __setExomemSqlForTests((strings, ...values): Promise<ExomemSqlResult> => {
    const marker = markerOf(strings);
    if (failMarkers.has(marker)) return Promise.reject(new Error("database unavailable"));

    if (marker === "exomem:record-alert-transition") {
      const [transition_id, job, alert, active] = values as [string, string, string, boolean];
      if (table.has(transition_id)) return Promise.resolve({ rows: [] });
      table.set(transition_id, {
        transition_id,
        job,
        alert,
        active,
        received_at: sequence++,
        notification_state: "pending",
        notification_attempts: 0,
        claimed_until: null,
        notified_at: null,
        last_error_code: null,
      });
      return Promise.resolve({ rows: [{ transition_id }] });
    }

    if (marker === "exomem:claim-alert-notification") {
      const [claimSeconds, transitionId] = values as [number, string];
      const row = table.get(transitionId);
      const claimable =
        row &&
        row.notification_state === "pending" &&
        (row.claimed_until === null || row.claimed_until < clock);
      if (!claimable) return Promise.resolve({ rows: [] });
      row.notification_attempts += 1;
      row.claimed_until = clock + claimSeconds * 1000;
      assertRowInvariants(row);
      return Promise.resolve({
        rows: [
          {
            transition_id: row.transition_id,
            job: row.job,
            alert: row.alert,
            active: row.active,
            notification_attempts: row.notification_attempts,
          },
        ],
      });
    }

    if (marker === "exomem:mark-alert-notified") {
      const [transitionId] = values as [string];
      const row = table.get(transitionId);
      if (row && row.notification_state === "pending") {
        row.notification_state = "delivered";
        row.notified_at = clock;
        row.claimed_until = null;
        row.last_error_code = null;
        assertRowInvariants(row);
      }
      return Promise.resolve({ rows: [] });
    }

    if (marker === "exomem:release-alert-notification") {
      const [state, errorCode, transitionId] = values as [
        Row["notification_state"],
        string,
        string,
      ];
      const row = table.get(transitionId);
      if (row && row.notification_state === "pending") {
        row.notification_state = state;
        row.claimed_until = null;
        row.last_error_code = errorCode;
        assertRowInvariants(row);
      }
      return Promise.resolve({ rows: [] });
    }

    if (marker === "exomem:latest-delivered-alert") {
      const [job, alert, transitionId] = values as [string, string, string];
      const match = [...table.values()]
        .filter(
          (row) =>
            row.job === job &&
            row.alert === alert &&
            row.notification_state === "delivered" &&
            row.transition_id !== transitionId
        )
        .sort((left, right) => right.received_at - left.received_at)[0];
      return Promise.resolve({ rows: match ? [{ active: match.active }] : [] });
    }

    if (marker === "exomem:list-claimable-alerts") {
      const [limit] = values as [number];
      const rows = [...table.values()]
        .filter(
          (row) =>
            row.notification_state === "pending" &&
            (row.claimed_until === null || row.claimed_until < clock)
        )
        .sort((left, right) => left.received_at - right.received_at)
        .slice(0, limit)
        .map((row) => ({ transition_id: row.transition_id }));
      return Promise.resolve({ rows });
    }

    if (marker === "exomem:count-alert-backlog") {
      const all = [...table.values()];
      return Promise.resolve({
        rows: [
          {
            pending: all.filter((row) => row.notification_state === "pending").length,
            failed: all.filter((row) => row.notification_state === "failed").length,
          },
        ],
      });
    }

    return Promise.resolve({ rows: [] });
  });
}

function seed(overrides: Partial<Row> & { transition_id: string }): Row {
  const row: Row = {
    job: "exomem-reconcile",
    alert: "scheduler_missed_run",
    active: true,
    received_at: sequence++,
    notification_state: "pending",
    notification_attempts: 0,
    claimed_until: null,
    notified_at: null,
    last_error_code: null,
    ...overrides,
  } as Row;
  table.set(row.transition_id, row);
  return row;
}

beforeEach(() => {
  sent = [];
  emailMode = "ok";
  failForAlert = null;
  table = new Map();
  failMarkers = new Set();
  clock = 1_000_000;
  sequence = 0;
  installFakeSql();
  process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = TOKEN_DIGEST;
});

afterEach(() => {
  __setExomemSqlForTests(null);
  delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256;
  delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS;
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

  it("accepts the previous digest during a rotation overlap", () => {
    const rotated = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = createHash("sha256")
      .update(rotated, "utf8")
      .digest("hex");
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS = TOKEN_DIGEST;
    assert.doesNotThrow(() => receiver.verifyAlertToken(rotated));
    assert.doesNotThrow(() => receiver.verifyAlertToken(TOKEN));
  });

  it("rejects the retired digest once the previous slot is cleared", () => {
    const rotated = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = createHash("sha256")
      .update(rotated, "utf8")
      .digest("hex");
    delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS;
    assert.doesNotThrow(() => receiver.verifyAlertToken(rotated));
    expectRejection(() => receiver.verifyAlertToken(TOKEN), "ALERT_ENDPOINT_NOT_FOUND", 404);
  });

  it("ignores a malformed previous digest rather than widening the ring", () => {
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS = "not-a-digest";
    assert.doesNotThrow(() => receiver.verifyAlertToken(TOKEN));
    expectRejection(
      () => receiver.verifyAlertToken("not-a-digest"),
      "ALERT_ENDPOINT_NOT_FOUND",
      404
    );
  });
});

describe("parseAlertTransition", () => {
  it("accepts the pinned sender shape", () => {
    assert.deepEqual(receiver.parseAlertTransition(senderBody(), TRANSITION_ID), {
      transitionId: TRANSITION_ID,
      job: "exomem-reconcile",
      alert: "scheduler_missed_run",
      active: true,
    });
  });

  it("accepts a resolution transition", () => {
    assert.equal(
      receiver.parseAlertTransition(senderBody({ active: false }), TRANSITION_ID).active,
      false
    );
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
    for (const payload of [[senderBody()], null, "{}"]) {
      expectRejection(
        () => receiver.parseAlertTransition(payload, TRANSITION_ID),
        "ALERT_PAYLOAD_INVALID",
        400
      );
    }
  });
});

describe("recordAlertTransition", () => {
  const transition = {
    transitionId: TRANSITION_ID,
    job: "exomem-reconcile",
    alert: "scheduler_missed_run",
    active: true,
  };

  it("accepts a first delivery", async () => {
    assert.equal((await receiver.recordAlertTransition(transition)).accepted, true);
    assert.equal(table.get(TRANSITION_ID)?.notification_state, "pending");
  });

  it("reports a replay as not accepted", async () => {
    await receiver.recordAlertTransition(transition);
    assert.equal((await receiver.recordAlertTransition(transition)).accepted, false);
    assert.equal(table.size, 1);
  });
});

describe("claimAlertNotification", () => {
  it("grants exclusivity, so an overlapping invocation cannot also send", async () => {
    seed({ transition_id: TRANSITION_ID });
    const first = await receiver.claimAlertNotification(TRANSITION_ID);
    const second = await receiver.claimAlertNotification(TRANSITION_ID);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(first.attempts, 1);
  });

  it("consumes an attempt on claim, so a died-mid-send claim cannot loop", async () => {
    seed({ transition_id: TRANSITION_ID });
    await receiver.claimAlertNotification(TRANSITION_ID);
    clock += 61_000; // lease expires; the process that held it never returned
    const retry = await receiver.claimAlertNotification(TRANSITION_ID);
    assert.equal(retry?.attempts, 2);
  });

  it("refuses a delivered row", async () => {
    seed({ transition_id: TRANSITION_ID, notification_state: "delivered", notified_at: clock });
    assert.equal(await receiver.claimAlertNotification(TRANSITION_ID), null);
  });

  it("refuses a row that exhausted its attempts", async () => {
    seed({ transition_id: TRANSITION_ID, notification_state: "failed" });
    assert.equal(await receiver.claimAlertNotification(TRANSITION_ID), null);
  });
});

describe("deliverClaimedAlert", () => {
  it("notifies the founder and records delivery", async () => {
    seed({ transition_id: TRANSITION_ID });
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.skipped, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "founder@substratesystems.io");
    assert.equal(sent[0].senderName, "Exomem");
    assert.match(sent[0].subject, /FIRING: scheduler_missed_run \(exomem-reconcile\)/);
    assert.equal(table.get(TRANSITION_ID)?.notification_state, "delivered");
  });

  it("renders a resolution distinctly", async () => {
    seed({ transition_id: TRANSITION_ID, active: false });
    await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.match(sent[0].subject, /RESOLVED: scheduler_missed_run/);
  });

  it("leaves a failed send pending and retryable below the ceiling", async () => {
    seed({ transition_id: TRANSITION_ID });
    emailMode = "throw";
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.errorCode, "EMAIL_DELIVERY_UNAVAILABLE");
    const row = table.get(TRANSITION_ID);
    assert.equal(row?.notification_state, "pending");
    assert.equal(row?.claimed_until, null, "a failed send must release its claim");
  });

  it("distinguishes a Brevo rejection from a transport failure", async () => {
    seed({ transition_id: TRANSITION_ID });
    emailMode = "reject";
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.errorCode, "EMAIL_DELIVERY_FAILED");
    assert.equal(table.get(TRANSITION_ID)?.last_error_code, "EMAIL_DELIVERY_FAILED");
  });

  it("parks a transition as failed once the attempt ceiling is reached", async () => {
    seed({
      transition_id: TRANSITION_ID,
      notification_attempts: receiver.ALERT_MAX_NOTIFICATION_ATTEMPTS - 1,
    });
    emailMode = "throw";
    await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(table.get(TRANSITION_ID)?.notification_state, "failed");
  });

  it("never leaks the provider failure text into stored state", async () => {
    seed({ transition_id: TRANSITION_ID });
    emailMode = "throw";
    await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.ok(!JSON.stringify([...table.values()]).includes("BREVO_API_KEY"));
  });

  it("skips an unclaimable transition without sending", async () => {
    seed({ transition_id: TRANSITION_ID, notification_state: "delivered", notified_at: clock });
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.skipped, true);
    assert.equal(sent.length, 0);
  });

  it("suppresses a redelivery that repeats the last delivered state", async () => {
    // The sender recomputes transition ids, so a retry can arrive under a new
    // id carrying the same state change.
    seed({
      transition_id: TRANSITION_ID,
      notification_state: "delivered",
      notified_at: clock,
      active: true,
    });
    seed({ transition_id: OTHER_ID, active: true });
    const outcome = await receiver.deliverClaimedAlert(OTHER_ID);
    assert.equal(outcome.delivered, true);
    assert.equal(outcome.skipped, true);
    assert.equal(sent.length, 0, "a repeated state must not produce a second email");
    assert.equal(table.get(OTHER_ID)?.notification_state, "delivered");
  });

  it("still notifies a genuine flap back to a previous state", async () => {
    seed({
      transition_id: TRANSITION_ID,
      notification_state: "delivered",
      notified_at: clock,
      active: false,
    });
    seed({ transition_id: OTHER_ID, active: true });
    const outcome = await receiver.deliverClaimedAlert(OTHER_ID);
    assert.equal(outcome.skipped, false);
    assert.equal(sent.length, 1);
  });

  it("notifies rather than suppressing when the redundancy check fails", async () => {
    seed({ transition_id: TRANSITION_ID });
    failMarkers.add("exomem:latest-delivered-alert");
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.delivered, true);
    assert.equal(sent.length, 1);
  });

  it("reports a lost state write without throwing", async () => {
    seed({ transition_id: TRANSITION_ID });
    failMarkers.add("exomem:mark-alert-notified");
    const outcome = await receiver.deliverClaimedAlert(TRANSITION_ID);
    assert.equal(outcome.errorCode, "NOTIFICATION_STATE_WRITE_FAILED");
    // The lease expires on its own, so the row returns to the claimable set.
    clock += 61_000;
    assert.ok(await receiver.claimAlertNotification(TRANSITION_ID));
  });
});

describe("runAlertNotificationPass", () => {
  it("drains a backlog the incoming transition did not create", async () => {
    // Distinct alert names: two rows sharing (job, alert, active) are by
    // definition the same news, and the redundancy guard would collapse them.
    seed({ transition_id: OTHER_ID, alert: "backup_age" });
    seed({ transition_id: TRANSITION_ID });
    const outcomes = await receiver.runAlertNotificationPass({ first: TRANSITION_ID, limit: 5 });
    assert.equal(outcomes.length, 2);
    assert.equal(sent.length, 2);
    assert.equal(table.get(OTHER_ID)?.notification_state, "delivered");
  });

  it("delivers a duplicate whose first attempt committed but never notified", async () => {
    // The CRITICAL path: attempt one inserted the row and died; the sender's
    // retry must not be acknowledged with nothing sent.
    seed({ transition_id: TRANSITION_ID });
    const { accepted } = await receiver.recordAlertTransition({
      transitionId: TRANSITION_ID,
      job: "exomem-reconcile",
      alert: "scheduler_missed_run",
      active: true,
    });
    assert.equal(accepted, false, "this models a redelivery, not a fresh insert");
    await receiver.runAlertNotificationPass({ first: TRANSITION_ID, limit: 5 });
    assert.equal(sent.length, 1);
    assert.equal(table.get(TRANSITION_ID)?.notification_state, "delivered");
  });

  it("does not process the same transition twice in one pass", async () => {
    seed({ transition_id: TRANSITION_ID });
    const outcomes = await receiver.runAlertNotificationPass({ first: TRANSITION_ID, limit: 5 });
    assert.equal(outcomes.length, 1);
    assert.equal(sent.length, 1);
  });

  it("keeps going past a row it cannot deliver", async () => {
    // Head-of-line: the oldest row fails every send, and a newer alert behind
    // it must still be delivered in the same pass.
    seed({ transition_id: OTHER_ID, alert: "poison" });
    seed({ transition_id: TRANSITION_ID });
    failForAlert = "poison";
    const outcomes = await receiver.runAlertNotificationPass({ limit: 5 });
    assert.equal(outcomes.length, 2, "both rows were attempted");
    assert.equal(table.get(OTHER_ID)?.notification_state, "pending");
    assert.equal(
      table.get(TRANSITION_ID)?.notification_state,
      "delivered",
      "a failing older row must not starve a newer one"
    );
    assert.equal(sent.length, 1);
  });

  it("retires a permanently failing row so it stops blocking the queue", async () => {
    seed({ transition_id: OTHER_ID });
    emailMode = "throw";
    for (let attempt = 0; attempt < receiver.ALERT_MAX_NOTIFICATION_ATTEMPTS; attempt += 1) {
      await receiver.runAlertNotificationPass({ limit: 5 });
      clock += 61_000;
    }
    assert.equal(table.get(OTHER_ID)?.notification_state, "failed");

    emailMode = "ok";
    seed({ transition_id: TRANSITION_ID });
    await receiver.runAlertNotificationPass({ limit: 5 });
    assert.equal(sent.length, 1, "a newer alert is delivered once the stuck row is retired");
    assert.equal(table.get(TRANSITION_ID)?.notification_state, "delivered");
  });

  it("survives a listing failure without losing the incoming transition", async () => {
    seed({ transition_id: TRANSITION_ID });
    failMarkers.add("exomem:list-claimable-alerts");
    const outcomes = await receiver.runAlertNotificationPass({ first: TRANSITION_ID, limit: 5 });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].delivered, true);
  });
});

describe("countAlertBacklog", () => {
  it("separates retryable pending work from rows that need a human", async () => {
    seed({ transition_id: TRANSITION_ID });
    seed({ transition_id: OTHER_ID, notification_state: "failed" });
    seed({ transition_id: "c".repeat(64), notification_state: "delivered", notified_at: clock });
    assert.deepEqual(await receiver.countAlertBacklog(), { pending: 1, failed: 1 });
  });
});
