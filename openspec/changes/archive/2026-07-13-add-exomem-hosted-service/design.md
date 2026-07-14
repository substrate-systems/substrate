## Context

Substrate already has several pieces worth reusing: a Next.js server boundary, Neon/Postgres migrations, Paddle transaction and webhook adapters, Brevo email delivery, browser-session patterns, R2 storage helpers, cron authentication, and content-free audit conventions. Those pieces currently serve Endstate Hosted Backup and must remain behaviorally isolated from the new product.

Exomem itself remains a one-vault runtime. The companion Exomem change publishes a versioned command contract, private cell authentication, hosted lifecycle hooks, process-safe mutations, tenant-bound transfers, and canonical export/restore helpers. It deliberately does not own public identity, billing, shared routing, infrastructure orchestration, or the consumer UI.

The first users are invitees who should be able to open a link, write something useful, and recall it without installing software or understanding Markdown, MCP, vault paths, GitHub OAuth, or hosting. The alpha therefore optimizes for a handful of isolated cells, strong boundaries, and excellent onboarding rather than maximum tenant density.

Substrate is deployed as a stateless web/control plane. Long-running Exomem cells and their persistent volumes live behind a private infrastructure adapter. This design cannot assume that a Next.js request owns a local filesystem or can synchronously create a durable container.

## Goals / Non-Goals

**Goals:**

- Get an invited non-technical user from invite link to useful capture and recall in under five minutes, excluding external provisioning outages.
- Derive every tenant destination from authenticated server-side identity and preserve one isolated Exomem cell/vault/state/log boundary per tenant.
- Reuse Paddle and existing Substrate primitives without coupling Exomem request execution to Paddle or Endstate subscription semantics.
- Support complimentary alpha access now and provider-backed paid access later through one provider-neutral entitlement model.
- Automate provision, health, suspend, resume, export, restore, credential rotation, and deletion through idempotent lifecycle operations.
- Preserve canonical Markdown/media ownership and offer verified portable export.
- Keep operational logs and control-plane state free of vault content, queries, titles, paths, emails where opaque IDs suffice, and secrets.
- Freeze a testable gateway/cell protocol shared with the Exomem repository.

**Non-Goals:**

- Pooling multiple tenants inside one Exomem process, Python interpreter, filesystem namespace, or SQLite store.
- Zero-knowledge search. The service can access plaintext while serving a tenant; encryption at rest and strict operator access are the honest ceiling.
- Public self-service signup during the invite-only alpha.
- Choosing a permanent Kubernetes/cloud vendor in the application contract. The first production adapter can target the existing private platform, but the control plane depends on an interface.
- Giving cells direct access to Paddle, account email, browser cookies, public OAuth bearer tokens, database credentials, R2 credentials, or a global tenant registry.
- Replacing Endstate authentication, billing, backup, or account deletion flows.

## Decisions

### 1. Exomem gets product-scoped access, not a renamed Endstate session

An Exomem invite contains a high-entropy random token. Substrate stores only its SHA-256 digest, expiration, bound normalized email, entitlement kind, and single-use state. Redemption atomically burns the invite, finds or creates the shared `users` identity row, creates the user's Exomem tenant if absent, and issues a dedicated opaque `exomem_session` cookie whose digest is stored in `exomem_sessions`.

The session cookie is `HttpOnly`, `Secure` in production, `SameSite=Lax`, path-scoped to `/`, rotated after sensitive events, and revocable. State-changing browser routes validate same-origin `Origin`/`Host` plus a session-bound CSRF token. A returning invitee can request a magic link only for an existing Exomem account; the response is deliberately non-enumerating.

The invite is an explicit alpha trust decision, so possession of a valid email-bound link establishes the initial session. The redemption screen displays the bound address before committing and never accepts a replacement email. Admin invite creation is protected by a separate deployment secret and is not exposed in public navigation.

**Alternative considered:** reuse `endstate_account_session`. Rejected because its one-hour GUI handoff and Endstate-specific recovery assumptions would couple product lifecycles and make Exomem access dependent on a technical desktop app.

