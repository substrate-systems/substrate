## Context

`src/app/api/download/route.ts` currently builds a same-origin URL `/downloads/endstate-latest.{format}` and 302-redirects to it. The files were staged manually into `public/downloads/` per deploy. After switching to git-based auto-deploy (following the `/updates/latest.json` change), gitignored binaries never reach Vercel's build context, so the redirect lands on a 404.

The `endstate-gui` release pipeline already publishes the installers as GitHub Release assets with deterministic filenames (`Endstate_<version>_x64-setup.exe`, `Endstate_<version>_x64_en-US.msi`). The GitHub REST API exposes `browser_download_url` on each asset. Proxying that — mirroring the pattern used by `/updates/latest.json` — removes the staging step entirely.

## Goals / Non-Goals

**Goals:**
- First-time buyers land on a current installer without anyone remembering to stage binaries per release.
- Consistent architecture with `/updates/latest.json`: proxy GitHub, edge-cache 5 minutes, 503 on upstream failure.
- Eliminate gitignored-binary footguns.

**Non-Goals:**
- Versioned download URLs (e.g. `/api/download?version=1.7.1`) — always latest.
- Authentication, rate limiting, or analytics on the redirect.
- Multi-channel support (beta, nightly) — single stable channel only.
- Serving the installer bytes through Vercel — we redirect to GitHub's CDN.

## Decisions

**Use GitHub's REST API, not the `/releases/latest/download/<asset>` pattern.**
The manifest endpoint uses the `/releases/latest/download/latest.json` URL because `latest.json` has a stable filename. Installer filenames contain the version (`Endstate_1.7.2_x64-setup.exe`), so we can't hardcode them. Calling `GET /repos/:owner/:repo/releases/latest` returns the full asset list from which we pick the right file by extension. Alternative considered: a fixed-name wrapper like `endstate-latest.exe` attached to each release. Rejected because `tauri-action`'s default artifact naming would have to be patched per release.

**Pick assets by extension, excluding `.sig`.**
Tauri release assets include signature files named `<installer>.sig`. A naive "ends with `.exe`" match could, in theory, grab a `.exe.sig` — unlikely but cheap to rule out. The match is: `name.endsWith('.' + format) && !name.endsWith('.sig')`.

**302 redirect, not server-side streaming.**
A stream would proxy multi-MB bytes through Vercel on every click, burning bandwidth quota for no user benefit. The redirect sends the browser straight to GitHub's CDN. Alternative considered: `NextResponse.rewrite` or piping the body. Rejected for cost and correctness (range requests, resume, etc., are GitHub's problem now).

**`next: { revalidate: 300 }` on the metadata fetch.**
Matches `/updates/latest.json`. 5 minutes is fast enough that a release published at T+0 reaches users by T+5 and slow enough to stay inside GitHub's unauthenticated API rate limit (60 req/hr/IP). The Vercel edge IP pool handles production load; local dev will cache-miss on each restart but never hot-loop.

**Remove `export const dynamic = 'force-dynamic'`.**
That directive was irrelevant for a pure same-origin redirect but would fight our fetch-level caching now. Keeping only `runtime = 'nodejs'` lets Next.js cache the upstream fetch.

## Risks / Trade-offs

- **[Risk] GitHub unauth API rate limit (60/hr/IP)** → Mitigation: 5-minute edge cache means one miss → 12 cache-hits/hr on average. Production traffic from Vercel's edge pool easily fits. If abuse becomes real we can add a token or switch to `/releases/latest/download/<glob>` with stable-named wrappers.
- **[Risk] Asset filename scheme changes in `endstate-gui`** → Mitigation: 503 is non-destructive. We'd see it in Vercel logs and adapt.
- **[Risk] GitHub returns no matching asset (e.g. a draft release, or MSI-only release)** → Mitigation: 503 with `download_unavailable` is the correct signal; the download page can later surface a friendly message. Out of scope for this change.

## Migration Plan

1. Merge change; Vercel auto-deploys.
2. `curl -I https://substratesystems.io/api/download` → expect 302 to `github.com/Artexis10/endstate-gui/releases/download/gui-v*/Endstate_*_x64-setup.exe`.
3. `curl -I https://substratesystems.io/api/download?format=msi` → expect 302 to the matching `.msi`.
4. Rollback: revert the route file. The pre-change behavior (404 because `public/downloads/` is empty) returns — still broken, but no worse than today.
5. Post-deploy archive OpenSpec change.
