import { SensitiveSecret } from "./security";

const ACCESS_CLIENT_ID = /^[A-Za-z0-9._-]{1,512}$/;
const ACCESS_CLIENT_SECRET = /^\S{16,2048}$/;

export type CloudflareAccessCredential = {
  clientId: SensitiveSecret;
  clientSecret: SensitiveSecret;
};

export type CloudflareAccessConfig = {
  selectedVersion: "active" | "previous";
  active: CloudflareAccessCredential;
  previous: CloudflareAccessCredential | null;
};

export class CloudflareAccessConfigurationError extends Error {
  constructor() {
    super("CLOUDFLARE_ACCESS_CONFIGURATION_INVALID");
    this.name = "CloudflareAccessConfigurationError";
  }
}

function present(value: string | undefined): string | null {
  return value && value.trim() === value && value.length > 0 ? value : null;
}

function credentialPair(
  clientIdRaw: string | undefined,
  clientSecretRaw: string | undefined,
  required: boolean
): CloudflareAccessCredential | null {
  const clientId = present(clientIdRaw);
  const clientSecret = present(clientSecretRaw);
  if (!clientId && !clientSecret && !required) return null;
  if (
    !clientId ||
    !clientSecret ||
    !ACCESS_CLIENT_ID.test(clientId) ||
    !ACCESS_CLIENT_SECRET.test(clientSecret)
  ) {
    throw new CloudflareAccessConfigurationError();
  }
  return {
    clientId: new SensitiveSecret(clientId),
    clientSecret: new SensitiveSecret(clientSecret),
  };
}

export function cloudflareAccessConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudflareAccessConfig | null {
  const hasAny = [
    env.EXOMEM_CF_ACCESS_CLIENT_ID,
    env.EXOMEM_CF_ACCESS_CLIENT_SECRET,
    env.EXOMEM_CF_ACCESS_CLIENT_ID_PREVIOUS,
    env.EXOMEM_CF_ACCESS_CLIENT_SECRET_PREVIOUS,
    env.EXOMEM_CF_ACCESS_SEND_VERSION,
  ].some((value) => value !== undefined);
  if (!hasAny && env.NODE_ENV !== "production") return null;

  const active = credentialPair(
    env.EXOMEM_CF_ACCESS_CLIENT_ID,
    env.EXOMEM_CF_ACCESS_CLIENT_SECRET,
    true
  );
  const previous = credentialPair(
    env.EXOMEM_CF_ACCESS_CLIENT_ID_PREVIOUS,
    env.EXOMEM_CF_ACCESS_CLIENT_SECRET_PREVIOUS,
    false
  );
  const selectedVersion = env.EXOMEM_CF_ACCESS_SEND_VERSION ?? "active";
  if (
    !active ||
    (selectedVersion !== "active" && selectedVersion !== "previous") ||
    (selectedVersion === "previous" && !previous)
  ) {
    throw new CloudflareAccessConfigurationError();
  }
  return { selectedVersion, active, previous };
}

export function cloudflareAccessHeaders(
  config: CloudflareAccessConfig | null
): Record<string, string> {
  if (!config) return {};
  const selected = config.selectedVersion === "active" ? config.active : config.previous;
  if (!selected) throw new CloudflareAccessConfigurationError();
  return {
    "CF-Access-Client-Id": selected.clientId.reveal(),
    "CF-Access-Client-Secret": selected.clientSecret.reveal(),
  };
}
