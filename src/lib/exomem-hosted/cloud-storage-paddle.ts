import { createHash } from "node:crypto";
import { z } from "zod";
import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { isExomemMoney, type ExomemMoney } from "@/lib/exomem/money";
import { ExomemBillingError, safePaddleJson, type PaddleTransport } from "./paddle-billing";
import { assertExomemPaddlePurpose, type ExomemPaddleConfig } from "./paddle-config";

// Paddle fixes these ID formats and billing intervals; they do not classify customer content.
const priceId = z.string().regex(/^pri_[a-z0-9]{26}$/);
const subscriptionId = z.string().regex(/^sub_[a-z0-9]{26}$/);
const cycle = z.object({
  interval: z.enum(["day", "week", "month", "year"]),
  frequency: z.number().int().positive(),
});
const item = z.object({ price: z.object({ id: priceId }), quantity: z.number().int().positive() });
const subscription = z.object({
  id: subscriptionId,
  customer_id: z.string(),
  status: z.string(),
  updated_at: z.iso.datetime({ offset: true }),
  currency_code: z.string(),
  billing_cycle: cycle,
  collection_mode: z.string(),
  scheduled_change: z.unknown(),
  custom_data: z.record(z.string(), z.unknown()).nullable(),
  items: z.array(item).min(1).max(100),
});
const catalogue = z.object({
  id: priceId,
  product_id: z.string(),
  status: z.string(),
  billing_cycle: cycle,
  trial_period: z.unknown(),
  tax_mode: z.string(),
  quantity: z.object({
    minimum: z.number().int().positive(),
    maximum: z.number().int().positive(),
  }),
  custom_data: z.object({
    exomem_storage_bytes: z.number().int().positive().safe(),
    exomem_storage_packs: z.array(z.number().int().positive()).min(1),
  }),
});

export type StorageItem = { price_id: string; quantity: number };
export type StorageSubscription = z.infer<typeof subscription>;
type StorageCatalogue = z.infer<typeof catalogue>;
export type StorageQuote = {
  due: ExomemMoney;
  recurring: ExomemMoney;
  tax: ExomemMoney;
  nextBilledAt: string | null;
  observedAt: string;
};

export type StoragePayment = { id: string; due: ExomemMoney; tax: ExomemMoney };

const invalid = () => new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
const conflict = () => new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function storageItems(value: StorageSubscription): StorageItem[] {
  return value.items.map(({ price, quantity }) => ({ price_id: price.id, quantity }));
}

export function sameStorageItems(left: StorageItem[], right: StorageItem[]): boolean {
  const stable = (items: StorageItem[]) =>
    JSON.stringify([...items].sort((a, b) => a.price_id.localeCompare(b.price_id)));
  return stable(left) === stable(right);
}

export function storageSubscriptionFingerprint(value: StorageSubscription): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function storageTransport(
  config: ExomemPaddleConfig,
  transport = paddleFetch
): PaddleTransport {
  assertExomemPaddlePurpose(config, "reconciliation");
  return transport;
}

