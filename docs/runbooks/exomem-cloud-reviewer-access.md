# Exomem Cloud directory reviewer access

Directory reviewers use a provider-bound credential to sign in to a dedicated
sample Cloud vault through the existing OAuth form. It replaces the owner's
email-link step for that sample account. Normal Cloud users continue to use
email links; Hosted reviewer credentials never authorize the Cloud resource.

## Deploy and prepare the sample

Operator API access uses the exact `operator-token` binding in
`contracts/bws-exomem-production-v1.json`. Validate it with
`bwsx-secret check --bindings contracts/bws-exomem-production-v1.json operator-token`,
then use `bwsx-secret run` with that binding to inject `EXOMEM_ADMIN_TOKEN` into
an operator client. The client must not log bearer headers or credential
response bodies. This binding does not rotate the token or change its delivery
to the web app.

For a missing invitation, the `transactional-mail` binding selects Substrate's
Brevo key as `BREVO_API_KEY`. Read Brevo's transactional event report filtered
to that exact recipient and send date; do not fetch email bodies or log API
headers. An invitation marked `sent` records provider acceptance, not inbox
delivery. Inspect the provider event before resending.

Apply migration `0058_exomem_cloud_reviewer_access.sql` and the updated
`scripts/exomem-cloud-grants.sql` before deploying the web app and the new,
verified, pinned gateway image from the same delivery. The migration runner
applies the grants even when the schema is already up to date; run it as the
migration owner after gateway-role provisioning. The gateway requires narrow
column reads for lineage checks and the invoker reviewer predicates, not
credential username digests or password hashes.
The gateway bundles the token lookup, so a web-only deployment does not deploy
reviewer validation. No cell image change is needed. Leave
`EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED` disabled until both deployed
processes are verified and the sample vault is ready.

Create a separate sample account through normal operator invitation/admission
with `marketplaceReviewerPurpose: true` and a complimentary entitlement.
The purpose is immutable: never convert an existing ordinary account or reuse
its private content. Both Cloud invitation paths preserve this purpose and
refuse re-admission with a different purpose. Load only governed sample content.

Before issuance, verify the existing sample tenant has an unblocked, non-deleted
owner, a Cloud cell with desired and observed state `running` and `ready: true`,
and an active complimentary entitlement with no Paddle customer, subscription
or transaction references. Issuance does not admit, provision or change purpose.

Enable `EXOMEM_CLOUD_ENABLED` and `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED`
on both the web and gateway processes. Cloud configuration must name the same
MCP resource on both.

## Issue and store access

Use the authenticated operator API at `/api/exomem/admin/reviewer-access` with
`credentialKind: "cloud_provider_review"`. For POST, supply `provider` (`openai`
or `anthropic`), `ownerUserId`, `tenantId`, `fixtureVersion`, the sample fixture's
SHA-256 `fixturePayloadDigest`, and `expiresAt`. Use a 30-day initial window;
the API refuses past expiry or more than 90 days. Each provider has independent
active authority; issuing again rotates that provider's previous lineage.

POST returns the generated username and password once. Use an operator client
that does not log response bodies and transfer the values directly to approved
secret custody and the directory's secure review-access fields. Keep them out
of Git, logs, chat, public plugin metadata, screenshots and recordings.

GET with `credentialKind=cloud_provider_review&provider=...` returns only fixture,
expiry and revocation status. It cannot recover the plaintext credential.
DELETE with the same kind and provider revokes the selected credential and its
sessions, transactions, codes, grants, refresh families and access tokens
atomically. It preserves the other provider and unrelated ordinary accounts.
Operator revocation remains available when the reviewer flag is disabled.

## Verify actual reviewer sign-in

Start from the provider's normal OAuth connection in a clean browser without
owner cookies. Enter the credential in the existing reviewer disclosure/form,
then complete ordinary consent. The client must already qualify under Cloud's
pinned/CIMD admission and match the credential's provider. The continuation,
form nonce and resource are checked; credentials cannot transfer another
reviewer's transaction.

Run sample bootstrap, capture and readback through MCP. Verify the sample vault
is the only vault visible. Check that reviewer checkout initiation, checkout
resumption and customer-portal creation are refused. Session/code/token expiry
never exceeds credential expiry. Runtime health stays a routing concern after
issuance, while stopped/deleted cells, blocked/deleted owners, expired/revoked
credentials and payment-bearing or otherwise ineligible entitlements cease to
authorize reviewer activity.

## Roll back

Disable the reviewer flag on both web and gateway, then revoke each Cloud
provider lineage through the operator API. Keep the additive migration and
ordinary Cloud sign-in. Do not roll back to a binary that accepts the new kind
as Hosted authority. Re-enable only after both deployed processes contain the
reviewer-aware validation and a fresh clean-browser acceptance succeeds.
