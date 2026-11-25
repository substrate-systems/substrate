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

The ticket is `<payload>.<mac>`. The MAC is HMAC-SHA-256 under `EXOMEM_CONTROL_PLANE_KEY` with its own domain label, so no other use of that key produces a ticket. The payload carries the purpose `download`, tenant, cell, the owner's first-party grant and login family, the SHA-256 of the exact path, and issue and expiry times. It names a login family and carries no bearer.

The ticket lives 4 hours by default, because a media element sends every later Range request to the address it first followed, and a long recording is watched over hours. `EXOMEM_CLOUD_DOWNLOAD_TICKET_LIFETIME_SECONDS` sets the life from 60 seconds to 24 hours. The app and the gateway read the same name, and both cap the life at signing and at verification. A gateway set shorter than the app refuses the longer ticket, so a mismatch fails closed. Both fail at start on a value outside the range.

The ticket's validity does not rest on a short-lived Home family. The gateway resolves the family on every request, and the shared lookup ends at the family's expiry. So the signer takes a family that outlives the ticket: it reuses the owner's Home family only when it has at least the ticket's life plus the two minutes that an access token needs, and otherwise opens a new 30-day family. Signing out, or revoking the owner's browser sessions, therefore never ends a ticket that was already issued. Only ending the grant does.

Alternative: a new signing key or a table of tickets. Rejected: a new secret and new state for no extra property, since the gateway re-checks the grant and family on every request. Alternative: a ticket that stays valid on the grant alone, with a second grant-only lookup in the gateway. Rejected: it duplicates the one SQL that decides who may act as an owner.

### D3. The gateway re-resolves the login on every request

On `GET /download` a ticket and a bearer together answer 400. A ticket must verify (MAC, expiry, path digest) before any login lookup or cell request; an invalid ticket pays the per-IP bucket and answers 401. A valid one takes the same per-tenant rate limit as the OAuth route, then a slot, then the gateway resolves the named login family through the existing OAuth lookup. That lookup covers revocation, client admission, tenant deletion, owner block and cell deletion. The login must be first-party, and its tenant and cell must match the ticket. The cell must be running or read-only. The gateway never logs the ticket. The OAuth branch and the ticket branch share one helper for the steps after the login is known.

The ticket opens only `GET /download` for its path. `/mcp`, `/upload` and any other path refuse it.

A download holds its slots for the length of the stream, so media downloads have their own per-process pool, `EXOMEM_GATEWAY_MAX_MEDIA_DOWNLOADS` (default 16, from 1 to 128), beside the pool that MCP calls use. The per-tenant cap of 4 stays on both. A full pool answers 429 with `Retry-After`, and a full media pool never refuses an MCP call. The stream also gives back the gateway server's own in-flight slot, which MCP shares.

A ticket response is hardened for a browser that follows a link to it: `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `content-security-policy: sandbox`. Content that is not audio or video is forced to `content-disposition: attachment`, keeping the cell's filename. Audio and video keep the cell's disposition. The closed set `audio`, `video` is the top-level media types of RFC 6838.

The app route admits a link that the owner follows from another site, such as one shown in a web chat client: a cross-site request whose fetch metadata says navigate to a document. It refuses every other cross-site request. The admitted request only navigates to the gateway, whose answer is an attachment under a sandbox policy that the other site cannot read.

### D4. Two storage figures, each against its own limit

Migration 0095 adds `vault_used_bytes`, `media_used_bytes`, `media_allowance_bytes` and `media_usage_observed_at`. A CHECK ties every figure to its read time, and every figure is at least zero. cellctl alone writes them, through a guarded column grant that the grants script re-applies after each migration. `used_bytes` keeps its meaning.

Home reads them in the status poll. When `media_usage_observed_at` is set, Home shows "Vault storage" against the volume and "Media storage" against the allowance, and a figure that is NULL shows as unknown, never as zero. When all four are NULL, Home shows today's single figure unchanged. The full-disk notices read the vault figure when the cell reports one.

### D5. Privacy copy states the standard mode and the automatic purge

The privacy page says that the cell encrypts each original before upload, that the store and the internal carrier see ciphertext, sizes and keyed names, that the key is wrapped under the cell root, and that we can unwrap that root, so the copy makes no claim that only the owner can read stored originals. It says that playing, downloading and exporting decrypt in the cell and pass the edge and gateway.

On deletion, the content keys retire first. The systems then hide the stored copies when the 7-day deletion grace ends, with no manual step, and the object store deletes the hidden copies 14 days later (`cloud-cell-storage-deletion`). The page says about 21 days after the deletion. It names the object store's provider but says nothing about the media bucket's region, and it does not imply that the originals share the backups' EU region.

## Risks / Trade-offs

- A 4-hour ticket sits in the address bar, the browser history and any access log, so it behaves like a bearer for its path. The path digest, `no-referrer`, the per-request grant and family check, the attachment and sandbox headers, and grant revocation bound it. Redacting the ingress access log's query string is an ingress setting outside this repository (task 4.2).
- Each redirect runs one short login transaction. The route is capped at 120 per minute per tenant.
- There is no in-app player yet. A top-level link downloads the file. Playing and seeking in the browser needs a same-origin player page, which is a follow-up (task 4.3).
