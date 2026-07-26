import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(resolve(process.cwd(), "src/lib/exomem-hosted/db.ts"), "utf8");

describe("invite admission capacity boundary", () => {
  it("gates new invite admission on capacity before session, tenant operation, or consumption", () => {
    const capacityGate = source.indexOf("capacity_gate AS");
    const owner = source.indexOf("owner AS", capacityGate);
    const allocation = source.indexOf("capacity_allocation AS", owner);
    const session = source.indexOf("product_session AS", allocation);
    const operation = source.indexOf("operation AS", session);
    const consumed = source.indexOf("consumed AS", operation);
    assert.ok(capacityGate >= 0);
    assert.ok(owner > capacityGate);
    assert.ok(allocation > owner);
    assert.ok(session > allocation);
    assert.ok(operation > session);
    assert.ok(consumed > operation);
    assert.match(source, /INSERT INTO exomem_capacity_allocations/i);
    assert.match(source, /redeemed_session_id = product_session\.id/i);
  });
});
