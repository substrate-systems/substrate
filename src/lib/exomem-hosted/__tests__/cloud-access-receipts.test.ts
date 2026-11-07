import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { receiveAccessNotification } from "../cloud-access-receipts";

const secret = "synthetic-notification-secret-0000";
function request(events: unknown[], signingSecret = secret) {
  const body = JSON.stringify({ events });
  return new Request("https://app.example.test/api/exomem/access-record/receipts", {
    method: "POST",
    headers: {
      "x-bz-event-notification-signature": `v1=${createHmac("sha256", signingSecret).update(body).digest("hex")}`,
    },
    body,
  });
}
const event = {
  eventVersion: 1,
  eventType: "b2:ObjectCreated:Upload",
  bucketId: "test-bucket",
  objectName: "access/node/object.json.gz",
  objectVersionId: "retained-version",
  eventTimestamp: 1_800_000_000_000,
};
const config = { enabled: true, bucketId: "test-bucket", prefix: "access/", signingSecret: secret };

test("signed receipt persists exact version before acknowledging; retries preserve identity", async () => {
  const received: unknown[] = [];
  const persist = async (receipts: unknown[]) => {
    received.push(...receipts);
  };
  assert.equal((await receiveAccessNotification(request([event]), config, persist)).status, 200);
  assert.equal((await receiveAccessNotification(request([event]), config, persist)).status, 200);
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(received[0], {
    bucketId: "test-bucket",
    objectKey: event.objectName,
    versionId: "retained-version",
    providerAt: new Date(event.eventTimestamp).toISOString(),
  });
  const failed = await receiveAccessNotification(request([event]), config, async () => {
    throw new Error("storage down");
  });
  assert.equal(failed.status, 503);
});

test("forged, cross-bucket and oversized notifications cannot enqueue work or supply a fetch URL", async () => {
  let writes = 0;
  const persist = async () => {
    writes += 1;
  };
  assert.equal(
    (await receiveAccessNotification(request([event], "wrong"), config, persist)).status,
    401
  );
  assert.equal(
    (await receiveAccessNotification(request([{ ...event, bucketId: "other" }]), config, persist))
      .status,
    400
  );
  assert.equal(
    (
      await receiveAccessNotification(
        request([{ ...event, objectName: "https://private.example/secret" }]),
        config,
        persist
      )
    ).status,
    400
  );
  assert.equal(
    (
      await receiveAccessNotification(
        request([{ ...event, ignored: "x".repeat(140_000) }]),
        config,
        persist
      )
    ).status,
    413
  );
  assert.equal(writes, 0);
  assert.equal((await receiveAccessNotification(request([null]), config, persist)).status, 400);
  assert.equal(writes, 0);
});

test("disabled receipt path cannot claim record availability", async () => {
  assert.equal(
    (
      await receiveAccessNotification(
        request([event]),
        { ...config, enabled: false },
        async () => {}
      )
    ).status,
    404
  );
});
