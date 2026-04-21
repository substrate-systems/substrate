## Context

The Endstate GUI ships with a Tauri auto-updater configured to poll `https://substratesystems.io/updates/latest.json` on every launch. The `endstate-gui` release pipeline already produces a signed Tauri updater manifest (`latest.json`) and attaches it to each GitHub Release as a named asset. The substrate landing page (this repo) owns the `substratesystems.io` domain and is the natural host for the manifest endpoint.

Serving the manifest directly from this repo — rather than pointing the updater at `github.com` — keeps the public domain stable across release-asset URL changes and gives us an edge-cache choke point that isolates GitHub rate limits from real user launch traffic. The upstream asset URL is `https://github.com/Artexis10/endstate-gui/releases/latest/download/latest.json`.

## Goals / Non-Goals

**Goals:**
- Serve the Tauri updater manifest at `/updates/latest.json` with the exact body published by the `endstate-gui` release pipeline.
- Cache responses at the Vercel edge for 5 minutes to absorb launch-time polling bursts.
- Fail loudly with a 503 when the upstream asset is unreachable, so dashboards surface outages instead of silently serving stale manifests.

**Non-Goals:**
- Constructing the manifest ourselves from GitHub release metadata.
- Adding authentication, rate limiting, or request validation.
- Transforming, filtering, or re-signing any field of the upstream manifest.
- Supporting multiple release channels (beta, nightly) at this stage.

## Decisions

**Proxy the prebuilt asset instead of using GitHub's release API.**
The release pipeline already produces a correctly signed Tauri manifest — fetching the raw `latest.json` asset is simpler, matches the signed artifact byte-for-byte, and avoids a second code path that could drift from the signing process. Alternative considered: call `api.github.com/repos/.../releases/latest` and reassemble the manifest. Rejected because it duplicates release-pipeline logic in the landing repo and would require storing the signing key here.

**Edge caching via `next: { revalidate: 300 }` + `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`.**
Tauri updaters poll on launch, so cache hits are the common case. 5 minutes is short enough that a release published at T+0 reaches all clients by T+5, and SWR=60 means a cache miss never blocks the updater on a cold GitHub fetch. Alternative considered: `force-dynamic` with no cache. Rejected because it sends every launch straight to GitHub.

**503 on upstream failure, not 502 or cached-stale.**
503 is the standard "temporarily unavailable, try again later" signal. Tauri's updater already treats non-200s as "no update available" and proceeds, so a 503 is recoverable. Alternative considered: serving the last-known-good body from a stored copy. Rejected because it adds stateful infrastructure for a failure mode that is already handled gracefully by the client.

## Risks / Trade-offs

- **[Risk] GitHub release asset URL changes** → Mitigation: the `/download/latest.json` pattern is stable across GitHub's history; if it changes, the 503 failure mode is non-destructive and gives us time to adapt.
- **[Risk] Stale manifest served during release rollout window** → Mitigation: 5-minute edge cache is acceptable; releases are not time-critical enough to require instant propagation.
- **[Risk] Upstream 404 on a new repo or moved releases** → Mitigation: 503 surfaces the problem in Vercel logs; the `console.error` call carries status code and URL for debugging.

## Migration Plan

1. Merge change, deploy to Vercel production.
2. `curl https://substratesystems.io/updates/latest.json` to confirm 200 + valid manifest.
3. No client-side migration needed — existing installed GUI builds already poll this URL.
4. Rollback: revert the route file; the URL returns 404 again, which is the pre-change state (updater silently handles it).
