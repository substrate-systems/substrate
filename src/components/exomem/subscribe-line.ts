// The subscribe step's line (Journey board, "subscribe"): the price Paddle previews for
// checkout when it is known, else a promise that Paddle shows it. Home's subscribe view
// and the journey's subscribe step both read it from here.

import type { PaddlePricePreview } from "@/lib/paddle";

/** "€10.00 per month, including tax": Paddle's total, its billing cycle and tax. */
function subscribePrice(price: PaddlePricePreview): string {
  const cycle = price.billingCycle;
  const cadence = !cycle
    ? ""
    : cycle.frequency === 1
      ? ` per ${cycle.interval}`
      : ` every ${cycle.frequency} ${cycle.interval}s`;
  return `${price.total}${cadence}${price.includesTax ? ", including tax" : ""}`;
}

/**
 * The whole line. `app` is the assistant that opened the flow, when one did; started on
 * the web, the line ends "Then add it to your assistant."
 */
export function subscribeLine(price: PaddlePricePreview | null, app?: string): string {
  const next = app ? `Then ${app} connects in one step.` : "Then add it to your assistant.";
  return price
    ? `${subscribePrice(price)}. Cancel any time through Paddle. ${next}`
    : `Paddle shows the price at checkout. ${next}`;
}
