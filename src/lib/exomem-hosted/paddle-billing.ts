import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import { recordExomemCheckoutTransaction } from "./db";
import {
  assertExomemPaddlePurpose,
  ExomemPaddleConfigurationError,
  loadExomemPaddleConfig,
  loadExomemPaddleTransactionConfig,
  type ExomemPaddleConfig,
} from "./paddle-config";

export type PaddleTransport = (path: string, init?: RequestInit) => Promise<Response>;

export class ExomemBillingError extends Error {
  readonly code:
    | "EXOMEM_BILLING_INPUT_REJECTED"
    | "EXOMEM_PAID_CHECKOUT_DISABLED"
    | "EXOMEM_PADDLE_CONFIGURATION_INVALID"
    | "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
    | "EXOMEM_BILLING_STATE_CONFLICT"
    | "EXOMEM_PADDLE_UNAVAILABLE"
    | "EXOMEM_PADDLE_RESPONSE_INVALID";
  readonly status: number;

  constructor(code: ExomemBillingError["code"], status: number) {
    super(code);
    this.name = "ExomemBillingError";
    this.code = code;
    this.status = status;
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
  | { state: "open"; checkoutUrl: string }
  | { state: "canceled" }
  | { state: "completed"; customerId: string | null; subscriptionId: string };

type InspectedExomemCheckoutState =
  | { state: "open"; checkoutUrl: string | null }
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
    // Consume and discard. Provider bodies may contain identifiers or user data.
    await response.arrayBuffer().catch(() => undefined);
    throw new ExomemBillingError("EXOMEM_PADDLE_UNAVAILABLE", 502);
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

function safePaddleId(value: unknown, prefix: "txn" | "sub" | "ctm"): string | null {
  return typeof value === "string" && new RegExp(`^${prefix}_[a-z0-9]{26}$`).test(value)
    ? value
    : null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export async function createExomemCheckout(
  input: CheckoutInput,
  dependencies: BillingDependencies = {}
): Promise<{ checkoutUrl: string }> {
  assertExactInput(input, ["userId", "tenantId"]);
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "checkout");
  } catch (error) {
    throw safeConfigurationError(error);
  }

  const payload = await safePaddleJson(dependencies.transport ?? paddleFetch, "/transactions", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: config.priceId, quantity: 1 }],
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
  const transactionId = safePaddleId((payload as { data?: { id?: unknown } })?.data?.id, "txn");
  const checkoutUrl = transactionId
    ? safeTransactionCheckoutUrl(
        (payload as { data?: { checkout?: { url?: unknown } } })?.data?.checkout?.url,
        config.checkoutUrl,
        transactionId
      )
    : null;
  if (!checkoutUrl || !transactionId) {
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
    await cancelUnboundTransaction(transactionId, dependencies.transport ?? paddleFetch);
    if (recordFailed) throw new ExomemBillingError("EXOMEM_PADDLE_UNAVAILABLE", 503);
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  return { checkoutUrl };
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
  const customData = safeObject(data?.custom_data);
  if (
    data?.id !== input.transactionId ||
    customData?.product_key !== config.productKey ||
    customData?.user_id !== input.userId ||
    customData?.tenant_id !== input.tenantId
  ) {
    throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
  }
  if (data.status === "draft" || data.status === "ready") {
    let checkoutUrl: string | null = null;
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
      const items = Array.isArray(data.items) ? data.items : [];
      const catalogMatches = items.some((item) => {
        const price = safeObject(safeObject(item)?.price);
        return (
          price?.id === checkoutConfig.priceId && price?.product_id === checkoutConfig.productId
        );
      });
      checkoutUrl = safeTransactionCheckoutUrl(
        safeObject(data.checkout)?.url,
        checkoutConfig.checkoutUrl,
        input.transactionId
      );
      if (!catalogMatches || !checkoutUrl) {
        throw new ExomemBillingError("EXOMEM_BILLING_STATE_CONFLICT", 409);
      }
    }
    return { state: "open", checkoutUrl };
  }
  if (data.status === "canceled") return { state: "canceled" };
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
