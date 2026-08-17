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

export type ConnectRoute = "claude-install" | "chatgpt-install" | "manual-url";

export function connectRoutes(installPlatforms: readonly ("claude" | "openai")[]): ConnectRoute[] {
  const routes: ConnectRoute[] = [];
  if (installPlatforms.includes("claude")) routes.push("claude-install");
  if (installPlatforms.includes("openai")) routes.push("chatgpt-install");
  // Always last, and always present: Codex has no marketplace install action,
  // and a one-click route can be absent while the cell is perfectly reachable —
  // the install actions are gated on a live artifact matching the promoted
  // contract digest, which is a release-pipeline fact, not a tenant fact. A
  // first run that offered nothing because a digest had not been promoted would
  // be the same dead end the consent page had.
  routes.push("manual-url");
  return routes;
}
