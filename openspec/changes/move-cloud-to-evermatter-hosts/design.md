# Design

## Context

Three values shape the hosted service's public identity:

- `EXOMEM_CLOUD_MCP_URL` is the MCP resource. Access tokens, refresh tokens, grants and authorization codes each store it in a `resource` column. About ten call sites compare it by exact equality.
- `EXOMEM_PUBLIC_BASE_URL` gives the OAuth issuer, `${base}/api/exomem/oauth`, on the website origin.
- The gateway signs internal JWTs with `iss` set to the login's resource, and derives upload URLs from it.

Clients store the MCP URL in their own configuration and send their stored `resource` on every refresh. Not every MCP client follows a redirect on a POST.

## Goals / Non-Goals

**Goals**

- No connected client is signed out or has to reconnect.
- New connections use `mcp.evermatter.ai`.
- RFC 8707 audience binding stays: a token works only at a resource in the accepted set.

**Non-Goals**

- Renaming internal identifiers: tables, cookies, JWT audiences, headers, env names.

## Decisions

### D1. An accepted-resource set

A new setting lists the accepted resource URLs, newest first. The first entry is the resource that discovery offers to new clients. `EXOMEM_CLOUD_MCP_URL` stays as the fallback when the list is unset, so the change deploys inert.

- The gateway accepts a token when its stored resource is in the set. Both hosts front the same resource server, and the gateway learns the host only from the client-controlled Host header, so binding a token to its arrival host would add no protection.
- The protected-resource metadata and the 401 challenge name the resource of the host that served them when that resource is in the set, else the first entry.
- The authorize and token endpoints accept a `resource` parameter that is in the set. A refresh keeps the resource of its token family.

Rewriting stored resource values was rejected: clients would still send the old resource and call the old URL.

### D2. The old host keeps serving

Both hosts route to the same gateway. Removal waits until no live token family references the old resource, and not before 2027-11-23.

### D3. Public pages move to the product site

The product's public pages get their canonical home on `evermatter.ai`. Requests for them on `substratesystems.io` get a 308.

### D4. App pages follow the web app's public base origin

The app pages (sign-in, setup, home, authorize, operator) serve on the origin that the web app's `EXOMEM_PUBLIC_BASE_URL` names; on any other product host they get a 308 to that origin. On the web app that one value gives the app pages, the magic-link and Home URLs, the checkout return URL and the issuer that its own metadata names, so setting it to `https://evermatter.ai` moves sign-in, consent and every link together. It does not move the issuer that MCP clients use: the gateway's protected-resource metadata names each MCP host's own issuer (below), and no step of the move changes it. The session and continuation cookies are host-only, and each CSRF and consent check compares the request's Origin with its own Host, so a browser flow must finish on one host.

