## Why

Hosted Exomem's control plane and OAuth/MCP implementation are merged, but the public product still says Hosted is hypothetical, its required privacy and terms URLs are missing, and production OAuth/MCP discovery currently returns 500. Those are stop-ship failures for friend onboarding and both Claude and OpenAI marketplace review.

## What Changes

- Present self-hosted Exomem and the invite-only Hosted service as two honest product choices, with Hosted onboarding framed as install, sign in once, and use it naturally.
- Publish Exomem-specific privacy, terms, support, and hosted setup surfaces that accurately describe plaintext processing inside an isolated encrypted tenant cell rather than claiming zero-knowledge or end-to-end encryption.
- Add the exact, environment-backed OpenAI domain-verification challenge route without committing or logging the challenge value.
- Make public OAuth metadata side-effect-free, validate browser `Origin` before protected work, and ensure an unauthenticated Hosted MCP request returns the standards-compliant authorization challenge without depending on database-backed rate limiting.
- Add deterministic marketplace-readiness tests and a production probe command/runbook covering product, policy, OAuth discovery, MCP challenge, and tool discovery.
- Keep marketplace install links fail-closed: public and account surfaces expose only exact install actions backed by live promoted client artifacts.

## Capabilities

### New Capabilities

- `exomem-marketplace-surface`: Public Hosted product, policy, support, domain-proof, readiness-probe, and install-first onboarding behavior required for marketplace distribution.

### Modified Capabilities

None.

## Impact

- Affects the public `/exomem` route, new Exomem policy/support/setup routes, sitemap, the OpenAI well-known challenge, focused Hosted MCP/OAuth request ordering, tests, and the Hosted alpha runbook.
- Reuses the merged Hosted OAuth, gateway, tenant, promotion, and account install-action contracts; it does not introduce a second MCP endpoint or change tenant data architecture.
- Adds one deployment secret for OpenAI's domain challenge, an optional exact MCP origin allowlist, and requires `EXOMEM_PUBLIC_BASE_URL=https://substratesystems.io` plus the existing Hosted production configuration/migrations to be healthy before marketplace readiness can pass.
- Pairs with Exomem's `productize-hosted-marketplace-release` change, which generates provider submission packets and validates the exact live artifact bindings.
