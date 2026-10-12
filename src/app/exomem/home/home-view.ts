// What Home says, computed from what the routes returned. Every function here is
// pure: data and the reader's clock in, words out. Copy comes from the Home board
// (docs/exomem-design/reference/boards/Home-Page.dc.html) and the approved export
// copy; a value the server does not know drops its clause rather than inventing one.

import { CLIENT_PLATFORM_NAMES, displayNameVouched } from "@/lib/exomem-hosted/client-platforms";
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
  gigabytes,
  isoDay,
  secondsAgo,
  shortDateTime,
  type Clock,
} from "./home-format";
import type { Lifecycle } from "./home-state";

// --- Which Home ---

/**
 * on: the memory is live · readonly: a payment failed · ended: the subscription
 * ended and the memory is kept · paused / suspended: the cell is stopped ·
 * trouble: the cell should run and does not · export_pause: an export holds it.
 */
export type HomeVariant =
  | "on"
  | "readonly"
  | "ended"
  | "paused"
  | "suspended"
  | "trouble"
  | "export_pause";

export type HomeMode =
  | { kind: "loading" }
  | { kind: "subscribe" }
  | { kind: "preparing" }
  | { kind: "deleting" }
  | { kind: "deleted" }
  | { kind: "home"; variant: HomeVariant };

/** The lifecycle says whether the cell serves; the account step says why it does or does not. */
export function homeMode(lifecycle: Lifecycle, account: HomeAccount | null): HomeMode {
  const step = account?.step ?? null;
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
      return {
        kind: "home",
        variant: lifecycle.code === "CELL_PAUSED_FOR_EXPORT" ? "export_pause" : "trouble",
      };
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
};

/** Null when activity is unavailable or not released: Home then shows no count and no line. */
export function activityFacts(
  activity: HomeActivity | typeof NOT_RELEASED | null
): ActivityFacts | null {
  if (!activity || activity === "not_released" || activity.state !== "live") return null;
  // The cell lists events newest first.
  return {
    noteCount: activity.note_count,
    newest: activity.events[0] ?? null,
    lastSave: activity.events.find((event) => event.action === "saved") ?? null,
    since: activity.since,
  };
}

