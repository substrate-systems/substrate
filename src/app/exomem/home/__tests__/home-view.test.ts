import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaddlePricePreview } from "@/lib/paddle";
import type { HomeAccount, HomeActivity, HomeApp, HomeExport } from "../home-api";
import type { Lifecycle } from "../home-state";
import {
  activityFacts,
  banner,
  deletionLinkMinutes,
  directoryHint,
  exportView,
  homeMode,
  levelsView,
  liveLine,
  notices,
  planView,
  showsUsualPrice,
  statusCopy,
  storageView,
  subscribeView,
} from "../home-view";

// Every case renders in UTC at a fixed moment, so dates read the same on any machine.
const NOW = Date.parse("2026-10-12T10:00:00Z");
const clock = { now: NOW, timeZone: "UTC" };
const READY: Lifecycle = { state: "ready", code: "CELL_READY", retryable: false };
const NONE: ReadonlySet<string> = new Set();

function account(overrides: Partial<HomeAccount> = {}): HomeAccount {
  return {
    kind: "owner",
    email: "owner@example.test",
    timeZone: { value: null, reason: "not_recorded" },
    supportReference: "EX-7Q4M",
    step: "connect",
    plan: {
      source: "paddle",
      name: { value: "Exomem · monthly", reason: null },
      priceId: { value: "pri_example", reason: null },
      friendPrice: { offered: false, applied: false, inviterName: null },
    },
    nextPaymentAt: { value: "2026-10-31T09:00:00Z", reason: null },
    nextPaymentAmount: { value: null, reason: "not_reported" },
    readOnlyUntil: { value: null, reason: "not_past_due" },
    endedAt: { value: null, reason: "not_ended" },
    keptUntil: { value: null, reason: "not_ended" },
    reviewerEndsAt: { value: null, reason: "not_reviewer" },
    ...overrides,
  };
}

function activity(overrides: Partial<Extract<HomeActivity, { state: "live" }>> = {}) {
  return {
    state: "live",
    since: "2026-10-12T08:00:00Z",
    as_of: "2026-10-12T10:00:00Z",
    note_count: 11402,
    events: [],
    ...overrides,
  } as HomeActivity;
}

function app(overrides: Partial<HomeApp> = {}): HomeApp {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    displayName: "Claude",
    displayNameSource: "platform",
    platform: "claude",
    kind: "web",
    context: "conversation",
    redirectHosts: ["claude.example.test"],
    connectedAt: "2026-10-05T09:00:00Z",
    lastAuthorizedAt: "2026-10-05T09:00:00Z",
    ...overrides,
  };
}

