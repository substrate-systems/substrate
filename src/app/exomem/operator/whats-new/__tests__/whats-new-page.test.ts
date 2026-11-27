import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { DigestOverview, MonthDetail } from "@/lib/exomem-hosted/whats-new-digest/approval";
import {
  lockedReason,
  monthFigures,
  moved,
  selectionAllowed,
  setupFigures,
  stateLabel,
  switchFigure,
  toggled,
} from "../whats-new-state";

describe("Exomem monthly What's new page", () => {
  it("is private, dynamic, excluded from indexing and sends no referrer", async (context) => {
    // Only the page module's exports are under test: its stylesheet and client component are stood in for.
    mock.module("../../../home/home.module.css", { defaultExport: {} });
    mock.module("../whats-new-client", { defaultExport: () => null });
    context.after(() => mock.reset());
    const page = await import("../page");
    const robots = page.metadata.robots as { index?: boolean; follow?: boolean; nocache?: boolean };
    assert.equal(page.dynamic, "force-dynamic");
    assert.equal(page.revalidate, 0);
    assert.deepEqual([robots.index, robots.follow, robots.nocache], [false, false, true]);
    assert.equal(page.metadata.referrer, "no-referrer");
  });
});

describe("the page's selection helpers", () => {
  const note = (position: number) => ({ version: "1.0.0", position });

  it("allows 3 to 6 notes, and none only where the page offers a skip", () => {
    assert.deepEqual(
      [0, 2, 3, 6, 7].map((count) => selectionAllowed(count, false)),
      [false, false, true, true, false]
    );
    assert.equal(selectionAllowed(0, true), true);
    assert.equal(selectionAllowed(2, true), false);
  });

  it("stops a pick at six notes, and a second click removes a note", () => {
    const six = [0, 1, 2, 3, 4, 5].map(note);
    assert.equal(toggled(six, note(6)).length, 6);
    assert.deepEqual(
      toggled(six, note(2)).map((n) => n.position),
      [0, 1, 3, 4, 5]
    );
  });

  it("moves a note one place and leaves the list alone at its ends", () => {
    assert.deepEqual(moved([1, 2, 3], 1, -1), [2, 1, 3]);
    assert.deepEqual(moved([1, 2, 3], 0, -1), [1, 2, 3]);
    assert.deepEqual(moved([1, 2, 3], 2, 1), [1, 2, 3]);
  });
});

describe("what holds Approve and Edit", () => {
  const month = (state: string) =>
    ({ state, releases: { missing: [{}] } }) as unknown as MonthDetail;

  it("gives each state the operator can still act on its own reason", () => {
    const reasons = ["waiting_for_notes", "waiting_for_model", "awaiting_approval"].map((state) =>
      lockedReason(month(state))
    );
    assert.ok(reasons.every((reason) => reason.length > 0));
    assert.equal(new Set(reasons).size, reasons.length);
  });
});

describe("a release list that was not read", () => {
  const waiting = (releaseList: MonthDetail["releaseList"], total: number) =>
    ({
      state: "waiting_for_notes",
      releaseList,
      releases: { total, acceptedWithout: 0, missing: [] },
      notes: [],
    }) as unknown as MonthDetail;
  const failure = (status: "unavailable" | "not_configured") => ({
    listedAt: null,
    failure: { status, detail: "releases list answered 403", at: "2026-11-27T19:04:00.000Z" },
  });
  const releasesFigure = (detail: MonthDetail) =>
    monthFigures(detail).find((figure) => figure.label === "Releases")?.value;

  it("is not shown as zero releases, and carries the last try and its reason", () => {
    const unread = waiting(failure("unavailable"), 0);
    assert.notEqual(releasesFigure(unread), "0");
    const tried = monthFigures(unread).find((figure) => figure.label.includes("last try"));
    assert.ok(tried?.value.includes("27 Nov 2026, 19:04 UTC") && tried.value.includes("403"));
    // A list that was read and holds nothing is a true zero.
    const read = waiting({ listedAt: "2026-11-27T19:04:00.000Z", failure: null }, 0);
    assert.equal(releasesFigure(read), "0");
  });

  it("names a missing token apart from an outage, and either apart from a month that is waiting for notes", () => {
    const labels = [
      stateLabel(waiting(failure("not_configured"), 0), true, 0),
      stateLabel(waiting(failure("unavailable"), 0), true, 0),
      stateLabel(waiting({ listedAt: "2026-11-27T19:04:00.000Z", failure: null }, 2), true, 0),
    ];
    assert.equal(new Set(labels).size, 3);
  });
});

describe("why sending without approval is not offered", () => {
  const figure = (measurement: Partial<DigestOverview["measurement"]>) =>
    switchFigure({
      switch: { sendWithoutApproval: false, recordedAt: null, applies: true },
      measurement: {
        measured: [],
        monthsToMeasure: 3,
        complete: true,
        allPass: false,
        withdrawn: false,
        offered: false,
        ...measurement,
      },
    } as unknown as DigestOverview).value;

  it("says a month scored low only when one did, and a changed model or prompt when all three passed", () => {
    const low = figure({ allPass: false });
    const changed = figure({ allPass: true });
    assert.ok(low.includes("under two thirds"));
    assert.ok(changed.includes("model or prompt changed") && !changed.includes("two thirds"));
    // Fewer than three counted months is still counting, not a failure.
    assert.ok(
      figure({ complete: false, measured: [{}] as never }).includes("2 more counted months")
    );
  });
});

describe("the page's setup", () => {
  const setup = (overrides: Partial<DigestOverview>) =>
    setupFigures({
      firstMonth: null,
      firstMonthMalformed: false,
      githubConfigured: true,
      modelConfigured: true,
      unsubscribeKeys: { current: "ok", previous: "unset" },
      ...overrides,
    } as DigestOverview);
  const firstMonth = (figures: ReturnType<typeof setup>) =>
    figures.find((figure) => figure.label === "First month")?.value;

  it("tells a malformed first month from an unset one and from a month", () => {
    const values = [
      firstMonth(setup({})),
      firstMonth(setup({ firstMonthMalformed: true })),
      firstMonth(setup({ firstMonth: "2026-11" })),
    ];
    assert.equal(new Set(values).size, 3);
  });
});
