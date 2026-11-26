## Why

A Cloud cell can keep stored originals, such as recordings and videos, in a separate object store, and evict the cached copy from its disk. Today the owner has no way to open an evicted recording from the browser, Home cannot show the two storage figures that follow, and the privacy page does not mention the media store.

## What Changes

- Add a signed-in browser download route. It authenticates the session, resolves the tenant's serving cell from the session only, and redirects to the gateway's `GET /download` with a short-lived download ticket. Media bytes never pass through the Next.js app.
- The gateway accepts that ticket on `GET /download` as an alternative to the OAuth bearer and runs the same per-request checks.
- Add four nullable columns to `exomem_cloud_cells` for the vault and media storage figures, writable only by cellctl, and show them in Home.
- Name the media store and its standard-mode key custody on the Cloud privacy page.

## Capabilities

### New Capabilities

### Modified Capabilities

- `exomem-hosted-gateway`: Add the download ticket and the signed-in download route.
- `exomem-tenant-control-plane`: Add the cell's observed vault and media storage figures.
- `exomem-home`: Show the two storage figures, each as known or unknown.

## Impact

The gateway, a Next API route, the Home status read and Storage card, the Cloud privacy page, one migration and the Cloud grants script change. The migration only adds nullable columns, so older code is unaffected and a revert leaves them unused. cellctl writes the columns after this change deploys; until then Home shows the whole-volume figure as before.
