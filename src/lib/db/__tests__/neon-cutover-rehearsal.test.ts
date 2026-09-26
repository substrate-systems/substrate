import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client, Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  readPasswordFile,
  readPasswords,
  runCutover,
  type CutoverEnv,
  type NeonTransport,
} from "../../../../scripts/neon-cutover";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
} from "../../exomem-hosted/db";
import { redeemCloudInviteAtomic } from "../../exomem-hosted/cloud-admission";
import {
  claimPaddleEventProcessing,
  getJwksKeys,
  listBackupsForUser,
  listChunksForVersion,
  listVersions,
} from "../../hosted-backup/db";
import { __resetPgSqlPoolForTests } from "../pg-sql";

// Task 4.1 (design D8): the Neon-to-self-hosted cutover, rehearsed end to end
// against two disposable local containers. A PostgreSQL 16 source stands in
// for Neon: a NOSUPERUSER, CREATEROLE admin owns the database the way
// Neon's neondb_owner does, and the website's role ran the migrations and
// owns the schema. A PostgreSQL 17 target is set up the way
// infra/ansible/roles/postgres sets up the control server: four NOSUPERUSER
// roles, and exomem_control owned by substrate_owner.
//
// The admin also plays Neon's owner role, which a consumer logs in as, so
// the freeze resets its password through Neon's API. A fake Neon control
// plane applies each reset to the source container, and creates the dump
// role there when create-dump-role asks for it.
//
// Opt-in: it needs Docker and pulls postgres:16 and postgres:17.
//   npm run rehearse:neon-cutover
// Containers are named <prefix>-*, with the prefix from
// NEON_CUTOVER_REHEARSAL_CONTAINER_PREFIX (default cutover-rehearsal).

const enabled = process.env.RUN_NEON_CUTOVER_REHEARSAL === "1";
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(__dirname, "../../../..");
const SEED_SQL = join(__dirname, "fixtures", "neon-cutover-seed.sql");

const rand = randomBytes(4).toString("hex");
const PREFIX = process.env.NEON_CUTOVER_REHEARSAL_CONTAINER_PREFIX || "cutover-rehearsal";
const SRC_CONTAINER = `${PREFIX}-src-${rand}`;
const DST_CONTAINER = `${PREFIX}-dst-${rand}`;
const secret = (): string => randomBytes(18).toString("base64url");
const PW = {
  srcSuper: secret(),
  dstSuper: secret(),
  admin: secret(),
  web: secret(),
  gateway: secret(),
  owner: secret(),
  app: secret(),
  exomemGateway: secret(),
  cellctl: secret(),
};
const DUMP_ROLE = "neon_cutover_dump";

// Every table seeded because it carries Endstate, Paddle or OAuth state (or
// the Cloud tables the grants script governs), plus the type probe.
const SEEDED_TABLES = [
  "users",
  "auth_credentials",
  "refresh_tokens",
  "signing_keys",
  "account_sessions",
  "claim_tokens",
  "recovery_tokens_used",
  "redeemed_browser_session_jtis",
  "audit_log_account_deletions",
  "backups",
  "backup_versions",
  "backup_chunks",
  "backup_version_operations",
  "r2_purge_queue",
  "rate_limit_events",
  "subscriptions",
  "paddle_webhook_events",
  "paddle_cancellation_tombstones",
  "supporter_contributions",
  "supporter_email_outbox",
  "exomem_tenants",
  "exomem_entitlements",
  "exomem_paddle_events",
  "exomem_sessions",
  "exomem_invites",
  "exomem_oauth_clients",
  "exomem_oauth_admitted_cimd_hosts",
  "exomem_oauth_authorization_transactions",
  "exomem_oauth_grants",
  "exomem_oauth_authorization_codes",
  "exomem_oauth_token_families",
  "exomem_oauth_access_tokens",
  "exomem_oauth_refresh_tokens",
  "exomem_oauth_account_blocks",
  "exomem_cloud_cells",
  "exomem_cloud_capacity",
  "exomem_cloud_settings",
  "exomem_cloud_rollout",
  "exomem_rate_limit_buckets",
  "hosted_backup_generation_visibility_policy",
  "cutover_rehearsal_types",
] as const;
const C1_TABLES = [
  "exomem_cloud_cells",
  "exomem_cloud_settings",
  "exomem_cloud_capacity",
  "exomem_cloud_rollout",
] as const;
const ENDSTATE_USER = "00000000-0000-4000-8000-000000000001";
const ENDSTATE_BACKUP = "00000000-0000-4000-8000-000000000301";
const ENDSTATE_VERSION = "00000000-0000-4000-8000-000000000302";
const PROCESSED_PADDLE_EVENT = "evt_01rehearsalprocessed";
const OPEN_INVITE_DIGEST = Buffer.alloc(32, 0x0d);

let srcPort = 0;
let dstPort = 0;
let workDir = "";
let binDir = "";
let archive = "";
const clients: Array<Client | Pool> = [];

