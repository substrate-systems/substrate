# Proposal

## Why

The product Exomem becomes Evermatter, with the product domain `evermatter.ai`. The company site stays `substratesystems.io`. Today the hosted MCP gateway answers on one host, and each OAuth token is bound by exact equality to that host's resource URL. If the configured resource URL changed, every connected agent client would lose its connection. On 2026-11-13 a disconnect cost a user ten days of saves, so the move must not drop a connection.

## What Changes

- The MCP gateway answers on a new host, `mcp.evermatter.ai`, and keeps answering on the old host.
- The gateway and the OAuth server accept a configured set of resource URLs instead of one. Each token stays bound to the resource it was issued for, and a token whose resource is outside the set is refused.
- New connections are offered the new resource. Existing connections keep their old resource and keep refreshing.
- Sign-in moves to `evermatter.ai`. The product app pages (sign-in, setup, home, authorize, operator) serve on the origin that the web app's `EXOMEM_PUBLIC_BASE_URL` names, at the root on `evermatter.ai`, and the other host and the old `/exomem/` addresses redirect them there. A redirect that changes host is temporary, because it reverses at the switch and at a rollback. Setting that value to `https://evermatter.ai` on the web app moves sign-in, consent, the email links and Home together. Each MCP host names its own OAuth issuer: the old host keeps the company issuer, and `mcp.evermatter.ai` names the `evermatter.ai` issuer. That pairing deploys before any client release, setup offer or service notice points clients at the new host. A connection made on the new host before that deploy signs in once afterwards; the deploy counts them first. A client release that changes its configured MCP URL makes a new connection, which signs in once. The OAuth API endpoints keep answering on both hosts, so a client that stored the old token endpoint keeps refreshing. The company endpoints retire with the old MCP host, because the migration is complete only when no product surface depends on `substratesystems.io`.
- `evermatter.ai` serves the product's public pages (landing, docs, benchmarks, privacy, terms, support). The old public product paths on `substratesystems.io` redirect there permanently.
- Cloud email sends as Evermatter from an `evermatter.ai` address once that domain is authenticated with the mail provider.

## Capabilities

### New Capabilities

- `evermatter-public-hosts`: which hosts serve the product, how a token's resource is matched to a host, and the redirects from the old public paths.

### Modified Capabilities

None.

## Impact

- **Code:** `src/lib/exomem-hosted/cloud-config.ts`, `cloud-oauth.ts`, `cloud-handler.ts`, `oauth-store.ts`, the OAuth authorize and token routes, `src/exomem-gateway/server.ts`, `cloud-origin.ts` and `cloud-transfer-tools.ts` for each MCP host's issuer, its startup check and the Home link, and the other resource-equality call sites; `src/lib/exomem/product-site.ts` and `src/proxy.ts` for host routing and redirects; `src/lib/exomem-hosted/public-origin.ts` for the page addresses; the authorization-server metadata route for the issuer of each app host; `src/lib/exomem-hosted/paddle-config.ts` and `paddle-billing.ts` so a checkout begun on either app origin resumes; `src/lib/exomem-hosted/turnstile.ts` so a start token from either app host passes; `src/lib/exomem-hosted/privacy.ts` for the analytics exclusion; `src/app/sitemap.ts`, `src/lib/seo.ts`; `src/lib/exomem-hosted/mail-sender.ts`.
- **Configuration:** a new accepted-resources setting on the web app and the gateway; the Vercel project's domains; the gateway ingress, TLS and DNS for `mcp.evermatter.ai` in the platform chart; `EVERMATTER_SITE_ORIGIN` on the web app; `EVERMATTER_SITE_ORIGIN` on the gateway, which the new MCP host's issuer needs; the web app's `EXOMEM_PUBLIC_BASE_URL` set to `https://evermatter.ai`, with the gateway's value left on `https://substratesystems.io`; before that step, `evermatter.ai` on the Turnstile widget's hostnames and approved by Paddle as a checkout domain, live and sandbox.
- **Data:** none. Stored token rows keep their resource values.
- **Related programme:** the product repository's `rename-to-evermatter` change renames the product's external surfaces.
