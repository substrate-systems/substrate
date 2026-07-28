## Context

Substrate already contains the Hosted Exomem account, invitation, OAuth 2.1, MCP gateway, tenant control plane, client-artifact promotion, and owner-only install-action implementation merged by PR #59. The private account experience can expose provider install URLs only after exact artifacts are promoted live. The public product surface did not move with that implementation: `/exomem` still calls Hosted a future possibility and claims end-to-end encryption, while `/exomem/privacy` and `/exomem/terms` do not exist.

The marketplace reviewers also exercise the public origin before they can use a reviewer account. On the current production deployment, both well-known OAuth metadata routes and an unauthenticated MCP request return 500 even though Vercel's matched-route headers prove the merged routes are deployed. The immediate cause is a missing or malformed production `EXOMEM_PUBLIC_BASE_URL`: all three paths resolve it and fail closed before responding. Metadata is static deployment configuration, and after the canonical origin is valid the MCP authorization challenge must not depend on database-backed rate limiting, token, session, or tenant work.

This repository owns the public deployment and truthful service boundary. The Exomem repository owns deterministic client packages and provider submission packets. Both must agree on canonical URLs and live artifact identity without duplicating either runtime.

## Goals / Non-Goals

**Goals:**

- Turn `/exomem` into an honest two-path product page: self-hosted now, Hosted private alpha for invited users, and public marketplace availability only when exact install actions are live.
- Publish stable, product-specific privacy, terms, support, and setup URLs required by Claude and OpenAI review.
- Explain the actual privacy boundary: encrypted in transit and at rest, tenant-isolated cells, plaintext processing for search, limited operator access, portable export, and explicit destruction.
- Serve OpenAI's domain-verification challenge exactly from an operator-held environment value.
- Make OAuth metadata and the unauthenticated MCP challenge side-effect-free and observable, enforce exact Origin validation, then provide a safe production preflight for public and authenticated checks.

**Non-Goals:**

- Replacing the merged OAuth, MCP, tenant, or promotion architecture.
- Opening self-service signup or claiming general availability during the invite-only alpha.
- Publishing provider install URLs before their existing artifact records are live.
- Storing a domain challenge, reviewer credential, OAuth token, invite, tenant ID, or content-bearing response in source control or logs.
- Treating repository tests or mocked MCP calls as real provider acceptance.
- Representing the policy pages as legal approval; provider submission remains gated on owner/legal review.

## Decisions

### Keep public and account installation fail-closed

The public page will describe the clients and one-login journey, but it will link to a provider directory only through a server-side helper that accepts the same sanitized, live client-artifact records used by Home. Until a channel is published, the public action remains an alpha request/sign-in action rather than a guessed marketplace URL.

The alternative—hard-coding expected provider slugs—would create broken links and falsely advertise unapproved listings.

### Publish product-specific policy and support routes

Exomem gets dedicated `/exomem/privacy`, `/exomem/terms`, `/exomem/support`, and `/exomem/setup` pages. They use the existing public site shell and explicit revision dates. The privacy page describes collected account/billing/content/operational data, purposes, subprocessors/categories, retention, export/deletion, security boundary, operator access, international processing, rights, and contact. Terms cover alpha eligibility, user data ownership and processing license, acceptable use, availability, payment where enabled, export/deletion, suspension, warranties, liability, and contact.

The global Endstate terms are not reused because they describe a different product and purchase model. Policy text stays deliberately factual; explicit legal approval is an external release prerequisite.

### Treat metadata, Origin validation, and the authentication challenge as the database-free front door

Well-known metadata derives only from a validated public origin and fixed protocol constants. The canonical request order is: resolve the configured origin; validate a present `Origin` header; reject forbidden selector headers; parse the bearer shape; return the static challenge for a missing or malformed bearer; then run the existing durable IP limiter, token, identity, tenant, and cell checks for a syntactically valid bearer.

Missing `Origin` is accepted for server-side MCP clients. A present value must be a syntactically exact origin matching the canonical public origin or an explicitly configured entry in `EXOMEM_MCP_ALLOWED_ORIGINS`; `null`, wildcards, credentials, paths, query/fragment data, neighboring subdomains, and wrong ports are rejected with a content-free 403 before any database work. The optional list is exact and operator-controlled—no Anthropic or OpenAI origins are guessed.

