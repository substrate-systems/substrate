// What Home says, computed from what the routes returned. Every function here is
// pure: data and the reader's clock in, words out. Copy comes from the Home board
// (docs/exomem-design/reference/boards/Home-Page.dc.html) and the approved export
// copy; a value the server does not know drops its clause rather than inventing one.

import { subscribeLine } from "@/components/exomem/subscribe-line";
import { formatMoney } from "@/lib/exomem/money";
import {
  CLIENT_FAMILY_NAMES,
  CLIENT_PLATFORM_GLYPHS,
  displayNameVouched,
} from "@/lib/exomem-hosted/client-platforms";
import type {
  ActivityClientFamily,
  CloudHomeUnavailableReason,
} from "@/lib/exomem-hosted/cloud-home-mcp";
import type {
  HomeAccount,
  HomeActivity,
  HomeApp,
  HomeBilling,
  HomeExport,
  HomeLevels,
  HomeStorage,
  LevelContext,
  LevelKey,
  NOT_RELEASED,
} from "./home-api";
import {
  ago,
  count,
  dayMonth,
  dayMonthTime,
  gigabytes,
  secondsAgo,
  shortDateTime,
  type Clock,
} from "./home-format";
import type { PaddlePricePreview } from "@/lib/paddle";
import { breakCopy, consentCopy, subscribeCopy } from "../_journey/copy";
import { friendCheckoutPanel, type PricePanel } from "../invite/invite-view";
import type { Lifecycle } from "./home-state";

// --- Which Home ---

/**
 * on: the memory is live · readonly: a payment failed · ended: the subscription
 * ended and the memory is kept · paused / suspended: the cell is stopped ·
 * trouble: the cell should run and does not · export_pause: an export holds it ·
 * hold_pause: maintenance holds it (a backup, an upgrade) and ends by itself ·
 * unknown: the account could not be read, so Home claims no state for it.
 */
export type HomeVariant =
  | "on"
  | "readonly"
  | "ended"
  | "paused"
  | "suspended"
  | "trouble"
  | "export_pause"
  | "hold_pause"
  | "unknown";

/** Where the first account read is: Home says nothing about the account until it settles. */
export type AccountRead = "loading" | "failed" | "known";

export type HomeMode =
  | { kind: "loading" }
  | { kind: "subscribe" }
  | { kind: "preparing" }
  | { kind: "deleting" }
  | { kind: "deleted" }
  | { kind: "home"; variant: HomeVariant };

/** The account's friend offer, as the account view reports it. */
export type FriendOffer = Pick<HomeAccount["plan"]["friendPrice"], "offered" | "inviterName">;

/**
 * Whether the subscribe step may ask Paddle for the usual price: only for an account it has
 * read (a non-null offer) that holds no friend offer. Checkout charges the friend price instead.
 */
export function showsUsualPrice(offer: FriendOffer | null): boolean {
  return offer !== null && !offer.offered;
}

/** Who gave the friend offer that checkout applies; null without one, or once the name is gone. */
export function offerInviter(offer: FriendOffer | null): string | null {
  return offer?.offered ? offer.inviterName : null;
}

/**
 * The subscribe step's line and price card, on Home, setup and consent. An account with a
 * friend offer reads the friend line and the "shown at checkout" card. An offer whose
 * inviter's name went with their account reads that Paddle shows the price at checkout.
 */
export function subscribeView(
  offer: FriendOffer | null,
  price: PaddlePricePreview | null,
  app?: string
): { line: string; friendCard: PricePanel | null } {
  const inviter = offerInviter(offer);
  return inviter
    ? { line: subscribeCopy.friendLede(inviter), friendCard: friendCheckoutPanel(inviter) }
    : { line: subscribeLine(showsUsualPrice(offer) ? price : null, app), friendCard: null };
}

