## Context

The gateway already serves `GET /download` for an OAuth bearer and relays a stored original from the cell, with Range. A browser media element cannot send a bearer, and media bytes must not stream through the Next.js app. The app and the gateway share `EXOMEM_CONTROL_PLANE_KEY`. Home already holds a first-party OAuth login family per owner.

## Goals / Non-Goals

Goals: an owner opens a stored original from the browser and seeks inside it; the gateway keeps every per-request check; Home shows honest storage figures.
Non-goals: a reviewer download, a new secret, a new table, a release flag, and any change to the cell's own download contract.

## Decisions

### D1. The app redirects to the gateway with a ticket

`GET /api/exomem/cloud/download?path=` authenticates the session, refuses a reviewer session and a cross-site request, resolves the serving cell from the session, and answers 302 to the gateway's `/download` with `path` and `ticket`. The response is private and not cached, and sends no referrer. The route is rate limited per tenant. A stopped or not-ready cell answers 503 and mints nothing.

Alternative: stream through the app. Rejected: a Vercel function would carry every media byte.

### D2. The ticket is an HMAC over the shared control-plane key

The ticket is `<payload>.<mac>`. The MAC is HMAC-SHA-256 under `EXOMEM_CONTROL_PLANE_KEY` with its own domain label, so no other use of that key produces a ticket. The payload carries the purpose `download`, tenant, cell, the owner's Home login family and grant, the SHA-256 of the exact path, and issue and expiry times. It lives at most 10 minutes, at signing and at verification. It is reusable inside its life, because a media element sends several Range requests. It names a login family and carries no bearer.

Alternative: a new signing key or a table of tickets. Rejected: a new secret and new state for no extra property, since the gateway re-checks the login family on every request.

### D3. The gateway re-resolves the login on every request

On `GET /download` a ticket and a bearer together answer 400. A ticket must verify (MAC, expiry, path digest) before any database work; an invalid ticket pays the per-IP bucket and answers 401. A valid one takes the same rate limit and concurrency slot as the OAuth route, then the gateway resolves the named login family through the existing OAuth lookup. That lookup covers revocation, client admission, tenant deletion, owner block and cell deletion. The login must be first-party, and its tenant and cell must match the ticket. The cell must be running or read-only. The gateway never logs the ticket. Responses to a browser add `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.

The ticket opens only `GET /download` for its path. `/mcp`, `/upload` and any other path refuse it.

### D4. Two storage figures, each against its own limit

Migration 0094 adds `vault_used_bytes`, `media_used_bytes`, `media_allowance_bytes` and `media_usage_observed_at`. A CHECK ties every figure to its read time, and every figure is at least zero. cellctl alone writes them, through a guarded column grant that the grants script re-applies after each migration. `used_bytes` keeps its meaning.

Home reads them in the status poll. When `media_usage_observed_at` is set, Home shows "Vault storage" against the volume and "Media storage" against the allowance, and a figure that is NULL shows as unknown, never as zero. When all four are NULL, Home shows today's single figure unchanged. The full-disk notices read the vault figure when the cell reports one.

### D5. Privacy copy states only the standard mode

The privacy page says that the cell encrypts each original before upload, that the store and the internal carrier see ciphertext, sizes and keyed names, that the key is wrapped under the cell root, and that we can unwrap that root, so the copy makes no claim that only the owner can read stored originals. It says that playing, downloading and exporting decrypt in the cell and pass the edge and gateway. It says that deletion retires the content keys and an operator step deletes stored copies after a grace of at least 7 days.

## Risks / Trade-offs

- A ticket lasts at most 10 minutes. A longer playback needs a new ticket, which the link supplies by redirecting again.
- Each redirect runs one short login transaction. The route is capped at 120 per minute per tenant.
- The ingress access log can record the query string. Redacting it is an ingress setting outside this repository.
