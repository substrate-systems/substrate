# Endstate installer downloads

This directory holds the Windows installer artifacts served by the public
`/api/download` redirect endpoint and linked from `substratesystems.io/download`.

## Expected files

- `endstate-latest.exe` — latest Windows EXE installer
- `endstate-latest.msi` — latest Windows MSI installer

Both filenames are stable. The redirect endpoint hardcodes these paths so the
public URL never changes when a new release is cut.

## How to update

Before each deploy that ships a new Endstate build:

1. Download the latest `endstate-*.exe` and `endstate-*.msi` from the
   [endstate-gui GitHub Releases](https://github.com/Artexis10/endstate-gui/releases).
2. Rename them to `endstate-latest.exe` and `endstate-latest.msi`.
3. Place them in this directory (`public/downloads/`).
4. Deploy to Vercel. Files in `public/` are served as static assets from the
   deployment's filesystem.

## Why binaries are not committed

`.exe` and `.msi` files in this directory are gitignored so the repo does not
bloat with multi-MB artifacts. The installer build is produced by
`release-please.yml` in the `endstate-gui` repo and is the source of truth.

## Future

When artifacts outgrow the Vercel deployment size limit, move hosting to
Vercel Blob or Cloudflare R2 and update the redirect target in
`src/app/api/download/route.ts`. The public URL (`/api/download`) stays the
same.
