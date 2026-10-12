// Which step the web setup opens on, from the account's step (the shared consent
// rule) and its cell. "Your Exomem is ready" is only said once the cell is ready;
// until then the page shows its progress state and asks the server again.
import type { LifecycleStatus } from "@/lib/exomem-hosted/cloud-status";
import type { ConsentStep } from "@/lib/exomem-hosted/consent-state";

export type SetupScreen = "subscribe" | "preparing" | "choose" | "ended" | "paused" | "suspended";

/** Null: no account this page can show (it sends the visitor to sign in). */
export function setupScreen(step: ConsentStep, cell: LifecycleStatus["state"]): SetupScreen | null {
  switch (step) {
    case "sign-in":
      return null;
    case "connect":
    case "connect-read-only":
      return cell === "ready" ? "choose" : "preparing";
    case "subscribe":
    case "ended":
    case "paused":
    case "suspended":
      return step;
  }
}
