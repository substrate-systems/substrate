import type { HomeActivity } from "./home-api";

export type ActivityEvent = Extract<HomeActivity, { state: "live" }>["events"][number];

export function activityEventKey(event: ActivityEvent): string {
  return `${event.at}|${event.app_id ?? ""}|${event.client}|${event.action}|${event.items}`;
}

/** Initial history stays quiet; later observations may animate once. */
export function createActivityObserver() {
  let through: number | null = null;
  const seen = new Set<string>();
  return (feed: HomeActivity): ActivityEvent | null => {
    if (feed.state !== "live") return null;
    const first = through === null;
    const newest = feed.events[0];
    const at = Date.parse(newest?.at ?? feed.as_of);
    if (!Number.isFinite(at)) return null;
    if (through === null || at > through) {
      through = at;
      seen.clear();
    }
    const fresh = newest && at >= through && !seen.has(activityEventKey(newest));
    // Keep equal-time observations when a late poll returns an older or smaller feed.
    for (const event of feed.events)
      if (Date.parse(event.at) >= through) seen.add(activityEventKey(event));
    return first || !fresh ? null : newest;
  };
}