export async function readStorageSubscription(
  id: string,
  transport: PaddleTransport
): Promise<StorageSubscription> {
  if (!subscriptionId.safeParse(id).success) throw conflict();
  const payload = await safePaddleJson(transport, `/subscriptions/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const result = subscription.safeParse(object(payload)?.data);
  if (
    !result.success ||
    result.data.id !== id ||
    new Set(result.data.items.map((x) => x.price.id)).size !== result.data.items.length
  )
    throw invalid();
  return result.data;
}

export async function readStorageCatalogue(
  id: string,
  transport: PaddleTransport
): Promise<StorageCatalogue> {
  if (!priceId.safeParse(id).success) throw conflict();
  const payload = await safePaddleJson(transport, `/prices/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const result = catalogue.safeParse(object(payload)?.data);
  if (
    !result.success ||
    result.data.id !== id ||
    result.data.status !== "active" ||
    result.data.trial_period !== null
  )
    throw invalid();
  const value = result.data;
  if (
    value.quantity.maximum < value.quantity.minimum ||
    new Set(value.custom_data.exomem_storage_packs).size !==
      value.custom_data.exomem_storage_packs.length
  )
    throw invalid();
  return value;
}

export function storageQuantities(current: StorageSubscription, price: StorageCatalogue): number[] {
  if (
    current.status !== "active" ||
    current.collection_mode !== "automatic" ||
    current.billing_cycle.interval !== price.billing_cycle.interval ||
    current.billing_cycle.frequency !== price.billing_cycle.frequency
  )
    throw conflict();
  const items = storageItems(current);
  const existing = items.find((x) => x.price_id === price.id);
  if (!existing && items.length >= 100) return [];
  return price.custom_data.exomem_storage_packs.filter((added) => {
    const quantity = (existing?.quantity ?? 0) + added;
    return (
      Number.isSafeInteger(quantity) &&
      quantity >= price.quantity.minimum &&
      quantity <= price.quantity.maximum
    );
  });
}

export function storageTargetItems(
  current: StorageSubscription,
  price: StorageCatalogue,
  added: number
): StorageItem[] {
  if (!storageQuantities(current, price).includes(added)) throw conflict();
  const items = storageItems(current);
  const existing = items.find((x) => x.price_id === price.id);
  const quantity = (existing?.quantity ?? 0) + added;
  return existing
    ? items.map((x) => (x.price_id === price.id ? { ...x, quantity } : x))
    : [...items, { price_id: price.id, quantity }];
}

function storageUpdateBody(items: StorageItem[], customData?: Record<string, unknown>) {
  return {
    items,
    proration_billing_mode: "prorated_immediately",
    on_payment_failure: "prevent_change",
    ...(customData ? { custom_data: customData } : {}),
  };
}

function money(amount: unknown, currency: unknown): ExomemMoney {
  const value = { amount, currencyCode: currency };
  if (!isExomemMoney(value)) throw invalid();
  return value;
}

export async function previewStorageChange(
  current: StorageSubscription,
  items: StorageItem[],
  transport: PaddleTransport
): Promise<StorageQuote> {
  const payload = await safePaddleJson(
    transport,
    `/subscriptions/${encodeURIComponent(current.id)}/preview`,
    {
      method: "PATCH",
      body: JSON.stringify(storageUpdateBody(items)),
    }
  );
  const data = object(object(payload)?.data);
  const immediate = object(object(data?.immediate_transaction)?.details);
  const totals = object(immediate?.totals);
  const recurring = object(object(data?.recurring_transaction_details)?.totals);
  const consent = data?.consent_requirements;
  if (
    !data ||
    !recurring ||
    !Array.isArray(consent) ||
    consent.length ||
    data.currency_code !== current.currency_code
  )
    throw invalid();
  // A null immediate transaction means no charge, as reported by the preview itself.
  const due =
    data.immediate_transaction === null
      ? money("0", current.currency_code)
      : money(totals?.grand_total, totals?.currency_code);
  return {
    due,
    tax:
      data.immediate_transaction === null
        ? money("0", current.currency_code)
        : money(totals?.tax, totals?.currency_code),
    recurring: money(recurring.grand_total, recurring.currency_code),
    nextBilledAt:
      typeof data.next_billed_at === "string" && Number.isFinite(Date.parse(data.next_billed_at))
        ? data.next_billed_at
        : null,
    observedAt: new Date().toISOString(),
  };
}

export async function updateStorageSubscription(
  current: StorageSubscription,
  items: StorageItem[],
  operationId: string,
  transport: PaddleTransport
): Promise<void> {
  await safePaddleJson(transport, `/subscriptions/${encodeURIComponent(current.id)}`, {
    method: "PATCH",
    // Paddle copies subscription custom data to upgrade transactions; preserve all existing bindings.
    body: JSON.stringify(
      storageUpdateBody(items, { ...current.custom_data, exomem_storage_operation: operationId })
    ),
  });
}

export async function findStoragePayment(
  current: StorageSubscription,
  operationId: string,
  storagePriceId: string,
  addedQuantity: number,
  since: string,
  transport: PaddleTransport
): Promise<StoragePayment | null> {
  let after: string | null = null;
  // The bounded window cannot grant from an incomplete read; a later poll can try again.
  for (let page = 0; page < 3; page += 1) {
    const query = new URLSearchParams({
      subscription_id: current.id,
      origin: "subscription_update",
      status: "completed",
      "created_at[GTE]": since,
      per_page: "30",
      order_by: "created_at[DESC]",
    });
    if (after) query.set("after", after);
    const payload = await safePaddleJson(transport, `/transactions?${query}`, { method: "GET" });
    const root = object(payload);
    if (!Array.isArray(root?.data)) throw invalid();
    for (const value of root.data) {
      const tx = object(value);
      if (
        tx?.subscription_id === current.id &&
        tx.customer_id === current.customer_id &&
        tx.origin === "subscription_update" &&
        tx.status === "completed" &&
        object(tx.custom_data)?.exomem_storage_operation === operationId &&
        typeof tx.id === "string"
      ) {
        const items = Array.isArray(tx.items) ? tx.items : [];
        const includesStorage = items.some((value) => {
          const item = object(value);
          return (
            object(item?.price)?.id === storagePriceId &&
            typeof item?.quantity === "number" &&
            item.quantity >= addedQuantity
          );
        });
        const totals = object(object(tx.details)?.totals);
        if (includesStorage && totals)
          return {
            id: tx.id,
            due: money(totals.grand_total, totals.currency_code),
            tax: money(totals.tax, totals.currency_code),
          };
      }
    }
    if (object(object(root?.meta)?.pagination)?.has_more === false) return null;
    const last = object(root.data.at(-1))?.id;
    if (typeof last !== "string" || last === after) throw invalid();
    after = last;
  }
  return null;
}

export async function storagePaymentMethodTransaction(
  current: StorageSubscription,
  transport: PaddleTransport
): Promise<string> {
  const payload = await safePaddleJson(
    transport,
    `/subscriptions/${encodeURIComponent(current.id)}/update-payment-method-transaction`,
    { method: "GET" }
  );
  const tx = object(object(payload)?.data);
  // This transaction updates a card; it is neither a new subscription nor proof of a storage payment.
  if (
    !tx ||
    tx.subscription_id !== current.id ||
    tx.customer_id !== current.customer_id ||
    tx.origin !== "subscription_payment_method_change" ||
    typeof tx.id !== "string"
  )
    throw invalid();
  return tx.id;
}

export async function storagePaymentMethodReady(
  current: StorageSubscription,
  id: string,
  transport: PaddleTransport
): Promise<boolean> {
  const payload = await safePaddleJson(transport, `/transactions/${encodeURIComponent(id)}`, {
    method: "GET",
  });
  const tx = object(object(payload)?.data);
  return (
    tx?.subscription_id === current.id &&
    tx.customer_id === current.customer_id &&
    tx.origin === "subscription_payment_method_change" &&
    tx.status === "completed"
  );
}
