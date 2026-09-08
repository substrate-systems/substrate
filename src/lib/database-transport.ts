import { checkServerIdentity } from "node:tls";
import type { PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

const CONNECTION_OPTIONS = new Set([
  "ssl",
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslnegotiation",
  "channel_binding",
  "application_name",
  "fallback_application_name",
  "options",
  "client_encoding",
  "connect_timeout",
  "statement_timeout",
  "query_timeout",
  "idle_in_transaction_session_timeout",
  "keepalives",
  "keepalives_idle",
]);

function refused(reason: string): never {
  // Connection strings and parser errors can contain database credentials.
  throw new Error(`DATABASE_TRANSPORT_${reason}`);
}

export type VerifiedPostgresConfig = PoolConfig & {
  sslnegotiation: "postgres" | "direct";
  enableChannelBinding: boolean;
};

/** Parse once so URI SSL options cannot replace the verified TLS policy. */
export function verifiedPostgresConfig(
  databaseUrl: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): VerifiedPostgresConfig {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") refused("TLS_BYPASS");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    refused("INVALID_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2 ||
    url.hash
  )
    refused("INVALID_URL");
  const peer = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) refused("INVALID_PORT");
  const seen = new Set<string>();
  for (const [name] of url.searchParams) {
    if (!CONNECTION_OPTIONS.has(name) || seen.has(name)) refused("UNSUPPORTED_OPTION");
    seen.add(name);
  }
  const mode = url.searchParams.get("sslmode");
  const ssl = url.searchParams.get("ssl");
  const negotiation = url.searchParams.get("sslnegotiation") ?? "postgres";
  const binding = url.searchParams.get("channel_binding");
  if (ssl !== null && ssl !== "true" && ssl !== "1") refused("TLS_REQUIRED");
  if (negotiation !== "postgres" && negotiation !== "direct") refused("UNSUPPORTED_OPTION");
  if (binding !== null && !["require", "prefer", "disable"].includes(binding))
    refused("UNSUPPORTED_OPTION");

  const localPlaintext =
    mode === "disable" &&
    (environment.NODE_ENV === "development" || environment.NODE_ENV === "test") &&
    environment.DATABASE_ALLOW_INSECURE_LOOPBACK === "true" &&
    (peer === "127.0.0.1" || peer === "::1");
  if (mode !== null && mode !== "require" && mode !== "verify-full" && !localPlaintext) {
    refused("TLS_REQUIRED");
  }
  if (
    localPlaintext &&
    (ssl !== null ||
      negotiation === "direct" ||
      binding === "require" ||
      ["sslrootcert", "sslcert", "sslkey"].some((key) => seen.has(key)))
  ) {
    refused("CONFLICTING_OPTIONS");
  }
  // Normalize libpq-style `require` to strict semantics without pg's ambiguous
  // legacy-mode warning. Certificate/key/CA files remain supported by its parser.
  url.searchParams.delete("ssl");
  url.searchParams.delete("channel_binding");
  url.searchParams.set("sslmode", localPlaintext ? "disable" : "verify-full");
  let config: PoolConfig;
  try {
    config = parseIntoClientConfig(url.toString());
  } catch {
    refused("INVALID_CONFIGURATION");
  }
  if (config.host?.replace(/^\[|\]$/g, "") !== peer) refused("INVALID_PEER");
  const material = config.ssl && typeof config.ssl === "object" ? config.ssl : {};
  return {
    ...config,
    host: peer,
    port,
    sslnegotiation: negotiation,
    enableChannelBinding: binding === "require" || binding === "prefer",
    ssl: localPlaintext
      ? false
      : {
          ...material,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          // pg supplies SNI for DNS peers but not IPs. Pin verification to the
          // actual parsed peer in both cases, including an IP subjectAltName.
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(peer, certificate),
        },
  };
}
