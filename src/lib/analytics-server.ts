import { PostHog } from "posthog-node";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** Upper bound on how long a capture may delay the response it is observing. */
const FLUSH_TIMEOUT_MS = 800;

/**
 * Server-side capture for events the browser cannot be trusted to report.
 *
 * The installer download is the motivating case: /download 302s to GitHub, so a
 * client-side click races the page teardown and can be dropped before it
 * flushes. The server sees every request that actually resolved.
 *
 * No-ops without a key, matching the client provider.
 */
let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Serverless: send immediately rather than batching against a background
      // timer that the function freeze would strand.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

/**
 * The distinct_id posthog-js persists, so a server event joins the same person
 * as that visitor's browser events instead of creating a second identity.
 *
 * Reads the Cookie header rather than NextRequest.cookies so this works for any
 * Request — route handlers, tests, and future non-Next callers alike.
 *
 * posthog-js stores `ph_<project key>_posthog` as URL-encoded JSON. Returns null
 * when absent: a first-touch visitor with no cookie yet, or a blocked SDK.
 */
export function distinctIdFromRequest(req: Request): string | null {
  if (!POSTHOG_KEY) return null;

  const header = req.headers.get("cookie");
  if (!header) return null;

  const name = `ph_${POSTHOG_KEY}_posthog`;
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return null;

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match.slice(name.length + 1)));
    if (parsed && typeof parsed === "object" && "distinct_id" in parsed) {
      const id = (parsed as { distinct_id: unknown }).distinct_id;
      return typeof id === "string" && id.length > 0 ? id : null;
    }
  } catch {
    // Malformed or rotated cookie: the event is still worth recording, just
    // without an identity to join it to.
  }
  return null;
}

/**
 * Capture and flush before returning.
 *
 * Awaited rather than deferred: `after()` needs a request scope, and a
 * fire-and-forget promise can be stranded by a serverless freeze — both would
 * silently drop the download event, which is the one number this exists to
 * measure. The flush is raced against FLUSH_TIMEOUT_MS so a slow or failing
 * PostHog can never hold up the user's download.
 */
export async function captureServer(params: {
  event: string;
  distinctId: string | null;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const posthog = getClient();
  if (!posthog) return;

  try {
    posthog.capture({
      // Without a cookie there is no person to attach to; a stable synthetic id
      // keeps these events countable without inventing a fake visitor identity.
      distinctId: params.distinctId ?? "anonymous_server_event",
      event: params.event,
      properties: {
        ...params.properties,
        // Marks events that could not be joined to a browser session, so they
        // can be excluded from funnels rather than skewing them.
        server_side: true,
        identity_resolved: params.distinctId !== null,
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      posthog.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch (err) {
    // Analytics must never break the request it is observing.
    console.error("[analytics-server] capture_failed", {
      event: params.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
