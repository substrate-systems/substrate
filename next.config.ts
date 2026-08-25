import type { NextConfig } from "next";

// Keep in sync with src/app/providers.tsx — the SDK posts to /ingest and these
// rewrites forward to whichever PostHog region is configured.
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * PostHog serves the SDK bundle and session assets from a sibling `-assets`
 * host (us.i.posthog.com -> us-assets.i.posthog.com). Derived rather than
 * hardcoded so switching regions only means changing the env var.
 */
function assetsHost(host: string): string {
  return host.replace(
    /^(https:\/\/)([a-z0-9-]+)\.i\.posthog\.com$/,
    (_match, scheme: string, region: string) => `${scheme}${region}-assets.i.posthog.com`
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PostHog's ingest endpoints are trailing-slash sensitive; Next's default
  // redirect would break the proxied requests.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      // Pretty public URL for the Endstate installer. Served by the
      // /api/download route which 302s to the current artifact.
      { source: "/download", destination: "/api/download" },
      // OIDC Discovery 1.0 §3 / RFC 8414 §3 require the discovery doc to
      // live at `${issuer}/.well-known/openid-configuration`. The route
      // handlers live under /api/.well-known/* (Next App Router); this
      // rewrite makes the public URL match the issuer claim.
      { source: "/.well-known/:path*", destination: "/api/.well-known/:path*" },
      // Same-origin analytics ingest. Assets rule must precede the catch-all.
      { source: "/ingest/static/:path*", destination: `${assetsHost(POSTHOG_HOST)}/static/:path*` },
      { source: "/ingest/:path*", destination: `${POSTHOG_HOST}/:path*` },
    ];
  },
  async headers() {
    const privateHeaders = [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ];
    return [
      { source: "/exomem/operator", headers: privateHeaders },
      { source: "/api/exomem/admin/:path*", headers: privateHeaders },
    ];
  },
};

export default nextConfig;
