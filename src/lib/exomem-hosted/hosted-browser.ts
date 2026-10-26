export type HostedErrorBody = {
  code: string;
  message: string;
  retryable?: boolean;
  requestId?: string;
  remediation?: string;
  limit?: unknown;
};

export class HostedBrowserError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  // The cell computes a remediation for refusals a person can act on. It was
  // being dropped here, so a fixable refusal read as an unexplained failure.
  readonly remediation?: string;
  readonly limit?: unknown;

  constructor(error: HostedErrorBody, status: number) {
    super(error.message || "That did not work. Please try again.");
    this.name = "HostedBrowserError";
    this.code = error.code || "REQUEST_FAILED";
    this.retryable = Boolean(error.retryable);
    this.status = status;
    if (error.remediation) this.remediation = error.remediation;
    if (error.limit) this.limit = error.limit;
  }
}

function errorFrom(value: unknown): HostedErrorBody {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    const nested = body.error;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const error = nested as Record<string, unknown>;
      return {
        code: typeof error.code === "string" ? error.code : "REQUEST_FAILED",
        message:
          typeof error.message === "string"
            ? error.message
            : "That did not work. Please try again.",
        retryable: error.retryable === true,
        requestId: typeof error.requestId === "string" ? error.requestId : undefined,
        remediation: typeof error.remediation === "string" ? error.remediation : undefined,
        limit: error.limit,
      };
    }
  }
  return { code: "REQUEST_FAILED", message: "That did not work. Please try again." };
}

async function decodeResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new HostedBrowserError(errorFrom(body), response.status);
  }
  return body as Record<string, unknown>;
}

export async function postPublicJson(
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  return decodeResponse(response);
}

export function browserCookie(cookieName: string): string {
  for (const part of (document.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export function csrfCookie(): string {
  return browserCookie("exomem_csrf");
}

export async function postPrivateJson(
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "PUT" = "POST",
  options: { csrfToken?: string; signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Record<string, unknown>> {
  const csrf = options.csrfToken === undefined ? csrfCookie() : options.csrfToken;
  const response = await (options.fetcher ?? fetch)(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-exomem-csrf": csrf,
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return decodeResponse(response);
}

export async function getPrivateJson(
  path: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const response = await fetcher(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return decodeResponse(response);
}

export function takeFragmentToken(): string | null {
  const token = window.location.hash.slice(1).trim();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return token || null;
}

// A settled checkout sends the browser to Home, or to the consent page of a live
// OAuth transaction (billing/checkout/route.ts). Any other target is refused, so a
// server bug cannot turn the response into a redirect off this origin.
export function settledCheckoutDestination(response: Record<string, unknown>): string | null {
  if (
    response.success !== true ||
    response.state !== "settled" ||
    typeof response.redirectUrl !== "string"
  ) {
    return null;
  }
  const base = "https://origin.invalid";
  let destination: URL;
  try {
    destination = new URL(response.redirectUrl, base);
  } catch {
    return null;
  }
  if (destination.origin !== base || destination.hash) return null;
  const query = [...destination.searchParams.keys()];
  if (destination.pathname === "/exomem/home" && query.length === 0) return "/exomem/home";
  if (
    destination.pathname === "/exomem/authorize" &&
    query.length === 1 &&
    query[0] === "confirmation"
  ) {
    return `${destination.pathname}${destination.search}`;
  }
  return null;
}

export function friendlyHostedError(error: unknown): string {
  if (!(error instanceof HostedBrowserError)) {
    return "Something went wrong. Please try again.";
  }
  if (error.code === "EXOMEM_SESSION_INVALID") return "Your sign-in has expired.";
  if (error.code === "ACCESS_TOKEN_INVALID") {
    // Sign-in links last 15 minutes and work once, so this is nearly always one
    // of those two rather than anything the person did wrong. The bare cell
    // message ("the access link is invalid or unavailable") named neither cause
    // nor cure, which reads as a broken product rather than a stale link.
    return "That link has expired or was already used. Enter your email below for a new one.";
  }
  // Where the server said what would fix it, say that. The cases above are the
  // ones we can phrase better, because they are about the session rather than
  // about the request.
  if (error.remediation) return `${error.message} ${error.remediation}`;
  return error.message;
}
/** Cross-tab notification carries no identity or destination; the server checks both. */
export const EXOMEM_SIGN_IN_EVENT_KEY = "exomem-access-session";
