import { Client } from "pg";

const extensionLock: [number, number] = [481_516, 4_217];
const initializedDatabases = new Map<string, Promise<void>>();

async function ensureExtensionInPublic(client: Client, name: "citext" | "pgcrypto"): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS ${name} WITH SCHEMA public`);
  const result = await client.query<{ in_public: boolean }>(
    "SELECT extnamespace = 'public'::regnamespace AS in_public FROM pg_extension WHERE extname = $1",
    [name]
  );
  if (!result.rows[0]?.in_public) await client.query(`ALTER EXTENSION ${name} SET SCHEMA public`);
}

async function installExomemPostgresTestExtensions(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  let locked = false;

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", extensionLock);
    locked = true;
    await ensureExtensionInPublic(client, "citext");
    await ensureExtensionInPublic(client, "pgcrypto");
  } finally {
    if (locked)
      await client.query("SELECT pg_advisory_unlock($1, $2)", extensionLock).catch(() => undefined);
    await client.end();
  }
}

/**
 * Keep database-wide extensions outside per-suite schemas so isolated-schema
 * migrations can resolve their types and functions through `public`.
 *
 * Existing test databases can have an extension left in a private schema by
 * older isolated-suite runs; relocating it under the advisory lock repairs
 * that stale state before current suites start.
 */
export function ensureExomemPostgresTestExtensions(databaseUrl: string): Promise<void> {
  const existing = initializedDatabases.get(databaseUrl);
  if (existing) return existing;

  const initialization = installExomemPostgresTestExtensions(databaseUrl).catch((error) => {
    initializedDatabases.delete(databaseUrl);
    throw error;
  });
  initializedDatabases.set(databaseUrl, initialization);
  return initialization;
}