- The token, register and revoke routes are not redirected and answer on both hosts. Some clients store the token endpoint and do not follow a redirect on a POST.
- The authorize route, a browser navigation, sends a GET on another host to the base origin with a 307 before it sets its continuation cookies; otherwise the consent page on the base origin would never see them.
- Tokens are opaque and never carry the issuer, so a token from before the switch keeps working.
- Each MCP host pairs with its own issuer: the issuer of the app origin whose host it is or sits under. The app origins are the web app's public base origin, `EVERMATTER_SITE_ORIGIN` and the company origin, the same set whose metadata names its own issuer, so the pairing needs no host list or setting of its own. `https://exomem.substratesystems.io/mcp` names `https://substratesystems.io/api/exomem/oauth` in every state, and `https://mcp.evermatter.ai/mcp` names `https://evermatter.ai/api/exomem/oauth` from its first connection. No connection sees its authorization server change, so a client that stores its registration per authorization server keeps that registration and its refresh token.
- The gateway readiness check refuses an accepted MCP host that sits under no app origin, for example `mcp.evermatter.ai` while the gateway lacks `EVERMATTER_SITE_ORIGIN`. Such a host would name the base's issuer, and moving its connections to another issuer later would disconnect them.
- The gateway keeps `EXOMEM_PUBLIC_BASE_URL` on `https://substratesystems.io` as its web-API base, which it calls and gives to transfer commands as `--api-base-url`. The web API answers there without a redirect, and the gateway's calls refuse a redirect, so that value moves only when the old host retires (D2). The Home link in the gateway's tool replies follows `EVERMATTER_SITE_ORIGIN` instead: `https://evermatter.ai/home#your-data` serves in both states, through one 308 to the company form before the switch.
- The OAuth endpoints on `substratesystems.io` stay while the old MCP host serves, because only connections made on that host hold the company issuer. They retire with the old host (D2).
- A browser session on the old host does not carry over; the person signs in once on `evermatter.ai`.
- A magic link requested on the old host and opened after the switch asks the person to confirm their email, because the new host has no cookie from the request. A connection begun before the switch lands on Home, because its continuation cookies stay on the old host.
- The authorization-server metadata names the issuer of the app host that serves it: `https://substratesystems.io/api/exomem/oauth` on the company site and `https://evermatter.ai/api/exomem/oauth` on the product site, before and after the switch. Any other host gets the issuer of the public base origin. A client accepts metadata only when its issuer matches the address it was fetched from (RFC 8414 §3.3), so the company issuer that the old host names stays valid after the web app moves, and the product-site issuer that the new host names is valid before it. An old-host connection after the switch authorizes through the company endpoints: its authorize request gets the 307 above, consent completes on `evermatter.ai`, and its token, register and revoke calls answer on the company host. A new connection on `mcp.evermatter.ai` before the switch authorizes through the product-site endpoints: its authorize request gets a 307 to the company host, consent completes there, and the code goes back to the client, which exchanges it on `evermatter.ai`. The code carries no issuer, and the token route has no host check. This chain needs the web deploy that serves per-host metadata (task 2.5) before the gateway names the product-site issuer; until then, the metadata on `evermatter.ai` names the company issuer, and a client refuses the mismatch.
- An open Paddle transaction keeps the checkout URL it was made with. A resumed checkout accepts Home under either app origin (`https://substratesystems.io/exomem/home` and `https://evermatter.ai/home`) and no other page, so a checkout begun before the switch, or before a rollback, still opens. A new transaction gets the Home URL of the public base origin.
- The start form's bot check accepts a token made on any app host, so a person who solved the challenge on the old host just before the deploy still gets their email. Cloudflare issues a token only on a hostname that the widget lists, so the widget must list `evermatter.ai` before the switch.
- On `evermatter.ai` the app pages serve at the root (`/home`, `/sign-in`, `/authorize`), as the public pages do; a rewrite serves each root address from its route folder under `src/app/exomem`. The mapping never rewrites or redirects an API or `/.well-known` route.
- An address that leaves the page (an email link, a consent or checkout return URL, a Home link in a tool reply) takes the root form on the product site's origin and the `/exomem/` form on any other origin. So `substratesystems.io` keeps `/exomem/*` until the switch. A server redirect and a navigation that a page script starts take the form of the host they run on. A link that a page renders keeps the route form, because a client component renders the same link on the server and in the browser; the product host answers it with one 308 to the root form.
- Old addresses get a 308 that keeps the query: `/exomem/<app page>` on `evermatter.ai` to its root form, and on `substratesystems.io` straight to the root form on `evermatter.ai`. Before the switch, a root-form app address on `evermatter.ai` gets a 308 to the `/exomem/` form on `substratesystems.io`, so a link sent after a switch still opens after a rollback.
- The session, CSRF, continuation and theme cookies have `Path=/`, and the magic-link, recovery and access-log cookies are scoped to their API paths. So the root addresses receive the cookies they need, and an existing session on `substratesystems.io` keeps working there.
- The analytics exclusion and the theme treat a root-form app path as the app page it names.

Keeping the issuer and the app pages on `substratesystems.io` was the earlier plan; the operator chose sign-in on `evermatter.ai` on 2026-11-24. Naming the company issuer for every connection, new ones included, was rejected on 2026-11-27: retiring that issuer later would disconnect every connection made on the new host.

## Risks / Trade-offs