describe("which Home the owner sees", () => {
  it("shows an ended subscription as ended, though its kept cell still serves", () => {
    // A cancelled account keeps a read-only cell that passes readiness. Reading the
    // lifecycle alone would tell this owner their memory is on.
    assert.deepEqual(homeMode(READY, account({ step: "ended" }), "known"), {
      kind: "home",
      variant: "ended",
    });
  });

  it("shows a failed payment as read-only", () => {
    assert.deepEqual(homeMode(READY, account({ step: "connect-read-only" }), "known"), {
      kind: "home",
      variant: "readonly",
    });
  });

  it("tells an owner-paused subscription from an operator suspension", () => {
    const stopped: Lifecycle = { state: "suspended", code: "EXOMEM_SUSPENDED", retryable: false };
    assert.deepEqual(homeMode(stopped, account({ step: "paused" }), "known"), {
      kind: "home",
      variant: "paused",
    });
    assert.deepEqual(homeMode(stopped, account({ step: "suspended" }), "known"), {
      kind: "home",
      variant: "suspended",
    });
  });

  it("shows a pause for an export or for maintenance as a pause, not as trouble", () => {
    const held: Lifecycle = { state: "degraded", code: "CELL_PAUSED_FOR_EXPORT", retryable: true };
    const failing: Lifecycle = { state: "degraded", code: "CELL_NOT_READY", retryable: true };
    assert.deepEqual(homeMode(held, account(), "known"), { kind: "home", variant: "export_pause" });
    // A backup or upgrade holds the cell too, and ends by itself: a pause, not trouble.
    const maintained: Lifecycle = {
      state: "degraded",
      code: "CELL_PAUSED_FOR_HOLD",
      retryable: true,
    };
    assert.deepEqual(homeMode(maintained, account(), "known"), {
      kind: "home",
      variant: "hold_pause",
    });
    assert.deepEqual(homeMode(failing, account(), "known"), { kind: "home", variant: "trouble" });
  });

  it("says nothing about the account until it is read, and claims no state when it cannot be", () => {
    // Before the account is read, a reviewer's Home would look like an owner's, with Delete.
    assert.deepEqual(homeMode(READY, null, "loading"), { kind: "loading" });
    assert.deepEqual(homeMode(READY, null, "failed"), { kind: "home", variant: "unknown" });
    const unknown = statusCopy("unknown", false, null, clock);
    assert.equal(unknown.headline, "Your Exomem");
    assert.deepEqual(planView("unknown", null, null, clock), {
      name: "Plan",
      meta: "not available right now",
      action: null,
      note: null,
    });
  });

  it("never shows the ready Home before the first payment", () => {
    const unpaid: Lifecycle = {
      state: "awaiting_payment",
      code: "PAYMENT_REQUIRED",
      retryable: false,
    };
    assert.deepEqual(homeMode(unpaid, account({ step: "subscribe" }), "known"), {
      kind: "subscribe",
    });
  });
});

describe("the subscribe view", () => {
  const usual = {
    total: { amount: "1500", currencyCode: "EUR" },
    billingCycle: { interval: "month", frequency: 1 },
  } as PaddlePricePreview;

  it("never quotes the usual price to an account that holds a friend offer", () => {
    const owner = account();
    const friend = account({
      plan: { ...owner.plan, friendPrice: { offered: true, applied: false, inviterName: "Alex" } },
    });

    const view = subscribeView(friend.plan.friendPrice, usual);

    assert.equal(showsUsualPrice(friend.plan.friendPrice), false);
    assert.doesNotMatch(view.line, /€15/);
    assert.match(view.line, /Alex’s friend price/);
    // The card leaves the amount to checkout, with no usual price struck beside it.
    assert.equal(view.friendCard?.was, null);
    assert.doesNotMatch(view.friendCard?.main ?? "", /€/);
    // Without an offer, the usual price is the line.
    assert.equal(showsUsualPrice(owner.plan.friendPrice), true);
    assert.match(subscribeView(owner.plan.friendPrice, usual).line, /€15 a month/);
  });

  it("leaves the price to checkout when the inviter's deleted account took their name", () => {
    // Deleting the inviter's account clears their name; checkout still applies the offer.
    const friend = account({
      plan: {
        ...account().plan,
        friendPrice: { offered: true, applied: false, inviterName: null },
      },
    });

    const view = subscribeView(friend.plan.friendPrice, usual);

    assert.equal(showsUsualPrice(friend.plan.friendPrice), false);
    assert.match(view.line, /^Paddle shows the price at checkout\./);
    assert.equal(view.friendCard, null);
  });
});

