import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  createNoticeCache,
  NOTICE_HEADER_MAX_BYTES,
  SAY_MAX_CHARS,
} from "../../lib/exomem-hosted/service-notice-header";
import type { ServiceNotice } from "../../lib/exomem-hosted/service-notice-model";

// add-exomem-service-notices D3: what the gateway tells a cell about the operator's
// notices. These cases run the real cache and header encoder against a stand-in for
// the one database query, so they name what a cell and a reader depend on.

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-12-01T10:00:00Z");
const STATUS = "https://status.example.test";
const CELL = "aaaaaaaaaaaaaaaa";
const OTHER_CELL = "bbbbbbbbbbbbbbbb";

let counter = 0;
function notice(over: Partial<ServiceNotice> = {}): ServiceNotice {
  counter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`,
    kind: "maintenance",
    summary: "We are moving storage.",
    startsAt: new Date(T0 + 2 * HOUR),
    endsAt: new Date(T0 + 3 * HOUR),
    announceFrom: new Date(T0 - HOUR),
    cancelledAt: null,
    resolvedAt: null,
    cellIds: [],
    createdAt: new Date(T0 - 2 * HOUR),
    ...over,
  };
}

function incident(over: Partial<ServiceNotice> = {}): ServiceNotice {
  return notice({
    kind: "incident",
    summary: "Saving is slow.",
    startsAt: new Date(T0 - HOUR),
    endsAt: null,
    announceFrom: null,
    ...over,
  });
}

type Decoded = {
  v: number;
  kind: string;
  state: string;
  starts_at: string;
  ends_at: string | null;
  say: string;
};

function decode(header: string | null): Decoded {
  assert.ok(header, "a header was expected");
  assert.match(header, /^[A-Za-z0-9_-]+$/, "base64url has no padding or + and /");
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Decoded;
}

/** A cache over a fixed list that counts how many times the database would be asked. */
function cacheOver(
  notices: () => ServiceNotice[],
  clock: { at: number },
  options: Partial<Parameters<typeof createNoticeCache>[0]> = {}
) {
  let loads = 0;
  const cache = createNoticeCache({
    load: async () => {
      loads += 1;
      return notices();
    },
    now: () => clock.at,
    statusUrl: () => STATUS,
    ...options,
  });
  return { cache, loads: () => loads };
}

describe("the service notice header", () => {
  it("carries the one bounded shape, with the times in UTC and no tenant data", async () => {
    const { cache } = cacheOver(() => [notice({ cellIds: [CELL] })], { at: T0 });
    const header = await cache.headerFor(CELL);
    const body = decode(header);
    assert.deepEqual(Object.keys(body).sort(), [
      "ends_at",
      "kind",
      "say",
      "starts_at",
      "state",
      "v",
    ]);
    assert.equal(body.v, 1);
    assert.equal(body.kind, "maintenance");
    assert.equal(body.state, "scheduled");
    assert.equal(body.starts_at, "2026-12-01T12:00:00Z");
    assert.equal(body.ends_at, "2026-12-01T13:00:00Z");
    assert.match(body.say, /^Exomem maintenance is planned for 1 December, 12:00 to 13:00 UTC\./);
    assert.match(body.say, /We are moving storage\./);
    assert.ok(body.say.endsWith(`More at ${STATUS}`));
    assert.ok(!JSON.stringify(body).includes(CELL), "the cell id stays out of the header");
  });

  it("says an incident is active, with no end time", async () => {
    const { cache } = cacheOver(() => [incident()], { at: T0 });
    const body = decode(await cache.headerFor(CELL));
    assert.equal(body.kind, "incident");
    assert.equal(body.state, "active");
    assert.equal(body.ends_at, null);
    assert.match(body.say, /^Exomem has a known problem that started 1 December, 09:00 UTC\./);
  });

  it("stays inside both limits for a summary that is long, wide or full of quotes", async () => {
    // 280 plain characters fit whole. The others outgrow the 1,024 bytes first: an emoji
    // is four bytes, a CJK character three, and a quote becomes two in JSON.
    const cases = [
      { summary: "x".repeat(280), whole: true },
      { summary: "🛠".repeat(280), whole: false },
      { summary: "語".repeat(280), whole: false },
      { summary: '"'.repeat(280), whole: false },
    ];
    for (const { summary, whole } of cases) {
      const { cache } = cacheOver(() => [notice({ summary })], { at: T0 });
      const header = await cache.headerFor(CELL);
      const body = decode(header);
      assert.ok(Buffer.byteLength(header!, "utf8") <= NOTICE_HEADER_MAX_BYTES);
      assert.ok(body.say.length <= SAY_MAX_CHARS);
      // The status page pointer is the last thing to go, and a cut never splits an emoji.
      assert.ok(body.say.endsWith(`More at ${STATUS}`));
      assert.ok(!body.say.includes("\uFFFD"));
      assert.equal(body.say.includes(summary), whole);
      assert.equal(body.say.includes("…"), !whole, "a shortened summary says so");
    }
  });

  it("keeps a short summary whole", async () => {
    const { cache } = cacheOver(() => [notice()], { at: T0 });
    assert.ok(!decode(await cache.headerFor(CELL)).say.includes("…"));
  });
});

describe("which notice a cell hears", () => {
  it("gives a named cell its notice and every other cell none, and a fleet notice to all", async () => {
    const named = notice({ cellIds: [CELL], summary: "Only for one." });
    const { cache } = cacheOver(() => [named], { at: T0 });
    assert.match(decode(await cache.headerFor(CELL)).say, /Only for one\./);
    assert.equal(await cache.headerFor(OTHER_CELL), null);

    const fleet = cacheOver(() => [notice()], { at: T0 });
    assert.ok(await fleet.cache.headerFor(CELL));
    assert.ok(await fleet.cache.headerFor(OTHER_CELL));
  });

  it("says nothing while maintenance is not yet announced, after it ends, or once cancelled or resolved", async () => {
    const clock = { at: T0 };
    const quiet = (over: Partial<ServiceNotice>) =>
      cacheOver(() => [over.kind === "incident" ? incident(over) : notice(over)], clock).cache;
    assert.equal(await quiet({ announceFrom: new Date(T0 + HOUR) }).headerFor(CELL), null);
    assert.equal(
      await quiet({ startsAt: new Date(T0 - 2 * HOUR), endsAt: new Date(T0 - HOUR) }).headerFor(
        CELL
      ),
      null
    );
    assert.equal(await quiet({ cancelledAt: new Date(T0 - 1) }).headerFor(CELL), null);
    assert.equal(
      await quiet({ kind: "incident", resolvedAt: new Date(T0 - 1) }).headerFor(CELL),
      null
    );
  });

  it("prefers an active incident, then active maintenance, then the earliest scheduled maintenance", async () => {
    const later = notice({
      summary: "Later.",
      startsAt: new Date(T0 + 6 * HOUR),
      endsAt: new Date(T0 + 7 * HOUR),
    });
    const earlier = notice({ summary: "Earlier." });
    const active = notice({
      summary: "Under way.",
      startsAt: new Date(T0 - HOUR),
      endsAt: new Date(T0 + HOUR),
    });
    const problem = incident({ summary: "Problem." });
    const say = async (list: ServiceNotice[]) =>
      decode(await cacheOver(() => list, { at: T0 }).cache.headerFor(CELL)).say;

    assert.match(await say([later, earlier, active, problem]), /Problem\./);
    assert.match(await say([later, earlier, active]), /Under way\./);
    assert.match(await say([later, earlier]), /Earlier\./);
    assert.match(await say([earlier, later]), /Earlier\./);
  });

  it("breaks a tie between equal notices the same way whatever order the database lists them", async () => {
    const a = notice({ summary: "First by id." });
    const b = notice({ summary: "Second by id." });
    const first = decode(await cacheOver(() => [a, b], { at: T0 }).cache.headerFor(CELL));
    const second = decode(await cacheOver(() => [b, a], { at: T0 }).cache.headerFor(CELL));
    assert.equal(first.say, second.say);
    assert.match(first.say, /First by id\./);
  });

  it("moves maintenance from scheduled to active at its start without asking the database again", async () => {
    const clock = { at: T0 };
    const starting = notice({ startsAt: new Date(T0 + 10_000), endsAt: new Date(T0 + HOUR) });
    const { cache, loads } = cacheOver(() => [starting], clock);
    assert.equal(decode(await cache.headerFor(CELL)).state, "scheduled");
    clock.at = T0 + 20_000;
    const after = decode(await cache.headerFor(CELL));
    assert.equal(after.state, "active");
    assert.match(after.say, /^Exomem maintenance is under way until 1 December, 11:00 UTC\./);
    assert.equal(loads(), 1);
  });
});

describe("how fresh the gateway's notices are", () => {
  afterEach(() => mock.timers.reset());

  it("asks the database once for a burst of requests, and again only after 30 seconds", async () => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    let list: ServiceNotice[] = [];
    let loads = 0;
    // No `now` option: this is the clock the gateway really uses.
    const cache = createNoticeCache({
      load: async () => {
        loads += 1;
        return list;
      },
      statusUrl: () => STATUS,
    });

    assert.equal(await cache.headerFor(CELL), null);
    list = [notice()];
    await Promise.all(Array.from({ length: 50 }, () => cache.headerFor(CELL)));
    mock.timers.tick(29_000);
    assert.equal(await cache.headerFor(CELL), null);
    assert.equal(loads, 1, "no query inside the 30 seconds");

    // The first request after the copy ages gets the new notice itself.
    mock.timers.tick(1_001);
    assert.equal(decode(await cache.headerFor(CELL)).kind, "maintenance");
    assert.equal(loads, 2);
  });

  it("shares one load between requests that arrive while it runs", async () => {
    let loads = 0;
    let finish: (list: ServiceNotice[]) => void = () => undefined;
    const cache = createNoticeCache({
      load: () => {
        loads += 1;
        return new Promise<ServiceNotice[]>((resolve) => (finish = resolve));
      },
      now: () => T0,
      statusUrl: () => STATUS,
    });
    const pending = Array.from({ length: 20 }, () => cache.headerFor(CELL));
    finish([notice()]);
    const headers = await Promise.all(pending);
    assert.equal(loads, 1);
    assert.ok(headers.every((header) => header !== null));
  });

  it("never sends a resolved or cancelled notice once its copy has aged and been refreshed", async () => {
    const clock = { at: T0 };
    let list = [incident(), notice()];
    const { cache } = cacheOver(() => list, clock);
    assert.equal(decode(await cache.headerFor(CELL)).kind, "incident");

    list = [];
    clock.at = T0 + 30_001;
    assert.equal(await cache.headerFor(CELL), null);
  });

  it("serves a current notice on the first request after a long quiet spell", async () => {
    // Sparse traffic: each gap is far longer than the 30 seconds a copy lives.
    const clock = { at: T0 };
    let list: ServiceNotice[] = [];
    const { cache, loads } = cacheOver(() => list, clock);
    assert.equal(await cache.headerFor(CELL), null);

    list = [incident()];
    clock.at += 6 * 60_000;
    assert.equal(decode(await cache.headerFor(CELL)).kind, "incident");

    // Maintenance that became active during the next gap is active in the very first reply.
    list = [notice({ startsAt: new Date(clock.at + 60_000), endsAt: new Date(clock.at + HOUR) })];
    clock.at += 6 * 60_000;
    const after = decode(await cache.headerFor(CELL));
    assert.equal(after.state, "active");
    assert.equal(loads(), 3);
  });

  it("sends no header while the database fails, and recovers on the first try after 30 seconds", async () => {
    const clock = { at: T0 };
    let failing = false;
    let loads = 0;
    const warnings = mock.method(console, "warn", () => undefined);
    try {
      const cache = createNoticeCache({
        load: async () => {
          loads += 1;
          if (failing) throw new Error("connection refused");
          return [notice()];
        },
        now: () => clock.at,
        statusUrl: () => STATUS,
      });
      assert.ok(await cache.headerFor(CELL));

      // The copy that was good a minute ago is not served: it can no longer vouch for itself.
      failing = true;
      clock.at = T0 + 60_000;
      assert.equal(await cache.headerFor(CELL), null);
      assert.equal(await cache.headerFor(CELL), null);
      assert.equal(loads, 2, "one failed try, not one per request");
      assert.ok(warnings.mock.callCount() >= 1, "the outage is logged");

      failing = false;
      clock.at = T0 + 91_000;
      assert.ok(await cache.headerFor(CELL));
    } finally {
      warnings.mock.restore();
    }
  });

  it("gives up on a database that hangs after the load timeout, and sends no header", async () => {
    const warnings = mock.method(console, "warn", () => undefined);
    try {
      const cache = createNoticeCache({
        load: () => new Promise<ServiceNotice[]>(() => undefined),
        now: () => T0,
        statusUrl: () => STATUS,
        loadTimeoutMs: 20,
      });
      const started = Date.now();
      assert.equal(await cache.headerFor(CELL), null);
      assert.ok(Date.now() - started < 1_000);
      assert.ok(warnings.mock.callCount() >= 1);
    } finally {
      warnings.mock.restore();
    }
  });
});
