// The one description of the environment Home's end-to-end tests run in, shared by
// the launcher (serve.ts), the Playwright config and the specs.

export function homeE2eAddress() {
  const port = Number(process.env.HOME_E2E_PORT ?? 3461);
  return { port, baseUrl: `http://localhost:${port}` };
}

export function homeE2eEnvironment() {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.EXOMEM_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Home's end-to-end tests need DATABASE_URL: a migrated test database.");
  }
  const { port, baseUrl } = homeE2eAddress();
  const cellPort = Number(process.env.HOME_E2E_CELL_PORT ?? 3462);
  const mcpUrl = `https://127.0.0.1:${cellPort}/mcp/v1`;
  const mailPort = cellPort + 2;
  // Only the Brevo stand-in accepts this key; it is not a secret.
  const mailApiKey = "home-e2e-brevo-key";
  // Only the isolated test scheduler accepts this value; it is not a secret.
  const schedulerSecret = "home-e2e-scheduler-key";
  return {
    databaseUrl,
    port,
    cellPort,
    baseUrl,
    controlPort: cellPort + 1,
    controlUrl: `http://127.0.0.1:${cellPort + 1}`,
    mcpUrl,
    mailPort,
    mailApiKey,
    schedulerSecret,
    mailUrl: `http://127.0.0.1:${mailPort}`,
    serverEnv: {
      DATABASE_URL: databaseUrl,
      EXOMEM_CLOUD_MCP_URL: mcpUrl,
      EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
      EXOMEM_CLOUD_HOME_CHANNEL_ENABLED: "true",
      EXOMEM_CLOUD_STORAGE_ENABLED: "true",
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_home_fixture",
      EXOMEM_PADDLE_PRODUCT_ID: "pro_" + "a".repeat(26),
      EXOMEM_PADDLE_PRICE_ID: "pri_" + "a".repeat(26),
      EXOMEM_PADDLE_STORAGE_PRICE_ID: "pri_" + "b".repeat(26),
      EXOMEM_CLOUD_VIEWER_ENABLED: "true",
      EXOMEM_CLOUD_EXPORTS_ENABLED: "true",
      EXOMEM_EXPORT_TTL_HOURS: "24",
      EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED: "true",
      // Emails carry links to this origin; a test opens a link's path on the test server.
      EXOMEM_PUBLIC_BASE_URL: process.env.EXOMEM_E2E_PUBLIC_BASE_URL ?? "https://app.example.test",
      // Rate limits and stored secrets key off this; a fixed test key, not a secret.
      EXOMEM_CONTROL_PLANE_KEY: Buffer.alloc(32, 0x5a).toString("base64url"),
      BREVO_API_KEY: mailApiKey,
      BREVO_API_BASE_URL: `http://127.0.0.1:${mailPort}/v3`,
      EXOMEM_HOSTED_SCHEDULER_SECRET: schedulerSecret,
    },
  };
}