describe("the live line and the note count", () => {
  it("shows nothing, never zero, when the cell cannot answer", () => {
    const facts = activityFacts({ state: "unavailable", reason: "CELL_UNREACHABLE" }, NOW);
    assert.equal(liveLine(facts, [app()], NONE, clock), null);
    const status = statusCopy("on", false, facts, clock);
    assert.equal(status.statusLine, null);
  });

  it("waits for the first note from the app the owner connected", () => {
    const facts = activityFacts(activity({ note_count: 0 }), NOW);
    assert.equal(
      liveLine(facts, [app()], NONE, clock)?.text,
      "Waiting for the first note from Claude"
    );
    assert.equal(
      statusCopy("on", false, facts, clock).statusLine,
      "No notes yet · ask your assistant to remember something"
    );
  });

  it("names the newest event's client, action, count and age", () => {
    const facts = activityFacts(
      activity({
        events: [
          { client: "claude-code", action: "recalled", items: 4, at: "2026-10-12T09:59:48Z" },
          { client: "claude-ai", action: "saved", items: 1, at: "2026-10-12T09:58:00Z" },
        ],
      }),
      NOW
    );
    assert.equal(liveLine(facts, [], NONE, clock)?.text, "Claude Code recalled 4 notes · 12 s ago");
    assert.equal(
      statusCopy("on", false, facts, clock).statusLine,
      "11,402 notes · last saved 2 minutes ago"
    );
  });

  it("does not invent a count the cell did not report", () => {
    const facts = activityFacts(
      activity({
        note_count: null,
        events: [{ client: null, action: "saved", items: null, at: "2026-10-12T09:59:00Z" }],
      }),
      NOW
    );
    assert.equal(liveLine(facts, [], NONE, clock)?.text, "Your app saved notes · 1 minute ago");
    assert.equal(statusCopy("on", false, facts, clock).statusLine, "Last saved 1 minute ago");
  });

  it("does not name an app the owner has just disconnected", () => {
    const claude = app();
    const chatgpt = app({
      id: "00000000-0000-4000-8000-000000000002",
      displayName: "ChatGPT",
      platform: "openai",
    });
    const facts = activityFacts(activity({ note_count: 0 }), NOW);
    assert.equal(
      liveLine(facts, [claude, chatgpt], new Set([claude.id]), clock)?.text,
      "Waiting for the first note from ChatGPT"
    );
    assert.equal(
      liveLine(facts, [claude], new Set([claude.id]), clock)?.text,
      "Waiting for the first note"
    );
  });

  it("times an event by the cell's clock when the browser's clock is wrong", () => {
    // The browser runs five minutes fast: the cell's answer said 10:00 when it read 10:05.
    const facts = activityFacts(
      activity({
        events: [{ client: "codex", action: "saved", items: 1, at: "2026-10-12T09:59:48Z" }],
      }),
      NOW + 300_000
    );
    const later = { now: NOW + 300_000, timeZone: "UTC" };
    assert.equal(liveLine(facts, [], NONE, later)?.text, "Codex saved a note · 12 s ago");
  });

  it("says since when nothing happened, after a cell restart", () => {
    const facts = activityFacts(activity({ events: [] }), NOW);
    assert.equal(
      liveLine(facts, [], NONE, clock)?.text,
      "No assistant activity since 12 Oct, 08:00"
    );
  });
});