**Alternative considered:** GitHub OAuth. Rejected because it is an onboarding tax for non-technical users and would duplicate public auth in every cell.

### 2. One owner maps to one tenant and exactly one active cell

The control-plane model is:

```text
users --1:1--> exomem_tenants --1:1--> active exomem_cells
                          |--1:1--> exomem_entitlements
                          |--1:n--> exomem_lifecycle_operations
```

`exomem_tenants.owner_user_id` is unique. `exomem_cells.tenant_id` permits historical cells but a partial unique constraint permits only one active/provisioning/draining cell. Tenant and cell IDs are opaque UUIDs; neither is supplied by the public caller. The mapping is immutable during normal requests. Restore/migration creates a replacement cell through an explicit lifecycle operation, verifies it, then atomically swaps the active binding.

Cell endpoint, service credential, provisioner reference, and release are control-plane state. Service credentials are unique per cell, generated with 256 bits of entropy, encrypted using an application key held outside the database, and decrypted only inside the private forwarding/provisioning adapter. Logs and API responses never contain them.

**Alternative considered:** one shared Exomem server with a `tenant_id` parameter. Rejected because existing modules contain process globals and vault-bound caches; a single missed selector would become a cross-tenant disclosure.

### 3. Provisioning is an idempotent reconciler behind an adapter

Next.js writes a desired state and an idempotent lifecycle operation; it does not claim success because an outbound create call returned. A reconciler route protected by the existing cron secret leases pending operations, calls a `CellProvisioner`, records provider-neutral checkpoints, and polls private readiness until the expected cell/protocol/release binding is confirmed.

The adapter contract covers:

- create or converge one cell with distinct vault/state/log volumes;
- inject only that cell's ID, private credential, protocol, release, and provider-neutral resource policy;
- return an opaque provider reference and private endpoint;
- query content-free health;
- rotate a cell credential;
- quiesce, resume, stop, and seal;
- request verified export/restore hooks;
- destroy cell compute, volumes, backup objects, and tenant encryption keys.

The repository ships an HTTP adapter for a private provisioner plus an in-memory/fake adapter for tests. The HTTP request is signed/authenticated with a provisioner credential and uses idempotency keys. A deployment-specific K3s/controller implementation can live with the infrastructure it controls; Substrate's durable contract does not import Kubernetes APIs.

Operations use states `pending`, `running`, `waiting`, `succeeded`, `failed_retryable`, and `failed_terminal`. Replays with the same tenant/type/idempotency key return the same operation. A lease and next-attempt timestamp prevent two serverless invocations from performing the same transition concurrently. Backoff is bounded and failures expose a content-free stable code.

**Alternative considered:** provision synchronously during invite redemption. Rejected because container/volume creation can exceed request limits and turns an external timeout into an ambiguous partially-created account.

### 4. The gateway resolves identity first and forwards the registry contract

The public command route is `/api/exomem/commands/[command]`; there is no tenant or cell segment. It authenticates an Exomem browser session or a future product API token, resolves exactly one active mapping, evaluates suspension/readiness and an internal entitlement projection, then loads the Exomem registry contract for the cell protocol.

The gateway rejects unknown commands from the contract. It does not maintain independent parameter schemas or call Exomem leaves itself. It may reject reserved tenant selectors before forwarding, but command validation/coercion and stable Exomem errors remain cell-owned.

Private forwarding uses the cell's unique service credential and trusted headers:

- `X-Exomem-Cell-Id`
- `X-Exomem-Protocol-Version`
- `X-Exomem-Request-Id`
- `X-Exomem-Principal-Scope`
- `Idempotency-Key` for an authenticated public key

The principal scope is a stable HMAC of product, user ID, and tenant ID, not an email or public bearer token. Public requests carrying internal header names, tenant/cell selectors, or private endpoints are rejected before routing. The gateway never forwards the public Authorization header.

