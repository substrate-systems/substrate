import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOWNLOAD_TICKET_MAX_LIFETIME_SECONDS,
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

function ticket(options: Parameters<typeof signDownloadTicket>[2] = { now: NOW }): string {
  return signDownloadTicket({ ...LOGIN, path: PATH }, KEY, options);
}

describe("download ticket", () => {
  it("names the login it was minted for and works for every request inside its life", () => {
    const minted = ticket();
    assert.deepEqual(verifyDownloadTicket(minted, PATH, KEY, NOW), LOGIN);
    assert.deepEqual(verifyDownloadTicket(minted, PATH, KEY, NOW + 599), LOGIN);
  });

  it("is refused after ten minutes and cannot be minted for longer", () => {
    assert.equal(verifyDownloadTicket(ticket(), PATH, KEY, NOW + 600), null);
    assert.throws(
      () => ticket({ now: NOW, lifetimeSeconds: DOWNLOAD_TICKET_MAX_LIFETIME_SECONDS + 1 }),
      RangeError
    );
  });

  it("is useless for any other path, including a prefix or a case change", () => {
    const minted = ticket();
    for (const other of [
      "Recordings/other.mp4",
      "Recordings/standup.mp",
      "recordings/standup.mp4",
      "",
    ]) {
      assert.equal(verifyDownloadTicket(minted, other, KEY, NOW), null, other);
    }
  });

  it("is refused when the payload or the MAC changes, or another key signed it", () => {
    const [payload, mac] = ticket().split(".");
    const flipped = (text: string) => `${text.startsWith("A") ? "B" : "A"}${text.slice(1)}`;
    assert.equal(verifyDownloadTicket(`${flipped(payload)}.${mac}`, PATH, KEY, NOW), null);
    assert.equal(verifyDownloadTicket(`${payload}.${flipped(mac)}`, PATH, KEY, NOW), null);
    assert.equal(verifyDownloadTicket(`${payload}.`, PATH, KEY, NOW), null);
    assert.equal(verifyDownloadTicket(ticket(), PATH, Buffer.alloc(32, 10), NOW), null);
  });

  it("is refused when it is not shaped like a ticket", () => {
    for (const garbage of ["", "x", "a.b.c", ".", `${"A".repeat(2000)}.${"B".repeat(43)}`]) {
      assert.equal(verifyDownloadTicket(garbage, PATH, KEY, NOW), null);
    }
  });
});
