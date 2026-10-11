// What the authenticated Exomem home offers, and in what order.
//
// Kept apart from the component for the same reason as `consent-audience.ts`:
// the ordering IS the defect. The first run used to open on a capture box and a
// search box, with "Connect with Claude" folded inside a collapsed "Files,
// status, and account" panel below them. Stripped of the assistant, that is a
// notes app with two fields, and it invites a comparison against Notion and
// Apple Notes that Exomem does not win — while the thing that makes it worth
// having, memory resident inside Claude and ChatGPT, is invisible.
//
// Expressing the decision as data lets it be asserted directly, without
// rendering, so what the tests pin cannot drift from what ships.
//
// The per-client list deliberately does NOT live here. It lives with the copy it
// belongs to, in `assistant-instructions.ts` (`CLIENT_GUIDES`), because an
// earlier split had one module naming three clients and the other five — a
// mismatch that silently decided a client got the manual path.

export type HomeSection = "connect" | "account";

export function homeSections(): HomeSection[] {
  // Connect is unconditionally first. Capture and search left the page: they
  // called routes that cannot reach a Cloud cell, so the assistant is the only
  // way in until the redesigned Home brings them back through the cell.
  return ["connect", "account"];
}
