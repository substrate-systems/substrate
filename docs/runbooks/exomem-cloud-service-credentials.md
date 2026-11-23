# Exomem Cloud service credentials

A service credential lets one named product backend reach one tenant's Cloud
cell without an interactive OAuth login. The secret is `exs_` followed by 32
random bytes; the control plane stores only its SHA-256 digest and the gateway
resolves it against `exomem_cloud_service_credentials`. An `exs_` bearer is
never an OAuth token and an OAuth token is never a service credential: the
gateway selects the lookup by the secret's own prefix and never falls through.

## Before issuing anything

Apply migration `0088_exomem_cloud_service_credentials.sql` and the updated
`scripts/exomem-cloud-grants.sql`; the migration runner applies the grants on
every run. The gateway needs its column-scoped SELECT on the new table — the
row it reads carries only the digest, so the gateway still never sees a
secret. Deploy the gateway image that contains the service lookup before
handing out the first credential; an older gateway answers every `exs_`
bearer with 401 because the digest simply resolves nothing in its OAuth
table.

Until Exomem's service-principal stage exists, a service credential
authorizes every Cloud operation the owner's own token would — both
`exomem.read` and `exomem.write`, through the same tenant cell, as the
recorded owner. Issue a credential only for a tenant whose owner has explicitly
permitted the named product that full access, and record that permission with
the issuance note. The credential binds to the tenant, not the cell row: a
rebuilt cell keeps it working. The principal (`service:<name>`) is a
format-checked identifier, not an authority grant: it names the product in the origin
proof the cell sees, it does not narrow what the product may do.

Operator API access uses the `operator-token` binding exactly as the
reviewer-access runbook describes. The client must not log bearer headers or
credential response bodies.

## Issue

`POST /api/exomem/admin/service-credentials` with a JSON body naming one
tenant selector — `tenantId` or `email` (the owner's), never both — and
`principal` matching `^service:[a-z][a-z0-9-]{0,39}$`, for example
`service:creator-platform`.

Issuance refuses with 409 `SERVICE_CREDENTIAL_TENANT_INELIGIBLE` when the
tenant is `deletion_pending` or `deleted`, its owner has an account block, it
has no non-deleted cell, or it is a marketplace-reviewer tenant — reviewer
credentials carry their own expiry contract a long-lived secret would
sidestep. A 409 `SERVICE_CREDENTIAL_LIMIT` means the tenant and principal
already hold two live credentials; revoke one before issuing another.

The 201 response is the only place the secret ever appears: `secret`,
`credentialId`, `tenantId`, `principal`, `cellId`, `cloudMcpUrl`. It is sent
with `cache-control: no-store`. Copy it straight into the product's secret
custody; there is no recovery path. If the value is lost, rotate — the old
row still works until revoked, so a lost copy is a reason to replace, not to
share. `cloudMcpUrl` is `null` when the deployment does not publish the Cloud
MCP URL — derive it from the platform's advertised Cloud endpoint (the same
origin the operator API is served on, plus the configured MCP path) rather
than re-issuing; the credential itself is unaffected.

`GET /api/exomem/admin/service-credentials?tenantId=...` (or `?email=...`)
lists id, principal, `createdAt` and `revokedAt` — never a secret or a
digest.

## Verify

Have the product read `GET {cloudMcpUrl-origin}/.well-known/exomem-cell`
through the gateway with `Authorization: Bearer exs_...`. A 200 with the
cell's discovery document means the credential resolves and the cell is
running; 401 means the digest did not resolve (wrong secret, revoked, or a
tenant that left eligibility); 503 `CELL_NOT_READY` means the credential is
fine but the cell is not; 504 `CELL_TIMEOUT` means the cell accepted no
answer inside the headers timeout — treat it like 503 and retry; a 502 means
the cell's answer was unusable. Then
run the product's normal `tools/call` happy path.

## Rotate

Rotation is the designed reason two live credentials per tenant and
principal are allowed:

1. Issue a second credential for the same tenant and principal. Both are
   now live; the gateway admits either.
2. Deliver the new secret to the product and switch its configuration.
3. Verify the product's calls succeed, then revoke the first credential.
   Revocation takes effect on the next request the gateway receives with
   it — there is no cache to wait out.

A third live credential is refused with `SERVICE_CREDENTIAL_LIMIT`; never
delete rows by hand to work around it.

## Revoke

`DELETE /api/exomem/admin/service-credentials` with `{"credentialId": "..."}`.
The response reports `revoked: true` when this call revoked it and `false`
when it was already revoked or never existed — both are success, so a retry
or an audit re-run is always safe. From the next request on, the gateway
answers the credential with 401 and contacts no cell.

Revocation is the response for a lost copy, a product offboarding, an owner
withdrawing permission, and a tenant leaving eligibility. The tenant's other
credentials and its owner's ordinary OAuth sessions are untouched.

## What not to do

Do not put a service credential into a URL, a log line, an email or a chat.
Do not point one product's credential at another tenant's cell — the lookup
resolves the credential's tenant's cell and the gateway refuses
selector headers, so there is no request-side way to redirect it. Do not
issue a credential "for later" without an owner permission on record.
