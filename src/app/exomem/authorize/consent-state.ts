// The one next step the consent page offers, computed on the server from the
// visitor's session and entitlement.
//
// Connect is offered exactly when `canConnect` holds, which is the rule the consent
// gate (`attachExistingOwnerAuthorizationAtomic`) applies in SQL, so the page never
// shows a Connect button that the server refuses.
import { canConnect, hasConnectableEffectiveState } from "@/lib/exomem-hosted/entitlements";

export type ConsentStep =
  // No usable session: sign in, or use an invitation.
  | "sign-in"
  // Admitted, but the first payment has not settled.
  | "subscribe"
  | "connect"
  // A payment failed. Connect works and Exomem is read-only until billing is fixed.
  | "connect-read-only"
  // The subscription was cancelled. Exomem is read-only until it closes.
  | "ended"
  | "paused"
  | "suspended";

export type ConsentAccount = {
  effectiveState: string;
  sourceState: string;
};

export function consentStep(account: ConsentAccount | null): ConsentStep {
  // A deleted account has no session, and an unknown state is not one this page
  // can route. Both render the signed-out view, as a storage error does.
  if (!account) return "sign-in";
  if (canConnect(account)) {
    return account.effectiveState === "grace" ? "connect-read-only" : "connect";
  }
  // Connectable but for the first payment.
  if (hasConnectableEffectiveState(account.effectiveState)) return "subscribe";
  if (account.effectiveState === "cancelled") return "ended";
  if (account.effectiveState === "suspended") {
    // `paused` is Paddle's documented subscription status, and only the owner can
    // resume it in billing. Every other suspension is an operator decision.
    return account.sourceState === "paused" ? "paused" : "suspended";
  }
  return "sign-in";
}
