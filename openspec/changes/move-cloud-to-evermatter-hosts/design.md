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

The app pages (sign-in, setup, home, authorize, operator) serve on the origin that the web app's `EXOMEM_PUBLIC_BASE_URL` names; on any other product host they get a 308 to that origin. On the web app that one value gives the app pages, the magic-link and Home URLs, the checkout return URL and the issuer that its own metadata names, so setting it to `https://evermatter.ai` moves sign-in, consent and every link together. It does not move the issuer that MCP clients use: the gateway keeps its own value, so its protected-resource metadata keeps naming `https://substratesystems.io/api/exomem/oauth` for every connection, old or new. The session and continuation cookies are host-only, and each CSRF and consent check compares the request's Origin with its own Host, so a browser flow must finish on one host.

- The token, register and revoke routes are not redirected and answer on both hosts. Some clients store the token endpoint and do not follow a redirect on a POST.
- The authorize route, a browser navigation, sends a GET on another host to the base origin with a 307 before it sets its continuation cookies; otherwise the consent page on the base origin would never see them.
- Tokens are opaque and never carry the issuer, so a token from before the switch keeps working.
- The gateway keeps `EXOMEM_PUBLIC_BASE_URL` on `https://substratesystems.io`. No connection sees its authorization server change, so a client that stores its registration per authorization server keeps that registration and its refresh token. The web-API base that the gateway calls and gives to transfer commands also stays on the company host, which keeps answering it. The gateway's tool replies keep linking Home as `https://substratesystems.io/exomem/home`, which the web app answers with one 308 to `https://evermatter.ai/home`. `EVERMATTER_SITE_ORIGIN` on the gateway does not change that link, because the mapping takes the root form only on the product site's origin.
- The OAuth endpoints on `substratesystems.io` stay as long as any connection holds the company issuer. Only a later governed change, with evidence that no live token family needs them, removes them.
- A browser session on the old host does not carry over; the person signs in once on `evermatter.ai`.
- A magic link requested on the old host and opened after the switch asks the person to confirm their email, because the new host has no cookie from the request. A connection begun before the switch lands on Home, because its continuation cookies stay on the old host.
- The authorization-server metadata names the issuer of the app host that serves it: `https://substratesystems.io/api/exomem/oauth` on the company site and `https://evermatter.ai/api/exomem/oauth` on the product site, before and after the switch. Any other host gets the issuer of the public base origin. A client accepts metadata only when its issuer matches the address it was fetched from (RFC 8414 §3.3), so the company issuer that the gateway names stays valid after the web app moves. A connection then authorizes through the company endpoints: its authorize request gets the 307 above, consent completes on `evermatter.ai`, and its token, register and revoke calls answer on the company host.
- An open Paddle transaction keeps the checkout URL it was made with. A resumed checkout accepts Home under either app origin (`https://substratesystems.io/exomem/home` and `https://evermatter.ai/home`) and no other page, so a checkout begun before the switch, or before a rollback, still opens. A new transaction gets the Home URL of the public base origin.
- The start form's bot check accepts a token made on any app host, so a person who solved the challenge on the old host just before the deploy still gets their email. Cloudflare issues a token only on a hostname that the widget lists, so the widget must list `evermatter.ai` before the switch.
- On `evermatter.ai` the app pages serve at the root (`/home`, `/sign-in`, `/authorize`), as the public pages do; a rewrite serves each root address from its route folder under `src/app/exomem`. The mapping never rewrites or redirects an API or `/.well-known` route.
- An address that leaves the page (an email link, a consent or checkout return URL, a Home link in a tool reply) takes the root form on the product site's origin and the `/exomem/` form on any other origin. So `substratesystems.io` keeps `/exomem/*` until the switch. A server redirect and a navigation that a page script starts take the form of the host they run on. A link that a page renders keeps the route form, because a client component renders the same link on the server and in the browser; the product host answers it with one 308 to the root form.
- Old addresses get a 308 that keeps the query: `/exomem/<app page>` on `evermatter.ai` to its root form, and on `substratesystems.io` straight to the root form on `evermatter.ai`. Before the switch, a root-form app address on `evermatter.ai` gets a 308 to the `/exomem/` form on `substratesystems.io`, so a link sent after a switch still opens after a rollback.
- The session, CSRF, continuation and theme cookies have `Path=/`, and the magic-link, recovery and access-log cookies are scoped to their API paths. So the root addresses receive the cookies they need, and an existing session on `substratesystems.io` keeps working there.
- The analytics exclusion and the theme treat a root-form app path as the app page it names.

Keeping the issuer and the app pages on `substratesystems.io` was the earlier plan; the operator chose sign-in on `evermatter.ai` on 2026-11-24.

## Risks / Trade-offs

- **A token outside the set.** Tests cover a token for each listed resource, a token for an unlisted resource, and a refresh with the old resource.
- **Two hosts to operate.** The second host is ingress and DNS only; the gateway is the same deployment.

## Migration Plan

1. Ship the code with the set unset (inert).
2. Add DNS, TLS and ingress for `mcp.evermatter.ai`.
3. Set `EXOMEM_CLOUD_MCP_URLS` to the new URL first, then the old URL, with the same list on the web app and the gateway; deploy the web app first. A bad list fails the web build and the gateway readiness check. Change `EXOMEM_CLOUD_MCP_URL` only in the same deploy that removes the old host.
4. Check that a token from an existing connection still works at the old host, and that a new connection receives the new resource.
5. Set `EVERMATTER_SITE_ORIGIN` to `https://evermatter.ai` on the web app once that origin serves TLS. The product pages then serve at its root, and the redirect of app pages to the sign-in origin needs this value.
6. Move sign-in on the web app only: set the web app's `EXOMEM_PUBLIC_BASE_URL` to `https://evermatter.ai`. The gateway keeps `https://substratesystems.io` and changes nothing in this step, so the gateway's calls to the web API stay where they are.
   - Before the switch, the operator adds `evermatter.ai` to the Turnstile widget's hostnames and confirms that Cloudflare lists it. Without it, the start form on the new host gets no token and every start request fails.
   - Before the switch, Paddle reports `evermatter.ai` approved as a checkout domain for live and for sandbox, because Paddle takes a transaction's checkout URL only on an approved domain. Live approval is a Paddle review that can take days.
   - Before the switch, the operator checks the account-level default payment link: if it names `https://substratesystems.io/exomem/home`, change it to `https://evermatter.ai/home`. The Endstate checkout uses that link when `PADDLE_CHECKOUT_SUCCESS_URL` is unset, so keep any other value. The shared Paddle webhook destination stays on the company host, where the webhook route keeps answering.
   - Right after the switch, the operator requests a magic link to a Gmail, an Outlook.com and an iCloud mailbox. Each must arrive in the inbox and open sign-in on `evermatter.ai`; a miss is a rollback trigger. The test runs after the switch because only the production web app mails sign-in links that open on `evermatter.ai`.
   - Rollback: the redirects are built from the environment at build time, so a changed value takes effect only after a redeploy. The fast path is Vercel Instant Rollback to the last deployment built before the switch, which carries the old value. Then set the value back, so that the next build keeps it. Sessions made on `evermatter.ai` end, and people sign in again on the old host.
7. Rollback of the resource set: unset the set. Tokens issued for the new resource then stop working, so roll back only before step 3's new connections exist, or keep the new resource listed second.
