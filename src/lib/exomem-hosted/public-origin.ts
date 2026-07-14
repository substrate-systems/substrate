import { ExomemHostedError } from "./errors";

const DEVELOPMENT_DEFAULT_ORIGIN = "https://substratesystems.io";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function invalidPublicBaseUrl(): ExomemHostedError {
  return new ExomemHostedError({
    code: "PUBLIC_BASE_URL_INVALID",
    status: 500,
    message: "public Exomem URL configuration is invalid",
  });
}

export function parseExomemPublicBaseUrl(
  value: string | undefined,
  environment = process.env.NODE_ENV
): string {
  const configured =
    value ?? (environment === "production" ? undefined : DEVELOPMENT_DEFAULT_ORIGIN);
  if (!configured) throw invalidPublicBaseUrl();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidPublicBaseUrl();
  }
  const safeHttps = url.protocol === "https:";
  const safeDevelopmentHttp =
    environment !== "production" && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (
    (!safeHttps && !safeDevelopmentHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidPublicBaseUrl();
  }
  return url.origin;
}

export function exomemPublicBaseUrlFromEnv(): string {
  return parseExomemPublicBaseUrl(process.env.EXOMEM_PUBLIC_BASE_URL);
}

export function exomemPublicFragmentUrl(baseUrl: string, path: string, token: string): string {
  const origin = parseExomemPublicBaseUrl(baseUrl);
  const url = new URL(path, `${origin}/`);
  url.hash = token;
  return url.toString();
}