- **A token outside the set.** Tests cover a token for each listed resource, a token for an unlisted resource, and a refresh with the old resource.
- **Two hosts to operate.** The second host is ingress and DNS only; the gateway is the same deployment.

## Migration Plan

1. Ship the code with the set unset (inert).
2. Add DNS, TLS and ingress for `mcp.evermatter.ai`.
3. Set `EXOMEM_CLOUD_MCP_URLS` to the new URL first, then the old URL, with the same list on the web app and the gateway; deploy the web app first. A bad list fails the web build and the gateway readiness check. Change `EXOMEM_CLOUD_MCP_URL` only in the same deploy that removes the old host.
4. Check that a token from an existing connection still works at the old host, and that a new connection receives the new resource.
5. Set `EVERMATTER_SITE_ORIGIN` to `https://evermatter.ai` on the web app once that origin serves TLS. The product pages then serve at its root, and the redirect of app pages to the sign-in origin needs this value.
6. Deploy the web app with tasks 2.5 and 2.6. This deploy changes no setting: each app host's metadata names its own issuer, a resumed checkout accepts Home under either app origin, and the start form accepts a token from either app host.
7. Name each MCP host's own issuer on the gateway: build the gateway image from a commit that carries it, and roll the platform chart with `EVERMATTER_SITE_ORIGIN` set to `https://evermatter.ai` on the gateway. Do this after step 6, for the reason in D4. The readiness check refuses the new image without that setting while `mcp.evermatter.ai` is listed. Then the protected-resource metadata on each MCP host names that host's issuer. Rollback: roll the chart back to the previous revision. Before any connection exists on `mcp.evermatter.ai`, that changes nothing that a client holds; after one exists, the rollback moves its issuer and disconnects it.
8. Move sign-in on the web app only: set the web app's `EXOMEM_PUBLIC_BASE_URL` to `https://evermatter.ai` and redeploy. This is its own deploy after step 6, so the last deployment built before the switch carries tasks 2.5 and 2.6. The gateway changes nothing in this step.
   - Before the switch, the operator adds `evermatter.ai` to the Turnstile widget's hostnames and confirms that Cloudflare lists it. Without it, the start form on the new host gets no token and every start request fails.
   - Before the switch, Paddle reports `evermatter.ai` approved as a checkout domain for live and for sandbox, because Paddle takes a transaction's checkout URL only on an approved domain. Live approval is a Paddle review that can take days.
   - Before the switch, the operator checks the account-level default payment link: if it names `https://substratesystems.io/exomem/home`, change it to `https://evermatter.ai/home`. The Endstate checkout uses that link when `PADDLE_CHECKOUT_SUCCESS_URL` is unset, so keep any other value. The shared Paddle webhook destination stays on the company host, where the webhook route keeps answering.
   - Before the switch, the operator sends the sign-in email with an `evermatter.ai` link to a Gmail, an Outlook.com and an iCloud mailbox through the production sender. The renderer takes the link as an argument and the sender is the one that every sign-in email uses (`renderExomemMagicLinkEmail` and `sendTransactionalEmail` with `EXOMEM_SENDER`, as in `access-delivery.ts`), so the message differs from a real one only in its token. Each must arrive in the inbox; a miss holds the switch. The same send also shows the sender's domain beside the link's: the switch does not wait for task 3.2, and a sign-in link on a domain other than the sender's can score as phishing.
   - Right after the switch, the operator requests one real magic link, which must open sign-in on `evermatter.ai`; a miss is a rollback trigger.
   - Rollback: the redirects are built from the environment at build time, so a changed value takes effect only after a redeploy. The fast path is Vercel Instant Rollback to the last deployment built before the switch, step 6's or a later one, which carries the old value. Never roll back to a build older than step 6: it lacks the metadata that connections on `mcp.evermatter.ai` need. Then set the value back, so that the next build keeps it. Sessions made on `evermatter.ai` end, and people sign in again on the old host.
9. Rollback of the resource set: unset the set. Tokens issued for the new resource then stop working, so roll back only before step 3's new connections exist, or keep the new resource listed second.
