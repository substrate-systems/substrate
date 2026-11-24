import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExomemHostedError } from "../errors";
import { noticeState, type ServiceNotice } from "../service-notice-model";
import { parseNewNotice } from "../service-notices";

const NOW = new Date("2026-11-23T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const maintenance = {
  kind: "maintenance",
  summary: "We are moving storage.",
  startsAt: at(24 * HOUR),
  endsAt: at(25 * HOUR),
};

function refusal(body: Record<string, unknown>): string {
  try {
    parseNewNotice(body, NOW);
  } catch (error) {
    assert.ok(error instanceof ExomemHostedError);
    assert.equal(error.status, 400);
    return error.message;
  }
  assert.fail("the notice was accepted");
}

describe("a new service notice", () => {
  it("announces maintenance 48 hours before its start unless the operator sets another time", () => {
    const defaulted = parseNewNotice(maintenance, NOW);
    assert.equal(defaulted.announceFrom?.toISOString(), at(24 * HOUR - 48 * HOUR));
    const chosen = parseNewNotice({ ...maintenance, announceFrom: at(HOUR) }, NOW);
    assert.equal(chosen.announceFrom?.toISOString(), at(HOUR));
  });

  it("starts an incident now when the operator names no start", () => {
    const incident = parseNewNotice({ kind: "incident", summary: "Saving is slow." }, NOW);
    assert.equal(incident.startsAt.toISOString(), NOW.toISOString());
    assert.equal(incident.endsAt, null);
  });

  it("refuses what the specification forbids, naming the fix", () => {
    assert.match(refusal({ ...maintenance, startsAt: at(-HOUR) }), /start in the future/);
    assert.match(refusal({ ...maintenance, endsAt: maintenance.startsAt }), /end after it starts/);
    assert.match(
      refusal({ ...maintenance, announceFrom: at(48 * HOUR) }),
      /not be after the start/
    );
    assert.match(
      refusal({ kind: "incident", summary: "Down.", startsAt: at(HOUR) }),
      /no later than now/
    );
    assert.match(refusal({ kind: "incident", summary: "Down.", endsAt: at(HOUR) }), /no end/);
    assert.match(refusal({ ...maintenance, kind: "outage" }), /kind must be/);
  });

  it("refuses an operator summary that is empty, over 280 characters or on several lines", () => {
    assert.match(refusal({ ...maintenance, summary: "  " }), /summary must be 1 to 280/);
    assert.match(refusal({ ...maintenance, summary: "x".repeat(281) }), /summary must be 1 to 280/);
    assert.match(refusal({ ...maintenance, summary: "Line one.\nLine two." }), /single line/);
    // Separators and bidi controls split or reorder the line a reader sees, as a newline does.
    for (const character of ["\u2028", "\u2029", "\u202E", "\u2066", "\u2069"]) {
      assert.match(
        refusal({ ...maintenance, summary: `Line one.${character}Line two.` }),
        /single line/
      );
    }
    // The limit counts characters, so 280 emoji are accepted.
    assert.equal(
      parseNewNotice({ ...maintenance, summary: "🛠".repeat(280) }, NOW).summary.length,
      560
    );
  });

  it("refuses a time with no zone, because it would mean the server's own zone", () => {
    assert.match(refusal({ ...maintenance, startsAt: "2026-11-25T02:00:00" }), /with a zone/);
  });

  it("refuses a misspelled field instead of ignoring it", () => {
    assert.match(
      refusal({ ...maintenance, ends_at: at(26 * HOUR) }),
      /ends_at is not a notice field/
    );
  });

  it("takes each named cell once and refuses a malformed cell id", () => {
    const cell = "abcdefghijklmnop";
    const twice = parseNewNotice({ ...maintenance, cellIds: [cell, cell] }, NOW);
    assert.deepEqual(twice.cellIds, [cell]);
    assert.match(refusal({ ...maintenance, cellIds: ["not a cell"] }), /list of cell ids/);
  });
});

describe("a notice's state follows from its times", () => {
  const notice = (over: Partial<ServiceNotice>): ServiceNotice => ({
    id: "n",
    kind: "maintenance",
    summary: "s",
    startsAt: new Date(at(10 * HOUR)),
    endsAt: new Date(at(11 * HOUR)),
    announceFrom: new Date(at(HOUR)),
    cancelledAt: null,
    resolvedAt: null,
    cellIds: [],
    createdAt: NOW,
    ...over,
  });
  const stateAt = (n: ServiceNotice, offset: number) =>
    noticeState(n, new Date(NOW.getTime() + offset));

  it("moves maintenance from pending to scheduled to active to over", () => {
    const n = notice({});
    assert.equal(stateAt(n, 0), "pending");
    assert.equal(stateAt(n, HOUR), "scheduled");
    assert.equal(stateAt(n, 10 * HOUR), "active");
    assert.equal(stateAt(n, 11 * HOUR), "over");
  });

  it("is over once cancelled, however the times stand", () => {
    assert.equal(stateAt(notice({ cancelledAt: NOW }), 5 * HOUR), "over");
  });

  it("keeps an incident active until it is resolved", () => {
    const incident = notice({ kind: "incident", endsAt: null, announceFrom: null, startsAt: NOW });
    assert.equal(stateAt(incident, 100 * HOUR), "active");
    assert.equal(stateAt({ ...incident, resolvedAt: NOW }, 100 * HOUR), "over");
  });
});
