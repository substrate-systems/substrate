// The Exomem brand-kit favicon served as /favicon.ico on the Cloud MCP host, so
// clients that show a site icon for this server show Exomem's mark instead of the
// parent domain's. These are the bytes of public/exomem/icons/favicon.ico; the
// server test fails when that file changes and this copy does not. The image is
// embedded because the gateway image ships only the bundled script.
const FAVICON_BASE64 =
  "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";

export const FAVICON_PATH = "/favicon.ico";
export const FAVICON = Buffer.from(FAVICON_BASE64, "base64");
export const FAVICON_HEADERS = {
  "content-type": "image/x-icon",
  "content-length": String(FAVICON.length),
  "cache-control": "public, max-age=86400",
};
