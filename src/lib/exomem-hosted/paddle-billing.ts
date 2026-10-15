import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { recordExomemCheckoutTransaction } from "./db";
import {
  assertExomemPaddlePurpose,
  ExomemPaddleConfigurationError,
  loadExomemPaddleConfig,
  loadExomemPaddleTransactionConfig,
  type ExomemPaddleConfig,
} from "./paddle-config";
import { known, unknown, type Known } from "./known";
import {
  mapPaddleSubscriptionState,
  paddleExomemItem,
  paddleSubscriptionFacts,
  type PaddleSourceState,
} from "./paddle-webhook";
import { carriesFriendPrice } from "./paddle-friend-price";
import { LIVE_SUBSCRIPTION_SOURCE_STATES } from "./entitlements";
import {
  CURRENCY_CODE,
  isExomemMoney,
  MONEY_MINOR_UNITS,
  type ExomemMoney,
} from "@/lib/exomem/money";

export type PaddleTransport = (path: string, init?: RequestInit) => Promise<Response>;

export class ExomemBillingError extends Error {
  readonly code:
    | "EXOMEM_BILLING_INPUT_REJECTED"
    | "EXOMEM_PAID_CHECKOUT_DISABLED"
    | "EXOMEM_PADDLE_CONFIGURATION_INVALID"
    | "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
    | "EXOMEM_BILLING_STATE_CONFLICT"
    | "EXOMEM_TRANSACTION_NOT_OWNED"
    | "EXOMEM_PADDLE_UNAVAILABLE"
    | "EXOMEM_PADDLE_RESPONSE_INVALID"
    | "EXOMEM_FRIEND_DISCOUNT_INVALID";
  readonly status: number;
  readonly providerCode: string | null;
  readonly providerStatus: number | null;

  constructor(
    code: ExomemBillingError["code"],
    status: number,
    provider?: { code: string | null; status: number }
  ) {
    super(code);
    this.name = "ExomemBillingError";
    this.code = code;
    this.status = status;
    this.providerCode = provider?.code ?? null;
    this.providerStatus = provider?.status ?? null;
  }
}

type BillingDependencies = {
  config?: ExomemPaddleConfig;
  transport?: PaddleTransport;
  recordCheckoutTransaction?: typeof recordExomemCheckoutTransaction;
};

type CheckoutInput = {
  userId: string;
  tenantId: string;
};

/**
 * What the server attaches to a new checkout. Both come from stored data,
 * never from the request: `customerId` is the owner's existing Paddle
 * customer when they resubscribe, `friendPrice` is whether their tenant
 * accepted a friend offer.
 */
export type ExomemCheckoutOptions = {
  customerId?: string | null;
  friendPrice?: boolean;
};

type PortalInput = CheckoutInput & {
  customerId: string;
  subscriptionId?: string;
  environment: ExomemPaddleConfig["environment"];
};

type ResumeCheckoutInput = CheckoutInput & {
  transactionId: string;
  environment: ExomemPaddleConfig["environment"];
};

export type ExomemCheckoutState =
  | { state: "open"; checkoutUrl: string; priceId: string; discountId: string | null }
  | { state: "canceled" }
  | { state: "completed"; customerId: string | null; subscriptionId: string };

type InspectedExomemCheckoutState =
  | { state: "open"; checkoutUrl: string | null; priceId: string | null; discountId: string | null }
  | Exclude<ExomemCheckoutState, { state: "open" }>;

function assertExactInput(
  value: unknown,
  allowedKeys: readonly string[]
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExomemBillingError("EXOMEM_BILLING_INPUT_REJECTED", 400);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ExomemBillingError("EXOMEM_BILLING_INPUT_REJECTED", 400);
  }
  for (const key of allowedKeys.filter((key) => key !== "subscriptionId")) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 255) {
      throw new ExomemBillingError("EXOMEM_BILLING_INPUT_REJECTED", 400);
    }
  }
  const optionalSubscription = (value as Record<string, unknown>)["subscriptionId"];
  if (
    optionalSubscription !== undefined &&
    (typeof optionalSubscription !== "string" ||
      optionalSubscription.trim().length === 0 ||
      optionalSubscription.length > 255)
  ) {
    throw new ExomemBillingError("EXOMEM_BILLING_INPUT_REJECTED", 400);
  }
}

