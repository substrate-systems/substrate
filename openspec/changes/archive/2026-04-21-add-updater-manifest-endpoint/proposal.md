## Why

The Endstate GUI's Tauri auto-updater checks `https://substratesystems.io/updates/latest.json` on every launch, but that URL currently returns 404. Installed GUI builds (verified on `gui-v1.7.2`) cannot discover new releases until we serve the Tauri updater manifest from that path. The `endstate-gui` release pipeline already publishes a prebuilt, signed `latest.json` as a GitHub Release asset, so the substrate landing site needs only to proxy that asset at the expected URL.

## What Changes

- Add a new route at `/updates/latest.json` served by the Next.js app in this repo.
- The route proxies `https://github.com/Artexis10/endstate-gui/releases/latest/download/latest.json` and returns its body unchanged.
- Response is edge-cached for 5 minutes with stale-while-revalidate of 60 seconds to absorb launch-time polling traffic.
- Upstream fetch failures surface as `503` with a plain JSON error body; the Tauri updater silently handles this and retries next launch.
- No authentication, rate limiting, or field transformation — the endpoint is a pure proxy.

## Capabilities

### New Capabilities
- `updater-manifest`: Serves the Tauri updater manifest for the Endstate GUI auto-updater.

### Modified Capabilities
<!-- None — no existing specs affected. -->

## Impact

- New route file `src/app/updates/latest.json/route.ts`.
- Outbound fetch to `github.com` release CDN on cache miss (every 5 minutes worst case).
- No database, auth, or environment-variable changes.
- No changes to `next.config.ts` rewrites — the endpoint lives natively at `/updates/latest.json`.
