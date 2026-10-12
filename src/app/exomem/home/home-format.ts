// How Home writes numbers, sizes and times. Every value is formatted when the page
// renders, in the reader's time zone (the browser's, unless a test passes one).
// The formats are the Home board's: en-GB dates ("31 October", "13 Oct, 14:20") and
// its "2 minutes ago" wording.

const LOCALE = "en-GB";

export type Clock = {
  /** The reader's current time, in ms. */
  now: number;
  /** An IANA zone; undefined means the browser's own. */
  timeZone?: string;
};

function format(iso: string, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone }).format(new Date(iso));
}

/** "31 October" */
export function dayMonth(iso: string, timeZone?: string): string {
  return format(iso, { day: "numeric", month: "long" }, timeZone);
}

/** "13 October at 14:20" */
export function dayMonthTime(iso: string, timeZone?: string): string {
  return format(
    iso,
    { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" },
    timeZone
  );
}

/** "13 Oct, 14:20" */
export function shortDateTime(iso: string, timeZone?: string): string {
  return format(
    iso,
    { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
    timeZone
  );
}

/** "11,402" */
export function count(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** Bytes as decimal gigabytes with one decimal at most: "1.2", "10.7". */
export function gigabytes(bytes: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(bytes / 1e9);
}

/** The status line's wording: "just now", "2 minutes ago", "3 h ago". */
export function ago(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** The live line's wording: "12 s ago" for the last minute, then as `ago`. */
export function secondsAgo(iso: string, now: number): string {
  const seconds = Math.floor(Math.max(0, now - Date.parse(iso)) / 1000);
  return seconds < 60 ? `${seconds} s ago` : ago(iso, now);
}
