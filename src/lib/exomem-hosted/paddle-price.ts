import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { loadExomemPaddleConfig, type ExomemPaddleConfig } from "./paddle-config";

/**
 * What Paddle charges for the configured Exomem Cloud price, formatted for
 * display. Pages render a copy without a number when this is null.
 */
export type ExomemCloudPrice = Readonly<{
  /** The amount and cadence, for example "€10 per month". */
  summary: string;
  /** "including tax" or "plus tax"; null when the price defers to the account setting. */
  tax: string | null;
}>;

// The price changes only when the operator edits it in Paddle, so a few
// minutes of staleness is acceptable and saves a Paddle call per page render.
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
// The pages await this call while rendering; a hung Paddle must not hang them.
const PRICE_REQUEST_TIMEOUT_MS = 3000;
// The page copy is English, and the server formats once so the client
// hydrates the same string it was sent.
const PRICE_LOCALE = "en";
// Paddle documents billing_cycle.interval as exactly these four values.
const BILLING_INTERVALS = new Set(["day", "week", "month", "year"]);

let cachedPrice: { key: string; price: ExomemCloudPrice; expiresAt: number } | null = null;

type PriceFailure =
  | "configuration_invalid"
  | "unconfigured"
  | "request_failed"
  | "response_rejected"
  | "response_invalid";

function logUnavailable(reason: PriceFailure): null {
  console.error({ event: "exomem_paddle_price_unavailable", reason });
  return null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatAmount(minorUnits: string, currency: string): string {
  const formatter = new Intl.NumberFormat(PRICE_LOCALE, {
    style: "currency",
    currency,
    trailingZeroDisplay: "stripIfInteger",
  });
  // Paddle amounts are in the currency's lowest denomination; Intl resolves
  // that currency's ISO 4217 minor-unit digits.
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new RangeError("currency digits unresolved");
  return formatter.format(Number(minorUnits) / 10 ** digits);
}

function formatCadence(billingCycle: unknown): string | null | undefined {
  if (billingCycle === null) return null;
  const cycle = safeObject(billingCycle);
  const interval = cycle?.interval;
  const frequency = cycle?.frequency;
  if (
    typeof interval !== "string" ||
    !BILLING_INTERVALS.has(interval) ||
    typeof frequency !== "number" ||
    !Number.isInteger(frequency) ||
    frequency < 1
  ) {
    return undefined;
  }
  return frequency === 1 ? `per ${interval}` : `every ${frequency} ${interval}s`;
}

function formatTax(taxMode: unknown): string | null {
  if (taxMode === "internal") return "including tax";
  if (taxMode === "external") return "plus tax";
  // "account_setting" defers to an account default that the price does not state.
  return null;
}

function parsePrice(payload: unknown, priceId: string): ExomemCloudPrice | null {
  const data = safeObject(safeObject(payload)?.data);
  const unitPrice = safeObject(data?.unit_price);
  const amount = unitPrice?.amount;
  const currency = unitPrice?.currency_code;
  if (
    data?.id !== priceId ||
    data.status !== "active" ||
    typeof amount !== "string" ||
    !/^\d+$/.test(amount) ||
    typeof currency !== "string"
  ) {
    return null;
  }
  const cadence = formatCadence(data.billing_cycle ?? null);
  if (cadence === undefined) return null;
  let formattedAmount: string;
  try {
    formattedAmount = formatAmount(amount, currency);
  } catch {
    // Intl rejects a malformed currency code.
    return null;
  }
  return {
    summary: cadence ? `${formattedAmount} ${cadence}` : formattedAmount,
    tax: formatTax(data.tax_mode),
  };
}

/**
 * Reads the configured Exomem Cloud price from Paddle. Returns null, and logs
 * why, whenever Paddle cannot answer; callers then show no number at all.
 */
export async function loadExomemCloudPrice(): Promise<ExomemCloudPrice | null> {
  let config: ExomemPaddleConfig;
  try {
    config = loadExomemPaddleConfig();
  } catch {
    return logUnavailable("configuration_invalid");
  }
  if (!config.priceId || !config.apiKey) return logUnavailable("unconfigured");

  const now = Date.now();
  const key = `${config.environment}:${config.priceId}`;
  if (cachedPrice && cachedPrice.key === key && cachedPrice.expiresAt > now) {
    return cachedPrice.price;
  }

  let response: Response;
  try {
    response = await paddleFetch(`/prices/${encodeURIComponent(config.priceId)}`, {
      method: "GET",
      signal: AbortSignal.timeout(PRICE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return logUnavailable("request_failed");
  }
  if (!response.ok) {
    // Consume and discard. Provider bodies are not useful on a public page.
    await response.arrayBuffer().catch(() => undefined);
    return logUnavailable("response_rejected");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return logUnavailable("response_invalid");
  }
  const price = parsePrice(payload, config.priceId);
  if (!price) return logUnavailable("response_invalid");
  cachedPrice = { key, price, expiresAt: now + PRICE_CACHE_TTL_MS };
  return price;
}