function url(port: number, user: string, password: string, database: string): string {
  return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?sslmode=disable`;
}
const srcSuperUrl = (db = "neondb") => url(srcPort, "postgres", PW.srcSuper, db);
const dstSuperUrl = (db = "exomem_control") => url(dstPort, "postgres", PW.dstSuper, db);
const adminUrl = () => url(srcPort, "cutover_admin", PW.admin, "neondb");
const webUrl = () => url(srcPort, "substrate_web", PW.web, "neondb");
const legacyGatewayUrl = () => url(srcPort, "exomem_hosted_gateway", PW.gateway, "neondb");
const ownerUrl = () => url(dstPort, "substrate_owner", PW.owner, "exomem_control");
const appUrl = () => url(dstPort, "substrate_app", PW.app, "exomem_control");
const cellctlUrl = () => url(dstPort, "exomem_cellctl", PW.cellctl, "exomem_control");
const gatewayUrl = () => url(dstPort, "exomem_gateway", PW.exomemGateway, "exomem_control");

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function startPostgres(name: string, image: string, password: string): Promise<number> {
  await docker(
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-p",
    "127.0.0.1::5432",
    image
  );
  const published = await docker("port", name, "5432/tcp");
  const port = Number(published.split("\n")[0]!.split(":").pop());
  // The image's init phase runs its temporary server on the unix socket
  // only, so the first successful TCP connection is the final server.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const probe = new Client({ connectionString: url(port, "postgres", password, "postgres") });
    try {
      await probe.connect();
      await probe.end();
      return port;
    } catch (error) {
      await probe.end().catch(() => undefined);
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}

async function connected(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  await client.connect();
  clients.push(client);
  return client;
}

async function once<T>(connectionString: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A source session that may write although the source is frozen: the read-only default is only a default. */
async function onFrozenSource<T>(work: (client: Client) => Promise<T>): Promise<T> {
  return once(srcSuperUrl(), async (client) => {
    await client.query("SET default_transaction_read_only = off");
    return work(client);
  });
}

const NEON_API_KEY = `neon-rehearsal-key-${rand}`;

function cutoverEnv(): CutoverEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CUTOVER_SOURCE_ADMIN_URL: adminUrl(),
    CUTOVER_TARGET_OWNER_URL: ownerUrl(),
    CUTOVER_ROLE_URL_SUBSTRATE_WEB: webUrl(),
    CUTOVER_ROLE_URL_EXOMEM_HOSTED_GATEWAY: legacyGatewayUrl(),
    CUTOVER_ROLE_URL_CUTOVER_ADMIN: adminUrl(),
    NEON_API_KEY,
    NEON_PROJECT_ID: "rehearsal-project",
    NEON_BRANCH_ID: "br-rehearsal",
    // A local host has no ep-... label, so the endpoint is named here.
    NEON_ENDPOINT_ID: "ep-rehearsal",
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Sets `role`'s password on the source as Neon's control plane would. */
const applyPassword = (role: string, password: string) =>
  onFrozenSource((client) =>
    client.query(
      `ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(password)}`
    )
  );

// A fake Neon control plane with the documented response shapes. A role
// creation (201) or a password reset sets a new random password on the
// compute and returns it with a running operation, which reports finished
// on its second poll.
let neonResets = 0;
let neonCreates = 0;
const operationPolls = new Map<string, number>();
const fakeNeon: NeonTransport = async (path, init) => {
  if (path === "/projects/rehearsal-project/endpoints/ep-rehearsal") {
    return json(200, {
      endpoint: { id: "ep-rehearsal", project_id: "rehearsal-project", branch_id: "br-rehearsal" },
    });
  }
  if (path === "/projects/rehearsal-project/branches/br-rehearsal/roles" && init?.method === "POST") {
    neonCreates += 1;
    const name = (JSON.parse(String(init.body)) as { role: { name: string } }).role.name;
    const password = `npg_${randomBytes(12).toString("base64url")}`;
    const exists = await onFrozenSource((client) =>
      client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])
    );
    if (exists.rowCount) return json(409, { code: "CONFLICT", message: "role already exists" });
    await onFrozenSource((client) =>
      client.query(
        `CREATE ROLE ${client.escapeIdentifier(name)} LOGIN PASSWORD ${client.escapeLiteral(password)}`
      )
    );
    return json(201, {
      role: { branch_id: "br-rehearsal", name, password, protected: false },
      operations: [{ id: `op-create-${neonCreates}`, action: "apply_config", status: "running" }],
    });
  }
  const reset =
    /^\/projects\/rehearsal-project\/branches\/br-rehearsal\/roles\/([^/]+)\/reset_password$/.exec(
      path
    );
  if (reset && init?.method === "POST") {
    neonResets += 1;
    const role = decodeURIComponent(reset[1]!);
    const password = `npg_${randomBytes(12).toString("base64url")}`;
    await applyPassword(role, password);
    return json(200, {
      role: { branch_id: "br-rehearsal", name: role, password, protected: false },
      operations: [{ id: `op-reset-${neonResets}`, action: "apply_config", status: "running" }],
    });
  }
  const operation = /^\/projects\/rehearsal-project\/operations\/([^/]+)$/.exec(path);
  if (operation && (init?.method ?? "GET") === "GET") {
    const polls = (operationPolls.get(operation[1]!) ?? 0) + 1;
    operationPolls.set(operation[1]!, polls);
    return json(200, {
      operation: { id: operation[1], status: polls > 1 ? "finished" : "running" },
    });
  }
  return json(404, { request_id: "rehearsal", code: "NOT_FOUND", message: `no route ${path}` });
};

async function cutover(
  args: string[],
  env: CutoverEnv = cutoverEnv()
): Promise<{ code: number; output: string; stdout: string }> {
  const lines: string[] = [];
  const written: string[] = [];
  const code = await runCutover(
    args,
    env,
    {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      stdout: { isTTY: false, write: (text) => written.push(text) },
    },
    { neonTransport: fakeNeon }
  );
  // The operator's view of each phase is the rehearsal's evidence; stdout
  // carries switch-back-url's password and is never printed.
  console.log(`$ neon-cutover ${args.join(" ")}  -> exit ${code}\n${lines.join("\n")}\n`);
  return { code, output: lines.join("\n"), stdout: written.join("") };
}

// cutover_admin stands in for the owner role, which a consumer logs in as.
const APP_ROLES = "--app-roles=substrate_web,exomem_hosted_gateway,cutover_admin";
const passwordFile = () => join(workDir, "neon-passwords.jsonl");
const FILE = () => `--password-file=${passwordFile()}`;
const ROLES = () => [APP_ROLES, FILE()];
const rotatedAdminPassword = (): string => readPasswords(passwordFile()).get("cutover_admin")!;
const rotatedAdminUrl = () => url(srcPort, "cutover_admin", rotatedAdminPassword(), "neondb");
const dumpPassword = (file = passwordFile()): string => readPasswords(file).get(DUMP_ROLE)!;
const dumpUrl = (db = "neondb", file = passwordFile()) => url(srcPort, DUMP_ROLE, dumpPassword(file), db);
const aclRecords = (file = passwordFile()) =>
  readPasswordFile(file).entries.filter((entry) => "datacl" in entry);
const refusedWith = (code: string) => (error: { code?: string }) => error.code === code;

/** `connectionString` with the read-only default overridden, the way a misbehaving consumer could. */
function readWrite(connectionString: string): string {
  const target = new URL(connectionString);
  target.searchParams.set("options", "-c default_transaction_read_only=off");
  return target.toString();
}

/** Connects as `connectionString`'s role, overriding the read-only default, and writes. */
async function writeAs(connectionString: string, key = "late-write"): Promise<void> {
  await once(readWrite(connectionString), async (client) => {
    await client.query("INSERT INTO rate_limit_events (scope, key) VALUES ('cutover-probe', $1)", [
      key,
    ]);
  });
}

/** A consumer that reconnects and writes every 100 ms, as a retrying serverless function would. */
function reconnectingWriter(connectionString: string) {
  let running = true;
  const writes: number[] = [];
  const refusals = new Set<string>();
  let tries = 0;
  const loop = (async () => {
    while (running) {
      tries += 1;
      try {
        await writeAs(connectionString, "reconnecting");
        writes.push(Date.now());
      } catch (error) {
        refusals.add((error as { code?: string }).code ?? "no SQLSTATE");
      }
      await new Promise((done) => setTimeout(done, 100));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { tries, writes, refusals };
    },
  };
}

/** A database's effective ACL, one `grantee=PRIVILEGE[*]/grantor` line per entry, sorted. */
async function aclEntries(db: string): Promise<string[]> {
  return once(url(srcPort, "postgres", PW.srcSuper, "postgres"), async (client) => {
    const { rows } = await client.query<{ entry: string }>(
      `SELECT coalesce((SELECT rolname FROM pg_roles WHERE oid = a.grantee), 'PUBLIC') || '=' ||
              a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END || '/' ||
              (SELECT rolname FROM pg_roles WHERE oid = a.grantor) AS entry
       FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
       WHERE d.datname = $1 ORDER BY 1`,
      [db]
    );
    return rows.map((row) => row.entry);
  });
}

/** What the freeze changes on `db`: its ACL and its read-only default. */
async function lockState(db: string) {
  const acl = await aclEntries(db);
  const readOnly = await once(url(srcPort, "postgres", PW.srcSuper, db), async (client) => {
    const { rows } = await client.query<{ value: string }>(
      "SELECT current_setting('default_transaction_read_only') AS value"
    );
    return rows[0]!.value;
  });
  return { acl, readOnly };
}

const connectGrantees = (acl: string[]) =>
  acl.filter((entry) => /=CONNECT\*?\//.test(entry)).map((entry) => entry.split("=")[0]);

async function tablePrivileges(role: string, tables: readonly string[]) {
  return once(ownerUrl(), async (client) => {
    const { rows } = await client.query<{
      relname: string;
      s: boolean;
      i: boolean;
      u: boolean;
      d: boolean;
    }>(
      `SELECT c.relname,
              has_table_privilege($1, c.oid, 'SELECT') AS s, has_table_privilege($1, c.oid, 'INSERT') AS i,
              has_table_privilege($1, c.oid, 'UPDATE') AS u, has_table_privilege($1, c.oid, 'DELETE') AS d
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($2::text[])`,
      [role, tables]
    );
    return new Map(rows.map((row) => [row.relname, row]));
  });
}

async function aclSnapshot(): Promise<unknown[]> {
  return once(dstSuperUrl(), async (client) => {
    const { rows } = await client.query(
      `SELECT c.relname, c.relacl::text, (SELECT array_agg(a.attname || '=' || a.attacl::text ORDER BY a.attname)
         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL) AS attacl
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') ORDER BY c.relname`
    );
    return rows;
  });
}

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0]!;
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

function writePgWrapper(name: "pg_dump" | "pg_restore"): void {
  // The target's major version, as the runbook asks of the operator's tools.
  const passthrough = [
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGAPPNAME",
    "PGOPTIONS",
    "PGCONNECT_TIMEOUT",
  ]
    .map((variable) => `-e ${variable}`)
    .join(" ");
  const script = `#!/bin/sh\nexec docker run --rm --name "${PREFIX}-${name.replace("_", "-")}-$$" --network host --user "$(id -u):$(id -g)" -v "${workDir}:${workDir}" ${passthrough} postgres:17 ${name} "$@"\n`;
  writeFileSync(join(binDir, name), script);
  chmodSync(join(binDir, name), 0o755);
}

// ---------------------------------------------------------------------------
// Side sources: small Neon-shaped databases on the source container, one per
// failure scenario, so each can freeze and roll back without disturbing the
// main sequence. Their roles have privileges on their own database only.

type SideSource = {
  roles: { admin: string; web: string; other: string };
  password: { admin: string; web: string; other: string };
  db: string;
  file: string;
  url: (role: "admin" | "web" | "other", password?: string) => string;
  env: (extra?: CutoverEnv) => CutoverEnv;
};