Protocol contracts are cached by `(cell release, protocol version, contract digest)` and verified against a checked-in compatibility fixture. A cell that cannot prove the expected cell ID and compatible protocol is unavailable; the gateway never retries against another tenant.

Reads can retry a bounded number of times on transport failure. Mutations retry only with a stable authenticated idempotency key. Cell result/error envelopes and codes pass through unchanged, except transport/control-plane failures are returned in the same outer error shape using reserved gateway codes.

**Alternative considered:** copy the command list into TypeScript. Rejected because registry drift would create inconsistent validation and silent feature gaps.

### 5. Transfers terminate at the gateway and use tenant-bound grants

The browser first requests a short-lived transfer grant for `upload` or `download`. The grant is signed by a Substrate key and contains opaque subject scope, tenant ID, cell ID, operation, audience, `iat`, `exp`, `jti`, and resource limits. No endpoint or cell credential is present.

The public transfer route verifies the grant and current session/entitlement, re-resolves the active cell, requires the token cell to match that mapping, then streams to the private cell using the cell credential. Paths remain vault-relative command data and are validated again by Exomem. Grant IDs are hashed into a content-free audit/replay table. Alpha replay resistance is short TTL plus scoped operation and append-only conflict behavior; the schema supports one-time consumption later.

Uploads are size-limited before and during streaming. Request bodies and filenames are never logged. Downloads set safe content-disposition and do not reveal file existence on auth/routing failure.

### 6. Entitlements are provider-neutral; Paddle is one adapter

`exomem_entitlements` stores effective state, source, capability set, resource limits, provider references with their environment provenance, source revision, and timestamps. Request-time checks read only its provider-neutral capability projection. Effective states are `provisioning`, `active`, `grace`, `suspended`, `cancelled`, and `deleted`.

Complimentary invites create an `active` entitlement with source `complimentary` and the alpha capability bundle. This makes the first invites independent of pricing and Paddle configuration.

Paid checkout uses the existing Paddle client and environment switch. The server selects the configured Exomem price; callers cannot submit a price ID. The Paddle transaction receives `custom_data` containing a product key, internal user ID, and tenant ID. Its identifier and provider environment are atomically bound to the owner while serialized against deletion. A `_ptxn` checkout return is removed from browser history and sent through an authenticated, CSRF-protected server check before Paddle.js opens it. The candidate remains only in session-scoped browser storage until validation settles or Paddle.js actually opens, so transient validation or client initialization failures have an explicit retry/dismiss path without restoring the URL. Inspection first uses transaction-only merchant configuration; terminal completed/canceled recovery therefore survives browser, return-origin, and sale-catalog rotation, while a still-open transaction must pass the full current checkout, catalog, and URL checks. A canceled transaction is compare-and-cleared before one replacement can be created; a completed transaction promotes its subscription/customer, triggers reconciliation, and never creates a second charge path. The shared webhook verifies the signature once, dispatches Exomem product events by product key/catalog membership, stores event IDs idempotently, and projects provider state into the Exomem entitlement. Endstate events continue through the existing handler unchanged.

Paddle customer, subscription, transaction, product, and price IDs remain in control-plane tables and billing responses. Their sandbox/production provenance is stored with the references and repaired for legacy rows only from exact receipts or verified webhooks. Unresolved legacy references are frozen while unrelated lifecycle updates remain possible. They are never forwarded to a cell or written into a vault. Paddle calls are confined to checkout, customer-portal creation, webhooks, periodic billing reconciliation, and deletion-time termination; normal Exomem capture/recall never calls Paddle. Webhook and reconciliation ordering use occurrence time plus a provider revision/event record so an older observation cannot reactivate a newer suspension.

