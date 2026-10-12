import type { ExomemMoney } from "@/lib/exomem-hosted/paddle-billing";

/**
 * A price as Exomem shows it: "€10", or "€10.50" when the amount has cents.
 * The amount is Paddle's, in the currency's smallest unit; it has at most 12
 * digits, so it is exact as a number. Emails write it in en-GB; Home passes
 * the reader's locale.
 */
export function emailMoney(price: ExomemMoney, locale = "en-GB"): string {
  const fractionDigits =
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: price.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** fractionDigits;
  const minor = Number(price.amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currencyCode,
    minimumFractionDigits: minor % scale === 0 ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minor / scale);
}
