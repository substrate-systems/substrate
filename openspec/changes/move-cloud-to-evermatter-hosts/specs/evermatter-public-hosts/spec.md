## ADDED Requirements

### Requirement: Existing connections survive the host move

A token issued before the new host exists SHALL keep working at the host it was issued for,
and its refresh SHALL keep succeeding. No connection made on the old host SHALL have to sign in
again because of the move. A client whose configured MCP URL changes to the new host
makes a new connection, which signs in once; that is not a reconnect of the existing one.

#### Scenario: An existing client keeps calling the old host

- **WHEN** a client connected before the move calls the old MCP URL with its access token
- **THEN** the call succeeds as before

#### Scenario: An existing client refreshes

- **WHEN** that client refreshes with its stored `resource` value
- **THEN** the token endpoint issues a new token bound to the same resource

### Requirement: A token works only for an accepted resource

The gateway SHALL accept a token only when the token's stored resource is in the configured
set of accepted resources.

#### Scenario: A token for an unlisted resource

- **WHEN** a token whose stored resource is not in the configured set is presented
- **THEN** the gateway refuses it with a challenge

#### Scenario: A token at either host

- **WHEN** a token issued for the old resource is presented at the new host
- **THEN** the gateway accepts it, because both hosts front the same resource server

### Requirement: New connections get the new host

The setup page, and a host outside the configured set, SHALL offer the first resource in the set.
The protected-resource metadata of each host in the set SHALL name that host's own resource.

#### Scenario: A new client connects

- **WHEN** a new client starts the connection flow from the product's setup page
- **THEN** it receives the `mcp.evermatter.ai` URL and a token bound to that resource

### Requirement: Old public product paths redirect to evermatter.ai

A request for a public product page on `substratesystems.io` SHALL get a permanent redirect to
the same page on `evermatter.ai`. The token, register and revoke endpoints SHALL NOT redirect.
A GET to the authorize endpoint on a host other than the public base origin SHALL get a
temporary redirect to the same path and query on that origin, before it sets any cookie.

#### Scenario: A visitor follows an old link

- **WHEN** a browser requests the old product landing page
- **THEN** it gets a 308 to `https://evermatter.ai/`

#### Scenario: A stored token endpoint keeps working

- **WHEN** a client posts a refresh to the token endpoint on `substratesystems.io`
- **THEN** the endpoint answers there with no redirect

#### Scenario: A client re-authorizes through a stored old-host authorize URL

- **WHEN** the public base origin is `https://evermatter.ai` and a browser opens the authorize endpoint on `substratesystems.io`
- **THEN** it gets a 307 to the same path and query on `https://evermatter.ai`, with no cookie set, and consent completes there

### Requirement: App pages serve on the configured public origin

The product app pages (sign-in, setup, home, authorize, operator) SHALL serve on the origin that
`EXOMEM_PUBLIC_BASE_URL` names. On any other product host they SHALL get a temporary redirect
(307) to the same page on that origin, because the redirect reverses at the switch and at a
rollback, and a browser that kept a 308 would loop.

#### Scenario: Sign-in after the switch

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and a browser requests the sign-in page on `substratesystems.io`
- **THEN** it gets a 307 to `https://evermatter.ai/sign-in`

#### Scenario: Sign-in before the switch

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://substratesystems.io` and a browser requests `/sign-in` or `/exomem/sign-in` on `evermatter.ai`
- **THEN** it gets a 307 to `https://substratesystems.io/exomem/sign-in`

#### Scenario: A browser that kept the redirects from before the switch

- **WHEN** a browser kept every permanent redirect it followed before the switch, and sign-in then moves to `evermatter.ai` or moves back
- **THEN** every app page it requests on either host still ends at an address that serves

### Requirement: App pages serve at the product site's root

When the public base origin is the product site, the app pages SHALL serve at its root, and
their `/exomem/` addresses on that host SHALL get a 308 to the root form with the query kept.
Elsewhere they SHALL keep the `/exomem/` form. Every app address that leaves a page SHALL take the served form.

#### Scenario: Home at the root

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and a browser requests `/home` on `evermatter.ai`
- **THEN** Home serves there with no redirect

#### Scenario: An old Home address on the product host

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and a browser requests `/exomem/home?_ptxn=txn_1` on `evermatter.ai`
- **THEN** it gets a 308 to `/home?_ptxn=txn_1`

#### Scenario: An API route on the product host