/** The lifecycle says whether the cell serves; the account step says why it does or does not. */
export function homeMode(
  lifecycle: Lifecycle,
  account: HomeAccount | null,
  accountRead: AccountRead
): HomeMode {
  const step = account?.step ?? null;
  // These states draw the account's Home, so they wait for the account and never guess it.
  const needsAccount =
    lifecycle.state === "suspended" ||
    lifecycle.state === "degraded" ||
    lifecycle.state === "ready";
  if (needsAccount && accountRead === "loading") return { kind: "loading" };
  if (needsAccount && !account) return { kind: "home", variant: "unknown" };
  switch (lifecycle.state) {
    case "loading":
      return { kind: "loading" };
    case "awaiting_payment":
      return { kind: "subscribe" };
    case "preparing":
      return { kind: "preparing" };
    case "deletion_pending":
      return { kind: "deleting" };
    case "deleted":
      return { kind: "deleted" };
    case "suspended":
      if (step === "paused") return { kind: "home", variant: "paused" };
      if (step === "ended") return { kind: "home", variant: "ended" };
      return { kind: "home", variant: "suspended" };
    case "degraded":
      if (lifecycle.code === "CELL_PAUSED_FOR_EXPORT")
        return { kind: "home", variant: "export_pause" };
      if (lifecycle.code === "CELL_PAUSED_FOR_HOLD") return { kind: "home", variant: "hold_pause" };
      return { kind: "home", variant: "trouble" };
    case "ready":
      if (step === "connect-read-only") return { kind: "home", variant: "readonly" };
      if (step === "ended") return { kind: "home", variant: "ended" };
      return { kind: "home", variant: "on" };
  }
}

/** Amber, the breathing mark and the lit web are for a memory that is on. */
export function isLive(variant: HomeVariant): boolean {
  return variant === "on";
}

// --- Live activity ---

type ActivityEvent = Extract<HomeActivity, { state: "live" }>["events"][number];

export type ActivityFacts = {
  noteCount: number | null;
  newest: ActivityEvent | null;
  lastSave: ActivityEvent | null;
  since: string;
  /** The cell's clock minus the browser's, when the answer arrived. */
  cellOffsetMs: number;
};

/**
 * Null when activity is unavailable or not released: Home then shows no count and no
 * line. `receivedAt` is the browser's time when the answer arrived.
 */
export function activityFacts(
  activity: HomeActivity | typeof NOT_RELEASED | null,
  receivedAt: number
): ActivityFacts | null {
  if (!activity || activity === "not_released" || activity.state !== "live") return null;
  // The cell lists events newest first.
  return {
    noteCount: activity.note_count,
    newest: activity.events[0] ?? null,
    lastSave: activity.events.find((event) => event.action === "saved") ?? null,
    since: activity.since,
    cellOffsetMs: Date.parse(activity.as_of) - receivedAt,
  };
}

// What Home says in place of the live line when the cell could not report activity.
// Every reason the server can give has an entry, so a new reason fails tsc here; null
// keeps the line empty, as Home did before for a stopped, starting, unreachable or
// outdated cell.
const UNAVAILABLE_ACTIVITY: Record<CloudHomeUnavailableReason, string | null> = {
  CELL_STOPPED: null,
  CELL_NOT_READY: null,
  CELL_UNREACHABLE: null,
  CELL_OUTDATED: null,
  HOME_CLIENT_DISABLED: "Activity isn’t available right now.",
  ACCOUNT_ACCESS_CLOSED: "Activity isn’t available for this account.",
};

/** The sentence in place of the live line when activity is unavailable, or null for none. */
export function activityUnavailableText(
  activity: HomeActivity | typeof NOT_RELEASED | null
): string | null {
  if (!activity || activity === "not_released" || activity.state !== "unavailable") return null;
  // parseActivity passes on any reason string; one this build does not know shows nothing.
  return UNAVAILABLE_ACTIVITY[activity.reason] ?? null;
}

/** Now on the cell's clock, so an event's age does not depend on the browser's clock. */
function cellNow(facts: ActivityFacts, clock: Clock): number {
  return clock.now + facts.cellOffsetMs;
}

