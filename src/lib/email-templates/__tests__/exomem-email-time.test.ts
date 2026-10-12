import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emailDate,
  emailDateTime,
  emailDuration,
  emailSameDay,
} from "../exomem-email-time";

// Every time limit in an email is computed at send in the reader's zone. These cases are
// the ways that goes wrong for a real reader: the wrong local day, the wrong side of a
// clock change, an unlabelled UTC time read as local, a rounding that overstates.
describe("time limits in Exomem emails", () => {
  it("shows the reader's own calendar day when UTC is still on the day before", () => {
    const at = new Date("2026-10-24T22:30:00.000Z");
    assert.equal(emailDateTime(at, "Europe/Tallinn"), "25 October, 01:30");
    assert.equal(emailDateTime(at, "America/New_York"), "24 October, 18:30");
  });

  it("follows the clock change: the same local hour twice on the night summer time ends", () => {
    assert.equal(emailDateTime(new Date("2026-10-25T00:30:00.000Z"), "Europe/Berlin"), "25 October, 02:30");
    assert.equal(emailDateTime(new Date("2026-10-25T01:30:00.000Z"), "Europe/Berlin"), "25 October, 02:30");
    assert.equal(emailDateTime(new Date("2026-10-25T02:30:00.000Z"), "Europe/Berlin"), "25 October, 03:30");
  });

  it("labels a time UTC when the reader's zone is unknown", () => {
    const at = new Date("2026-10-24T22:30:00.000Z");
    assert.equal(emailDateTime(at, null), "24 October, 22:30 UTC");
    assert.equal(emailDate(at, null), "24 October (UTC)");
  });

  it("says how long is left in the unit a reader would use, and nothing once it has passed", () => {
    const now = new Date("2026-10-12T09:00:00.000Z");
    const later = (ms: number) => new Date(now.getTime() + ms);
    assert.equal(emailDuration(now, later(15 * 60_000)), "15 minutes");
    assert.equal(emailDuration(now, later(48 * 3_600_000)), "48 hours");
    assert.equal(emailDuration(now, later(30 * 86_400_000)), "30 days");
    assert.equal(emailDuration(now, later(-1)), null);
  });

  it("decides 'today' by the reader's calendar, not UTC's", () => {
    const deletedAt = new Date("2026-10-24T23:30:00.000Z");
    const sentAt = new Date("2026-10-25T00:10:00.000Z");
    assert.equal(emailSameDay(deletedAt, sentAt, null), false);
    assert.equal(emailSameDay(deletedAt, sentAt, "Europe/Tallinn"), true);
  });
});
