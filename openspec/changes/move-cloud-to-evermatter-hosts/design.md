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

### D4. App pages follow the issuer

The app pages (sign-in, setup, home, authorize, operator) serve on the origin that `EXOMEM_PUBLIC_BASE_URL` names; on any other product host they get a 308 to that origin. That one value already gives the OAuth issuer, the magic-link and Home URLs and the checkout return URL, so setting it to `https://evermatter.ai` moves sign-in, the issuer and every link together. The session and continuation cookies are host-only, and each CSRF and consent check compares the request's Origin with its own Host, so a browser flow must finish on one host.

- The token, register and revoke routes are not redirected and answer on both hosts. Some clients store the token endpoint and do not follow a redirect on a POST.
- The authorize route, a browser navigation, sends a GET on another host to the base origin with a 307 before it sets its continuation cookies; otherwise the consent page on the base origin would never see them.
- Tokens are opaque and never carry the issuer, so a token from before the switch keeps working.
- A browser session on the old host does not carry over; the person signs in once on `evermatter.ai`.
- After the switch, the authorization-server metadata names the new issuer on both hosts. A client that rediscovers goes through the protected-resource metadata, which names the new issuer. A client that re-fetches metadata under the old issuer sees a mismatch and fails that discovery, and recovers through the protected-resource metadata on its next challenge.
- On `evermatter.ai` the app pages serve at the root (`/home`, `/sign-in`, `/authorize`), as the public pages do. The route folders under `src/app/exomem` and every API and `/.well-known` route keep their paths, and the mapping never rewrites or redirects them.
- An address that leaves the page (an email link, a consent or checkout return URL, a Home link in a tool reply) takes the root form on the product site's origin and the `/exomem/` form on any other origin. So `substratesystems.io` keeps `/exomem/*` until the switch. A link inside a page keeps the route form, and the product host answers it with a 308 to the root form.
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
6. Move sign-in: set `EXOMEM_PUBLIC_BASE_URL` to `https://evermatter.ai` on the web app and the gateway together, after `evermatter.ai` serves TLS and the mail links for that host are tested. Set `EVERMATTER_SITE_ORIGIN` on the gateway in the same step, so the Home links in its tool replies take the root form; without it they redirect once. Rollback: set it back; sessions made on `evermatter.ai` then end and people sign in again on the old host.
7. Rollback of the resource set: unset the set. Tokens issued for the new resource then stop working, so roll back only before step 3's new connections exist, or keep the new resource listed second.