// The cell names a client by its content-free family; null is a client it does not
// name, which the board calls "Your app".

function clientName(family: ActivityClientFamily | null): string {
  return family === null ? "Your app" : CLIENT_FAMILY_NAMES[family];
}

function eventVerb(event: ActivityEvent): string {
  const verb = event.action;
  if (event.items === null) return `${verb} notes`;
  if (event.items === 1) return `${verb} a note`;
  return `${verb} ${count(event.items)} notes`;
}

/** The live line, or null when Home must show nothing in its place. */
export function liveLine(
  facts: ActivityFacts | null,
  apps: readonly HomeApp[],
  disconnected: ReadonlySet<string>,
  clock: Clock
): { text: string; key: string; client?: ActivityClientFamily | null } | null {
  if (!facts) return null;
  if (facts.noteCount === 0) {
    const first = apps.find((app) => !disconnected.has(app.id))?.displayName;
    return {
      text: first ? `Waiting for the first note from ${first}` : "Waiting for the first note",
      key: "waiting",
    };
  }
  if (facts.newest) {
    const event = facts.newest;
    return {
      text: `${clientName(event.client)} ${eventVerb(event)} · ${secondsAgo(event.at, cellNow(facts, clock))}`,
      key: `${event.at}|${event.client}|${event.action}|${event.items}`,
      client: event.client,
    };
  }
  return {
    text: `No assistant activity since ${shortDateTime(facts.since, clock.timeZone)}`,
    key: "idle",
  };
}

/** The first save on a new account. The note's path stays in the cell: the channel is content free. */
export function firstNoteLine(facts: ActivityFacts | null, clock: Clock): string | null {
  if (!facts || facts.noteCount !== 1 || !facts.lastSave) return null;
  return `saved by ${clientName(facts.lastSave.client)} ${ago(facts.lastSave.at, cellNow(facts, clock))}`;
}

// --- Headline and status line ---

