// A date as the board writes it, in the reader's own time zone. Kept apart from the
// journey's components so the rule can be checked without a browser.

import { useSyncExternalStore } from "react";
import type { Known } from "@/lib/exomem-hosted/known";
import { unknownDate } from "./copy";

const noChange = () => () => {};

/** "10 November", in the time zone of the browser that runs it. */
function dayMonth(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(new Date(iso));
}

/**
 * A date as the board writes it ("10 November"), in the reader's own time zone.
 * The server cannot know that zone, so it renders the date as not known yet, and the
 * browser writes the date once the page hydrates. Unknown is said in words.
 */
export function useReaderDate(date: Known<string>): string {
  return useSyncExternalStore(
    noChange,
    () => (date.value === null ? unknownDate : dayMonth(date.value)),
    () => unknownDate
  );
}
