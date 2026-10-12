"use client";

/**
 * How long a web app's page shows the hand-back (connected, declined or kept)
 * before the browser goes back to the app. The design allows at most 3 seconds.
 */
const HANDBACK_MS = 2500;

/**
 * Sends an app on this computer its answer (a code, or access_denied) in the
 * background, so the page can stay and say what happened. Chrome's Local Network
 * Access can block a public page's request to a loopback address; a top-level
 * navigation is exempt, so a blocked request falls back to one.
 */
export async function tellLoopbackApp(redirectUrl: string): Promise<void> {
  try {
    await fetch(redirectUrl, { mode: "no-cors", credentials: "omit", cache: "no-store" });
  } catch {
    window.location.assign(redirectUrl);
  }
}

/** A web app gets its answer by a top-level navigation, after the page has shown it. */
export function returnToWebApp(redirectUrl: string): () => void {
  const timer = window.setTimeout(() => window.location.assign(redirectUrl), HANDBACK_MS);
  return () => window.clearTimeout(timer);
}
