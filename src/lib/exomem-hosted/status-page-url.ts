/**
 * Where Exomem's status page lives: `EXOMEM_STATUS_PAGE_URL`, an https address.
 * Configuration, because the page is a third party's and its address can change.
 * This is the one place that names the setting and its default. It imports nothing,
 * so Next pages, the email outbox and the gateway bundle can all use it.
 */

const DEFAULT_STATUS_PAGE_URL = "https://status.substratesystems.io";
// The address goes into every notice sentence and header, which are bounded (400 characters,
// 1,024 bytes); a longer one would crowd out the operator's summary or overflow the header.
const STATUS_PAGE_URL_MAX_CHARS = 200;

/**
 * The status page address: the configured one, else the default. Every "Status page" link
 * and every service notice uses it, so a person who hits an error always has somewhere to look.
 */
export function statusPageUrl(env: Record<string, string | undefined> = process.env): string {
  return configuredStatusPageUrl(env) ?? DEFAULT_STATUS_PAGE_URL;
}

function configuredStatusPageUrl(env: Record<string, string | undefined>): string | null {
  const value = env.EXOMEM_STATUS_PAGE_URL?.trim();
  if (!value) return null;
  if (value.length > STATUS_PAGE_URL_MAX_CHARS) return rejected("too_long");
  try {
    return new URL(value).protocol === "https:" ? value : rejected("not_https");
  } catch {
    return rejected("not_https");
  }
}

// Once per process: Home renders and every gateway request read the setting, so a line per read
// would flood the log. It names the setting and why, never the value, which may hold a token.
let warnedRejected = false;
function rejected(reason: "too_long" | "not_https"): null {
  if (!warnedRejected) {
    warnedRejected = true;
    console.warn({
      event: "exomem_status_page_url_rejected",
      setting: "EXOMEM_STATUS_PAGE_URL",
      reason,
    });
  }
  return null;
}
