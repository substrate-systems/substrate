## 1. Route Implementation

- [ ] 1.1 Rewrite `src/app/api/download/route.ts` to fetch `https://api.github.com/repos/Artexis10/endstate-gui/releases/latest` with `next: { revalidate: 300 }`, sending `Accept: application/vnd.github+json` and a `User-Agent`.
- [ ] 1.2 Validate `format` query param against `{exe, msi}` with `exe` as default.
- [ ] 1.3 Pick the first release asset whose `name` ends with `.<format>` and not `.sig`; 302-redirect to its `browser_download_url`.
- [ ] 1.4 On upstream non-2xx, fetch throw, or no matching asset: `console.error` with context; return `NextResponse.json({ error: 'download_unavailable' }, { status: 503 })`.
- [ ] 1.5 Remove `export const dynamic = 'force-dynamic'`. Keep `export const runtime = 'nodejs'`.

## 2. Cleanup

- [ ] 2.1 Remove `/public/downloads/*.exe` and `/public/downloads/*.msi` lines from `.gitignore`.
- [ ] 2.2 Rewrite `public/downloads/README.md` to document the new dynamic redirect; keep file so directory exists.

## 3. Verification

- [ ] 3.1 `npm run openspec:validate` passes strict.
- [ ] 3.2 `npm run build` succeeds.
- [ ] 3.3 `npm run dev`, then `curl -I http://localhost:3000/api/download` → `HTTP/1.1 302` with `Location:` matching `https://github.com/Artexis10/endstate-gui/releases/download/gui-v*/Endstate_*_x64-setup.exe`.
- [ ] 3.4 `curl -I http://localhost:3000/api/download?format=msi` → 302 to the `.msi` asset.
- [ ] 3.5 `curl -I http://localhost:3000/api/download?format=exe` → 302 to the `.exe` asset (same as default).

## 4. Release

- [ ] 4.1 Commit: `feat(download): dynamic redirect to latest github release asset`.
- [ ] 4.2 Hugo reviews diff before push.
- [ ] 4.3 Push to `main`; Vercel auto-deploys.
- [ ] 4.4 Post-deploy: `curl -I https://substratesystems.io/api/download` returns 302 to current `.exe`.
- [ ] 4.5 Archive: `npx openspec archive add-dynamic-download-redirect`.
