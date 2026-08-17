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

export type HomeSection = "connect" | "capture" | "account";

export function homeSections(): HomeSection[] {
  // Connect is unconditionally first. There is no server-side signal for "this
  // person has already connected an assistant", so rather than guess and demote
  // it wrongly, the section stays compact enough to sit above capture
  // permanently.
  return ["connect", "capture", "account"];
}

export type ConnectClient = "claude" | "chatgpt" | "codex";

export type ConnectStep = {
  client: ConnectClient;
  /** A one-click marketplace install exists for this client right now. */
  oneClick: boolean;
};

/**
 * Every supported client, always, each with manual steps when no one-click
 * install is available for it.
 *
 * The first version of this returned install actions plus a single fallback
 * headed "Codex, or any other MCP client". That was a dead end for the people
 * it mattered most to. Install actions come from `loadOwnerInstallActions`,
 * which requires a *live* client artifact whose contract, compatibility,
 * package and archive digests all match the currently promoted candidate — a
 * release-pipeline fact, not a tenant fact, and one that is false for both
 * platforms until a promotion window has run. So the common case for a newly
 * invited person is zero install actions, and the only instruction on their
 * screen would have been headed "Codex" no matter which assistant they use.
 *
 * Hence: never fewer than three named paths, and the one-click install is an
 * upgrade to a client's card rather than the precondition for having one.
 */
export function connectSteps(installPlatforms: readonly ("claude" | "openai")[]): ConnectStep[] {
  return [
    { client: "claude", oneClick: installPlatforms.includes("claude") },
    { client: "chatgpt", oneClick: installPlatforms.includes("openai") },
    // Codex is CLI-only and has no marketplace action to promote, so its card
    // is always the manual one.
    { client: "codex", oneClick: false },
  ];
}