function notes(n: number, example = false): string {
  return `${count(n)} ${example ? "example " : ""}note${n === 1 ? "" : "s"}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joined(parts: (string | null | false | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length ? kept.join(" · ") : null;
}

/** A status line starts with a capital, whichever part is first. */
function line(parts: (string | null | false)[]): string | null {
  const text = joined(parts);
  return text ? capitalise(text) : null;
}

export function statusCopy(
  variant: HomeVariant,
  reviewer: boolean,
  facts: ActivityFacts | null,
  clock: Clock
): { headline: string; statusLine: string | null } {
  const n = facts?.noteCount ?? null;
  const saved = facts?.lastSave
    ? `last saved ${ago(facts.lastSave.at, cellNow(facts, clock))}`
    : null;
  switch (variant) {
    case "on":
      if (reviewer) {
        return {
          headline: "Your memory is on",
          statusLine: line(["Sample account", n !== null && notes(n, true), saved]),
        };
      }
      return {
        headline: "Your memory is on",
        statusLine:
          n === 0
            ? "No notes yet · ask your assistant to remember something"
            : line([n !== null && notes(n), saved]),
      };
    case "readonly":
      return {
        headline: "Read-only for now",
        statusLine: line([n !== null && notes(n), "recall works, saving is paused"]),
      };
    case "ended":
      return {
        headline: "Subscription ended",
        statusLine: line([n !== null && notes(n), "read-only"]),
      };
    case "paused":
      return { headline: breakCopy.paused.title, statusLine: null };
    case "suspended":
      return { headline: "This Exomem is suspended", statusLine: null };
    case "trouble":
      return { headline: "Your memories are safe.", statusLine: null };
    case "export_pause":
      return {
        headline: "Paused for your export",
        statusLine: "Your assistants are back in a few minutes.",
      };
    case "hold_pause":
      return {
        headline: "Paused for maintenance",
        statusLine: "It ends by itself, and your assistants are back after it.",
      };
    case "unknown":
      return {
        headline: "Your Exomem",
        statusLine: "Your account details can’t be read right now. Try again in a minute.",
      };
  }
}

// --- The banner: the account's state and its one action ---

export type BannerAction = "fix_billing" | "resubscribe" | "resume";

/**
 * The account's banner. `exportOffered` is false while the export flag is off: Home then
 * shows no export row, so no sentence offers one (design.md deviation (s)).
 */
export function banner(
  variant: HomeVariant,
  account: HomeAccount | null,
  billing: HomeBilling | null,
  clock: Clock,
  exportOffered: boolean
): { text: string; action: BannerAction | null } | null {
  if (account?.kind === "reviewer") {
    const ends = account.reviewerEndsAt.value;
    return {
      text: `Reviewer access for the app directory review. It holds sample notes only${
        ends ? ` and ends on ${dayMonth(ends, clock.timeZone)}` : ""
      }. Everything here works as it does for a customer.`,
      action: null,
    };
  }
  switch (variant) {
    case "readonly": {
      const until = account?.readOnlyUntil.value;
      return {
        text: `Your last payment failed. Paddle tries again${
          until ? ` until ${dayMonth(until, clock.timeZone)}` : ""
        }. Fix it and saving starts again.`,
        action: billing?.portalAvailable ? "fix_billing" : null,
      };
    }
    case "ended": {
      const kept = account?.keptUntil.value;
      const until = kept ? dayMonth(kept, clock.timeZone) : null;
      // Without a checkout to start, nothing asks the owner to resubscribe (design.md (af)).
      if (!billing?.checkoutAvailable) {
        return { text: breakCopy.ended.ledeWithoutCheckout(until, exportOffered), action: null };
      }
      return {
        text: `${until ? `Kept until ${until}. ` : ""}${
          exportOffered ? "Export it, or resubscribe" : "Resubscribe"
        } to get it all back.`,
        action: "resubscribe",
      };
    }
    // The Journey board's paused step, for a web start (design.md (ac)).
    case "paused":
      return {
        text: breakCopy.paused.lede(breakCopy.webApp),
        action: billing?.portalAvailable ? "resume" : null,
      };
    case "suspended":
      return {
        text: exportOffered
          ? "It can’t connect to your assistant while it’s suspended. Your memory is safe, and you can still export it."
          : "It can’t connect to your assistant while it’s suspended. Your memory is safe.",
        action: null,
      };
    default:
      return null;
  }
}

// --- Notices: shown only while true ---

export type HomeNotice = {
  key: string;
  text: string;
  /** Amber edge: a live state that needs the person now. */
  attention: boolean;
  /** In order; none for a notice that only informs. */
  actions: ("copy_reference" | "status_page" | "support")[];
};

export function notices(
  variant: HomeVariant,
  account: HomeAccount | null,
  storage: StorageView,
  /** False while the export flag is off; see `banner`. */
  exportOffered: boolean,
  /** Whether a status page is configured, for the trouble notice's "Status page ↗". */
  statusPageOffered: boolean
): HomeNotice[] {
  const list: HomeNotice[] = [];
  const reference = account?.supportReference ?? null;
  // The board's trouble notice says saving is slow and recall works. Home cannot tell
  // that state apart, and here the cell does not answer, so it keeps its own words and
  // adds the board's status page link (design.md (v)).
  if (variant === "trouble") {
    list.push({
      key: "trouble",
      text: `Exomem is having trouble waking up. We are retrying without moving your data anywhere else.${
        reference ? ` Support reference: ${reference}.` : ""
      }`,
      attention: false,
      actions: [
        ...(reference ? (["copy_reference"] as const) : []),
        ...(statusPageOffered ? (["status_page"] as const) : []),
      ],
    });
  }
  // An ended memory is deleted when its kept window closes. Without an export, support
  // makes the copy, the way the suspended notice below sends the owner there.
  if (variant === "ended" && !exportOffered) {
    list.push({
      key: "copy",
      text: `For a copy of your memory, write to support${reference ? ` and quote ${reference}` : ""}.`,
      attention: false,
      actions: ["support"],
    });
  }
  if (variant === "suspended" && reference) {
    list.push({
      key: "suspended",
      text: `Write to support and quote ${reference}. We’ll tell you why it was suspended and what happens next.`,
      attention: false,
      actions: ["support"],
    });
  }
  // Storage add-ons are hidden at launch, so neither notice offers them.
  if (storage.state === "known" && storage.fraction >= 1) {
    list.push({
      key: "full",
      text: `Your Exomem is full (${storage.total} GB). Recall works; new saves wait for room. Nothing is ever deleted to make space.`,
      attention: true,
      actions: [],
    });
  } else if (storage.state === "known" && storage.fraction >= 0.8) {
    list.push({
      key: "filling",
      // Floor: a disk that is not full never reads as 100%.
      text: `Your Exomem is ${Math.floor(storage.fraction * 100)}% full. Everything works.`,
      attention: false,
      actions: [],
    });
  }
  return list;
}

// --- Connected apps ---

export function appGlyph(app: HomeApp): string {
  if (app.kind === "local") return ">_";
  if (app.platform === "claude" || app.platform === "openai")
    return CLIENT_PLATFORM_GLYPHS[app.platform];
  return app.displayName.trim().charAt(0).toUpperCase() || "+";
}

/**
 * The row's second line. On a reviewer account it says the app joined during the
 * review; a name Exomem does not vouch for shows where access goes.
 */
export function appMeta(app: HomeApp, clock: Clock, reviewer: boolean): string {
  const parts = [`connected ${dayMonth(app.connectedAt, clock.timeZone)}`];
  if (reviewer) parts.push("during review");
  if (!displayNameVouched(app.displayNameSource) && app.displayNameSource !== "redirect_host") {
    const destination = app.kind === "local" ? "this computer" : app.redirectHosts.join(", ");
    parts.push("name from the app", `sends access to ${destination}`);
  }
  return parts.join(" · ");
}

// --- Delete ---

/**
 * How long the emailed deletion link works, in whole minutes, from two server times:
 * the link's expiry and the server's time when it answered. Null when either is missing.
 */
export function deletionLinkMinutes(
  expiresAt: string | null,
  serverDate: string | null
): number | null {
  const expires = expiresAt ? Date.parse(expiresAt) : NaN;
  const answered = serverDate ? Date.parse(serverDate) : NaN;
  if (Number.isNaN(expires) || Number.isNaN(answered)) return null;
  return Math.max(1, Math.round((expires - answered) / 60_000));
}

// --- Involvement levels ---

const LEVEL_ROWS: readonly { context: LevelContext; title: string }[] = [
  { context: "conversation", title: "Chat apps" },
  { context: "coding", title: "Coding agents" },
];

/** "Chat apps" or "Coding agents": the row a context's level shows in. */
export function levelContextTitle(context: LevelContext): string {
  return LEVEL_ROWS.find((row) => row.context === context)!.title;
}

export type LevelsView =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "unavailable"; text: string }
  | {
      state: "live";
      revision: string;
      lockedText: string | null;
      rows: { context: LevelContext; title: string; level: LevelKey; isDefault: boolean }[];
    };

const LEVELS_UNREADABLE = "Levels can’t be read right now. Try again in a minute.";

// Every reason the server can give has its own sentence, so a new reason fails tsc here.
const UNAVAILABLE_LEVELS: Record<CloudHomeUnavailableReason, string> = {
  CELL_STOPPED: "Levels can’t be read while your Exomem is stopped.",
  CELL_NOT_READY: "Levels can’t be read while your Exomem is starting.",
  CELL_UNREACHABLE: LEVELS_UNREADABLE,
  CELL_OUTDATED: "Levels need a newer Exomem. It updates soon.",
  HOME_CLIENT_DISABLED: "Levels aren’t available right now.",
  ACCOUNT_ACCESS_CLOSED: "Levels aren’t available for this account.",
};

export function levelsView(levels: HomeLevels | typeof NOT_RELEASED | null): LevelsView {
  if (levels === "not_released") return { state: "hidden" };
  if (levels === null) return { state: "loading" };
  if (levels.state === "unavailable") {
    return {
      state: "unavailable",
      // parseLevels passes on any reason string, so one this build does not know still reads.
      text: UNAVAILABLE_LEVELS[levels.reason] ?? LEVELS_UNREADABLE,
    };
  }
  return {
    state: "live",
    revision: levels.revision,
    lockedText:
      levels.locked_by === "read_only"
        ? "Levels can’t change while Exomem is read-only."
        : levels.locked_by === "operator"
          ? "An operator setting fixes these levels."
          : null,
    rows: LEVEL_ROWS.map((row) => ({
      ...row,
      level: levels.levels[row.context].level,
      isDefault: levels.levels[row.context].source === "default",
    })),
  };
}

export function levelRefusalText(code: string): string {
  if (code === "PREFERENCE_CONFLICT")
    return "This changed elsewhere a moment ago. It shows the level in use now.";
  if (code === "CLOUD_CELL_READ_ONLY") return "Levels can’t change while Exomem is read-only.";
  if (code === "PREFERENCE_OPERATOR_OVERRIDE") return "An operator setting fixes these levels.";
  return "That didn’t finish. Try again in a minute.";
}

// --- Plan and account ---

export type PlanView = {
  name: string;
  meta: string;
  action: { label: string; kind: "portal" | "checkout" } | null;
  note: string | null;
};

function nextPayment(account: HomeAccount, clock: Clock): string | null {
  const next = account.nextPaymentAt;
  if (next.value) return `next payment ${dayMonth(next.value, clock.timeZone)}`;
  switch (next.reason) {
    case "complimentary":
      return "no payments";
    case "paused":
      return "paused";
    case "ended":
      return "ended";
    case "not_reported":
      return "next payment not reported yet";
    default:
      return null;
  }
}

export function planView(
  variant: HomeVariant,
  account: HomeAccount | null,
  billing: HomeBilling | null,
  clock: Clock
): PlanView {
  if (!account) return { name: "Plan", meta: "not available right now", action: null, note: null };
  if (account.kind === "reviewer") {
    const ends = account.reviewerEndsAt.value;
    return {
      name: "Reviewer access",
      meta: ends ? `complimentary · ends ${dayMonth(ends, clock.timeZone)}` : "complimentary",
      action: null,
      note: "No billing on a reviewer account. We reset it after the review.",
    };
  }
  const plan = account.plan;
  const friend = plan.friendPrice.applied && variant === "on";
  let name: string;
  if (variant === "ended") name = "No active plan";
  else if (plan.name.value) name = friend ? `${plan.name.value} · friend price` : plan.name.value;
  else if (plan.name.reason === "complimentary") name = "Complimentary access";
  else if (plan.name.reason === "no_subscription") name = "No active plan";
  else name = "Plan not reported yet";

  let meta: string | null;
  if (variant === "readonly") meta = "payment failed · retrying";
  else if (variant === "ended") {
    // The board's "ended 12 October"; a date the account does not know drops out.
    const ended = account.endedAt.value;
    meta = ended ? `ended ${dayMonth(ended, clock.timeZone)}` : "ended";
  } else {
    const inviter = friend && plan.friendPrice.inviterName;
    // The amount Paddle previews for the next payment, in en-GB like Home's dates. Unknown
    // shows no number at all, and so does a payment with no date: no money is promised
    // for a payment that may not come.
    const amount = account.nextPaymentAt.value ? account.nextPaymentAmount.value : null;
    const price = amount && formatMoney(amount);
    meta = joined([price, inviter && `from ${inviter}’s invitation`, nextPayment(account, clock)]);
  }

  let action: PlanView["action"] = null;
  if (variant === "readonly" && billing?.portalAvailable) {
    action = { label: consentCopy.readOnly.fixBilling, kind: "portal" };
  } else if (variant === "ended" && billing?.checkoutAvailable) {
    action = { label: breakCopy.ended.resubscribe, kind: "checkout" };
  } else if (variant !== "ended" && billing?.portalAvailable) {
    action = { label: "Manage billing", kind: "portal" };
  }
  return {
    name,
    meta: meta ?? "",
    action,
    note: billing?.source === "paddle" ? "Billing, invoices and receipts are in Paddle." : null,
  };
}

// --- Storage: the real disk ---

export type StorageView =
  | { state: "unknown" }
  | {
      state: "known";
      line: string;
      total: string;
      fraction: number;
      measured: string;
    };

export function storageView(storage: HomeStorage | null, clock: Clock): StorageView {
  if (!storage || storage.state !== "known") return { state: "unknown" };
  const total = gigabytes(storage.filesystem_bytes);
  return {
    state: "known",
    line: `${gigabytes(storage.used_bytes)} of ${total} GB`,
    total,
    fraction: storage.used_bytes / storage.filesystem_bytes,
    measured: `measured ${shortDateTime(storage.observed_at, clock.timeZone)}`,
  };
}

// --- Export ---

export type ExportView = {
  description: string;
  /** The row under the export row, if any. */
  detail:
    | { kind: "packing"; text: string }
    | { kind: "ready"; text: string; exportId: string }
    | { kind: "failed"; text: string }
    | { kind: "expired"; text: string }
    | null;
  busy: boolean;
};

const EXPORT_DESCRIPTION = "All your notes and files, as Markdown. Works in every state.";

export function exportView(summary: HomeExport, clock: Clock): ExportView {
  const pauses = summary.pauses_assistants;
  const description = pauses
    ? `${EXPORT_DESCRIPTION} Your assistants pause for a few minutes while we pack it.`
    : EXPORT_DESCRIPTION;
  switch (summary.state) {
    case "none":
      return { description, detail: null, busy: false };
    case "packing":
      return {
        description,
        busy: true,
        detail: {
          kind: "packing",
          text: pauses
            ? "Packing your notes and files… Your assistants are back in a few minutes. We’ll email you when it’s ready."
            : "Packing your notes and files… We’ll email you when it’s ready.",
        },
      };
    case "ready": {
      const hours = Math.round(
        (Date.parse(summary.expires_at) - Date.parse(summary.ready_at)) / 3_600_000
      );
      const kept = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} h`;
      return {
        description,
        busy: false,
        detail: {
          kind: "ready",
          exportId: summary.export_id,
          // No file name: cellctl names the download, and Home does not copy its rule.
          text: `kept ${kept}, until ${shortDateTime(summary.expires_at, clock.timeZone)}`,
        },
      };
    }
    case "failed":
      return {
        description,
        busy: false,
        // The board's words; the error code stays in the server's logs.
        detail: { kind: "failed", text: "The export didn’t finish. Your notes are unchanged." },
      };
    case "expired":
      return {
        description,
        busy: false,
        detail: {
          kind: "expired",
          // A newer export replaced it when the server has no expiry for it.
          text: summary.expires_at
            ? `Your last export was deleted on ${dayMonthTime(summary.expires_at, clock.timeZone)}. Export again any time.`
            : "Your last export was deleted. Export again any time.",
        },
      };
  }
}

export function exportRefusalText(
  code: string,
  retryAfterMs: number | null,
  clock: Clock
): string | null {
  switch (code) {
    case "EXPORT_IN_PROGRESS":
      return null;
    case "EXPORT_NO_DATA":
      return "There is nothing to export yet: your Exomem has not started.";
    case "EXPORT_UNAVAILABLE":
      return "Export is not available while your Exomem is being deleted.";
    case "RATE_LIMITED":
      return retryAfterMs
        ? `You can export again from ${shortDateTime(
            new Date(clock.now + retryAfterMs).toISOString(),
            clock.timeZone
          )}.`
        : "You can export again later.";
    default:
      return "That didn’t finish. Try again in a minute.";
  }
}
