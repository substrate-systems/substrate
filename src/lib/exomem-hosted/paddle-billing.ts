import { paddleFetch } from "@/lib/hosted-backup/paddle-client";
import {
  assertExomemPaddlePurpose,
  ExomemPaddleConfigurationError,
  loadExomemPaddleConfig,
  type ExomemPaddleConfig,
} from "./paddle-config";

export type PaddleTransport = (path: string, init?: RequestInit) => Promise<Response>;

export class ExomemBillingError extends Error {
  readonly code:
    | "EXOMEM_BILLING_INPUT_REJECTED"
    | "EXOMEM_PAID_CHECKOUT_DISABLED"
    | "EXOMEM_PADDLE_CONFIGURATION_INVALID"
    | "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
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
};

type CheckoutInput = {
  userId: string;
  tenantId: string;
};

type PortalInput = CheckoutInput & {
  customerId: string;
  subscriptionId?: string;
};

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
    }),
  });
  const checkoutUrl = safeHttpsUrl(
    (payload as { data?: { checkout?: { url?: unknown } } })?.data?.checkout?.url
  );
  if (!checkoutUrl) {
    throw new ExomemBillingError("EXOMEM_PADDLE_RESPONSE_INVALID", 502);
  }
  return { checkoutUrl };
}

export async function createExomemCustomerPortal(
  input: PortalInput,
  dependencies: BillingDependencies = {}
): Promise<{ portalUrl: string }> {
  assertExactInput(input, ["userId", "tenantId", "customerId", "subscriptionId"]);
  const config = dependencies.config ?? loadExomemPaddleConfig();
  try {
    assertExomemPaddlePurpose(config, "portal");
  } catch (error) {
    throw safeConfigurationError(error);
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
