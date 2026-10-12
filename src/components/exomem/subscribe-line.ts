// The subscribe step's line (Journey board, "subscribe"): the price Paddle previews for
// checkout when it is known, else a promise that Paddle shows it. Home's subscribe view
// and the journey's subscribe step both read it from here.

import { formatMoney } from "@/lib/exomem/money";
import type { PaddlePricePreview } from "@/lib/paddle";

/** "€10 a month", as the board writes it: Paddle's total and its billing cycle. */
function subscribePrice(price: PaddlePricePreview): string {
  const cycle = price.billingCycle;
  const cadence = !cycle
    ? ""
    : cycle.frequency === 1
      ? ` a ${cycle.interval}`
      : ` every ${cycle.frequency} ${cycle.interval}s`;
  return `${formatMoney(price.total)}${cadence}`;
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
