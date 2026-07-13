import { parseExomemPublicBaseUrl } from "./public-origin";

export const EXOMEM_PADDLE_PRODUCT_KEY = "exomem-hosted" as const;

export type ExomemPaddleEnvironment = "sandbox" | "production";
export type ExomemPaddlePurpose =
  | "checkout"
  | "transaction"
  | "portal"
  | "reconciliation"
  | "webhook"
  | "client";

export type ExomemPaddleConfig = Readonly<{
  environment: ExomemPaddleEnvironment;
  apiBaseUrl: string;
  productKey: typeof EXOMEM_PADDLE_PRODUCT_KEY;
  productId: string | null;
  priceId: string | null;
  checkoutUrl: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
  clientToken: string | null;
  clientEnvironment: ExomemPaddleEnvironment | null;
  paidCheckoutEnabled: boolean;
}>;

export class ExomemPaddleConfigurationError extends Error {
  readonly code:
    | "EXOMEM_PADDLE_CONFIGURATION_INVALID"
    | "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
    | "EXOMEM_PAID_CHECKOUT_DISABLED";

  constructor(code: ExomemPaddleConfigurationError["code"]) {
    super(code);
    this.name = "ExomemPaddleConfigurationError";
    this.code = code;
  }
}

type EnvironmentSource = Record<string, string | undefined>;

function optionalValue(env: EnvironmentSource, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function checkoutUrl(env: EnvironmentSource): string | null {
  const configuredOrigin = optionalValue(env, "EXOMEM_PUBLIC_BASE_URL");
  if (!configuredOrigin) return null;
  const runtimeEnvironment = env.NODE_ENV;
  if (
    runtimeEnvironment !== undefined &&
    runtimeEnvironment !== "development" &&
    runtimeEnvironment !== "production" &&
    runtimeEnvironment !== "test"
  ) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }
  try {
    const origin = parseExomemPublicBaseUrl(configuredOrigin, runtimeEnvironment);
    return new URL("/exomem/home", `${origin}/`).toString();
  } catch {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }
}

function credentialEnvironment(value: string): ExomemPaddleEnvironment | null {
  if (value.startsWith("pdl_sdbx_") || value.startsWith("test_")) {
    return "sandbox";
  }
  if (value.startsWith("pdl_live_") || value.startsWith("live_")) {
    return "production";
  }
  return null;
}

function assertCredentialEnvironment(
  value: string | null,
  environment: ExomemPaddleEnvironment
): void {
  if (!value) return;
  const detected = credentialEnvironment(value);
  if (detected && detected !== environment) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH");
  }
}

function requiredPaddleEnvironment(env: EnvironmentSource): ExomemPaddleEnvironment {
  const rawEnvironment = optionalValue(env, "PADDLE_ENVIRONMENT");
  if (rawEnvironment !== "sandbox" && rawEnvironment !== "production") {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }
  return rawEnvironment;
}

function paddleApiBaseUrl(environment: ExomemPaddleEnvironment): string {
  return environment === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

/**
 * Reads one explicit Paddle environment. Nothing is validated at import time,
 * so an unconfigured Exomem catalog cannot affect the existing Endstate path.
 * Paddle calls still use the repo's shared `paddleFetch`; apiBaseUrl is exposed
 * for validation/observability without creating a second client.
 */
export function loadExomemPaddleConfig(env: EnvironmentSource = process.env): ExomemPaddleConfig {
  const environment = requiredPaddleEnvironment(env);
  const apiKey = optionalValue(env, "PADDLE_API_KEY");
  const webhookSecret = optionalValue(env, "PADDLE_WEBHOOK_SECRET");
  const clientToken = optionalValue(env, "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN");
  const rawClientEnvironment = optionalValue(env, "NEXT_PUBLIC_PADDLE_ENVIRONMENT");
  let clientEnvironment: ExomemPaddleEnvironment | null = null;
  if (rawClientEnvironment === "sandbox" || rawClientEnvironment === "production") {
    clientEnvironment = rawClientEnvironment;
  } else if (rawClientEnvironment !== null) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }
  const productId = optionalValue(env, "EXOMEM_PADDLE_PRODUCT_ID");
  const priceId = optionalValue(env, "EXOMEM_PADDLE_PRICE_ID");
  const checkoutReturnUrl = checkoutUrl(env);
  const catalogEnvironment = optionalValue(env, "EXOMEM_PADDLE_CATALOG_ENVIRONMENT");

  assertCredentialEnvironment(apiKey, environment);
  assertCredentialEnvironment(clientToken, environment);
  if (clientEnvironment && clientEnvironment !== environment) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH");
  }
  if (catalogEnvironment && catalogEnvironment !== environment) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_ENVIRONMENT_MISMATCH");
  }
  if (priceId && !productId) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }

  return {
    environment,
    apiBaseUrl: paddleApiBaseUrl(environment),
    productKey: EXOMEM_PADDLE_PRODUCT_KEY,
    productId,
    priceId,
    checkoutUrl: checkoutReturnUrl,
    apiKey,
    webhookSecret,
    clientToken,
    clientEnvironment,
    paidCheckoutEnabled: Boolean(
      productId && priceId && checkoutReturnUrl && clientToken && clientEnvironment === environment
    ),
  };
}

/**
 * Loads only the merchant API facts needed to inspect or cancel an exact,
 * already-bound Paddle transaction. Browser, return-origin, and sale-catalog
 * settings are deliberately ignored because they may rotate after checkout.
 */
export function loadExomemPaddleTransactionConfig(
  env: EnvironmentSource = process.env
): ExomemPaddleConfig {
  const environment = requiredPaddleEnvironment(env);
  const apiKey = optionalValue(env, "PADDLE_API_KEY");
  assertCredentialEnvironment(apiKey, environment);
  return {
    environment,
    apiBaseUrl: paddleApiBaseUrl(environment),
    productKey: EXOMEM_PADDLE_PRODUCT_KEY,
    productId: null,
    priceId: null,
    checkoutUrl: null,
    apiKey,
    webhookSecret: null,
    clientToken: null,
    clientEnvironment: null,
    paidCheckoutEnabled: false,
  };
}

export function assertExomemPaddlePurpose(
  config: ExomemPaddleConfig,
  purpose: ExomemPaddlePurpose
): void {
  if (purpose === "checkout") {
    if (!config.productId || !config.priceId) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PAID_CHECKOUT_DISABLED");
    }
    if (
      !config.apiKey ||
      !config.checkoutUrl ||
      !config.clientToken ||
      config.clientEnvironment !== config.environment
    ) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
    }
    return;
  }
  if (purpose === "transaction") {
    // Cleanup is bound to the exact stored transaction, owner, tenant, and
    // provider environment. It must remain available after new checkout is
    // disabled or the sale catalog rotates.
    if (!config.apiKey) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
    }
    return;
  }
  if (purpose === "portal") {
    if (!config.apiKey) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
    }
    return;
  }
  if (purpose === "reconciliation") {
    if (!config.apiKey || !config.productId) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
    }
    return;
  }
  if (purpose === "webhook") {
    if (!config.webhookSecret) {
      throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
    }
    return;
  }
  if (!config.clientToken || !config.paidCheckoutEnabled) {
    throw new ExomemPaddleConfigurationError("EXOMEM_PADDLE_CONFIGURATION_INVALID");
  }
}
