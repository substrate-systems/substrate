import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Pretty public URL for the Endstate installer. Served by the
      // /api/download route which 302s to the current artifact.
      { source: "/download", destination: "/api/download" },
    ];
  },
};

export default nextConfig;
