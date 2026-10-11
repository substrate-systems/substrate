// Header names a caller may never send to the gateway. Routing comes only from
// the authenticated principal, so a header or cookie that names a tenant, cell,
// release or internal endpoint is refused before any token lookup.

// A closed set of selector names that the gateway contract reserves; it is not
// vocabulary, and a request may never carry one.
const RESERVED_FIELDS = new Set([
  "tenant",
  "tenant_id",
  "tenant_scope",
  "account",
  "account_id",
  "user",
  "user_id",
  "resource",
  "cell",
  "cell_id",
  "cell_endpoint",
  "vault",
  "vault_path",
  "vault_root",
  "path",
  "principal",
  "principal_scope",
  "request_id",
  "request",
  "protocol",
  "protocol_version",
  "service_credential",
  "internal_endpoint",
  "endpoint",
  "private_address",
  "public_subject",
  "storage_root",
  "subject",
  "idempotency_scope",
  "idempotency",
  "retry_scope",
  "retry",
  "profile",
  "profile_id",
  "auth",
  "authorization",
  "session",
  "session_id",
  "candidate",
  "candidate_id",
  "assignment",
  "assignment_id",
  "assignment_generation",
  "generation",
  "stage",
  "stage_id",
  "staged_client_release",
  "staged_client_release_id",
  "artifact",
  "artifact_id",
  "artifact_sha256",
  "release",
  "release_version",
  "schema",
  "schema_digest",
  "compatibility",
  "compatibility_digest",
  "gateway_contract_digest",
  "source_release",
  "bound_cell_id",
  "target_candidate_id",
  "contract_digest",
  "command_fingerprint",
]);

// The two public headers whose names collide with reserved fields and that a
// caller must send.
const PUBLIC_MCP_HEADER_EXCEPTIONS = new Set(["authorization", "cookie"]);

// The release selectors a cookie may not carry, from the same contract.
const RELEASE_SELECTOR_FIELDS = new Set([
  "candidate",
  "candidate_id",
  "assignment",
  "assignment_id",
  "assignment_generation",
  "generation",
  "stage",
  "stage_id",
  "staged_client_release",
  "staged_client_release_id",
  "artifact",
  "artifact_id",
  "artifact_sha256",
  "release",
  "release_version",
  "protocol",
  "protocol_version",
  "schema",
  "schema_digest",
  "compatibility",
  "compatibility_digest",
  "gateway_contract_digest",
  "source_release",
  "bound_cell_id",
  "target_candidate_id",
  "contract_digest",
  "command_fingerprint",
]);

function normalizeField(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
}

export function hasForbiddenGatewayHeaders(headers: Headers): boolean {
  const trustedIngressHeader =
    process.env.EXOMEM_GATEWAY_TRUSTED_INGRESS_SOURCE_HEADER?.toLowerCase();
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    const selector = normalizeField(normalized);
    if (
      (normalized.startsWith("x-exomem-") &&
        normalized !== "x-exomem-csrf" &&
        normalized !== trustedIngressHeader) ||
      normalized.startsWith("x-tenant") ||
      normalized === "x-cell-id" ||
      normalized === "x-vault-path" ||
      normalized === "x-vault-root" ||
      normalized === "x-principal-scope" ||
      normalized === "x-protocol-version" ||
      normalized === "x-internal-endpoint" ||
      normalized === "cf-access-client-id" ||
      normalized === "cf-access-client-secret" ||
      (RESERVED_FIELDS.has(selector) && !PUBLIC_MCP_HEADER_EXCEPTIONS.has(selector)) ||
      (normalized === "cookie" &&
        value.split(";").some((cookie) => {
          const [name] = cookie.split("=", 1);
          return RELEASE_SELECTOR_FIELDS.has(normalizeField(name ?? ""));
        }))
    ) {
      return true;
    }
  }
  return false;
}