Periodic billing reconciliation is durable rather than a minute-by-minute scan. Eligible Paddle entitlements carry next-check, lease, attempt, and stable error metadata. Each cron claims a small due batch with `FOR UPDATE SKIP LOCKED`; success schedules the next check six hours later, failure uses exponential backoff capped at six hours, and the provider request inherits the remaining cron deadline. Lifecycle and billing lanes start together and both settle before the cron responds. If catalog configuration disappears, provider provenance is unresolved, or stored and configured environments differ while eligible paid rows remain, reconciliation fails visibly before calling Paddle. The atomic projection rechecks tenant deletion state after the provider call and records a reconciliation observation as ignored rather than mutating a deletion-pending tenant.

Manual safety suspension always wins over billing state. Grace can retain reads/exports while disabling new writes according to policy. Complimentary and Paddle sources project the same capabilities, so replacing the commercial provider does not change the cell contract.

**Alternative considered:** reuse the Endstate `subscriptions` row directly. Rejected because one Paddle customer may hold multiple products and Endstate's zero-knowledge backup states/limits are not Exomem entitlements.

### 7. Exomem Home is one workspace, with complexity progressively disclosed

`/exomem/home` has three explicit states:

1. **Preparing:** invitation accepted, cell provisioning/recovery in progress, with plain-language progress and automatic polling.
2. **First memory:** one large capture box, a short example, and a visible privacy/ownership statement. Saving leads immediately to a recall prompt using the just-captured concept.
3. **Workspace:** capture and recall are primary; recent memory, connection/review suggestions, uploads, service status, export, billing, and deletion sit behind secondary panels.

Home never asks for a vault path, note type, YAML, scope, model, reranker, protocol, or tenant ID during the normal flow. The server maps simple capture to the registry `remember` command using product-safe defaults and recall to `ask_memory`. Advanced structured fields can be added later without changing the gateway.

Server components load only content-free account/cell status. Vault content is fetched on explicit authenticated actions and is not placed into analytics. Errors map stable codes to plain-language recovery actions while retaining a copyable request ID.

The existing public `/exomem` marketing page remains public. Home and invite pages are `noindex` and never leak an account's existence.

### 8. Export and deletion are durable control-plane workflows

An export request creates an idempotent lifecycle operation, quiesces the exact cell, invokes Exomem's deterministic export, verifies the returned manifest/digest, stores the encrypted archive in tenant-scoped object storage, resumes the cell, and creates a short-lived owner-only download URL. Object keys are opaque; the database stores integrity metadata and an opaque reference, not filenames or vault paths.

Deletion is product-scoped. It does not delete a shared `users` row or Endstate data. The flow:

1. require a fresh Exomem session and an emailed single-use confirmation;
2. set the tenant to suspended and revoke Exomem sessions/transfers;
3. optionally create the policy-required final export;
4. cancel the exact pending Paddle transaction or its completed subscription in the stored provider environment, independently of the currently saleable price, then atomically compare the complete billing-reference fingerprint, scrub the terminated references, and advance the leased billing checkpoint; a provider 404 is unverified rather than cancellation proof;
5. seal and stop the cell;
6. call the provisioner to delete compute, volumes, backups, and tenant key;
7. remove the active cell binding and mark Exomem entitlement/tenant deleted; and
8. retain only the minimum content-free audit proof allowed by policy.

Every destructive checkpoint is replayable and externally verified before advancing. UI never claims deletion is complete while storage/KMS destruction is merely queued.

### 9. Privacy is enforced at module and test boundaries

Operational events allow only timestamp, opaque tenant/cell ID, operation/command, request ID, stable status/error code, duration, release/protocol, and coarse byte/count buckets. A structured redaction helper rejects or hashes reserved content-bearing keys. Tests seed sensitive sentinels into queries, titles, paths, invite emails, credentials, grants, and cell responses and assert they do not appear in logs or errors.

Email is used only in identity/invite delivery and user-facing account views. Gateway, lifecycle, provisioner, and cell logs use opaque IDs. Analytics are disabled on authenticated Home content surfaces unless an explicit future privacy review adds aggregate content-free events.

Secrets use constant-time comparison where applicable, are never serialized by `toJSON`, and are redacted from thrown errors. Database access is least-privilege by deployment role where the platform supports it.

### 10. The first release is alpha-complete without a live price

