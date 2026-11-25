/**
 * The accepted Cloud resource list, `EXOMEM_CLOUD_MCP_URLS`: comma-separated, newest first.
 * Each entry is an HTTPS URL written in canonical form (`https://host/path`, lower-case host,
 * no port, no query, no fragment) on the gateway's mount path; the list has no duplicates and
 * still holds `EXOMEM_CLOUD_MCP_URL`, so a configuration change cannot strand the tokens issued
 * for it.
 *
 * The web app's build (next.config.ts) and the gateway's readiness check refuse a list this
 * module rejects, so a bad list stops a deploy instead of quietly narrowing what the Cloud
 * accepts. next.config.ts imports this file, so it has no imports of its own.
 */

type Env = Record<string, string | undefined>;

export function listedCloudResources(env: Env): string[] {
  return (env.EXOMEM_CLOUD_MCP_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Why the configured list is unusable, or null when it is unset or valid. */
export function cloudResourceListProblem(env: Env): string | null {
  const listed = listedCloudResources(env);
  if (!listed.length) return null;
  const mcpUrl = env.EXOMEM_CLOUD_MCP_URL?.trim();
  const mcpPath = env.EXOMEM_CLOUD_MCP_PATH?.trim();
  for (const entry of listed) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return `EXOMEM_CLOUD_MCP_URLS entry ${JSON.stringify(entry)} is not a URL`;
    }
    if (url.protocol !== "https:" || url.search || url.hash || url.port) {
      return `EXOMEM_CLOUD_MCP_URLS entry ${JSON.stringify(entry)} must be an https URL with no port, query or fragment`;
    }
    if (mcpPath && url.pathname !== mcpPath) {
      return `EXOMEM_CLOUD_MCP_URLS entry ${JSON.stringify(entry)} must use the path ${mcpPath}`;
    }
    if (`${url.origin}${url.pathname}` !== entry) {
      return `EXOMEM_CLOUD_MCP_URLS entry ${JSON.stringify(entry)} must be written as ${url.origin}${url.pathname}`;
    }
  }
  if (new Set(listed).size !== listed.length) return "EXOMEM_CLOUD_MCP_URLS lists an entry twice";
  if (mcpUrl && !listed.includes(mcpUrl)) {
    return "EXOMEM_CLOUD_MCP_URLS must include EXOMEM_CLOUD_MCP_URL";
  }
  return null;
}

/** Throws with the reason when the configured list is unusable. */
export function assertCloudResourceList(env: Env): void {
  const problem = cloudResourceListProblem(env);
  if (problem) throw new Error(problem);
}
