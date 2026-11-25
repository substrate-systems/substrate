import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  downloadTicketLifetimeSeconds,
  signDownloadTicket,
  verifyDownloadTicket,
} from "../cloud-download-ticket";

const KEY = Buffer.alloc(32, 9);
const LOGIN = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  cellId: "aaaaaaaaaaaaaaaa",
  familyId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
};
const PATH = "Recordings/standup.mp4";
const NOW = 1_800_000_000;
const FIFTEEN_MINUTES = 15 * 60;
const ONE_HOUR = 60 * 60;

function ticket(options: Parameters<typeof signDownloadTicket>[2] = { now: NOW }): string {
  return signDownloadTicket({ ...LOGIN, path: PATH }, KEY, options);
}

describe("download ticket", () => {
  it("names the login it was minted for", () => {
    assert.deepEqual(verifyDownloadTicket(ticket(), PATH, KEY, { now: NOW }), LOGIN);
  });

  it("lives fifteen minutes unless configured, so a ticket in an address is a short bearer", () => {
    assert.equal(downloadTicketLifetimeSeconds({}), FIFTEEN_MINUTES);
    assert.deepEqual(
      verifyDownloadTicket(ticket(), PATH, KEY, { now: NOW + FIFTEEN_MINUTES - 1 }),
      LOGIN
    );
    assert.equal(verifyDownloadTicket(ticket(), PATH, KEY, { now: NOW + FIFTEEN_MINUTES }), null);
  });

  it("takes its life from the setting and is capped at both ends by it", () => {
    const env = { EXOMEM_CLOUD_DOWNLOAD_TICKET_LIFETIME_SECONDS: String(ONE_HOUR) };
    assert.equal(downloadTicketLifetimeSeconds(env), ONE_HOUR);
    const longer = ticket({ now: NOW, lifetimeSeconds: ONE_HOUR });
    const gateway = { lifetimeSeconds: ONE_HOUR };
    assert.deepEqual(
      verifyDownloadTicket(longer, PATH, KEY, { now: NOW + ONE_HOUR - 1, ...gateway }),
      LOGIN
    );
    assert.equal(
      verifyDownloadTicket(longer, PATH, KEY, { now: NOW + ONE_HOUR, ...gateway }),
      null
    );
    // A gateway left at the default refuses a ticket that the app signed for an hour.
    assert.equal(
      verifyDownloadTicket(longer, PATH, KEY, { now: NOW, lifetimeSeconds: FIFTEEN_MINUTES }),
      null
    );
    assert.throws(() => ticket({ now: NOW, lifetimeSeconds: 24 * 60 * 60 + 1 }), RangeError);
    assert.throws(() => ticket({ now: NOW, lifetimeSeconds: 0 }), RangeError);
    for (const bad of ["abc", "59", "86401", "1.5", "-5"]) {
      assert.throws(
        () => downloadTicketLifetimeSeconds({ EXOMEM_CLOUD_DOWNLOAD_TICKET_LIFETIME_SECONDS: bad }),
        RangeError,
        bad
      );
    }
  });

  it("is useless for any other path, including a prefix or a case change", () => {
    const minted = ticket();
    for (const other of [
      "Recordings/other.mp4",
      "Recordings/standup.mp",
      "recordings/standup.mp4",
      "",
    ]) {
      assert.equal(verifyDownloadTicket(minted, other, KEY, { now: NOW }), null, other);
    }
  });

  it("is refused when the payload or the MAC changes, or another key signed it", () => {
    const [payload, mac] = ticket().split(".");
    const flipped = (text: string) => `${text.startsWith("A") ? "B" : "A"}${text.slice(1)}`;
    assert.equal(verifyDownloadTicket(`${flipped(payload)}.${mac}`, PATH, KEY, { now: NOW }), null);
    assert.equal(verifyDownloadTicket(`${payload}.${flipped(mac)}`, PATH, KEY, { now: NOW }), null);
    assert.equal(verifyDownloadTicket(`${payload}.`, PATH, KEY, { now: NOW }), null);
    assert.equal(verifyDownloadTicket(ticket(), PATH, Buffer.alloc(32, 10), { now: NOW }), null);
  });

  it("is refused when it is not shaped like a ticket", () => {
    for (const garbage of ["", "x", "a.b.c", ".", `${"A".repeat(2000)}.${"B".repeat(43)}`]) {
      assert.equal(verifyDownloadTicket(garbage, PATH, KEY, { now: NOW }), null);
    }
  });
});
