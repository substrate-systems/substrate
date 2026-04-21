## 1. Route Implementation

- [ ] 1.1 Create `src/app/updates/latest.json/route.ts` with `runtime = 'nodejs'` and `revalidate = 300`.
- [ ] 1.2 Implement GET handler that fetches `https://github.com/Artexis10/endstate-gui/releases/latest/download/latest.json` with `next: { revalidate: 300 }`.
- [ ] 1.3 On upstream 2xx: parse JSON body and return it as-is via `NextResponse.json` with `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`.
- [ ] 1.4 On upstream non-2xx or fetch error: `console.error` with status code and URL, return `NextResponse.json({ error: 'manifest_unavailable' }, { status: 503 })`.

## 2. Verification

- [ ] 2.1 `npm run openspec:validate` passes in strict mode.
- [ ] 2.2 `npm run build` compiles with no TypeScript errors.
- [ ] 2.3 `npm run lint` passes.
- [ ] 2.4 Local smoke test: `npm run dev`, then `curl http://localhost:3000/updates/latest.json` returns 200 with a Tauri manifest containing `version` and `platforms["windows-x86_64"]` with `url` and `signature` fields.
- [ ] 2.5 Confirm `Cache-Control` response header matches `public, s-maxage=300, stale-while-revalidate=60`.
- [ ] 2.6 Negative test: force an upstream failure (e.g., temporarily point at a bogus URL in a scratch branch or mock) and confirm 503 + JSON error body. Optional if upstream is reliably reachable.

## 3. Release

- [ ] 3.1 Commit with `feat(updates): manifest endpoint for Endstate auto-updater`.
- [ ] 3.2 Hugo deploys manually via `cd /home/hugoa/projects/substrate && vercel --prod`.
- [ ] 3.3 Post-deploy: `curl https://substratesystems.io/updates/latest.json` returns 200 with current release manifest.
- [ ] 3.4 Archive the OpenSpec change: `openspec archive add-updater-manifest-endpoint` once deploy is verified.