/** With `other`, a second consumer role that can write to `events`. */
async function sideSource(suffix: string, { other = false } = {}): Promise<SideSource> {
  const roles = {
    admin: `side_admin_${suffix}`,
    web: `side_web_${suffix}`,
    other: `side_other_${suffix}`,
  };
  const password = { admin: secret(), web: secret(), other: secret() };
  const db = `side_${suffix}`;
  const sideUrl = (role: keyof typeof roles, pw = password[role]) =>
    url(srcPort, roles[role], pw, db);
  await once(url(srcPort, "postgres", PW.srcSuper, "postgres"), async (client) => {
    await client.query(`CREATE ROLE ${roles.admin} LOGIN CREATEROLE PASSWORD '${password.admin}'`);
    await client.query(`GRANT pg_signal_backend, pg_monitor TO ${roles.admin}`);
    await client.query(`CREATE DATABASE ${db} OWNER ${roles.admin}`);
  });
  await once(sideUrl("admin"), async (client) => {
    await client.query(`CREATE ROLE ${roles.web} LOGIN PASSWORD '${password.web}'`);
    await client.query("CREATE TABLE events (id serial PRIMARY KEY, note text)");
    const writers = other ? `${roles.web}, ${roles.other}` : roles.web;
    if (other) await client.query(`CREATE ROLE ${roles.other} LOGIN PASSWORD '${password.other}'`);
    await client.query(`GRANT INSERT, SELECT ON events TO ${writers}`);
    await client.query(`GRANT USAGE ON SEQUENCE events_id_seq TO ${writers}`);
  });
  return {
    roles,
    password,
    db,
    file: join(workDir, `side-${suffix}-passwords.jsonl`),
    url: sideUrl,
    env: (extra = {}) => ({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CUTOVER_SOURCE_ADMIN_URL: sideUrl("admin"),
      NEON_API_KEY,
      NEON_PROJECT_ID: "side-project",
      NEON_BRANCH_ID: "br-side",
      NEON_ENDPOINT_ID: "ep-side",
      ...extra,
    }),
  };
}