The code and sandbox catalog support Paddle from day one, and the EUR 5 monthly friends price has completed the sandbox lifecycle drill, but the initial invite journey can still use complimentary entitlements. A public paid launch requires selecting the exact monthly price within EUR 10–15, then configuring its live catalog item, webhook endpoint/secret, checkout domain, and tax/terms handling. This separates product onboarding risk from live billing risk without building a throwaway entitlement path.

## Risks / Trade-offs

- **A control-plane routing bug is a high-value confused-deputy failure.** → Resolve identity and mapping server-side, use one unique credential per cell, require the cell to verify its own ID, reject reserved selectors/headers, and run two-cell sentinel tests.
- **Serverless requests cannot own long provisioning operations.** → Persist desired state and checkpoints, use a leased reconciler, and make every provider call idempotent.
- **The private provisioner is still a privileged component.** → Give it only lifecycle authority, authenticate every request, keep its endpoint private, audit opaque IDs, and never expose it to browsers.
- **One cell per user costs more at low utilization.** → Start lean with lexical recall and workers off, measure memory/cold start, and preserve a future migration boundary without weakening isolation now.
- **Invite-link possession is a bearer-auth event.** → Bind it to an email, use 256-bit single-use short-lived tokens, store only digests, show the bound account before redemption, and offer immediate session revocation.
- **Shared `users` identity can make product deletion ambiguous.** → Treat Exomem tenant/session/entitlement deletion as product-scoped and never cascade to Endstate rows.
- **Paddle webhooks can arrive late, duplicated, or out of order.** → Verify signatures, store event IDs, compare event/provider revision time, reconcile periodically, and make manual suspension dominant.
- **Gateway contract drift can break users mid-release.** → Negotiate an explicit protocol version, pin compatibility fixtures, roll out cells before gateway assumptions, and preserve additive compatibility.
- **Exports can be large and request-limited.** → Run them asynchronously, stream between private services/object storage, verify manifests, and return only short-lived download URLs.
- **The operator can access plaintext during service.** → State this honestly, encrypt disks/backups, restrict human access, and ensure content never enters operational logs or Paddle.

## Migration Plan

1. Land Exomem's mutation guard, hosted cell config/lifecycle, private contract, and portability helpers with local behavior unchanged.
2. Apply Substrate migrations and deploy product-scoped access/control-plane modules with the provisioner in dry-run/fake mode.
3. Configure the private provisioner adapter, cell image/release, protocol fixture, encryption key, and content-free health checks in sandbox.
4. Create the Paddle sandbox catalog/price and webhook routing, but issue the first internal tenant a complimentary entitlement.
5. Run a two-cell drill with unique sentinels through invite, provision, capture, recall, transfer, suspension, export, restore, credential rotation, and deletion.
6. Invite a tiny complimentary alpha cohort. Keep optional embeddings/media off until worker mutation conformance and resource limits pass.
7. Enable sandbox checkout for test accounts, reconcile duplicate/out-of-order webhooks, and verify portal/cancellation/grace behavior.
8. Move to live Paddle only after price, terms, retention, deletion, monitoring, and restore drills are signed off.

Rollback stops new routing, marks affected cells draining, pins the previous compatible gateway/cell release, and restarts against unchanged canonical vaults. Database migrations are additive; old application code ignores new Exomem tables. No rollback rewrites vault content. Before any canonical-format change, the control plane takes and verifies an export.

## Open Questions

- What exact public monthly price within EUR 10–15, annual price, and capability tiers should be published after the EUR 5 friends tier? The implementation uses an environment-selected catalog and does not block on this.
- Which production provisioner backs the HTTP adapter first, and in which region? The application protocol remains provider-neutral; a deployment adapter must be selected before real invites.
- What are the exact backup retention, deletion grace, and export expiry windows? Conservative alpha defaults can be configured, but terms must be finalized before paid live use.
- When should semantic embeddings and media extraction be enabled per tier? They remain explicit grants and default off for the alpha.