function safeConfigurationError(error: unknown): ExomemBillingError {
  if (error instanceof ExomemPaddleConfigurationError) {
    return new ExomemBillingError(error.code, 503);
  }
  return new ExomemBillingError("EXOMEM_PADDLE_CONFIGURATION_INVALID", 503);
}

/**
 * A Paddle API call whose failure says nothing about the provider's answer.
 * paddleFetch gives every call a deadline.
 */
async function safePaddleJson(
  transport: PaddleTransport,
  path: string,
  init: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await transport(path, init);
  } catch {
    throw new ExomemBillingError("EXOMEM_PADDLE_UNAVAILABLE", 503);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = safeObject(safeObject(body)?.error)?.code;
    // Check the code field format only; never retain a provider body or message.
    const providerCode =
      typeof code === "string" && code.length <= 80 && /^[a-z0-9_]+$/.test(code) ? code : null;
    throw new ExomemBillingError("EXOMEM_PADDLE_UNAVAILABLE", 502, {
      code: providerCode,
      status: response.status,
    });
  }
  try {
    return await response.json();
  } catch {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeTransactionCheckoutUrl(
  value: unknown,
  configuredUrl: string | null,
  transactionId: string
): string | null {
  if (typeof value !== "string" || !configuredUrl) return null;
  try {
    const candidate = new URL(value);
    const configured = new URL(configuredUrl);
    const query = [...candidate.searchParams];
    if (
      candidate.origin !== configured.origin ||
      candidate.pathname !== configured.pathname ||
      candidate.username ||
      candidate.password ||
      candidate.hash ||
      query.length !== 1 ||
      query[0][0] !== "_ptxn" ||
      query[0][1] !== transactionId
    ) {
      return null;
    }
    return candidate.toString();
  } catch {
    return null;
  }
}

function safePaddleId(
  value: unknown,
  prefix: "txn" | "sub" | "ctm" | "dsc" | "pri"
): string | null {
  return typeof value === "string" && new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value)
    ? value
    : null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A transport whose every call also ends at `deadline`, so a batch of Paddle
 * calls shares one time budget instead of each waiting its own timeout.
 */
export function paddleTransportUntil(
  deadline: AbortSignal,
  transport: PaddleTransport = paddleFetch
): PaddleTransport {
  return (path, init) =>
    transport(path, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
}

async function cancelUnboundTransaction(
  transactionId: string,
  transport: PaddleTransport
): Promise<void> {
  await safePaddleJson(transport, `/transactions/${encodeURIComponent(transactionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "canceled" }),
  });
}

/**
 * Checks the configured friend discount at Paddle before every use (a
 * friend checkout, a friend-price subscription update, a friend price
 * shown): active, recurring with no limit on intervals, no code, not
 * enabled for checkout, and restricted to exactly the base price. Returns
 * its id.
 *
 * Fails closed: any difference refuses the friend price outright. It
 * prevents a coupon anyone can type, a discount that lapses after some
 * renewals, and a discount that also reaches the storage price. When it
 * fires wrongly, friend checkouts and decisions fail until the operator
 * fixes the discount in Paddle; the invitee is not charged the wrong price.
 */
export async function verifyExomemFriendDiscount(
  config: ExomemPaddleConfig,
  transport: PaddleTransport = paddleFetch
): Promise<string> {
  const discountId = config.friendDiscountId;
  // A malformed id is refused before Paddle is asked.
  if (!discountId || !safePaddleId(discountId, "dsc") || !config.priceId) {
    throw new ExomemBillingError("EXOMEM_FRIEND_DISCOUNT_INVALID", 503);
  }
  const payload = await safePaddleJson(transport, `/discounts/${encodeURIComponent(discountId)}`, {
    method: "GET",
  });
  const discount = safeObject(safeObject(payload)?.data);
  const restrictTo = discount?.restrict_to;
  if (
    discount?.id !== discountId ||
    discount.status !== "active" ||
    discount.recur !== true ||
    discount.maximum_recurring_intervals !== null ||
    discount.code !== null ||
    discount.enabled_for_checkout !== false ||
    !Array.isArray(restrictTo) ||
    restrictTo.length !== 1 ||
    restrictTo[0] !== config.priceId
  ) {
    throw new ExomemBillingError("EXOMEM_FRIEND_DISCOUNT_INVALID", 503);
  }
  return discountId;
}

/** Server-selected catalogue terms; remove the legacy arm after every environment adopts the friend price. */
export async function selectExomemCheckoutPrice(
  friend: boolean,
  config: ExomemPaddleConfig = loadExomemPaddleConfig(),
  transport: PaddleTransport = paddleFetch
): Promise<{ priceId: string; discountId: string | null }> {
  if (!config.priceId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_CONFIGURATION_INVALID", 503);
  }
  if (friend && config.friendPriceId) {
    if (!safePaddleId(config.friendPriceId, "pri")) {
      throw new ExomemBillingError("EXOMEM_PADDLE_CONFIGURATION_INVALID", 503);
    }
    return { priceId: config.friendPriceId, discountId: null };
  }
  return {
    priceId: config.priceId,
    discountId: friend ? await verifyExomemFriendDiscount(config, transport) : null,
  };
}

/**
 * Creates the server-selected Paddle transaction and binds it to the owner
 * before its URL is returned. The friend discount and the customer come
 * only from `options`, which the caller reads from stored data.
 */
export async function createExomemCheckout(
  input: CheckoutInput,
  dependencies: BillingDependencies = {},
  options: ExomemCheckoutOptions = {}
): Promise<{ checkoutUrl: string; transactionId: string }> {
  assertExactInput(input, ["userId", "tenantId"]);
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "checkout");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  const transport = dependencies.transport ?? paddleFetch;
  const customerId = options.customerId ?? null;
  if (customerId !== null && !safePaddleId(customerId, "ctm")) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const { priceId, discountId } = await selectExomemCheckoutPrice(
    options.friendPrice === true,
    config,
    transport
  );

  const payload = await safePaddleJson(transport, "/transactions", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: priceId, quantity: 1 }],
      ...(discountId ? { discount_id: discountId } : {}),
      ...(customerId ? { customer_id: customerId } : {}),
      custom_data: {
        product_key: config.productKey,
        user_id: input.userId,
        tenant_id: input.tenantId,
      },
      collection_mode: "automatic",
      checkout: {
        url: config.checkoutUrl,
      },
    }),
  });
  const data = safeObject(safeObject(payload)?.data);
  const transactionId = safePaddleId(data?.id, "txn");
  const checkoutUrl = transactionId
    ? safeTransactionCheckoutUrl(safeObject(data?.checkout)?.url, config.checkoutUrl, transactionId)
    : null;
  if (!checkoutUrl || !transactionId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  // The transaction must carry exactly the discount the server chose; a
  // provider answer that dropped or swapped it is not sold.
  if ((data?.discount_id ?? null) !== discountId) {
    await cancelUnboundTransaction(transactionId, transport);
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  let recorded = false;
  let recordFailed = false;
  try {
    recorded = await (dependencies.recordCheckoutTransaction ?? recordExomemCheckoutTransaction)({
      userId: input.userId,
      tenantId: input.tenantId,
      transactionId,
      environment: config.environment,
    });
  } catch {
    recordFailed = true;
  }
  if (!recorded) {
    await cancelUnboundTransaction(transactionId, transport);
    if (recordFailed) throw new ExomemBillingError("EXOMEM_PADDLE_UNAVAILABLE", 503);
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  return { checkoutUrl, transactionId };
}

/**
 * Changes only the regular base item. Paddle keeps the renewal date, currency
 * and add-ons; do_not_bill leaves this period's payment unchanged.
 */
export async function applyExomemFriendPriceToSubscription(
  input: { subscriptionId: string; environment: ExomemPaddleConfig["environment"] },
  dependencies: BillingDependencies = {}
): Promise<{ nextBilledAt: string | null }> {
  if (!safePaddleId(input.subscriptionId, "sub")) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "portal");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  if (config.environment !== input.environment) {
    throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
  }
  const transport = dependencies.transport ?? paddleFetch;
  const path = `/subscriptions/${encodeURIComponent(input.subscriptionId)}`;
  const currentPayload = await safePaddleJson(transport, path, { method: "GET" });
  const current = safeObject(safeObject(currentPayload)?.data);
  const state = mapPaddleSubscriptionState(current?.status);
  if (
    !current ||
    current.id !== input.subscriptionId ||
    !state ||
    !(LIVE_SUBSCRIPTION_SOURCE_STATES as readonly string[]).includes(state)
  ) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const reference = paddleExomemItem(current, config.productId, [
    config.priceId,
    config.friendPriceId,
  ]);
  const facts = paddleSubscriptionFacts(current, reference);
  const priceId = reference?.priceId ?? null;
  if (carriesFriendPrice({ priceId, discountId: facts.discountId }, config)) {
    return { nextBilledAt: facts.nextBilledAt };
  }
  // Do not silently replace or stack another promotion; the invitation remains usable.
  if (facts.discountId !== null || !config.priceId || priceId !== config.priceId) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  if (config.friendPriceId) {
    const selected = await selectExomemCheckoutPrice(true, config, transport);
    const rawItems = Array.isArray(current.items) ? current.items : [];
    let baseItems = 0;
    const items = rawItems.map((raw) => {
      const item = safeObject(raw);
      const price = safeObject(item?.price);
      if (
        !safePaddleId(price?.id, "pri") ||
        !Number.isSafeInteger(item?.quantity) ||
        Number(item?.quantity) < 1
      ) {
        throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
      }
      const base = price?.id === config.priceId && price?.product_id === config.productId;
      if (base) baseItems++;
      return { price_id: base ? selected.priceId : price!.id, quantity: item!.quantity };
    });
    // A single base item prevents an ambiguous replacement from changing other items.
    if (baseItems !== 1) throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    const payload = await safePaddleJson(transport, path, {
      method: "PATCH",
      body: JSON.stringify({ items, proration_billing_mode: "do_not_bill" }),
    });
    const updated = safeObject(safeObject(payload)?.data);
    if (
      !updated ||
      updated.id !== input.subscriptionId ||
      paddleExomemItem(updated, config.productId, [selected.priceId])?.priceId !== selected.priceId
    ) {
      throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
    }
    return {
      nextBilledAt: paddleSubscriptionFacts(
        updated,
        paddleExomemItem(updated, config.productId, [selected.priceId])
      ).nextBilledAt,
    };
  }
  const discountId = await verifyExomemFriendDiscount(config, transport);
  const payload = await safePaddleJson(
    transport,
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        discount: { id: discountId, effective_from: "next_billing_period" },
      }),
    }
  );
  const data = safeObject(safeObject(payload)?.data);
  if (!data || data.id !== input.subscriptionId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  return { nextBilledAt: paddleSubscriptionFacts(data, null).nextBilledAt };
}

/**
 * A subscription as Paddle reports it now, read without storing anything:
 * its state, its discount and its next payment time.
 */
export async function readExomemSubscription(
  input: { subscriptionId: string; environment: ExomemPaddleConfig["environment"] },
  dependencies: BillingDependencies = {}
): Promise<{
  state: PaddleSourceState;
  priceId: string | null;
  discountId: string | null;
  nextBilledAt: string | null;
}> {
  if (!safePaddleId(input.subscriptionId, "sub")) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "reconciliation");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  if (config.environment !== input.environment) {
    throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
  }
  const payload = await safePaddleJson(
    dependencies.transport ?? paddleFetch,
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    { method: "GET" }
  );
  const data = safeObject(safeObject(payload)?.data);
  const state = mapPaddleSubscriptionState(data?.status);
  if (!data || data.id !== input.subscriptionId || !state) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  const facts = paddleSubscriptionFacts(data, null);
  return {
    state,
    priceId:
      paddleExomemItem(data, config.productId, [config.priceId, config.friendPriceId])?.priceId ??
      null,
    discountId: facts.discountId,
    nextBilledAt: facts.nextBilledAt,
  };
}

export type ExomemPrices = { usual: ExomemMoney; friend: ExomemMoney | null };

const PRICE_CACHE_MS = 10 * 60 * 1000;
const PRICE_CACHE_MAX_ENTRIES = 1_000;
const priceCache = new Map<string, { expiresAt: number; value: ExomemMoney }>();
const nextPaymentCache = new Map<
  string,
  { expiresAt: number; value: Known<ExomemMoney, "not_reported"> }
>();
// The account page waits this long at most for the next payment amount, and
// shows it as unknown when Paddle has not answered.
const NEXT_PAYMENT_TIMEOUT_MS = 3_000;
// When a shown friend price last passed the discount check. Only display
// reuses it; checkout and the subscription update check afresh.
const shownDiscountChecks = new Map<string, number>();

/** Test seam: empties the price preview cache. */
export function __clearExomemPriceCacheForTests(): void {
  priceCache.clear();
  nextPaymentCache.clear();
  shownDiscountChecks.clear();
}

async function previewOnePrice(
  input: { priceId: string; discountId: string | null; customerIp: string | null },
  transport: PaddleTransport
): Promise<ExomemMoney> {
  const payload = await safePaddleJson(transport, "/pricing-preview", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: input.priceId, quantity: 1 }],
      ...(input.discountId ? { discount_id: input.discountId } : {}),
      ...(input.customerIp ? { customer_ip_address: input.customerIp } : {}),
    }),
  });
  const data = safeObject(safeObject(payload)?.data);
  const lineItems = safeObject(data?.details)?.line_items;
  const line = Array.isArray(lineItems)
    ? lineItems.map(safeObject).find((item) => safeObject(item?.price)?.id === input.priceId)
    : undefined;
  const total = safeObject(line?.totals)?.total;
  const currencyCode = data?.currency_code;
  // A friend price is only a friend price if Paddle applied the discount to it.
  const discounted =
    input.discountId === null ||
    (Array.isArray(line?.discounts) &&
      line.discounts.some(
        (entry) => safeObject(safeObject(entry)?.discount)?.id === input.discountId
      ));
  if (
    typeof total !== "string" ||
    !MONEY_MINOR_UNITS.test(total) ||
    typeof currencyCode !== "string" ||
    !CURRENCY_CODE.test(currencyCode) ||
    !discounted
  ) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  return { amount: total, currencyCode };
}

async function cachedPrice(
  input: {
    country: string | null;
    priceId: string;
    discountId: string | null;
    customerIp: string | null;
  },
  transport: PaddleTransport,
  now: number
): Promise<ExomemMoney> {
  const key =
    input.country === null ? null : `${input.country}|${input.priceId}|${input.discountId ?? "-"}`;
  const hit = key ? priceCache.get(key) : undefined;
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await previewOnePrice(input, transport);
  if (key) {
    if (priceCache.size >= PRICE_CACHE_MAX_ENTRIES) priceCache.clear();
    priceCache.set(key, { expiresAt: now + PRICE_CACHE_MS, value });
  }
  return value;
}

/**
 * The usual price, and the friend price when asked, from Paddle's price
 * preview for the caller's network address. Each price is cached for 10
 * minutes per (country, price, discount); `country` is the platform's
 * geolocation of the caller, and without it nothing is cached. A failure
 * throws: the caller shows the price as unknown, never a guess.
 */
export async function previewExomemPrices(
  input: { country: string | null; customerIp: string | null; friend: boolean },
  dependencies: BillingDependencies & { now?: () => number } = {}
): Promise<ExomemPrices> {
  const config = dependencies.config ?? loadExomemPaddleConfig();
  if (!config.apiKey || !config.priceId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_CONFIGURATION_INVALID", 503);
  }
  const transport = dependencies.transport ?? paddleFetch;
  const now = (dependencies.now ?? Date.now)();
  const base = {
    country: input.country,
    priceId: config.priceId,
    customerIp: input.customerIp,
  };
  const usual = await cachedPrice({ ...base, discountId: null }, transport, now);
  if (!input.friend) return { usual, friend: null };
  if (config.friendPriceId) {
    const selected = await selectExomemCheckoutPrice(true, config, transport);
    const friend = await cachedPrice({ ...base, ...selected }, transport, now);
    return { usual, friend };
  }
  let discountId = config.friendDiscountId;
  if (!discountId || (shownDiscountChecks.get(discountId) ?? 0) <= now) {
    discountId = await verifyExomemFriendDiscount(config, transport);
    shownDiscountChecks.set(discountId, now + PRICE_CACHE_MS);
  }
  const friend = await cachedPrice({ ...base, discountId }, transport, now);
  return { usual, friend };
}

/**
 * The amount of a subscription's next payment, as Paddle previews that
 * transaction: its grand total in minor units, with discounts and tax, so a
 * friend price or an older price shows its own amount, never the base
 * price. `not_reported` when Paddle previews no next payment. Each answer
 * is cached 10 minutes per subscription and the last Paddle event applied to
 * it, so a stored change (a friend price, a new price, a scheduled
 * cancellation) is read afresh at once. A failure throws and is not cached.
 */
export async function readExomemNextPaymentAmount(
  input: {
    subscriptionId: string;
    environment: ExomemPaddleConfig["environment"];
    /**
     * The entitlement's `source_revision`, the id of the last applied Paddle event. Every
     * applied event changes it, even two events stamped in the same millisecond.
     */
    sourceRevision: string | null;
  },
  dependencies: BillingDependencies & { now?: () => number } = {}
): Promise<Known<ExomemMoney, "not_reported">> {
  if (!safePaddleId(input.subscriptionId, "sub")) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "reconciliation");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  if (config.environment !== input.environment) {
    throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
  }
  const now = (dependencies.now ?? Date.now)();
  const key = `${input.environment}|${input.subscriptionId}|${input.sourceRevision ?? ""}`;
  const hit = nextPaymentCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const payload = await safePaddleJson(
    dependencies.transport ?? paddleFetch,
    `/subscriptions/${encodeURIComponent(input.subscriptionId)}?include=next_transaction`,
    { method: "GET", signal: AbortSignal.timeout(NEXT_PAYMENT_TIMEOUT_MS) }
  );
  const data = safeObject(safeObject(payload)?.data);
  if (!data || data.id !== input.subscriptionId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  const totals = safeObject(safeObject(safeObject(data.next_transaction)?.details)?.totals);
  const money = {
    amount: totals?.grand_total,
    // Paddle bills a subscription's transactions in the subscription's currency.
    currencyCode: totals?.currency_code ?? data.currency_code,
  };
  const value: Known<ExomemMoney, "not_reported"> = isExomemMoney(money)
    ? known({ amount: money.amount, currencyCode: money.currencyCode })
    : unknown("not_reported");
  if (nextPaymentCache.size >= PRICE_CACHE_MAX_ENTRIES) nextPaymentCache.clear();
  nextPaymentCache.set(key, { expiresAt: now + PRICE_CACHE_MS, value });
  return value;
}

async function inspectExomemCheckout(
  input: ResumeCheckoutInput,
  dependencies: BillingDependencies,
  options: { purpose: "checkout" | "transaction" }
): Promise<InspectedExomemCheckoutState> {
  assertExactInput(input, ["userId", "tenantId", "transactionId", "environment"]);
  if (!safePaddleId(input.transactionId, "txn")) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  let config: ExomemPaddleConfig;
  try {
    config = dependencies.config ?? loadExomemPaddleTransactionConfig();
    // Exact terminal recovery needs only the stored environment and merchant
    // API. Current browser/catalog configuration is checked later only if the
    // transaction is still open.
    assertExomemPaddlePurpose(config, "transaction");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  if (config.environment !== input.environment) {
    throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
  }
  const payload = await safePaddleJson(
    dependencies.transport ?? paddleFetch,
    `/transactions/${encodeURIComponent(input.transactionId)}`,
    { method: "GET" }
  );
  const data = safeObject(safeObject(payload)?.data);
  if (data?.id !== input.transactionId) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  // A cancelled transaction cannot charge anyone, whoever Paddle names as
  // its owner, so its binding may go without the owner fields.
  if (data.status === "canceled") return { state: "canceled" };
  // The one proof that a transaction is not a checkout this owner opened:
  // Paddle reports all three correlation fields, and they name another
  // product, owner or tenant. Missing, partial or malformed fields prove
  // nothing, because the transaction can still charge the stored customer,
  // so they are unresolved like every other conflict below.
  const customData = safeObject(data.custom_data);
  const correlation = [customData?.product_key, customData?.user_id, customData?.tenant_id];
  if (!correlation.every((field) => typeof field === "string" && field.length > 0)) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  if (
    customData?.product_key !== config.productKey ||
    customData?.user_id !== input.userId ||
    customData?.tenant_id !== input.tenantId
  ) {
    throw new ExomemBillingError("EXOMEM_TRANSACTION_NOT_OWNED", 409);
  }
  if (data.status === "draft" || data.status === "ready") {
    let checkoutUrl: string | null = null;
    const items = Array.isArray(data.items) ? data.items : [];
    const actualPrice = safeObject(safeObject(items[0])?.price);
    const priceId = typeof actualPrice?.id === "string" ? actualPrice.id : null;
    if (options.purpose === "checkout") {
      let checkoutConfig: ExomemPaddleConfig;
      try {
        checkoutConfig = dependencies.config ?? loadExomemPaddleConfig();
        assertExomemPaddlePurpose(checkoutConfig, "checkout");
      } catch (error) {
        throw safeConfigurationError(error);
      }
      if (checkoutConfig.environment !== input.environment) {
        throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
      }
      // Reuse checks the actual price later; catalogue rotation must still allow cancellation.
      const catalogMatches =
        items.length === 1 &&
        priceId !== null &&
        actualPrice?.product_id === checkoutConfig.productId;
      checkoutUrl = safeTransactionCheckoutUrl(
        safeObject(data.checkout)?.url,
        checkoutConfig.checkoutUrl,
        input.transactionId
      );
      if (!catalogMatches || !checkoutUrl) {
        throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
      }
    }
    const discountId = typeof data.discount_id === "string" ? data.discount_id : null;
    return { state: "open", checkoutUrl, priceId, discountId };
  }
  if (["completed", "billed", "paid", "past_due"].includes(String(data.status))) {
    const subscriptionId = safePaddleId(data.subscription_id, "sub");
    const customerId = data.customer_id ? safePaddleId(data.customer_id, "ctm") : null;
    if (!subscriptionId || (data.customer_id && !customerId)) {
      throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
    }
    return { state: "completed", customerId, subscriptionId };
  }
  throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
}

export async function resumeExomemCheckout(
  input: ResumeCheckoutInput,
  dependencies: BillingDependencies = {}
): Promise<ExomemCheckoutState> {
  const inspection = await inspectExomemCheckout(input, dependencies, { purpose: "checkout" });
  if (inspection.state === "open" && !inspection.checkoutUrl) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  return inspection as ExomemCheckoutState;
}

export async function cancelExomemCheckoutTransaction(
  input: ResumeCheckoutInput,
  dependencies: BillingDependencies = {}
): Promise<Exclude<ExomemCheckoutState, { state: "open" }> | { state: "canceled" }> {
  const inspection = await inspectExomemCheckout(input, dependencies, {
    purpose: "transaction",
  });
  if (inspection.state !== "open") return inspection;
  const payload = await safePaddleJson(
    dependencies.transport ?? paddleFetch,
    `/transactions/${encodeURIComponent(input.transactionId)}`,
    { method: "PATCH", body: JSON.stringify({ status: "canceled" }) }
  );
  const data = safeObject(safeObject(payload)?.data);
  if (data?.id !== input.transactionId || data.status !== "canceled") {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  return { state: "canceled" };
}

export async function createExomemCustomerPortal(
  input: PortalInput,
  dependencies: BillingDependencies = {}
): Promise<{ portalUrl: string }> {
  assertExactInput(input, ["userId", "tenantId", "customerId", "subscriptionId", "environment"]);
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "portal");
  } catch (error) {
    throw safeConfigurationError(error);
  }
  if (config.environment !== input.environment) {
    throw new ExomemBillingError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH", 503);
  }

  const body = input.subscriptionId ? { subscription_ids: [input.subscriptionId] } : {};
  const payload = await safePaddleJson(
    dependencies.transport ?? paddleFetch,
    `/customers/${encodeURIComponent(input.customerId)}/portal-sessions`,
    { method: "POST", body: JSON.stringify(body) }
  );
  const portalUrl = safeHttpsUrl(
    (
      payload as {
        data?: { urls?: { general?: { overview?: unknown } } };
      }
    )?.data?.urls?.general?.overview
  );
  if (!portalUrl) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  return { portalUrl };
}
