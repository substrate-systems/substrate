// How the waiting step learns that an app connected (the change's design: "The web
// journey learns a connection by polling"). The first poll's server time is the
// baseline; an app whose last authorization is later than it joined while the page
// waited. A reconnect moves that time, so reconnecting counts. Comparing two server
// times keeps the browser's clock out of it.

export type ListedApp = {
  id: string;
  displayName: string;
  platform: string | null;
  /** The context the app's calls run in; its level is saved for this context. */
  context: "coding" | "conversation";
  lastAuthorizedAt: string;
};

/** The newest app authorized after `baseline`, or null while none has. */
export function joinedSince(baseline: string, apps: readonly ListedApp[]): ListedApp | null {
  const since = Date.parse(baseline);
  let newest: ListedApp | null = null;
  for (const app of apps) {
    const at = Date.parse(app.lastAuthorizedAt);
    if (at > since && (!newest || at > Date.parse(newest.lastAuthorizedAt))) newest = app;
  }
  return newest;
}

const FAST_MS = 3_000;
const FAST_FOR_MS = 10 * 60_000;
const SLOW_MS = 30_000;

/** Every 3 s for the first 10 minutes of waiting, then every 30 s, for as long as it waits. */
export function pollDelay(waitedMs: number): number {
  return waitedMs < FAST_FOR_MS ? FAST_MS : SLOW_MS;
}