describe("notices and the account banner", () => {
  const disk = (used: number) =>
    storageView(
      {
        state: "known",
        used_bytes: used,
        filesystem_bytes: 10_000_000_000,
        observed_at: "2026-10-12T03:00:00Z",
      },
      clock
    );

  it("warns at 80% and marks a full disk, never offering storage that is not sold yet", () => {
    assert.deepEqual(
      notices("on", account(), disk(7_900_000_000), true, false).map((notice) => notice.key),
      []
    );
    const filling = notices("on", account(), disk(8_500_000_000), true, false);
    assert.equal(filling[0]?.text, "Your Exomem is 85% full. Everything works.");
    assert.deepEqual(filling[0]?.actions, []);
    // A disk with room left never reads as 100% full.
    const nearly = notices("on", account(), disk(9_996_000_000), true, false);
    assert.equal(nearly[0]?.text, "Your Exomem is 99% full. Everything works.");
    const full = notices("on", account(), disk(10_000_000_000), true, false);
    assert.equal(full[0]?.attention, true);
    assert.match(full[0]?.text ?? "", /^Your Exomem is full \(10 GB\)\./);
  });

  it("shows the support reference with a way to copy it when the cell has trouble", () => {
    const [trouble] = notices("trouble", account(), { state: "unknown" }, true, false);
    assert.match(trouble?.text ?? "", /Support reference: EX-7Q4M\./);
    assert.deepEqual(trouble?.actions, ["copy_reference"]);
  });

  it("links the status page from the trouble notice only when one is configured", () => {
    const [trouble] = notices("trouble", account(), { state: "unknown" }, true, true);
    assert.deepEqual(trouble?.actions, ["copy_reference", "status_page"]);
  });

  it("drops a read-only end date it cannot know instead of guessing one", () => {
    const known = banner(
      "readonly",
      account({ readOnlyUntil: { value: "2026-10-25T09:00:00Z", reason: null } }),
      null,
      clock,
      true
    );
    assert.equal(
      known?.text,
      "Your last payment failed. Paddle tries again until 25 October. Fix it and saving starts again."
    );
    const unknown = banner(
      "readonly",
      account({ readOnlyUntil: { value: null, reason: "dunning_window_unconfigured" } }),
      null,
      clock,
      true
    );
    assert.equal(
      unknown?.text,
      "Your last payment failed. Paddle tries again. Fix it and saving starts again."
    );
  });

  it("offers Resubscribe only when checkout can take it", () => {
    const ended = account({
      step: "ended",
      keptUntil: { value: "2026-11-10T09:00:00Z", reason: null },
    });
    const closed = {
      source: "paddle",
      state: "cancelled",
      checkoutAvailable: false,
      portalAvailable: true,
    } as const;
    assert.equal(banner("ended", ended, closed, clock, true)?.action, null);
    assert.equal(
      banner("ended", ended, { ...closed, checkoutAvailable: true }, clock, true)?.action,
      "resubscribe"
    );
  });

  it("does not ask an ended owner to resubscribe when no checkout can start", () => {
    const kept = account({
      step: "ended",
      keptUntil: { value: "2026-11-10T09:00:00Z", reason: null },
    });
    assert.equal(
      banner("ended", kept, null, clock, false)?.text,
      "Your memory is read-only and kept until 10 November."
    );
    assert.equal(
      banner("ended", kept, null, clock, true)?.text,
      "Your memory is read-only and kept until 10 November. Export it any time before then."
    );
    const undated = account({ step: "ended", keptUntil: { value: null, reason: "not_reported" } });
    assert.equal(banner("ended", undated, null, clock, true)?.text, "Your memory is read-only.");
  });

  it("dates an ended plan from the cancellation, in the reader's zone, and drops a date it does not know", () => {
    const endedOn = account({
      step: "ended",
      endedAt: { value: "2026-10-11T23:30:00Z", reason: null },
    });
    assert.equal(planView("ended", endedOn, null, clock).meta, "ended 11 October");
    assert.equal(
      planView("ended", endedOn, null, { now: NOW, timeZone: "Europe/Tallinn" }).meta,
      "ended 12 October"
    );
    const undated = account({ step: "ended", endedAt: { value: null, reason: "not_reported" } });
    assert.equal(planView("ended", undated, null, clock).meta, "ended");
  });

  it("sends an ended owner to support for a copy, not to an export, while Home offers none", () => {
    const ended = account({
      step: "ended",
      keptUntil: { value: "2026-11-10T09:00:00Z", reason: null },
    });
    const open = {
      source: "paddle",
      state: "cancelled",
      checkoutAvailable: true,
      portalAvailable: true,
    } as const;
    assert.equal(
      banner("ended", ended, open, clock, false)?.text,
      "Kept until 10 November. Resubscribe to get it all back."
    );
    const [copy] = notices("ended", ended, { state: "unknown" }, false, false);
    assert.equal(copy?.text, "For a copy of your memory, write to support and quote EX-7Q4M.");
    assert.deepEqual(copy?.actions, ["support"]);
    assert.deepEqual(notices("ended", ended, { state: "unknown" }, true, false), []);
  });

  it("gives a reviewer the access end date and no billing", () => {
    const reviewer = account({
      kind: "reviewer",
      plan: { ...account().plan, source: "complimentary" },
      reviewerEndsAt: { value: "2026-11-11T09:00:00Z", reason: null },
    });
    assert.match(banner("on", reviewer, null, clock, true)?.text ?? "", /ends on 11 November\./);
    const plan = planView("on", reviewer, null, clock);
    assert.equal(plan?.meta, "complimentary · ends 11 November");
    assert.equal(plan?.action, null);
  });
});

