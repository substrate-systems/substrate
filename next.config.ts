import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
    ];
  },
};

export default nextConfig;