// The cell names a client by its content-free family (exomem privacy_log), a closed
// set that module fixes. Any other value, or none, is "Your app", as the board names
// an app it has no name for.
const CLIENT_FAMILY_NAMES: Record<string, string> = {
  "claude-ai": CLIENT_PLATFORM_NAMES.claude,
  chatgpt: CLIENT_PLATFORM_NAMES.openai,
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function clientName(family: string | null): string {
  return family !== null && Object.hasOwn(CLIENT_FAMILY_NAMES, family)
    ? CLIENT_FAMILY_NAMES[family]
    : "Your app";
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
  clock: Clock
): { text: string; key: string } | null {
  if (!facts) return null;
  if (facts.noteCount === 0) {
    const first = apps[0]?.displayName;
    return {
      text: first ? `Waiting for the first note from ${first}` : "Waiting for the first note",
      key: "waiting",
    };
  }
  if (facts.newest) {
    const event = facts.newest;
    return {
      text: `${clientName(event.client)} ${eventVerb(event)} · ${secondsAgo(event.at, clock.now)}`,
      key: `${event.at}|${event.client}|${event.action}|${event.items}`,
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
  return `saved by ${clientName(facts.lastSave.client)} ${ago(facts.lastSave.at, clock.now)}`;
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
  const saved = facts?.lastSave ? `last saved ${ago(facts.lastSave.at, clock.now)}` : null;
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
      return { headline: "Your subscription is paused", statusLine: null };
    case "suspended":
      return { headline: "This Exomem is suspended", statusLine: null };
    case "trouble":
      return { headline: "Your memories are safe.", statusLine: null };
    case "export_pause":
      return {
        headline: "Paused for your export",
        statusLine: "Your assistants are back in a few minutes.",
      };
  }
}

// --- The banner: the account's state and its one action ---

export type BannerAction = "fix_billing" | "resubscribe" | "resume";

export function banner(
  variant: HomeVariant,
  account: HomeAccount | null,
  billing: HomeBilling | null,
  clock: Clock
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
      return {
        text: `${kept ? `Kept until ${dayMonth(kept, clock.timeZone)}. ` : ""}Export it, or resubscribe to get it all back.`,
        action: billing?.checkoutAvailable ? "resubscribe" : null,
      };
    }
    case "paused":
      return {
        text: "Your memory is kept and readable. Resume it to connect your assistant.",
        action: billing?.portalAvailable ? "resume" : null,
      };
    case "suspended":
      return {
        text: "It can’t connect to your assistant while it’s suspended. Your memory is safe, and you can still export it.",
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
  action: "copy_reference" | "support" | null;
};

export function notices(
  variant: HomeVariant,
  account: HomeAccount | null,
  storage: StorageView
): HomeNotice[] {
  const list: HomeNotice[] = [];
  const reference = account?.supportReference ?? null;
  if (variant === "trouble") {
    list.push({
      key: "trouble",
      text: `Exomem is having trouble waking up. We are retrying without moving your data anywhere else.${
        reference ? ` Support reference: ${reference}.` : ""
      }`,
      attention: false,
      action: reference ? "copy_reference" : null,
    });
  }
  if (variant === "suspended" && reference) {
    list.push({
      key: "suspended",
      text: `Write to support and quote ${reference}. We’ll tell you why it was suspended and what happens next.`,
      attention: false,
      action: "support",
    });
  }
  // Storage add-ons are hidden at launch, so neither notice offers them.
  if (storage.state === "known" && storage.fraction >= 1) {
    list.push({
      key: "full",
      text: `Your Exomem is full (${storage.total} GB). Recall works; new saves wait for room. Nothing is ever deleted to make space.`,
      attention: true,
      action: null,
    });
  } else if (storage.state === "known" && storage.fraction >= 0.8) {
    list.push({
      key: "filling",
      text: `Your Exomem is ${Math.round(storage.fraction * 100)}% full. Everything works.`,
      attention: false,
      action: null,
    });
  }
  return list;
}

// --- Connected apps ---

export function appGlyph(app: HomeApp): string {
  if (app.kind === "local") return ">_";
  if (app.platform === "claude") return "C";
  if (app.platform === "openai") return "G";
  return app.displayName.trim().charAt(0).toUpperCase() || "+";
}

/** The row's second line. A name Exomem does not vouch for shows where access goes. */
export function appMeta(app: HomeApp, clock: Clock): string {
  const parts = [`connected ${dayMonth(app.connectedAt, clock.timeZone)}`];
  if (!displayNameVouched(app.displayNameSource) && app.displayNameSource !== "redirect_host") {
    const destination = app.kind === "local" ? "this computer" : app.redirectHosts.join(", ");
    parts.push("name from the app", `sends access to ${destination}`);
  }
  return parts.join(" · ");
}

/** Claude and ChatGPT list Exomem in their directories; the hint names the ones not yet connected. */
export function directoryHint(
  apps: readonly HomeApp[],
  disconnected: ReadonlySet<string>
): { title: string; text: string } | null {
  const live = apps.filter((app) => app.kind === "web" && !disconnected.has(app.id));
  const hints = [
    {
      name: CLIENT_PLATFORM_NAMES.claude,
      platform: "claude",
      text: `In ${CLIENT_PLATFORM_NAMES.claude}, find Exomem under Settings, then Connectors.`,
    },
    {
      name: CLIENT_PLATFORM_NAMES.openai,
      platform: "openai",
      text: `In ${CLIENT_PLATFORM_NAMES.openai}, find Exomem in the plugin directory.`,
    },
  ].filter((hint) => !live.some((app) => app.platform === hint.platform));
  if (!hints.length) return null;
  return {
    title: hints.map((hint) => hint.name).join(" or "),
    text: hints.map((hint) => hint.text).join(" "),
  };
}

// --- Involvement levels ---

export const LEVEL_ROWS: readonly { context: LevelContext; title: string }[] = [
  { context: "conversation", title: "Chat apps" },
  { context: "coding", title: "Coding agents" },
];

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

const UNAVAILABLE_LEVELS: Record<string, string> = {
  CELL_STOPPED: "Levels can’t be read while your Exomem is stopped.",
  CELL_NOT_READY: "Levels can’t be read while your Exomem is starting.",
  CELL_OUTDATED: "Levels need a newer Exomem. It updates soon.",
};

export function levelsView(levels: HomeLevels | typeof NOT_RELEASED | null): LevelsView {
  if (levels === "not_released") return { state: "hidden" };
  if (levels === null) return { state: "loading" };
  if (levels.state === "unavailable") {
    return {
      state: "unavailable",
      text:
        UNAVAILABLE_LEVELS[levels.reason] ??
        "Levels can’t be read right now. Try again in a minute.",
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
): PlanView | null {
  if (!account) return null;
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
  else if (variant === "ended") meta = "ended";
  else {
    const inviter = friend && plan.friendPrice.inviterName;
    meta = joined([inviter && `from ${inviter}’s invitation`, nextPayment(account, clock)]);
  }

  let action: PlanView["action"] = null;
  if (variant === "readonly" && billing?.portalAvailable) {
    action = { label: "Fix billing", kind: "portal" };
  } else if (variant === "ended" && billing?.checkoutAvailable) {
    action = { label: "Resubscribe", kind: "checkout" };
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
    | { kind: "failed"; text: string; code: string }
    | { kind: "expired"; text: string }
    | null;
  busy: boolean;
};

const EXPORT_DESCRIPTION = "All your notes and files, as Markdown. Works in every state.";

export function exportView(summary: HomeExport, clock: Clock): ExportView {
  const pauses = summary.pauses_assistants;
  const description =
    pauses && summary.state !== "packing"
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
          text: `exomem-${isoDay(summary.ready_at, clock.timeZone)}.zip · kept ${kept}, until ${shortDateTime(
            summary.expires_at,
            clock.timeZone
          )}`,
        },
      };
    }
    case "failed":
      return {
        description,
        busy: false,
        detail: {
          kind: "failed",
          text: "The export didn’t finish. Your notes are unchanged.",
          code: summary.error_code,
        },
      };
    case "expired":
      return {
        description,
        busy: false,
        detail: { kind: "expired", text: "Your last export was deleted. Export again any time." },
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
