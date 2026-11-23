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
- Moving the issuer or the product app pages (a later change).
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

### D3. Public pages move, app pages wait

The product's public pages get their canonical home on `evermatter.ai`. Requests for them on `substratesystems.io` get a 308. Sign-in, setup, home and authorize stay on the issuer's origin, because the session cookie is host-only and the consent flow runs on the issuer.

## Risks / Trade-offs

- **A token outside the set.** Tests cover a token for each listed resource, a token for an unlisted resource, and a refresh with the old resource.
- **Two hosts to operate.** The second host is ingress and DNS only; the gateway is the same deployment.

## Migration Plan

1. Ship the code with the set unset (inert).
2. Add DNS, TLS and ingress for `mcp.evermatter.ai`.
3. Set the accepted-resource set to the new URL first, then the old URL, on the web app and the gateway together.
4. Check that a token from an existing connection still works at the old host, and that a new connection receives the new resource.
5. Rollback: unset the set. Tokens issued for the new resource then stop working, so roll back only before step 3's new connections exist, or keep the new resource listed second.