A missing or malformed bearer therefore returns the canonical 401 challenge even if database or control-plane-key configuration is absent or unhealthy. A syntactically valid token still reaches the existing fail-closed durable IP limiter and token/tenant validation. The static challenge is protected at the Vercel edge/WAF rather than by an in-memory serverless limiter or anonymous database write.

This preserves security while avoiding a misleading 500 for the first unauthenticated request used in connector discovery.

### Expose the OpenAI challenge as an exact secret-backed response

`/.well-known/openai-apps-challenge` reads `OPENAI_APPS_CHALLENGE` at request time. When configured, GET returns exactly the trimmed value as `text/plain`, with `Cache-Control: no-store` and no logging. Missing, blank, newline-bearing, or oversized values fail closed without echoing input. The value is never accepted through a query parameter or checked into fixtures.

Request-time lookup allows challenge rotation without rebuilding a static artifact. The route is intentionally separate from OAuth metadata.

### Produce two levels of production evidence

A deterministic script checks public pages and their semantic digests, exact canonical metadata, the OpenAI challenge without printing its value, an attacker-Origin 403, and the unauthenticated MCP `WWW-Authenticate` response. Optional authenticated checks read a reviewer access token only from an environment variable and verify MCP `initialize` and `tools/list` while printing only status, tool names, counts, and contract digests.

The script emits a redacted JSON evidence document suitable for Exomem's marketplace readiness validator. It never records response bodies from content-bearing tools. Local route tests remain necessary but cannot substitute for a live-origin run.

### Keep production health diagnostic and fail-closed

If deployment configuration is wrong, the public probe reports the specific route and stable failure class without secrets. The runbook starts with deployment alias, `EXOMEM_PUBLIC_BASE_URL`, database/migration state, and route logs before any restart. It follows the existing rule that restarting the Exomem service can make long-lived connector sessions slower and is not a generic fix.

## Risks / Trade-offs

- [Policy text could overpromise or omit a legal requirement] -> Derive it from the implemented runbook/data flow, label the revision, and require explicit owner/legal approval before provider submission.
- [Challenge secret leaks through tests or logs] -> Test only synthetic values, disable caching, reject unsafe forms, and make the probe compare a digest rather than emit the value.
- [Moving durable rate limiting after bearer-shape validation changes anonymous ingress behavior] -> Keep it before token lookup for valid-looking credentials and protect the fixed database-free 401 at Vercel's edge with a generous per-IP rule.
- [Origin policy blocks a legitimate client] -> Allow missing Origin for server-to-server clients, seed only the canonical origin, add exact observed origins through configuration, and never use a wildcard or guessed provider list.
- [Public Hosted copy implies immediate availability] -> Say invite-only/private alpha and derive directory actions only from live artifact state.
- [Authenticated live probing exposes knowledge content] -> Limit it to `initialize` and `tools/list`, emit metadata only, and keep recall/capture evidence in the separate controlled acceptance run.
- [A successful build hides a stale production alias] -> Make the runbook and evidence include the deployed commit/alias when available and always probe the canonical production origin.

## Migration Plan

1. Add tests first for policy/setup routes, public copy, sitemap entries, domain challenge behavior, metadata independence, MCP challenge ordering, and redacted probe output.
2. Implement the public surfaces and route ordering without touching tenant or cell contracts.
3. Run the full unit suite, TypeScript check, production build, formatting, and strict OpenSpec validation.
4. Deploy the branch preview and run unauthenticated preflight, including attacker-Origin rejection, against it.
5. Set Production `EXOMEM_PUBLIC_BASE_URL` exactly to `https://substratesystems.io`; verify the control-plane key, database, migrations through 0034, optional exact origin allowlist, and edge rate rule; deploy to the canonical origin and run public plus authenticated metadata/tool-discovery preflight.
6. Supply the redacted evidence to the Exomem marketplace release gate, then proceed with provider submission only after policy approval and exact artifact promotion.

Rollback the application release if policy routes, metadata, or MCP challenge regress. The change requires no database migration and does not mutate tenant content. Remove or rotate the OpenAI challenge environment value independently after verification; the route then fails closed. Never down-migrate the existing Hosted schema as part of this rollback.

## Open Questions

- Final legal approval and the exact policy revision date remain owner decisions before submission.
- The production OpenAI challenge value exists only after the provider portal issues it.
- Public marketplace URLs remain absent until provider approval; the current invite-only action is the truthful fallback.
