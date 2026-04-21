# Endstate installer downloads

Installer binaries are **not** served from this directory. `/api/download`
resolves the latest `endstate-gui` GitHub Release on demand and 302-redirects
to the matching asset on GitHub's CDN. No per-deploy staging required.

## Flow

1. Browser hits `substratesystems.io/download` (or `/api/download?format=exe|msi`).
2. `next.config.ts` rewrites `/download` → `/api/download`.
3. `src/app/api/download/route.ts` fetches
   `https://api.github.com/repos/Artexis10/endstate-gui/releases/latest`
   (cached 5 minutes at the Vercel edge).
4. Handler picks the asset whose filename ends with `.exe` or `.msi` (never
   `.sig`) and 302-redirects to its `browser_download_url`.
5. Browser downloads directly from `github.com/.../releases/download/...`.

## Why this directory still exists

Kept so the path resolves if any historical link ever references it, and as a
home for this README documenting the architecture.

## Future: if GitHub becomes unsuitable

Swap the fetch target in `src/app/api/download/route.ts` to point at
Vercel Blob, Cloudflare R2, or another host. The public URL
(`/api/download`) stays the same.
