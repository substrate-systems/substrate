## Why

`/api/download` currently 302-redirects to `/downloads/endstate-latest.{exe,msi}` served from `public/downloads/`. That assumes a human manually drops the installers into `public/downloads/` before each deploy. With git-based auto-deploy to Vercel — which became the deploy path after the updater-manifest change — gitignored binaries never reach production at all, silently breaking the public download button on the Endstate page. Replacing the static redirect with a dynamic lookup against the `endstate-gui` GitHub Release API removes the staging step entirely and uses the same proxy-the-release pattern as `/updates/latest.json`.

## What Changes

- `/api/download` fetches the latest `endstate-gui` release metadata from the GitHub API on each request (edge-cached 5 minutes).
- The handler picks the asset whose filename matches the requested `format` (`exe` or `msi`, default `exe`) and 302-redirects to its `browser_download_url`.
- On upstream fetch failure or missing asset, returns `503` with `{ "error": "download_unavailable" }`.
- `export const dynamic = 'force-dynamic'` is removed; `runtime = 'nodejs'` stays.
- `/public/downloads/*.exe` and `*.msi` entries are removed from `.gitignore` since the directory no longer serves installers.
- `public/downloads/README.md` is rewritten to document the dynamic architecture (the directory stays as a historical marker).
- `/download` rewrite in `next.config.ts` is **unchanged**.

## Capabilities

### New Capabilities
- `download-redirect`: Serves the public installer download link, resolving the latest `endstate-gui` release asset on demand.

### Modified Capabilities
<!-- None — no existing specs cover the download route yet. -->

## Impact

- `src/app/api/download/route.ts` rewritten.
- `.gitignore` two lines removed.
- `public/downloads/README.md` rewritten.
- No database, env-var, or dependency changes.
- Outbound dependency added: `api.github.com` (cache miss only — 5-minute TTL).
