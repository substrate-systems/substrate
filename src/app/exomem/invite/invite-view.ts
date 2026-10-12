// What the invitation page shows from POST /api/exomem/access/inspect: who invited the
// person, their note, and the price panel (Journey board, "invite" and "inviteexisting").
// Every price comes from Paddle's preview in the answer; an unknown price says so in words.

import type { InvitationInspection } from "@/lib/exomem-hosted/invites";
import { formatMoney } from "@/lib/exomem/money";
import { inviteCopy } from "../_journey/copy";

export type PricePanel = {
  label: string;
  main: string;
  /** The usual price, struck through, beside a friend price. */
  was: string | null;
  note: string;
};

/** The person who sent a friend or covered invitation; an operator's has none. */
export function inviterOf(inspection: InvitationInspection): string | null {
  return inspection.kind === "standard" ? null : (inspection.inviter?.name ?? null);
}

/** Whether an existing owner may take the friend price, as far as the answer can say. */
export function friendPriceOffered(inspection: InvitationInspection): boolean {
  if (inspection.kind !== "friend" || !inviterOf(inspection)) return false;
  const price = inspection.price;
  // Paddle did not answer: the decision checks the plan itself.
  if (price.value === null) return price.reason === "price_unavailable";
  return price.value.friend.value !== null;
}

/** The price panel, or null when the invitation carries no price to show. */
export function pricePanel(inspection: InvitationInspection): PricePanel | null {
  const by = inviterOf(inspection);
  if (!by) return null;
  const { price } = inspection;
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
  return {
    label: inviteCopy.price.friend(by),
    main: inviteCopy.price.atCheckout,
    was: null,
    note: inviteCopy.price.exactAtCheckout,
  };
}
