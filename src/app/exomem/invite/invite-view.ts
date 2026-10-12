// What the invitation page shows from POST /api/exomem/access/inspect: who invited the
// person, their note, and the price panel (Journey board, "invite" and "inviteexisting").
// Every price comes from Paddle's preview in the answer; an unknown price says so in words.

import type { InvitationInspection, InvitationPrice } from "@/lib/exomem-hosted/invites";
import { formatMoney } from "@/lib/exomem/money";
import { inviteCopy } from "../_journey/copy";

export type PricePanel = {
  label: string;
  main: string;
  /** The usual price, struck through, beside a friend price. */
  was: string | null;
  note: string;
};

/**
 * A friend price whose amount only checkout knows (Journey board, "Shown at checkout"). True
 * without a preview, because checkout always applies the friend offer.
 */
export function friendCheckoutPanel(by: string): PricePanel {
  return {
    label: inviteCopy.price.friend(by),
    main: inviteCopy.price.atCheckout,
    was: null,
    note: inviteCopy.price.exactAtCheckout,
  };
}

/** The person who sent a friend or covered invitation; an operator's has none. */
export function inviterOf(inspection: InvitationInspection): string | null {
  return inspection.kind === "standard" ? null : (inspection.inviter?.name ?? null);
}

/** The prices, which the answer carries for a new person and for the owner signed in here. */
function priceOf(inspection: InvitationInspection): InvitationPrice | null {
  return "price" in inspection ? inspection.price : null;
}

/** Whether an existing owner may take the friend price: Paddle previewed it for their plan. */
export function friendPriceOffered(inspection: InvitationInspection): boolean {
  if (inspection.kind !== "friend" || !inviterOf(inspection)) return false;
  return priceOf(inspection)?.value?.friend.value != null;
}

/**
 * Paddle did not answer, so the page cannot tell whether the friend price fits the plan.
 * A failed preview is neither an offer nor a refusal.
 */
export function friendPriceUnchecked(inspection: InvitationInspection): boolean {
  const price = priceOf(inspection);
  return (
    inspection.kind === "friend" &&
    inviterOf(inspection) !== null &&
    price !== null &&
    price.value === null &&
    price.reason === "price_unavailable"
  );
}

/** The price panel, or null when the invitation carries no price to show. */
export function pricePanel(inspection: InvitationInspection): PricePanel | null {
  const by = inviterOf(inspection);
  const price = priceOf(inspection);
  if (!by || !price) return null;
  if (inspection.kind === "covered") {
    // An owner's plan is their own: a covered invitation does not change it.
    if (inspection.status === "existing") return null;
    return {
      label: inviteCopy.price.covered(by),
      main: inviteCopy.price.nothingToPay,
      was: null,
      note: inviteCopy.price.whileCovered,
    };
  }
  const friend = price.value?.friend.value ?? null;
  if (friend && price.value) {
    return {
      label: inviteCopy.price.friend(by),
      main: inviteCopy.price.perMonth(formatMoney(friend)),
      was: formatMoney(price.value.usual),
      note: inviteCopy.price.whileSubscribed,
    };
  }
  // An existing owner has no checkout to show the amount at.
  if (inspection.status === "existing") return null;
  return friendCheckoutPanel(by);
}
