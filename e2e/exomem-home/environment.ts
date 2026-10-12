// The one description of the environment Home's end-to-end tests run in, shared by
// the launcher (serve.ts), the Playwright config and the specs.

export function homeE2eEnvironment() {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.EXOMEM_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Home's end-to-end tests need DATABASE_URL: a migrated test database.");
  }
  const port = Number(process.env.HOME_E2E_PORT ?? 3461);
  const cellPort = Number(process.env.HOME_E2E_CELL_PORT ?? 3462);
  const mcpUrl = `https://127.0.0.1:${cellPort}/mcp/v1`;
  return {
    databaseUrl,
    port,
    cellPort,
    baseUrl: `http://127.0.0.1:${port}`,
    controlPort: cellPort + 1,
    controlUrl: `http://127.0.0.1:${cellPort + 1}`,
    mcpUrl,
    serverEnv: {
      DATABASE_URL: databaseUrl,
      EXOMEM_CLOUD_MCP_URL: mcpUrl,
      EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
      EXOMEM_CLOUD_HOME_CHANNEL_ENABLED: "true",
      EXOMEM_CLOUD_EXPORTS_ENABLED: "true",
      EXOMEM_EXPORT_TTL_HOURS: "24",
      EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED: "true",
      // Emails carry links to this origin; no test opens them.
      EXOMEM_PUBLIC_BASE_URL: "https://app.example.test",
    },
  };
}
