/**
 * A recipient's IANA time zone, as their browser reports it, or `null` when it
 * is absent or not a zone this runtime knows. Emails render their time limits
 * in this zone, and label them UTC when it is `null`.
 *
 * The zone list is the runtime's closed IANA set (`Intl.supportedValuesOf`).
 * Browsers and the runtime disagree on alias names (`Asia/Kolkata` against
 * `Asia/Calcutta`), so the value is first resolved through `Intl` to the
 * runtime's own name for that zone. `UTC` is an IANA zone that some runtimes
 * leave out of the list.
 */
let supportedZones: Set<string> | null = null;

export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-GB", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  supportedZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return resolved === "UTC" || supportedZones.has(resolved) ? resolved : null;
}
