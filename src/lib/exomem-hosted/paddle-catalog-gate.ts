import type { ExomemPaddleConfig } from "./paddle-config";

export type ExomemPaddleCatalogTransport = (path: string, init?: RequestInit) => Promise<Response>;

export type ExomemPaddleCatalogGateResult =
  | { state: "disabled"; environment: ExomemPaddleConfig["environment"] }
  | {
      state: "verified";
      environment: ExomemPaddleConfig["environment"];
      productStatus: "active";
      priceStatus: "active";
      currency: "EUR";
      amount: "500";
      interval: "month";
      frequency: 1;
    };

export class ExomemPaddleCatalogGateError extends Error {
  readonly code: "EXOMEM_PADDLE_CATALOG_INVALID" | "EXOMEM_PADDLE_CATALOG_UNAVAILABLE";

  constructor(code: ExomemPaddleCatalogGateError["code"]) {
    super(code);
    this.name = "ExomemPaddleCatalogGateError";
    this.code = code;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readCatalogResource(
  path: string,
  transport: ExomemPaddleCatalogTransport
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await transport(path, { method: "GET" });
  } catch {
    throw new ExomemPaddleCatalogGateError("EXOMEM_PADDLE_CATALOG_UNAVAILABLE");
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new ExomemPaddleCatalogGateError("EXOMEM_PADDLE_CATALOG_UNAVAILABLE");
  }
  try {
    const payload = object(await response.json());
    const data = object(payload?.data);
    if (!data) throw new Error("invalid payload");
    return data;
  } catch (error) {
    if (error instanceof ExomemPaddleCatalogGateError) throw error;
    throw new ExomemPaddleCatalogGateError("EXOMEM_PADDLE_CATALOG_UNAVAILABLE");
  }
}

export async function verifyExomemPaddleCatalog(
  config: ExomemPaddleConfig,
  transport: ExomemPaddleCatalogTransport
): Promise<ExomemPaddleCatalogGateResult> {
  if (!config.priceId) return { state: "disabled", environment: config.environment };
  if (!config.productId || !config.apiKey) {
    throw new ExomemPaddleCatalogGateError("EXOMEM_PADDLE_CATALOG_INVALID");
  }

  const product = await readCatalogResource(
    `/products/${encodeURIComponent(config.productId)}`,
    transport
  );
  const price = await readCatalogResource(
    `/prices/${encodeURIComponent(config.priceId)}`,
    transport
  );
  const unitPrice = object(price.unit_price);
  const billingCycle = object(price.billing_cycle);

  if (
    product.status !== "active" ||
    price.status !== "active" ||
    price.product_id !== config.productId ||
    unitPrice?.currency_code !== "EUR" ||
    unitPrice.amount !== "500" ||
    billingCycle?.interval !== "month" ||
    billingCycle.frequency !== 1
  ) {
    throw new ExomemPaddleCatalogGateError("EXOMEM_PADDLE_CATALOG_INVALID");
  }

  return {
    state: "verified",
    environment: config.environment,
    productStatus: "active",
    priceStatus: "active",
    currency: "EUR",
    amount: "500",
    interval: "month",
    frequency: 1,
  };
}
