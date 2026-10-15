import type { ExomemPaddleConfig } from "./paddle-config";

/** Configured provider IDs recognize both regional friend prices and existing legacy subscriptions. */
export function carriesFriendPrice(
  facts: { priceId: string | null; discountId: string | null },
  config: Pick<ExomemPaddleConfig, "friendPriceId" | "friendDiscountId">
): boolean {
  return (
    (config.friendPriceId !== null && facts.priceId === config.friendPriceId) ||
    (config.friendDiscountId !== null && facts.discountId === config.friendDiscountId)
  );
}