describe("plan and storage", () => {
  const portal = {
    source: "paddle",
    state: "active",
    checkoutAvailable: false,
    portalAvailable: true,
  } as const;

  it("reads the plan name and next payment from the stored subscription", () => {
    const plan = planView("on", account(), portal, clock);
    assert.equal(plan?.name, "Exomem · monthly");
    assert.equal(plan?.meta, "next payment 31 October");
    assert.deepEqual(plan?.action, { label: "Manage billing", kind: "portal" });
  });

  it("shows the next payment's amount, and no number when it is unknown", () => {
    const paying = (amount: string, currencyCode: string) =>
      account({ nextPaymentAmount: { value: { amount, currencyCode }, reason: null } });
    assert.equal(
      planView("on", paying("1000", "EUR"), portal, clock).meta,
      "€10 · next payment 31 October"
    );
    assert.equal(
      planView("on", paying("1050", "EUR"), portal, clock).meta,
      "€10.50 · next payment 31 October"
    );
    // Paddle did not answer: the row keeps its date and shows no amount, never zero.
    const unavailable = account({ nextPaymentAmount: { value: null, reason: "unavailable" } });
    assert.equal(planView("on", unavailable, portal, clock).meta, "next payment 31 October");
  });

  it("shows no amount when the next payment has no date", () => {
    // A cancellation scheduled in the portal clears the date before a cached amount expires.
    const undated = account({
      nextPaymentAt: { value: null, reason: "not_reported" },
      nextPaymentAmount: { value: { amount: "1000", currencyCode: "EUR" }, reason: null },
    });
    assert.equal(planView("on", undated, portal, clock).meta, "next payment not reported yet");
  });

  it("names the friend price and its inviter when the discount applies", () => {
    const plan = planView(
      "on",
      account({
        plan: {
          ...account().plan,
          friendPrice: { offered: true, applied: true, inviterName: "Alex" },
        },
      }),
      portal,
      clock
    );
    assert.equal(plan?.name, "Exomem · monthly · friend price");
    assert.equal(plan?.meta, "from Alex’s invitation · next payment 31 October");
    const withAmount = planView(
      "on",
      account({
        plan: {
          ...account().plan,
          friendPrice: { offered: true, applied: true, inviterName: "Alex" },
        },
        nextPaymentAmount: { value: { amount: "850", currencyCode: "EUR" }, reason: null },
      }),
      portal,
      clock
    );
    assert.equal(withAmount.meta, "€8.50 · from Alex’s invitation · next payment 31 October");
  });

  it("says a next payment was not reported rather than leaving a blank date", () => {
    const plan = planView(
      "on",
      account({ nextPaymentAt: { value: null, reason: "not_reported" } }),
      portal,
      clock
    );
    assert.equal(plan?.meta, "next payment not reported yet");
  });

  it("shows storage as unknown, with no bar, until cellctl has measured it", () => {
    assert.deepEqual(storageView({ state: "unknown" }, clock), { state: "unknown" });
    assert.deepEqual(storageView(null, clock), { state: "unknown" });
  });

  it("measures the real disk in decimal gigabytes, with the time it was read", () => {
    const view = storageView(
      {
        state: "known",
        used_bytes: 1_234_000_000,
        filesystem_bytes: 10_737_418_240,
        observed_at: "2026-10-12T03:00:00Z",
      },
      clock
    );
    assert.equal(view.state === "known" && view.line, "1.2 of 10.7 GB");
    assert.equal(view.state === "known" && view.measured, "measured 12 Oct, 03:00");
  });
});

