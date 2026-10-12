/**
 * Time limits in Exomem emails. Each one is computed when the email is sent,
 * in the reader's time zone, in the formats the boards' renderVals() use
 * (R12-Lifecycle, R28-Emails): a date is "14 October", a time "09:20". When
 * the reader's zone is unknown the value is shown in UTC and says so, because
 * an unlabelled time invites the reader to take it as their own.
 */

export type EmailTimeZone = string | null | undefined;

function zoneOf(timeZone: EmailTimeZone): string {
  return timeZone || "UTC";
}

function labelled(value: string, timeZone: EmailTimeZone, form: "suffix" | "bracket"): string {
  if (timeZone) return value;
  return form === "suffix" ? `${value} UTC` : `${value} (UTC)`;
}

function date(at: Date, timeZone: EmailTimeZone, month: "long" | "short"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zoneOf(timeZone),
    day: "numeric",
    month,
  }).format(at);
}

function clock(at: Date, timeZone: EmailTimeZone): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zoneOf(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** "14 October", or "14 October (UTC)" when the zone is unknown. */
export function emailDate(at: Date, timeZone: EmailTimeZone): string {
  return labelled(date(at, timeZone, "long"), timeZone, "bracket");
}

/** "09:20", or "09:20 UTC" when the zone is unknown. */
export function emailClock(at: Date, timeZone: EmailTimeZone): string {
  return labelled(clock(at, timeZone), timeZone, "suffix");
}

/** "14 October, 09:20", or "14 October, 09:20 UTC" when the zone is unknown. */
export function emailDateTime(at: Date, timeZone: EmailTimeZone): string {
  return labelled(`${date(at, timeZone, "long")}, ${clock(at, timeZone)}`, timeZone, "suffix");
}

/**
 * "14 Oct, 09:20", unlabelled: the approved place-opened copy (2026-10-12)
 * labels it itself, "(your time)" or "UTC".
 */
export function emailShortDateTime(at: Date, timeZone: EmailTimeZone): string {
  return `${date(at, timeZone, "short")}, ${clock(at, timeZone)}`;
}

/** Whether two instants fall on the same calendar day for the reader. */
export function emailSameDay(a: Date, b: Date, timeZone: EmailTimeZone): boolean {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneOf(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return day.format(a) === day.format(b);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "1 day", "30 days". */
export function emailCount(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * How long is left, in the unit a reader would use: minutes under two hours,
 * hours under three days, days after that ("15 minutes", "48 hours", "30
 * days"). `null` once the time has passed.
 */
export function emailDuration(from: Date, to: Date): string | null {
  const left = to.getTime() - from.getTime();
  if (left <= 0) return null;
  if (left < 2 * HOUR) return emailCount(Math.max(1, Math.round(left / MINUTE)), "minute");
  if (left < 3 * DAY) return emailCount(Math.round(left / HOUR), "hour");
  return emailCount(Math.round(left / DAY), "day");
}

/** Whole days left, rounded; 0 once the time has passed. */
export function emailDaysLeft(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY));
}
