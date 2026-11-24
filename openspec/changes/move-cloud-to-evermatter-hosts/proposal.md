# Proposal

## Why

The product Exomem becomes Evermatter, with the product domain `evermatter.ai`. The company site stays `substratesystems.io`. Today the hosted MCP gateway answers on one host, and each OAuth token is bound by exact equality to that host's resource URL. If the configured resource URL changed, every connected agent client would lose its connection. On 2026-11-13 a disconnect cost a user ten days of saves, so the move must not drop a connection.

## What Changes

- The MCP gateway answers on a new host, `mcp.evermatter.ai`, and keeps answering on the old host.
- The gateway and the OAuth server accept a configured set of resource URLs instead of one. Each token stays bound to the resource it was issued for, and a token whose resource is outside the set is refused.
- New connections are offered the new resource. Existing connections keep their old resource and keep refreshing.
- Sign-in moves to `evermatter.ai`. The product app pages (sign-in, setup, home, authorize, operator) serve on the origin that `EXOMEM_PUBLIC_BASE_URL` names, and the other host redirects them there. Setting that value to `https://evermatter.ai` moves the OAuth issuer, the email links and Home together. OAuth API endpoints keep answering on both hosts, so a client that stored the old token endpoint keeps refreshing.
- `evermatter.ai` serves the product's public pages (landing, docs, benchmarks, privacy, terms, support). The old public product paths on `substratesystems.io` redirect there permanently.
- Cloud email sends as Evermatter from an `evermatter.ai` address once that domain is authenticated with the mail provider.

## Capabilities

### New Capabilities

- `evermatter-public-hosts`: which hosts serve the product, how a token's resource is matched to a host, and the redirects from the old public paths.

### Modified Capabilities

None.

## Impact

- **Code:** `src/lib/exomem-hosted/cloud-config.ts`, `cloud-oauth.ts`, `cloud-handler.ts`, `oauth-store.ts`, the OAuth authorize and token routes, `src/exomem-gateway/server.ts` and `cloud-origin.ts`, and the other resource-equality call sites; `src/proxy.ts` for host routing and redirects; `src/app/sitemap.ts`, `src/lib/seo.ts`; `src/lib/exomem-hosted/mail-sender.ts`.
- **Configuration:** a new accepted-resources setting on the web app and the gateway; the Vercel project's domains; the gateway ingress, TLS and DNS for `mcp.evermatter.ai` in the platform chart.
- **Data:** none. Stored token rows keep their resource values.
- **Related programme:** the product repository's `rename-to-evermatter` change renames the product's external surfaces.
