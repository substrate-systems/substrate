// Which journey step the consent page opens on, from the server's consent view.
// Kept apart from the component because the choice is the part that matters: Connect
// is offered exactly in the steps the consent gate accepts (`consentStep`), and an
// app already connected is offered "Keep it as it is" instead of a second grant.
import type { ConsentStep } from "@/lib/exomem-hosted/consent-state";

export type ConsentScreen =
  | "expired"
  | "signedout"
  | "subscribe"
  | "connect"
  | "again"
  | "preparing"
  | "readonly"
  | "ended"
  | "paused"
  | "suspended";

export function consentScreen(
  view:
    | { step: "expired" }
    | { step: ConsentStep; alreadyConnected: boolean; cellStarting: boolean }
): ConsentScreen {
  switch (view.step) {
    case "expired":
      return "expired";
    case "sign-in":
      return "signedout";
    case "connect-read-only":
      return "readonly";
    case "connect":
      if (view.alreadyConnected) return "again";
      return view.cellStarting ? "preparing" : "connect";
    case "subscribe":
    case "ended":
    case "paused":
    case "suspended":
      return view.step;
  }
}

/** Steps where the app may connect now: the ones whose Connect the consent gate accepts. */
export function offersConnect(screen: ConsentScreen): boolean {
  return ["connect", "again", "preparing", "readonly"].includes(screen);
}