const roleUrlEnv = (role: string) =>
  `CUTOVER_ROLE_URL_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** A password file as an earlier run left it: one JSON line per entry, written `ageHours` ago. */
function writePasswordEntries(
  file: string,
  entries: Array<{ ageHours: number; role: string; password: string }>
): void {
  const lines = entries.map(({ ageHours, role, password }) =>
    JSON.stringify({ at: new Date(Date.now() - ageHours * 3_600_000).toISOString(), role, password })
  );
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * A fake Neon for side sources. `failFirstApply` roles' first reset returns
 * a password that never takes effect, with an operation that fails; a
 * `loseFirstResponse` role's first reset takes effect but its response never
 * arrives.
 */
function sideNeon(
  behaviour: { failFirstApply?: string[]; loseFirstResponse?: string[] } = {}
): { transport: NeonTransport; resets: () => number } {
  let resets = 0;
  const seen = new Set<string>();
  const transport: NeonTransport = async (path, init) => {
    if (path === "/projects/side-project/endpoints/ep-side")
      return json(200, { endpoint: { id: "ep-side", branch_id: "br-side" } });
    const operation = /^\/projects\/side-project\/operations\/(op-fail-\d+)$/.exec(path);
    if (operation) return json(200, { operation: { id: operation[1], status: "failed" } });
    const reset = /^\/projects\/side-project\/branches\/br-side\/roles\/([^/]+)\/reset_password$/.exec(
      path
    );
    if (!reset || init?.method !== "POST") return json(404, { code: "NOT_FOUND" });
    const role = decodeURIComponent(reset[1]!);
    resets += 1;
    const first = !seen.has(role);
    seen.add(role);
    const password = `npg_${randomBytes(12).toString("base64url")}`;
    if (first && behaviour.failFirstApply?.includes(role)) {
      return json(200, {
        role: { branch_id: "br-side", name: role, password },
        operations: [{ id: `op-fail-${resets}`, status: "running" }],
      });
    }
    await applyPassword(role, password);
    if (first && behaviour.loseFirstResponse?.includes(role)) throw new TypeError("fetch failed");
    return json(200, {
      role: { branch_id: "br-side", name: role, password },
      operations: [{ id: `op-${resets}`, status: "finished" }],
    });
  };
  return { transport, resets: () => resets };
}

async function sideCutover(
  args: string[],
  env: CutoverEnv,
  transport?: NeonTransport
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await runCutover(
    args,
    env,
    {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      stdout: { isTTY: false, write: () => true },
    },
    { neonTransport: transport }
  );
  console.log(`$ neon-cutover ${args.join(" ")}  -> exit ${code}\n${lines.join("\n")}\n`);
  return { code, output: lines.join("\n") };
}

const insertAs = (client: Client, note: string) =>
  client.query("INSERT INTO events (note) VALUES ($1)", [note]);

describe("Neon cutover rehearsal (D8, task 4.1)", { skip: !enabled, timeout: 600_000 }, () => {
  let heldWebSession: Client | undefined;
  let aclBeforeFreeze: string[] = [];

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), "neon-cutover-rehearsal-"));
    binDir = join(workDir, "bin");
    mkdirSync(binDir);
    writePgWrapper("pg_dump");
    writePgWrapper("pg_restore");
    archive = join(workDir, "neondb.dump");

    [srcPort, dstPort] = await Promise.all([
      startPostgres(SRC_CONTAINER, "postgres:16", PW.srcSuper),
      startPostgres(DST_CONTAINER, "postgres:17", PW.dstSuper),
    ]);

    // Source: Neon's shape. The admin is NOSUPERUSER and owns the database.
    await once(url(srcPort, "postgres", PW.srcSuper, "postgres"), async (client) => {
      await client.query(`CREATE ROLE cutover_admin LOGIN CREATEROLE PASSWORD '${PW.admin}'`);
      await client.query("GRANT pg_signal_backend TO cutover_admin");
      await client.query("GRANT pg_read_all_data TO cutover_admin WITH ADMIN OPTION");
      await client.query("CREATE DATABASE neondb OWNER cutover_admin");
    });
    await once(adminUrl(), async (client) => {
      await client.query(`CREATE ROLE substrate_web LOGIN PASSWORD '${PW.web}'`);
      await client.query(`CREATE ROLE exomem_hosted_gateway LOGIN PASSWORD '${PW.gateway}'`);
    });
    await once(srcSuperUrl(), async (client) => {
      await client.query("GRANT CREATE ON SCHEMA public TO substrate_web");
      await client.query("GRANT CREATE ON DATABASE neondb TO substrate_web");
    });
    const previousRelease = process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A;
    process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A = "yes";
    try {
      await applyMigrations({
        databaseUrl: webUrl(),
        migrationsDir: join(REPO_ROOT, "migrations"),
        grantsFile: join(REPO_ROOT, "scripts", "exomem-cloud-grants.sql"),
      });
    } finally {
      if (previousRelease === undefined) delete process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A;
      else process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A = previousRelease;
    }
    await once(webUrl(), async (client) => {
      await client.query(readFileSync(SEED_SQL, "utf8"));
      await client.query(
        "GRANT SELECT ON exomem_oauth_access_tokens, exomem_oauth_grants TO exomem_hosted_gateway"
      );
    });

    // Target: the Ansible role's shape.
    await once(url(dstPort, "postgres", PW.dstSuper, "postgres"), async (client) => {
      const roles: Array<[string, string]> = [
        ["substrate_owner", PW.owner],
        ["substrate_app", PW.app],
        ["exomem_gateway", PW.exomemGateway],
        ["exomem_cellctl", PW.cellctl],
      ];
      for (const [role, password] of roles) {
        await client.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`
        );
      }
      await client.query("CREATE DATABASE exomem_control OWNER substrate_owner ENCODING 'UTF8'");
    });
    await once(dstSuperUrl(), async (client) => {
      await client.query("CREATE SCHEMA pgbouncer AUTHORIZATION postgres");
    });
  });

  after(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    await __resetPgSqlPoolForTests().catch(() => undefined);
    await docker("rm", "-f", SRC_CONTAINER, DST_CONTAINER).catch(() => undefined);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("seeds a row in every Endstate, Paddle and OAuth table on the source", async () => {
    await once(srcSuperUrl(), async (client) => {
      for (const table of SEEDED_TABLES) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`
        );
        assert.ok(rows[0]!.n > 0, `${table} should hold at least one seeded row`);
      }
    });
  });

  it("create-dump-role creates the dump role through Neon's API, records its password, and grants it pg_read_all_data; a rerun grants again", async () => {
    const { code, output } = await cutover(["create-dump-role", FILE()]);
    assert.equal(code, 0, output);
    assert.equal(neonCreates, 1);
    assert.equal(statSync(passwordFile()).mode & 0o777, 0o600);
    const password = dumpPassword();
    assert.ok(password, "the generated password is recorded");
    assert.ok(!output.includes(password), "and never printed");
    assert.match(output, new RegExp(`${DUMP_ROLE}: created through the Neon API`));
    await once(srcSuperUrl(), async (client) => {
      const { rows } = await client.query<{ reads: boolean; login: boolean }>(
        `SELECT rolcanlogin AS login, pg_has_role(oid, 'pg_read_all_data', 'USAGE') AS reads
         FROM pg_roles WHERE rolname = $1`,
        [DUMP_ROLE]
      );
      assert.deepEqual(rows[0], { reads: true, login: true });
    });
    await once(dumpUrl(), (client) => client.query("SELECT 1"));

    // The role exists now: a rerun grants it again and does not refuse.
    const again = await cutover(["create-dump-role", FILE()]);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /already exists/);
    assert.match(again.output, /granted pg_read_all_data/);
    assert.equal(neonCreates, 1);
    assert.equal(neonResets, 0);
    assert.equal(dumpPassword(), password);
  });

  it("inventory needs a viewer that sees every session, then lists them and proves each consumer's credential", async () => {
    heldWebSession = await connected(webUrl());
    await heldWebSession.query("SELECT 1");
    // Without pg_monitor (or pg_read_all_stats) another role's session hides its
    // backend type, and a held session would read as "none".
    const blind = await cutover(["inventory", ...ROLES()]);
    assert.equal(blind.code, 1, blind.output);
    assert.match(blind.output, /pg_monitor/);
    await once(srcSuperUrl(), (client) => client.query("GRANT pg_monitor TO cutover_admin"));

    const { code, output } = await cutover(["inventory", ...ROLES()]);
    assert.equal(code, 0, output);
    assert.match(output, /^\s+substrate_web neondb "" \S+ idle 1$/m, "the held session is listed");
    for (const role of ["substrate_web", "exomem_hosted_gateway", "cutover_admin"])
      assert.match(output, new RegExp(`OK\\s+${role}: its CUTOVER_ROLE_URL logs in`));
    assert.match(output, /cutover_admin.*\[owner\]/);
    assert.match(output, /citext\s+1\.6/);
    assert.match(output, /pgcrypto\s+1\.3/);
    assert.doesNotMatch(output, new RegExp(PW.web));

    // Step 1's go/no-go: a stale credential is a no-go.
    const stale = await cutover(["inventory", ...ROLES()], {
      ...cutoverEnv(),
      CUTOVER_ROLE_URL_EXOMEM_HOSTED_GATEWAY: url(srcPort, "exomem_hosted_gateway", secret(), "neondb"),
    });
    assert.equal(stale.code, 2, stale.output);
    assert.match(stale.output, /FAIL\s+exomem_hosted_gateway: its CUTOVER_ROLE_URL does not log in \(28P01\)/);

    // So is a consumer that connects as a superuser, which no CONNECT lockout can stop.
    const superuser = await cutover(["inventory", `${APP_ROLES},postgres`, FILE()], {
      ...cutoverEnv(),
      CUTOVER_ROLE_URL_POSTGRES: srcSuperUrl(),
    });
    assert.equal(superuser.code, 2, superuser.output);
    assert.match(superuser.output, /postgres is a superuser/);

    const frozen = await cutover(["inventory", ...ROLES(), "--expect-frozen"]);
    assert.equal(frozen.code, 2, "an unfrozen source must fail --expect-frozen");
    assert.equal(neonResets, 0, "inventory never calls the Neon API");
  });

  it("dump refuses a source that is not frozen", async () => {
    const { code, output } = await cutover([
      "dump",
      `--archive=${archive}`,
      `--pg-bin-dir=${binDir}`,
      FILE(),
    ]);
    assert.equal(code, 1, output);
    assert.match(output, /not frozen/);
    assert.equal(existsSync(archive), false);
  });

  it("freeze takes CONNECT from every role but the owner and the dump role, rotates only the owner's password, and ends every other session", async () => {
    await writeAs(webUrl()); // sanity: writes work before the freeze
    aclBeforeFreeze = await aclEntries("neondb");
    assert.ok(connectGrantees(aclBeforeFreeze).includes("PUBLIC"));
    const heldAdminSession = await connected(adminUrl());
    await heldAdminSession.query("SELECT 1");
    const heldDumpSession = await connected(dumpUrl());
    await heldDumpSession.query("SELECT 1");
    const reconnecting = reconnectingWriter(webUrl());
    await new Promise((done) => setTimeout(done, 300));

    const { code, output } = await cutover(["freeze", ...ROLES()]);
    const frozenAt = Date.now();
    await new Promise((done) => setTimeout(done, 500));
    const attempts = await reconnecting.stop();
    assert.equal(code, 0, output);
    assert.match(output, /FROZEN/);
    assert.doesNotMatch(output, new RegExp(`${PW.web}|${PW.gateway}|${PW.admin}|${NEON_API_KEY}`));
    assert.ok(!output.includes(dumpPassword()), "the dump role's password is never printed");

    // The consumer that kept reconnecting did not fail the freeze, and
    // wrote nothing after it: every later attempt was refused at login.
    assert.ok(attempts.tries >= 5, `the writer kept trying (${attempts.tries})`);
    assert.ok(attempts.refusals.has("42501"), `refusals: ${[...attempts.refusals].join(", ")}`);
    assert.deepEqual(attempts.writes.filter((at) => at >= frozenAt), []);

    // Every held session was ended, the dump role's included.
    assert.match(output, /terminated \d+ other client session\(s\) of neondb/);
    await assert.rejects(heldWebSession!.query("SELECT 1"));
    await assert.rejects(heldAdminSession.query("SELECT 1"));
    await assert.rejects(heldDumpSession.query("SELECT 1"));

    // CONNECT is the lockout: the consumers' passwords are right (42501
    // comes after authentication) and nothing about their roles changed.
    await assert.rejects(writeAs(webUrl()), refusedWith("42501"));
    await assert.rejects(writeAs(legacyGatewayUrl()), refusedWith("42501"));

    // The owner keeps CONNECT, so a consumer that logs in as it is locked out
    // by one password reset through Neon, recorded only in the 0600 file.
    assert.equal(neonResets, 1);
    const rotated = rotatedAdminPassword();
    assert.notEqual(rotated, PW.admin);
    assert.ok(!output.includes(rotated), "the rotated password is never printed");
    await assert.rejects(writeAs(adminUrl()), refusedWith("28P01"));
    await once(rotatedAdminUrl(), (client) => client.query("SELECT 1"));
    // The dump role still connects.
    await once(dumpUrl(), (client) => client.query("SELECT 1"));

    await once(srcSuperUrl(), async (client) => {
      const { rows } = await client.query<{ rolname: string; rolcanlogin: boolean }>(
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('cutover_admin', 'substrate_web', 'exomem_hosted_gateway') ORDER BY 1"
      );
      assert.deepEqual(
        rows.map((row) => [row.rolname, row.rolcanlogin]),
        [
          ["cutover_admin", true],
          ["exomem_hosted_gateway", true],
          ["substrate_web", true],
        ],
        "no role's login flag changes"
      );
      const sessions = await client.query(
        "SELECT 1 FROM pg_stat_activity WHERE usename IN ('cutover_admin', 'substrate_web', 'exomem_hosted_gateway', $1)",
        [DUMP_ROLE]
      );
      assert.equal(sessions.rowCount, 0);
      // The second layer: every new session defaults to read-only.
      const readOnly = await client.query<{ value: string }>(
        "SELECT current_setting('default_transaction_read_only') AS value"
      );
      assert.equal(readOnly.rows[0]!.value, "on");
    });
    assert.deepEqual(connectGrantees(await aclEntries("neondb")).sort(), ["cutover_admin", DUMP_ROLE]);
    assert.equal(aclRecords().length, 1, "the ACL before the freeze is recorded in the file");

    const frozen = await cutover(["inventory", ...ROLES(), "--expect-frozen"]);
    assert.equal(frozen.code, 0, frozen.output);
    assert.match(frozen.output, /OK\s+substrate_web: refused at login \(42501\)/);
    assert.match(frozen.output, /OK\s+cutover_admin: its pre-freeze password is refused \(28P01\)/);
    assert.match(frozen.output, new RegExp(`OK\\s+${DUMP_ROLE} connects`));
  });

  it("a freeze rerun proves FROZEN again, keeps the recorded ACL, and never resets the owner twice", async () => {
    const recorded = rotatedAdminPassword();
    const { code, output } = await cutover(["freeze", ...ROLES()]);
    assert.equal(code, 0, output);
    assert.match(output, /already rotated: cutover_admin/);
    assert.match(output, /keep the ACL recorded at/);
    assert.equal(neonResets, 1, "the recorded, live password is never reset again");
    assert.equal(rotatedAdminPassword(), recorded);
    assert.equal(aclRecords().length, 1, "a locked ACL is never recorded as the one to restore");

    // CONNECT granted again during the window (by hand, or by Neon after a
    // restart): a rerun takes it away and still keeps the first record.
    await onFrozenSource((client) => client.query("GRANT CONNECT ON DATABASE neondb TO substrate_web"));
    const regranted = await cutover(["freeze", ...ROLES()]);
    assert.equal(regranted.code, 0, regranted.output);
    assert.match(regranted.output, /REVOKE CONNECT ON DATABASE neondb FROM substrate_web/);
    assert.equal(aclRecords().length, 1, "the rerun keeps the record of the ACL before the first freeze");
    assert.ok(!connectGrantees(await aclEntries("neondb")).includes("substrate_web"));
  });

  it("dump writes a custom-format archive and its checksum as the dump role", async () => {
    const { code, output } = await cutover([
      "dump",
      `--archive=${archive}`,
      `--pg-bin-dir=${binDir}`,
      FILE(),
    ]);
    assert.equal(code, 0, output);
    assert.match(output, new RegExp(`as ${DUMP_ROLE}`));
    const recorded = readFileSync(`${archive}.sha256`, "utf8").trim();
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    assert.equal(recorded, `${actual}  ${basename(archive)}`);
    assert.equal(readFileSync(archive).subarray(0, 5).toString("latin1"), "PGDMP");
    const again = await cutover(["dump", `--archive=${archive}`, `--pg-bin-dir=${binDir}`, FILE()]);
    assert.equal(again.code, 1, "an existing archive is never overwritten");
  });

  it("restore loads the archive into the empty target as substrate_owner, in one transaction", async () => {
    const { code, output } = await cutover([
      "restore",
      `--archive=${archive}`,
      `--pg-bin-dir=${binDir}`,
    ]);
    assert.equal(code, 0, output);
    // The plan counts tables, not their TABLE DATA entries, and names only real schemas.
    const sourceTables = await onFrozenSource(async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`
      );
      return rows[0]!.n;
    });
    assert.match(output, new RegExp(`: ${sourceTables} table\\(s\\) in public$`, "m"));
    assert.match(output, new RegExp(`restored ${sourceTables} table\\(s\\)`));
    await once(dstSuperUrl(), async (client) => {
      const { rows } = await client.query<{ owner: string; n: number }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner, count(*)::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' GROUP BY 1`
      );
      assert.deepEqual(
        rows.map((row) => row.owner),
        ["substrate_owner"]
      );
      const extensions = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pgcrypto') ORDER BY 1"
      );
      assert.deepEqual(
        extensions.rows.map((row) => row.extname),
        ["citext", "pgcrypto"]
      );
      const readOnly = await client.query<{ value: string }>(
        "SELECT current_setting('default_transaction_read_only') AS value"
      );
      assert.equal(
        readOnly.rows[0]!.value,
        "off",
        "the source's read-only default must not travel"
      );
    });
    const again = await cutover(["restore", `--archive=${archive}`, `--pg-bin-dir=${binDir}`]);
    assert.equal(again.code, 1, "a non-empty target is refused");
    assert.match(again.output, /not empty/);
  });

  it("restore refuses an archive whose checksum does not match", async () => {
    const copy = join(workDir, "tampered.dump");
    const bytes = readFileSync(archive);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(copy, bytes);
    writeFileSync(
      `${copy}.sha256`,
      readFileSync(`${archive}.sha256`, "utf8").replace(basename(archive), basename(copy))
    );
    const { code, output } = await cutover([
      "restore",
      `--archive=${copy}`,
      `--pg-bin-dir=${binDir}`,
    ]);
    assert.equal(code, 1, output);
    assert.match(output, /checksum/);
  });

  it("grants gives the target exactly the D7 role shape, the same checks the cloud-grants test makes", async () => {
    const { code, output } = await cutover(["grants"]);
    assert.equal(code, 0, output);

    const tables = await once(ownerUrl(), async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`
      );
      return rows.map((row) => row.relname);
    });
    const appTables = tables.filter(
      (name) => !(C1_TABLES as readonly string[]).includes(name) && name !== "schema_migrations"
    );
    assert.ok(appTables.length > 50);
    const privileges = await tablePrivileges("substrate_app", appTables);
    for (const name of appTables) {
      const grant = privileges.get(name)!;
      assert.ok(
        grant.s && grant.i && grant.u && grant.d,
        `substrate_app needs full DML on ${name}`
      );
    }
    const cloud = await tablePrivileges("substrate_app", C1_TABLES);
    for (const name of C1_TABLES) {
      assert.ok(cloud.get(name)!.s, `substrate_app should SELECT ${name}`);
      assert.equal(cloud.get(name)!.d, false, `substrate_app must not DELETE ${name}`);
    }

    // Real round trips as each role, rolled back: verify runs next and must
    // still see exactly what was restored.
    const app = await connected(appUrl());
    const host = `cutover-${rand}.example.test`;
    await app.query("BEGIN");
    await app.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1)",
      [host]
    );
    await app.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
    await app.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'read_only' WHERE cell_id = 'rehearsalcellaaa'"
    );
    await app.query("ROLLBACK");
    await assert.rejects(
      app.query(
        "UPDATE exomem_cloud_cells SET observed_state = 'failed' WHERE cell_id = 'rehearsalcellaaa'"
      ),
      /permission denied/
    );
    await assert.rejects(
      app.query("DELETE FROM exomem_cloud_cells WHERE cell_id = 'rehearsalcellaaa'"),
      /permission denied/
    );

    const cellctl = await connected(cellctlUrl());
    await cellctl.query("BEGIN");
    await cellctl.query(
      "UPDATE exomem_cloud_cells SET ready = false WHERE cell_id = 'rehearsalcellaaa'"
    );
    await cellctl.query("ROLLBACK");
    await assert.rejects(
      cellctl.query(
        "UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE cell_id = 'rehearsalcellaaa'"
      ),
      /permission denied/
    );
    await assert.rejects(cellctl.query("SELECT 1 FROM users LIMIT 1"), /permission denied/);

    const gateway = await connected(gatewayUrl());
    const routing = await gateway.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = 'rehearsalcellaaa'"
    );
    assert.equal(routing.rows[0]!.desired_state, "running");
    await assert.rejects(
      gateway.query(
        "SELECT observed_state FROM exomem_cloud_cells WHERE cell_id = 'rehearsalcellaaa'"
      ),
      /permission denied/
    );
    await assert.rejects(gateway.query("SELECT 1 FROM users LIMIT 1"), /permission denied/);

    await once(ownerUrl(), async (owner) => {
      await owner.query("CREATE TABLE later_migration_probe (id bigserial PRIMARY KEY, note text)");
      try {
        const inserted = await app.query(
          "INSERT INTO later_migration_probe (note) VALUES ('ok') RETURNING id"
        );
        assert.ok(
          inserted.rows[0]!.id,
          "a later migration's table and sequence inherit the grants"
        );
      } finally {
        await owner.query("DROP TABLE later_migration_probe");
      }
    });

    const before = await aclSnapshot();
    const rerun = await cutover(["grants"]);
    assert.equal(rerun.code, 0, rerun.output);
    assert.deepEqual(await aclSnapshot(), before, "a second run changes nothing");
  });

  it("verify passes when every table, sequence and extension matches", async () => {
    const { code, output } = await cutover(["verify", FILE()]);
    assert.equal(code, 0, output);
    for (const table of SEEDED_TABLES)
      assert.match(output, new RegExp(`OK\\s+public\\.${table}\\s`));
    assert.match(output, /public\.cutover_rehearsal_types_id_seq/);
    assert.doesNotMatch(output, /Endstate\.User|supporter@example|rehearsal-client/);
    // PgBouncer's auth schema is the target's own, and holds no table or sequence.
    assert.match(output, /note schema pgbouncer exists only on the target/);
  });

  it("verify fails when the Paddle dedupe ledger lost its unique key on the target", async () => {
    await once(dstSuperUrl(), (client) =>
      client.query("ALTER TABLE paddle_webhook_events DROP CONSTRAINT paddle_webhook_events_pkey")
    );
    try {
      const { code, output } = await cutover(["verify", FILE()]);
      assert.equal(code, 2, output);
      assert.match(output, /FAIL\s+public\.paddle_webhook_events\s.*constraints/);
      assert.match(output, /OK\s+public\.users\s/);
    } finally {
      await once(dstSuperUrl(), (client) =>
        client.query("ALTER TABLE paddle_webhook_events ADD PRIMARY KEY (event_id)")
      );
    }
    assert.equal((await cutover(["verify", FILE()])).code, 0);
  });

  it("verify fails on a schema, table or sequence that exists only on the target", async () => {
    await once(ownerUrl(), async (client) => {
      await client.query("CREATE SCHEMA cutover_extra");
      await client.query("CREATE TABLE cutover_extra.t (v int)");
      await client.query("CREATE SEQUENCE public.cutover_extra_seq");
    });
    try {
      const { code, output } = await cutover(["verify", FILE()]);
      assert.equal(code, 2, output);
      assert.match(output, /FAIL\s+schema cutover_extra\s+exists only on the target/);
      assert.match(output, /FAIL\s+cutover_extra\.t\s+exists only on the target/);
      assert.match(output, /FAIL\s+public\.cutover_extra_seq\s+exists only on the target/);
    } finally {
      await once(ownerUrl(), async (client) => {
        await client.query("DROP SCHEMA cutover_extra CASCADE");
        await client.query("DROP SEQUENCE public.cutover_extra_seq");
      });
    }
    assert.equal((await cutover(["verify", FILE()])).code, 0);
  });

  it("verify fails on a corrupted row and names only the table", async () => {
    const original = await once(dstSuperUrl(), async (client) => {
      const { rows } = await client.query<{ sha256: Buffer }>(
        "SELECT sha256 FROM backup_chunks WHERE version_id = $1 AND chunk_index = 1",
        [ENDSTATE_VERSION]
      );
      await client.query(
        "UPDATE backup_chunks SET sha256 = '\\x00'::bytea || substr(sha256, 2) WHERE version_id = $1 AND chunk_index = 1",
        [ENDSTATE_VERSION]
      );
      return rows[0]!.sha256;
    });
    try {
      const { code, output } = await cutover(["verify", FILE()]);
      assert.equal(code, 2, output);
      assert.match(output, /FAIL\s+public\.backup_chunks\s.*checksum/);
      assert.match(output, /OK\s+public\.users\s/);
    } finally {
      await once(dstSuperUrl(), (client) =>
        client.query(
          "UPDATE backup_chunks SET sha256 = $2 WHERE version_id = $1 AND chunk_index = 1",
          [ENDSTATE_VERSION, original]
        )
      );
    }
    assert.equal((await cutover(["verify", FILE()])).code, 0);
  });

  it("verify fails when a table's row count differs", async () => {
    await once(dstSuperUrl(), (client) =>
      client.query("INSERT INTO rate_limit_events (scope, key) VALUES ('cutover-extra', 'row')")
    );
    try {
      const { code, output } = await cutover(["verify", FILE()]);
      assert.equal(code, 2, output);
      assert.match(output, /FAIL\s+public\.rate_limit_events\s.*rows \d+ != \d+/);
    } finally {
      await once(dstSuperUrl(), (client) =>
        client.query("DELETE FROM rate_limit_events WHERE scope = 'cutover-extra'")
      );
    }
  });

  it("verify fails when a target sequence is behind the source", async () => {
    const original = await once(dstSuperUrl(), async (client) => {
      const { rows } = await client.query<{ last_value: string; is_called: boolean }>(
        "SELECT last_value, is_called FROM cutover_rehearsal_types_id_seq"
      );
      await client.query("SELECT setval('cutover_rehearsal_types_id_seq', 1, false)");
      return rows[0]!;
    });
    try {
      const { code, output } = await cutover(["verify", FILE()]);
      assert.equal(code, 2, output);
      assert.match(output, /FAIL\s+public\.cutover_rehearsal_types_id_seq\s.*behind/);
    } finally {
      await once(dstSuperUrl(), (client) =>
        client.query("SELECT setval('cutover_rehearsal_types_id_seq', $1, $2)", [
          original.last_value,
          original.is_called,
        ])
      );
    }
  });

  it("verify fails when an extension is missing on the target or its version differs", async () => {
    await onFrozenSource((client) => client.query("CREATE EXTENSION pg_trgm VERSION '1.5'"));
    await once(dstSuperUrl(), (client) => client.query("CREATE EXTENSION pg_trgm VERSION '1.6'"));
    try {
      const differs = await cutover(["verify", FILE()]);
      assert.equal(differs.code, 2, differs.output);
      assert.match(differs.output, /FAIL\s+extension pg_trgm\s.*1\.5 != 1\.6/);
      await once(dstSuperUrl(), (client) => client.query("DROP EXTENSION pg_trgm"));
      const missing = await cutover(["verify", FILE()]);
      assert.equal(missing.code, 2, missing.output);
      assert.match(missing.output, /FAIL\s+extension pg_trgm\s.*missing on target/);
    } finally {
      await once(dstSuperUrl(), (client) => client.query("DROP EXTENSION IF EXISTS pg_trgm"));
      await onFrozenSource((client) => client.query("DROP EXTENSION IF EXISTS pg_trgm"));
    }
    assert.equal((await cutover(["verify", FILE()])).code, 0);
  });

  it("post-checks at the database level: a Paddle replay dedupes, an Endstate backup reads, and an admission dry run commits nothing, all as substrate_app", async () => {
    const previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = appUrl();
    await __resetPgSqlPoolForTests();
    const appPool = new Pool({ connectionString: appUrl(), max: 2 });
    clients.push(appPool);
    try {
      // Paddle replay of an event Neon already processed: the carried ledger dedupes it.
      const replay = await claimPaddleEventProcessing({
        eventId: PROCESSED_PADDLE_EVENT,
        eventType: "subscription.updated",
      });
      assert.equal(replay.kind, "processed");

      // Endstate backup read through the real read path.
      const backups = await listBackupsForUser(ENDSTATE_USER);
      assert.equal(backups.length, 1);
      assert.equal(backups[0]!.id, ENDSTATE_BACKUP);
      assert.equal(backups[0]!.latest_version_id, ENDSTATE_VERSION);
      const versions = await listVersions(ENDSTATE_BACKUP);
      assert.deepEqual(
        versions.map((version) => version.id),
        [ENDSTATE_VERSION]
      );
      const chunks = await listChunksForVersion(ENDSTATE_VERSION);
      assert.deepEqual(
        chunks.map((chunk) => Buffer.from(chunk.sha256).toString("hex")),
        ["06".repeat(32), "07".repeat(32)]
      );
      assert.ok((await getJwksKeys()).some((key) => key.kid === "rehearsal-2026-09"));

      // Exomem admission dry run: the real Cloud redemption, rolled back.
      const client = await appPool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        __setExomemSqlForTests(taggedSql(client));
        async function inOpenTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
          return callback(taggedSql(client));
        }
        __setExomemTransactionForTests(inOpenTransaction);
        const admitted = await redeemCloudInviteAtomic({
          tokenDigest: OPEN_INVITE_DIGEST,
          sessionDigest: randomBytes(32),
          csrfDigest: randomBytes(32),
          sessionExpiresAt: new Date(Date.now() + 3_600_000),
        });
        assert.ok(admitted, "substrate_app can run Cloud admission on the restored database");
        assert.equal(admitted!.cellId.length, 16);
      } finally {
        await client.query("ROLLBACK");
        client.release();
        __setExomemSqlForTests(null);
        __setExomemTransactionForTests(null);
      }
      const invite = await once(ownerUrl(), (owner) =>
        owner.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [
          OPEN_INVITE_DIGEST,
        ])
      );
      assert.equal(invite.rows[0]!.consumed_at, null, "the dry run leaves the invite unconsumed");
    } finally {
      await __resetPgSqlPoolForTests();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
    }
  });

  it("switch-plan prints the Vercel commands and runs nothing", async () => {
    const { code, output } = await cutover([
      "switch-plan",
      "--target-host=control-db.example.test",
    ]);
    assert.equal(code, 0, output);
    assert.match(output, /vercel env rm DATABASE_URL production/);
    assert.match(output, /vercel env add DATABASE_URL production/);
    assert.match(output, /vercel env add DATABASE_MIGRATION_URL production/);
    assert.match(output, /vercel redeploy/);
    assert.match(output, /control-db\.example\.test:6432\/exomem_control_session/);
    for (const password of Object.values(PW)) assert.doesNotMatch(output, new RegExp(password));
  });


  it("rollback restores the recorded ACL exactly and clears the read-only default, and a stale consumer URL changes nothing", async () => {
    // Rollback sets no password, so a stale URL in the environment only fails
    // that consumer's proof; the consumer's real password keeps working.
    const stale = await cutover(["rollback", ...ROLES()], {
      ...cutoverEnv(),
      CUTOVER_ROLE_URL_SUBSTRATE_WEB: url(srcPort, "substrate_web", secret(), "neondb"),
    });
    assert.equal(stale.code, 2, stale.output);
    assert.match(stale.output, /FAIL\s+substrate_web/);
    assert.match(stale.output, /OK\s+exomem_hosted_gateway connects to a read-write session/);
    await writeAs(webUrl());
    assert.deepEqual(await aclEntries("neondb"), aclBeforeFreeze);

    const { code, output } = await cutover(["rollback", ...ROLES()]);
    assert.equal(code, 0, output);
    assert.match(output, /OK\s+cutover_admin connects with its rotated password to a read-write session/);
    assert.match(output, /OK\s+substrate_web connects to a read-write session/);
    assert.match(output, /ACL restored exactly/);
    assert.equal(neonResets, 1, "rollback never calls the Neon API");
    // The ACL is the recorded one, entry for entry: the dump role's CONNECT,
    // which the recorded ACL did not hold, is gone again.
    assert.deepEqual(await aclEntries("neondb"), aclBeforeFreeze);
    assert.ok(!connectGrantees(await aclEntries("neondb")).includes(DUMP_ROLE));
    // The owner's password stays rotated: its consumers switch to the new one.
    await assert.rejects(writeAs(adminUrl()), refusedWith("28P01"));
    await once(rotatedAdminUrl(), async (client) => {
      const { rows } = await client.query<{ value: string }>(
        "SELECT current_setting('transaction_read_only') AS value"
      );
      assert.equal(rows[0]!.value, "off");
    });
    await once(legacyGatewayUrl(), async (client) => {
      const { rows } = await client.query<{ value: string }>(
        "SELECT current_setting('transaction_read_only') AS value"
      );
      assert.equal(rows[0]!.value, "off");
    });
    await once(webUrl(), async (client) => {
      const { rows } = await client.query<{ value: string }>(
        "SELECT current_setting('default_transaction_read_only') AS value"
      );
      assert.equal(rows[0]!.value, "off");
      await client.query("DELETE FROM rate_limit_events WHERE scope = 'cutover-probe'");
    });
    const frozen = await cutover(["inventory", ...ROLES(), "--expect-frozen"]);
    assert.equal(frozen.code, 2, "after rollback the source is no longer frozen");
  });

  it("switch-back-url pipes the owner's Neon URL with its rotated password, and that URL writes", async () => {
    const { code, output, stdout } = await cutover(["switch-back-url", "--role=cutover_admin", FILE()]);
    assert.equal(code, 0, output);
    assert.ok(!output.includes(rotatedAdminPassword()), "the password goes to stdout only");
    assert.ok(!stdout.endsWith("\n"));
    await once(stdout, async (client) => {
      const { rows } = await client.query<{ me: string; value: string }>(
        "SELECT current_user AS me, current_setting('transaction_read_only') AS value"
      );
      assert.deepEqual(rows[0], { me: "cutover_admin", value: "off" });
    });
  });

  it("the runbook's target reset empties the target for a later window, which restores and grants again", async () => {
    await once(ownerUrl(), (client) => client.query("DROP OWNED BY substrate_owner"));
    await once(dstSuperUrl(), async (client) => {
      const left = await client.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')`
      );
      assert.equal(left.rowCount, 0);
      const pgbouncer = await client.query(
        "SELECT 1 FROM pg_namespace WHERE nspname = 'pgbouncer'"
      );
      assert.equal(pgbouncer.rowCount, 1, "PgBouncer's auth schema survives the reset");
    });
    const restored = await cutover(["restore", `--archive=${archive}`, `--pg-bin-dir=${binDir}`]);
    assert.equal(restored.code, 0, restored.output);
    const granted = await cutover(["grants"]);
    assert.equal(granted.code, 0, granted.output);
  });

  it("after FROZEN no reader, column writer, NOINHERIT member, view writer or SECURITY DEFINER caller can connect or write", async () => {
    const side = await sideSource("s1");
    const { roles, db } = side;
    const attackers = {
      reader: "side_reader_s1",
      column: "side_column_s1",
      member: "side_member_s1",
      view: "side_view_s1",
      definer: "side_definer_s1",
    };
    const attackerPassword = secret();
    await once(url(srcPort, "postgres", PW.srcSuper, db), async (client) => {
      for (const role of Object.values(attackers))
        await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${attackerPassword}'`);
      await client.query(`ALTER ROLE ${attackers.member} NOINHERIT`);
      await client.query(`GRANT ${roles.web} TO ${attackers.member}`);
      await client.query(`GRANT SELECT ON events TO ${attackers.reader}`);
      await client.query(`GRANT INSERT (note) ON events TO ${attackers.column}`);
      await client.query(
        `GRANT USAGE ON SEQUENCE events_id_seq TO ${attackers.column}, ${attackers.view}`
      );
    });
    await once(side.url("admin"), async (client) => {
      await client.query("CREATE VIEW events_view AS SELECT id, note FROM events");
      await client.query(`GRANT INSERT ON events_view TO ${attackers.view}`);
      await client.query(
        `CREATE FUNCTION add_event(note text) RETURNS void LANGUAGE sql SECURITY DEFINER
         SET search_path = public AS $$ INSERT INTO events (note) VALUES (note) $$`
      );
      await client.query("REVOKE ALL ON FUNCTION add_event(text) FROM PUBLIC");
      await client.query(`GRANT EXECUTE ON FUNCTION add_event(text) TO ${attackers.definer}`);
    });
    const attackerUrl = (role: string) => readWrite(url(srcPort, role, attackerPassword, db));
    const attacks: Array<[label: string, role: string, attack: (client: Client) => Promise<unknown>]> = [
      ["reader", attackers.reader, (client) => client.query("SELECT count(*) FROM events")],
      ["column writer", attackers.column, (client) => insertAs(client, "column")],
      [
        "NOINHERIT member",
        attackers.member,
        async (client) => {
          await client.query(`SET ROLE ${roles.web}`);
          await insertAs(client, "member");
        },
      ],
      [
        "view writer",
        attackers.view,
        (client) => client.query("INSERT INTO events_view (note) VALUES ('view')"),
      ],
      ["SECURITY DEFINER caller", attackers.definer, (client) => client.query("SELECT add_event('definer')")],
    ];
    // Before the freeze every path works.
    for (const [label, role, attack] of attacks)
      await once(attackerUrl(role), attack).catch((error: Error) => {
        throw new Error(`${label} should work before the freeze: ${error.message}`);
      });
    await once(url(srcPort, "postgres", PW.srcSuper, db), (client) => client.query("DELETE FROM events"));
    const heldReader = await connected(url(srcPort, attackers.reader, attackerPassword, db));
    await heldReader.query("SELECT 1");

    const neon = sideNeon();
    const env = side.env({ [roleUrlEnv(roles.web)]: side.url("web") });
    // The dump role exists already, and this window's file holds no password
    // for it: create-dump-role resets it through the API. This admin may not
    // grant pg_read_all_data, so it grants the role each object as its owner.
    const created = await sideCutover(["create-dump-role", `--password-file=${side.file}`], env, neon.transport);
    assert.equal(created.code, 0, created.output);
    assert.match(created.output, /already exists/);
    assert.match(created.output, /42501/);
    assert.equal(neon.resets(), 1);
    const eventsAcl = await once(url(srcPort, "postgres", PW.srcSuper, db), (client) =>
      client.query<{ acl: string }>("SELECT relacl::text AS acl FROM pg_class WHERE relname = 'events'")
    );
    assert.match(eventsAcl.rows[0]!.acl, new RegExp(`${DUMP_ROLE}=r/`));

    const frozen = await sideCutover(
      ["freeze", `--app-roles=${roles.web}`, `--password-file=${side.file}`],
      env,
      neon.transport
    );
    assert.equal(frozen.code, 0, frozen.output);
    await assert.rejects(heldReader.query("SELECT 1"), "a held reader's session is ended");
    for (const [label, role, attack] of attacks)
      await assert.rejects(once(attackerUrl(role), attack), refusedWith("42501"), label);
    const written = await once(url(srcPort, "postgres", PW.srcSuper, db), (client) =>
      client.query("SELECT note FROM events")
    );
    assert.equal(written.rowCount, 0, "nothing was written after FROZEN");

    // The daily check sees another client session, even the dump role's.
    const expectArgs = [
      "inventory",
      `--app-roles=${roles.web}`,
      `--password-file=${side.file}`,
      "--expect-frozen",
    ];
    const late = await connected(dumpUrl(db, side.file));
    await late.query("SELECT 1");
    const seen = await sideCutover(expectArgs, env);
    assert.equal(seen.code, 2, seen.output);
    assert.match(seen.output, /other client session/);
    await late.end();
    const clean = await sideCutover(expectArgs, env);
    assert.equal(clean.code, 0, clean.output);
  });

  it("freeze refuses a stale consumer credential or a superuser consumer before changing anything", async () => {
    const side = await sideSource("s2");
    const { roles } = side;
    writePasswordEntries(side.file, [{ ageHours: 0, role: DUMP_ROLE, password: secret() }]);
    const before = await lockState(side.db);
    const neon = sideNeon();
    const stale = side.env({ [roleUrlEnv(roles.web)]: side.url("web", secret()) });
    const inventory = await sideCutover(["inventory", `--app-roles=${roles.web}`], stale);
    assert.equal(inventory.code, 2, inventory.output);
    const frozen = await sideCutover(
      ["freeze", `--app-roles=${roles.web}`, `--password-file=${side.file}`],
      stale,
      neon.transport
    );
    assert.equal(frozen.code, 1, frozen.output);
    assert.match(frozen.output, new RegExp(`${roles.web} \\(28P01\\)`));
    assert.deepEqual(await lockState(side.db), before);
    // The consumer's real credential still works: nothing changed.
    await once(side.url("web"), (client) => client.query("SELECT 1"));

    const superuser = await sideCutover(
      ["freeze", `--app-roles=${roles.web},postgres`, `--password-file=${side.file}`],
      side.env({
        [roleUrlEnv(roles.web)]: side.url("web"),
        CUTOVER_ROLE_URL_POSTGRES: url(srcPort, "postgres", PW.srcSuper, side.db),
      }),
      neon.transport
    );
    assert.equal(superuser.code, 1, superuser.output);
    assert.match(superuser.output, /postgres is a superuser/);
    assert.deepEqual(await lockState(side.db), before);

    // A login role that inherits the owner's privileges keeps CONNECT through
    // it, so the freeze refuses before it changes anything.
    await once(url(srcPort, "postgres", PW.srcSuper, side.db), async (client) => {
      await client.query(`CREATE ROLE side_heir_s2 LOGIN INHERIT PASSWORD '${secret()}'`);
      await client.query(`GRANT ${roles.admin} TO side_heir_s2`);
    });
    const heir = await sideCutover(
      ["freeze", `--app-roles=${roles.web}`, `--password-file=${side.file}`],
      side.env({ [roleUrlEnv(roles.web)]: side.url("web") }),
      neon.transport
    );
    assert.equal(heir.code, 1, heir.output);
    assert.match(heir.output, /side_heir_s2 inherits/);
    assert.deepEqual(await lockState(side.db), before);
    assert.equal(neon.resets(), 0);
  });

  it("a reset whose Neon operation failed is reset again on the next freeze", async () => {
    const side = await sideSource("s3");
    const { roles } = side;
    const neon = sideNeon({ failFirstApply: [roles.admin] });
    const env = side.env({
      [roleUrlEnv(roles.web)]: side.url("web"),
      [roleUrlEnv(roles.admin)]: side.url("admin"),
    });
    const created = await sideCutover(["create-dump-role", `--password-file=${side.file}`], env, neon.transport);
    assert.equal(created.code, 0, created.output);
    const args = [
      "freeze",
      `--app-roles=${roles.web},${roles.admin}`,
      `--password-file=${side.file}`,
    ];
    const first = await sideCutover(args, env, neon.transport);
    assert.equal(first.code, 1, first.output);
    assert.match(first.output, /op-fail-\d+.*failed/);
    assert.equal(readPasswords(side.file).has(roles.admin), true, "the issued password is kept");
    await once(side.url("admin"), (client) => client.query("SELECT 1"));

    const second = await sideCutover(args, env, neon.transport);
    assert.equal(second.code, 0, second.output);
    assert.equal(neon.resets(), 3, "the dump role's reset, the failed one, and the retry");
    const live = readPasswords(side.file).get(roles.admin)!;
    await once(side.url("admin", live), (client) => client.query("SELECT 1"));
    await assert.rejects(once(side.url("admin"), (client) => client.query("SELECT 1")));
  });

  it("a reset whose response was lost is recovered with a console reset, as the runbook says", async () => {
    const side = await sideSource("s4");
    const { roles } = side;
    const neon = sideNeon({ loseFirstResponse: [roles.admin] });
    const env = side.env({
      [roleUrlEnv(roles.web)]: side.url("web"),
      [roleUrlEnv(roles.admin)]: side.url("admin"),
    });
    const created = await sideCutover(["create-dump-role", `--password-file=${side.file}`], env, neon.transport);
    assert.equal(created.code, 0, created.output);
    const args = [
      "freeze",
      `--app-roles=${roles.web},${roles.admin}`,
      `--password-file=${side.file}`,
    ];
    const lost = await sideCutover(args, env, neon.transport);
    assert.equal(lost.code, 1, lost.output);
    assert.match(lost.output, /could not reach the Neon API/);
    const stranded = await sideCutover(args, env, neon.transport);
    assert.equal(stranded.code, 1, stranded.output);
    assert.match(stranded.output, /Neon console/);
    assert.equal(neon.resets(), 2, "nothing resets a role whose live password nobody holds");

    // The operator resets the role in the Neon console, which shows the new password.
    const consolePassword = `npg_${randomBytes(12).toString("base64url")}`;
    await applyPassword(roles.admin, consolePassword);
    const consoleUrl = side.url("admin", consolePassword);
    const recovered = await sideCutover(
      args,
      { ...env, CUTOVER_SOURCE_ADMIN_URL: consoleUrl, [roleUrlEnv(roles.admin)]: consoleUrl },
      neon.transport
    );
    assert.equal(recovered.code, 0, recovered.output);
    assert.equal(neon.resets(), 3);
  });

  it("rollback restores the recorded ACL entry by entry, and names every consumer it could not prove", async () => {
    const side = await sideSource("s5", { other: true });
    const { roles, db } = side;
    // An ACL with explicit entries of its own: a grant option, a CREATE, and
    // no TEMPORARY for PUBLIC.
    await once(url(srcPort, "postgres", PW.srcSuper, db), async (client) => {
      await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${roles.other} WITH GRANT OPTION`);
      await client.query(`GRANT CREATE ON DATABASE ${db} TO ${roles.web}`);
      await client.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
    });
    const before = await lockState(side.db);
    const neon = sideNeon();
    const env = side.env({
      [roleUrlEnv(roles.web)]: side.url("web"),
      [roleUrlEnv(roles.other)]: side.url("other"),
      CUTOVER_ROLE_URL_SIDE_GHOST_S5: url(srcPort, "side_ghost_s5", secret(), db),
    });
    const created = await sideCutover(["create-dump-role", `--password-file=${side.file}`], env, neon.transport);
    assert.equal(created.code, 0, created.output);
    const frozen = await sideCutover(
      ["freeze", `--app-roles=${roles.web},${roles.other}`, `--password-file=${side.file}`],
      env,
      neon.transport
    );
    assert.equal(frozen.code, 0, frozen.output);
    assert.deepEqual(connectGrantees((await lockState(db)).acl).sort(), [DUMP_ROLE, roles.admin].sort());
    // During the window someone grants another privilege: rollback takes it away again.
    await once(url(srcPort, "postgres", PW.srcSuper, db), async (client) => {
      await client.query("SET default_transaction_read_only = off");
      await client.query(`GRANT CREATE ON DATABASE ${db} TO ${roles.other}`);
    });

    const rolledBack = await sideCutover(
      [
        "rollback",
        `--app-roles=${roles.web},${roles.other},side_ghost_s5`,
        `--password-file=${side.file}`,
      ],
      env
    );
    assert.equal(rolledBack.code, 2, rolledBack.output);
    assert.match(rolledBack.output, new RegExp(`OK\\s+${roles.web} connects to a read-write session`));
    assert.match(rolledBack.output, new RegExp(`OK\\s+${roles.other} connects to a read-write session`));
    assert.match(rolledBack.output, /FAIL\s+side_ghost_s5/);
    assert.match(rolledBack.output, /not proven: side_ghost_s5$/m);
    assert.deepEqual(await lockState(db), before, "the exact ACL, and the read-only default cleared");
    await once(side.url("other"), (client) => insertAs(client, "after rollback"));
  });

  it("freeze refuses a reused password file older than 24 h before it changes anything", async () => {
    const side = await sideSource("s6");
    const { roles } = side;
    // An earlier window's file: its first entry is 25 hours old.
    writePasswordEntries(side.file, [
      { ageHours: 25, role: roles.admin, password: side.password.admin },
      { ageHours: 1, role: DUMP_ROLE, password: secret() },
    ]);
    const before = await lockState(side.db);
    const neon = sideNeon();
    const env = side.env({
      [roleUrlEnv(roles.web)]: side.url("web"),
      [roleUrlEnv(roles.admin)]: side.url("admin"),
    });
    const refused = await sideCutover(
      ["freeze", `--app-roles=${roles.web},${roles.admin}`, `--password-file=${side.file}`],
      env,
      neon.transport
    );
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /more than 24 h old/);
    assert.deepEqual(await lockState(side.db), before);
    assert.equal(neon.resets(), 0);
    await once(side.url("admin"), (client) => client.query("SELECT 1"));
  });
});