- **WHEN** a client calls `/api/exomem/oauth/token` or `/.well-known/oauth-authorization-server/api/exomem/oauth` on either host
- **THEN** the route answers there, with no rewrite or redirect

#### Scenario: A sign-in link

- **WHEN** `EVERMATTER_SITE_ORIGIN` is `https://evermatter.ai` and a sign-in email is sent
- **THEN** its link is `https://evermatter.ai/sign-in#<token>` once the public base origin is `https://evermatter.ai`, and `https://substratesystems.io/exomem/sign-in#<token>` before

### Requirement: Connections survive the sign-in move

A connection made before the web app's public base origin moves SHALL keep refreshing and
rediscovering without a change of authorization server. The authorization-server metadata SHALL
name the issuer of the app host that serves it on either app origin, and the issuer of the public
base origin on any other host.

#### Scenario: An existing connection after the switch

- **WHEN** the web app's `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai`, and a client connected on the old MCP host before the switch refreshes through its stored token endpoint on `substratesystems.io` and then discovers afresh from its MCP URL
- **THEN** the refresh issues a token bound to the same resource, the protected-resource metadata names `https://substratesystems.io/api/exomem/oauth`, and the metadata fetched under that issuer names the same issuer

#### Scenario: Metadata on the old host after the switch

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and a client fetches the authorization-server metadata on `substratesystems.io`
- **THEN** its issuer is `https://substratesystems.io/api/exomem/oauth`

#### Scenario: Metadata on the new host before the switch

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://substratesystems.io` and a client fetches the authorization-server metadata on `evermatter.ai`
- **THEN** its issuer is `https://evermatter.ai/api/exomem/oauth`

### Requirement: Each MCP host names its own issuer

The protected-resource metadata of each accepted MCP host SHALL name the issuer of the app origin
whose host it is or sits under, whatever the sign-in state and the gateway's base URL. The
gateway SHALL refuse to start while an accepted MCP host sits under no app origin.

#### Scenario: The old MCP host

- **WHEN** a client fetches the protected-resource metadata on `exomem.substratesystems.io`, before or after the switch
- **THEN** it names `https://substratesystems.io/api/exomem/oauth`

#### Scenario: A new connection before the switch

- **WHEN** the web app's `EXOMEM_PUBLIC_BASE_URL` is `https://substratesystems.io` and a new client connects to `https://mcp.evermatter.ai/mcp`
- **THEN** the metadata names `https://evermatter.ai/api/exomem/oauth`, authorize on `evermatter.ai` gets a 307 to `substratesystems.io`, consent completes there, and the code exchanged on `evermatter.ai` gives a token for `https://mcp.evermatter.ai/mcp`

#### Scenario: A new MCP host without the product site setting

- **WHEN** the gateway's `EXOMEM_CLOUD_MCP_URLS` lists `https://mcp.evermatter.ai/mcp` and the gateway lacks `EVERMATTER_SITE_ORIGIN`
- **THEN** the gateway's startup check throws and names that resource, and the gateway does not start

### Requirement: Tool replies link Home on the product site

The gateway's tool replies SHALL link Home on the product site's origin while
`EVERMATTER_SITE_ORIGIN` is set, and on the gateway's public base origin otherwise.

#### Scenario: A Home link in a tool reply

- **WHEN** the gateway's `EVERMATTER_SITE_ORIGIN` is `https://evermatter.ai` and a transfer reply links Home, before or after the switch
- **THEN** the link is `https://evermatter.ai/home#your-data`, and the command in the same reply keeps the gateway's `--api-base-url`

### Requirement: Checkouts and the start form survive the sign-in move

A resumed checkout SHALL accept a transaction whose checkout URL is Home on either app origin,
and SHALL refuse any other URL. The start form's bot check SHALL accept a token made on either
app host, and SHALL refuse a token made on any other host.

#### Scenario: A checkout begun before the switch

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and the owner resumes a transaction whose checkout URL is `https://substratesystems.io/exomem/home?_ptxn=<id>`
- **THEN** the checkout opens

#### Scenario: A checkout URL on another page

- **WHEN** a resumed transaction's checkout URL is on any page other than Home on an app origin
- **THEN** the owner gets a billing-state conflict and checkout does not open

#### Scenario: A start token from the old host

- **WHEN** `EXOMEM_PUBLIC_BASE_URL` is `https://evermatter.ai` and the start form posts a Turnstile token that Cloudflare reports was made on `substratesystems.io`
- **THEN** the bot check passes, and a token made on any other host fails