describe("the export row", () => {
  const base = {
    export_id: "00000000-0000-4000-8000-0000000000aa",
    requested_at: "2026-10-12T09:00:00Z",
  };

  it("says the assistants pause only when the export stops a cell that serves them", () => {
    const running = exportView({ state: "none", pauses_assistants: true }, clock);
    const stopped = exportView({ state: "none", pauses_assistants: false }, clock);
    assert.match(
      running.description,
      /Your assistants pause for a few minutes while we pack it\.$/
    );
    assert.equal(
      stopped.description,
      "All your notes and files, as Markdown. Works in every state."
    );
    const packing = exportView({ state: "packing", ...base, pauses_assistants: true }, clock);
    // Packing must keep the warning the owner read before starting the export.
    assert.equal(packing.description, running.description);
    assert.equal(
      packing.detail?.text,
      "Packing your notes and files… Your assistants are back in a few minutes. We’ll email you when it’s ready."
    );
    assert.equal(packing.busy, true);
  });

  it("computes how long a ready export is kept from its own times", () => {
    const ready = exportView(
      {
        state: "ready",
        ...base,
        ready_at: "2026-10-12T09:30:00Z",
        expires_at: "2026-10-14T09:30:00Z",
        archive_bytes: 1024,
        pauses_assistants: false,
      } as HomeExport,
      clock
    );
    assert.equal(ready.detail?.text, "kept 2 days, until 14 Oct, 09:30");
  });

  it("says a failed export did not finish in plain words, not its error code", () => {
    const failed = exportView(
      { state: "failed", ...base, error_code: "EXPORT_TOO_LARGE", pauses_assistants: false },
      clock
    );
    assert.deepEqual(failed.detail, {
      kind: "failed",
      text: "The export didn’t finish. Your notes are unchanged.",
    });
  });

  it("says when an expired export was deleted, and only when the server knows", () => {
    const expired = (expires_at: string | null) =>
      exportView(
        { state: "expired", ...base, expires_at, pauses_assistants: false } as HomeExport,
        clock
      ).detail?.text;
    assert.equal(
      expired("2026-10-11T14:20:00Z"),
      "Your last export was deleted on 11 October at 14:20. Export again any time."
    );
    assert.equal(expired(null), "Your last export was deleted. Export again any time.");
  });
});

describe("involvement levels", () => {
  it("offers no switch when the cell cannot answer, and says why", () => {
    const view = levelsView({ state: "unavailable", reason: "CELL_STOPPED" });
    assert.deepEqual(view, {
      state: "unavailable",
      text: "Levels can’t be read while your Exomem is stopped.",
    });
  });

  it("locks the switch while read-only or fixed by an operator", () => {
    const live = (locked_by: "read_only" | "operator") =>
      levelsView({
        state: "live",
        revision: "7",
        writable: false,
        locked_by,
        levels: {
          coding: { level: "balanced", source: "default" },
          conversation: { level: "maximal", source: "env" },
        },
      });
    for (const lock of ["read_only", "operator"] as const) {
      const view = live(lock);
      assert.ok(view.state === "live" && view.lockedText, `${lock} must lock the switch`);
    }
  });

  it("leaves the section out while the Home channel is not released", () => {
    assert.deepEqual(levelsView("not_released"), { state: "hidden" });
  });
});

describe("the directory hint", () => {
  it("names only the directory apps the owner has not connected", () => {
    assert.equal(directoryHint([app()], new Set())?.title, "ChatGPT");
    assert.equal(directoryHint([], new Set())?.title, "Claude or ChatGPT");
    assert.equal(directoryHint([app()], new Set([app().id]))?.title, "Claude or ChatGPT");
    assert.equal(
      directoryHint(
        [app(), app({ id: "x", platform: "openai", displayName: "ChatGPT" })],
        new Set()
      ),
      null
    );
  });
});

describe("the deletion link's lifetime", () => {
  it("counts the minutes between two server times, not from the browser's clock", () => {
    // The server's Date header has whole seconds; the expiry was set a moment before it.
    assert.equal(
      deletionLinkMinutes("2026-10-12T10:14:59.400Z", "Mon, 12 Oct 2026 10:00:00 GMT"),
      15
    );
    assert.equal(deletionLinkMinutes("2026-10-12T10:01:00Z", "Mon, 12 Oct 2026 10:00:00 GMT"), 1);
    assert.equal(deletionLinkMinutes("2026-10-12T10:15:00Z", null), null);
  });
});
