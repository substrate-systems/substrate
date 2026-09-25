/**
 * Neon-to-self-hosted control database cutover (design D8 of
 * `adopt-exomem-cloud-plain-cells`, task 4.1). The operator procedure,
 * timings and rollback are in docs/runbooks/neon-cutover.md; read it first.
 *
 *   tsx scripts/neon-cutover.ts <phase> [options]
 *
 * Every phase runs alone and prints its plan before it acts:
 *
 *   inventory    read-only: versions, schemas, extensions, login roles, sessions
 *                and restore blockers on the source; with --app-roles, a login with
 *                each role's credential must succeed (step 1's go/no-go);
 *                --expect-frozen checks the lock instead
 *   create-dump-role  create the dump role named by CUTOVER_SOURCE_DUMP_URL, its
 *                password sent as a SCRAM verifier, and grant it pg_read_all_data
 *   freeze       lock the named application roles out of the source: each role's
 *                credential proven by a login first, each password rotated (never
 *                printed) on one of the two paths below, NOLOGIN on all but the admin,
 *                default_transaction_read_only = on for the database, then every
 *                other client session of the database terminated; then prove it
 *   dump         pg_dump --no-owner --no-acl as the separate dump role, custom format,
 *                with a sha256 file beside the archive
 *   restore      pg_restore into the empty target as substrate_owner, in one transaction
 *   grants       scripts/exomem-cloud-grants.sql through scripts/migrate.ts, then the
 *                D7 role checks
 *   verify       extensions, schemas, sequences, and per table its definition, row
 *                count and content checksum
 *   switch-plan  print the Vercel commands for the switch and the switch back; runs nothing
 *   rollback     re-enable the named roles on the source, each on its own, and clear
 *                its read-only default; a SQL-path role gets its pre-freeze password
 *                back, an API-path role keeps its rotated one
 *   switch-back-url  write an API-path role's Neon URL, with its rotated password, to a
 *                pipe into `vercel env add`; never to a terminal
 *
 * Two rotation paths. A role created with SQL takes the SQL path: NOLOGIN and
 * a SCRAM-rotated password. A console-managed role (--api-roles), such as
 * the owner role the freeze runs as, takes the Neon API path: its
 * password is reset through Neon's reset-password endpoint, so a compute
 * restart re-applies the new password instead of undoing it. The new
 * password is written only to --rotated-password-file (0600, never printed),
 * which freeze opens and checks before any Neon call. The file is only
 * appended to; a role's newest entry is its password, and every later phase
 * reads it from there.
 *
 * Connection strings come only from the environment, never from arguments,
 * and are never printed (only user@host:port/database is):
 *
 *   CUTOVER_SOURCE_ADMIN_URL   Neon, the role that administers the application roles
 *   CUTOVER_SOURCE_DUMP_URL    Neon, the separate pg_read_all_data dump role
 *   CUTOVER_TARGET_OWNER_URL   the new server as substrate_owner, through PgBouncer's
 *                              session alias or directly on 5432
 *   CUTOVER_ROLE_URL_<ROLE>    each application role's pre-freeze connection string,
 *                              as its consumer holds it (role name upper-cased, every
 *                              other character as "_")
 *   NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID
 *                              the API path's key (never printed), project and branch;
 *                              the branch must be the one the admin host's ep-... endpoint
 *                              serves (NEON_ENDPOINT_ID names the endpoint for a local host)
 *
 * Options:
 *   --app-roles=<a,b>      application roles (freeze, rollback, inventory)
 *   --api-roles=<a,b>      the application roles on the Neon API path (empty: none)
 *   --rotated-password-file=<path>  where the API path records rotated passwords
 *   --role=<role>          switch-back-url: the role whose URL to write
 *   --archive=<path>       dump output / restore input
 *   --pg-bin-dir=<dir>     directory holding pg_dump and pg_restore (default: PATH)
 *   --target-host=<host>   the new server's public PgBouncer hostname (switch-plan)
 *   --confirm-production   required by freeze, rollback and create-dump-role against a
 *                          non-local host (restore and grants are bounded by an empty
 *                          target and an exact migration match instead)
 *   --expect-frozen        inventory: exit 2 unless every named role is locked out
 *   --allow-unfrozen       dump: permit a dump of a source that is not frozen (timing trials)
 *
 * Exit status: 0 success, 1 refused or failed to run, 2 a check failed.
 */

import { spawn } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrations } from "./migrate";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const GRANTS_FILE = join(REPO_ROOT, "scripts", "exomem-cloud-grants.sql");

const TARGET_OWNER = "substrate_owner";
const TARGET_ROLES = ["substrate_app", "exomem_gateway", "exomem_cellctl"] as const;
const C1_TABLES = [
  "exomem_cloud_cells",
  "exomem_cloud_settings",
  "exomem_cloud_capacity",
  "exomem_cloud_rollout",
] as const;
const USER_SCHEMA = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;
const NOT_EXTENSION_MEMBER = `NOT EXISTS (SELECT 1 FROM pg_depend d
  WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`;

const PHASES = [
  "inventory",
  "create-dump-role",
  "freeze",
  "dump",
  "restore",
  "grants",
  "verify",
  "switch-plan",
  "rollback",
  "switch-back-url",
] as const;
type Phase = (typeof PHASES)[number];

type Options = {
  appRoles: string[];
  apiRoles: string[];
  rotatedPasswordFile?: string;
  role?: string;
  archive?: string;
  pgBinDir?: string;
  targetHost?: string;
  confirmProduction: boolean;
  expectFrozen: boolean;
  allowUnfrozen: boolean;
};

/** Environment variables as the phases read them (Next.js narrows NodeJS.ProcessEnv). */
export type CutoverEnv = Record<string, string | undefined>;

export type CutoverIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  /** switch-back-url's secret output; process.stdout unless injected. */
  stdout?: { isTTY?: boolean; write: (text: string) => unknown };
};

/** A Neon API request relative to https://console.neon.tech/api/v2, as PaddleTransport is for Paddle. */
export type NeonTransport = (path: string, init?: RequestInit) => Promise<Response>;

export type CutoverDeps = { neonTransport?: NeonTransport };

/** A refusal or a failure to run: exit 1. */
class CutoverError extends Error {}

type Context = {
  env: CutoverEnv;
  options: Options;
  io: CutoverIo;
  phase: Phase;
  deps: CutoverDeps;
};

const USAGE = `usage: tsx scripts/neon-cutover.ts <${PHASES.join("|")}> [options]
See the header of scripts/neon-cutover.ts and docs/runbooks/neon-cutover.md.`;

// ---------------------------------------------------------------------------
// Connection strings

function parseUrl(url: string, label: string): URL {
  try {
    const parsed = new URL(url);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("scheme");
    return parsed;
  } catch {
    throw new CutoverError(`${label} is not a postgresql:// connection string`);
  }
}

function hostOf(url: URL): string {
  return url.searchParams.get("host") ?? url.hostname.replace(/^\[(.*)\]$/, "$1");
}

function databaseOf(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** user@host:port/database, the only form a connection string is ever printed in. */
function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${decodeURIComponent(parsed.username)}@${hostOf(parsed)}:${parsed.port || "5432"}/${databaseOf(parsed)}`;
}

function isLocalUrl(url: string): boolean {
  const host = hostOf(new URL(url));
  return (
    host === "" ||
    host === "localhost" ||
    host === "::1" ||
    /^127\./.test(host) ||
    host.startsWith("/")
  );
}

function envUrl(ctx: Context, name: string): string {
  const value = ctx.env[name];
  if (!value) throw new CutoverError(`${name} is not set`);
  parseUrl(value, name);
  return value;
}

function roleUrlEnvName(role: string): string {
  return `CUTOVER_ROLE_URL_${role.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Mutating a database that is not on this machine takes an explicit --confirm-production. */
function requireLocalOrConfirmed(ctx: Context, targets: Array<[label: string, url: string]>): void {
  const remote = targets.filter(([, url]) => !isLocalUrl(url));
  if (remote.length > 0 && !ctx.options.confirmProduction) {
    throw new CutoverError(
      `refusing to run ${ctx.phase} against a non-local database without --confirm-production: ` +
        remote.map(([label, url]) => `${label} ${describeUrl(url)}`).join(", ")
    );
  }
}

/**
 * Session settings, the session-level read-only override and pg_dump's
 * snapshot all need one backend for the whole session, which a
 * transaction-mode pooler does not give.
 */
function refuseTransactionPooler(label: string, url: string): void {
  const parsed = new URL(url);
  const host = hostOf(parsed);
  if (/-pooler\./.test(host)) {
    throw new CutoverError(
      `${label} names Neon's pooled endpoint ${host}; use the direct endpoint (without -pooler)`
    );
  }
  if (parsed.port === "6432" && !databaseOf(parsed).endsWith("_session")) {
    throw new CutoverError(
      `${label} names PgBouncer's transaction-mode alias; use the exomem_control_session alias or port 5432`
    );
  }
}

/** node-postgres reads sslrootcert as a file path; libpq's "system" means the default CA store, which Node uses anyway. */
function nodePgConnectionString(url: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.get("sslrootcert") === "system")
    parsed.searchParams.delete("sslrootcert");
  return parsed.toString();
}

async function connect(url: string, applicationName: string): Promise<Client> {
  const client = new Client({
    connectionString: nodePgConnectionString(url),
    application_name: applicationName,
    connectionTimeoutMillis: 15_000,
  });
  // A backend terminated under us surfaces as an "error" event; the pending
  // query rejects on its own, so this listener only keeps the process alive.
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

/** The libpq environment for pg_dump/pg_restore: credentials never go on the command line. */
function libpqEnv(ctx: Context, url: string, applicationName: string): CutoverEnv {
  const parsed = new URL(url);
  const env: CutoverEnv = {};
  for (const [key, value] of Object.entries(ctx.env)) {
    if (!key.startsWith("PG") && !key.startsWith("CUTOVER_")) env[key] = value;
  }
  env.PGHOST = hostOf(parsed);
  env.PGPORT = parsed.port || "5432";
  env.PGUSER = decodeURIComponent(parsed.username);
  env.PGPASSWORD = decodeURIComponent(parsed.password);
  env.PGDATABASE = databaseOf(parsed);
  env.PGAPPNAME = applicationName;
  env.PGCONNECT_TIMEOUT = "15";
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  const sslrootcert = parsed.searchParams.get("sslrootcert");
  if (sslrootcert) env.PGSSLROOTCERT = sslrootcert;
  else if (sslmode === "verify-full" || sslmode === "verify-ca") env.PGSSLROOTCERT = "system";
  const options = parsed.searchParams.get("options");
  if (options) env.PGOPTIONS = options;
  return env;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

// ---------------------------------------------------------------------------
// Passwords

/**
 * PostgreSQL's stored SCRAM-SHA-256 verifier for `password`. Sending the
 * verifier rather than the password keeps the plaintext out of server logs.
 * SASLprep is the identity on printable ASCII, the only input accepted here.
 */
export function scramSha256Verifier(
  password: string,
  salt = randomBytes(16),
  iterations = 4096
): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new CutoverError("a role password must be non-empty printable ASCII");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** `url` with its password replaced; a password never travels any other way. */
function withPassword(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// The Neon API rotation path
//
// Neon's control plane owns the spec of a role created in its console or API
// and re-applies it when a compute restarts, which can undo a SQL-only
// rotation. A reset through the control plane is what it re-applies instead.
//   https://api-docs.neon.tech/reference/getprojectendpoint
//   https://api-docs.neon.tech/reference/resetprojectbranchrolepassword
//   https://api-docs.neon.tech/reference/getprojectoperation
//   https://neon.com/docs/manage/operations (the terminal statuses)

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_ID = /^[a-z0-9-]{1,60}$/;

/** The real transport: Neon's v2 API with the bearer key, which nothing else ever sees. */
export function neonHttpTransport(
  apiKey: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): NeonTransport {
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("accept", "application/json");
    return fetchImpl(`${NEON_API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  };
}

async function neonJson(
  transport: NeonTransport,
  path: string,
  init: RequestInit,
  purpose: string
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await transport(path, init);
  } catch {
    throw new CutoverError(`could not reach the Neon API to ${purpose}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const code = typeof fields.code === "string" ? fields.code : "no error code";
    const message = typeof fields.message === "string" ? ` (${fields.message.slice(0, 200)})` : "";
    throw new CutoverError(
      `the Neon API refused to ${purpose}: HTTP ${response.status} ${code}${message}`
    );
  }
  if (!body || typeof body !== "object") {
    throw new CutoverError(`the Neon API answered ${purpose} without a JSON object`);
  }
  return fields;
}

/**
 * Resets `role`'s password on the branch and returns it once the last
 * operation has finished, which is when Neon says the password is ready.
 * `record` receives the password as soon as Neon issues it, so a failure
 * while waiting never loses it.
 */
export async function rotateNeonRolePassword(input: {
  transport: NeonTransport;
  projectId: string;
  branchId: string;
  role: string;
  record?: (password: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<string> {
  const { transport, role, record, pollIntervalMs = 1_000, timeoutMs = 120_000 } = input;
  const project = encodeURIComponent(input.projectId);
  const reset = await neonJson(
    transport,
    `/projects/${project}/branches/${encodeURIComponent(input.branchId)}/roles/${encodeURIComponent(role)}/reset_password`,
    { method: "POST" },
    `reset the password of ${role}`
  );
  const returned = reset.role as { name?: unknown; password?: unknown } | undefined;
  if (
    !returned ||
    returned.name !== role ||
    typeof returned.password !== "string" ||
    !/^[\x20-\x7e]{8,}$/.test(returned.password)
  ) {
    throw new CutoverError(
      `the Neon API did not return the new password for ${role}; it may now hold a password nobody ` +
        "knows, so rerun freeze with the same --rotated-password-file to reset it again"
    );
  }
  const password = returned.password;
  record?.(password);
  const branch = (reset.role as { branch_id?: unknown }).branch_id;
  if (branch !== input.branchId) {
    throw new CutoverError(
      `the Neon API reset ${role} on branch ${String(branch)}, not ${input.branchId}; ` +
        "its new password is recorded, but stop and check NEON_BRANCH_ID"
    );
  }

  const deadline = Date.now() + timeoutMs;
  const operations = Array.isArray(reset.operations) ? reset.operations : [];
  for (const operation of operations as Array<{ id?: unknown; status?: unknown }>) {
    const id = typeof operation.id === "string" ? operation.id : undefined;
    let status = operation.status;
    while (status !== "finished" && status !== "skipped") {
      // Neon documents failed, error and cancelled as the unsuccessful terminal statuses.
      if (status === "failed" || status === "error" || status === "cancelled") {
        throw new CutoverError(`Neon operation ${id ?? "?"} applying ${role}'s password ${status}`);
      }
      if (!id) throw new CutoverError(`a Neon operation applying ${role}'s password has no id`);
      if (Date.now() > deadline) {
        throw new CutoverError(`Neon operation ${id} applying ${role}'s password did not finish`);
      }
      await new Promise((done) => setTimeout(done, pollIntervalMs));
      const polled = await neonJson(
        transport,
        `/projects/${project}/operations/${encodeURIComponent(id)}`,
        { method: "GET" },
        `check operation ${id}`
      );
      status = (polled.operation as { status?: unknown } | undefined)?.status;
    }
  }
  return password;
}

/**
 * Opens `path` without following a symbolic link, and checks that it is a
 * regular file this user owns with mode 0600. Every refusal names the file.
 */
function openPrivateFile(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP") throw new CutoverError(`${path} is a symbolic link; name the file itself`);
    if (code === "ENOENT" && flags & fsConstants.O_CREAT) {
      throw new CutoverError(`the directory ${dirname(path)} does not exist; create it (mode 700) first`);
    }
    throw error;
  }
  const stat = fstatSync(fd);
  const mode = stat.mode & 0o777;
  const problem = !stat.isFile()
    ? "is not a regular file"
    : process.getuid && stat.uid !== process.getuid()
      ? "belongs to another user"
      : mode & 0o077
        ? `is readable by others (mode ${mode.toString(8)}); it must be 0600`
        : mode !== 0o600
          ? `has mode ${mode.toString(8)}; it must be 0600`
          : undefined;
  if (problem) {
    closeSync(fd);
    throw new CutoverError(`${path} ${problem}`);
  }
  return fd;
}

/**
 * The rotated-password file: one JSON object per line, `{"role", "password"}`,
 * only ever appended to. The newest entry for a role is its current password;
 * the older ones stay as the history.
 */
export function readRotatedPasswords(path: string): Map<string, string> {
  const passwords = new Map<string, string>();
  let fd: number;
  try {
    fd = openPrivateFile(path, fsConstants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return passwords;
    throw error;
  }
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: { role?: unknown; password?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      throw new CutoverError(`${path} line ${index + 1} is not a rotated-password entry`);
    }
    if (typeof entry.role !== "string" || typeof entry.password !== "string") {
      throw new CutoverError(`${path} line ${index + 1} is not a rotated-password entry`);
    }
    passwords.set(entry.role, entry.password);
  }
  return passwords;
}

/**
 * Opens the rotated-password file for appending, creating it 0600. Freeze
 * opens it before any Neon call, so a reset can always be recorded.
 */
export function openRotatedPasswordFile(path: string): number {
  return openPrivateFile(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND
  );
}

/** Appends one entry through `fd`, on a line of its own, and syncs it to disk. */
export function appendRotatedPassword(fd: number, role: string, password: string): void {
  const size = fstatSync(fd).size;
  const last = Buffer.alloc(1);
  const newline = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  writeSync(fd, `${newline ? "\n" : ""}${JSON.stringify({ role, password })}\n`);
  fsyncSync(fd);
}

export function recordRotatedPassword(path: string, role: string, password: string): void {
  const fd = openRotatedPasswordFile(path);
  try {
    appendRotatedPassword(fd, role, password);
  } finally {
    closeSync(fd);
  }
}

function rotatedPasswords(ctx: Context): Map<string, string> {
  const file = ctx.options.rotatedPasswordFile;
  return file ? readRotatedPasswords(resolve(file)) : new Map();
}

/**
 * A session as the source admin: with its newest recorded password once the
 * API path has rotated the admin's own role, or with CUTOVER_SOURCE_ADMIN_URL
 * as it is when Neon refuses that one (a reset that never took effect).
 */
async function connectSourceAdmin(ctx: Context, applicationName: string): Promise<Client> {
  const url = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  const rotated = rotatedPasswords(ctx).get(decodeURIComponent(new URL(url).username));
  if (rotated) {
    try {
      return await connect(withPassword(url, rotated), applicationName);
    } catch (error) {
      if (errorCode(error) !== "28P01") throw error;
    }
  }
  return connect(url, applicationName);
}

type ApiPath = { transport: NeonTransport; projectId: string; branchId: string; file: string };

/** The API path's inputs, all checked before anything connects. */
function apiPathInputs(ctx: Context): ApiPath | undefined {
  const { apiRoles, appRoles, rotatedPasswordFile } = ctx.options;
  if (apiRoles.length === 0) return undefined;
  const stray = apiRoles.filter((role) => !appRoles.includes(role));
  if (stray.length > 0) {
    throw new CutoverError(`--api-roles must be a subset of --app-roles (${stray.join(", ")})`);
  }
  const missing = ["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_BRANCH_ID"].filter(
    (name) => !ctx.env[name]
  );
  if (!rotatedPasswordFile) missing.push("--rotated-password-file");
  if (missing.length > 0) {
    throw new CutoverError(
      `the Neon API path for ${apiRoles.join(", ")} needs ${missing.join(", ")}`
    );
  }
  const projectId = ctx.env.NEON_PROJECT_ID!;
  const branchId = ctx.env.NEON_BRANCH_ID!;
  if (!NEON_ID.test(projectId) || !NEON_ID.test(branchId)) {
    throw new CutoverError("NEON_PROJECT_ID and NEON_BRANCH_ID must be Neon ids ([a-z0-9-])");
  }
  return {
    transport: ctx.deps.neonTransport ?? neonHttpTransport(ctx.env.NEON_API_KEY!),
    projectId,
    branchId,
    file: resolve(rotatedPasswordFile!),
  };
}

/**
 * Proves NEON_BRANCH_ID is the branch the admin URL's compute serves, before
 * any reset: a stale branch ID (P5's, say) would otherwise reset the roles
 * of whichever branch it names. The endpoint is the admin host's first label
 * (ep-...); a local host (the rehearsal) names it with NEON_ENDPOINT_ID.
 */
async function requireEndpointOnBranch(ctx: Context, api: ApiPath, adminUrl: string): Promise<void> {
  const label = hostOf(new URL(adminUrl)).split(".")[0]!.replace(/-pooler$/, "");
  const endpoint = /^ep-[a-z0-9-]+$/.test(label)
    ? label
    : isLocalUrl(adminUrl)
      ? ctx.env.NEON_ENDPOINT_ID
      : undefined;
  if (!endpoint || !/^ep-[a-z0-9-]{1,60}$/.test(endpoint)) {
    throw new CutoverError(
      `CUTOVER_SOURCE_ADMIN_URL names no Neon endpoint (ep-...), so NEON_BRANCH_ID cannot be checked against it`
    );
  }
  const answer = await neonJson(
    api.transport,
    `/projects/${encodeURIComponent(api.projectId)}/endpoints/${encodeURIComponent(endpoint)}`,
    { method: "GET" },
    `look up endpoint ${endpoint}`
  );
  const branch = (answer.endpoint as { branch_id?: unknown } | undefined)?.branch_id;
  if (branch !== api.branchId) {
    throw new CutoverError(
      `endpoint ${endpoint} serves branch ${String(branch)}, not NEON_BRANCH_ID ${api.branchId}; no password was reset`
    );
  }
}

// ---------------------------------------------------------------------------
// External tools

function toolPath(ctx: Context, name: "pg_dump" | "pg_restore"): string {
  return ctx.options.pgBinDir ? join(ctx.options.pgBinDir, name) : name;
}

function run(
  command: string,
  args: string[],
  env: CutoverEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      fail(new CutoverError(`could not run ${command}: ${error.message}`))
    );
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function toolMajor(ctx: Context, name: "pg_dump" | "pg_restore"): Promise<number> {
  const { code, stdout } = await run(toolPath(ctx, name), ["--version"], libpqToolEnv(ctx));
  const major = /\(PostgreSQL\)\s+(\d+)/.exec(stdout)?.[1];
  if (code !== 0 || !major)
    throw new CutoverError(`could not read the version of ${toolPath(ctx, name)}`);
  return Number(major);
}

function libpqToolEnv(ctx: Context): CutoverEnv {
  const env: CutoverEnv = {};
  for (const [key, value] of Object.entries(ctx.env)) {
    if (!key.startsWith("PG") && !key.startsWith("CUTOVER_")) env[key] = value;
  }
  return env;
}

function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}

async function serverMajor(client: Client): Promise<number> {
  const { rows } = await client.query<{ v: string }>(
    "SELECT current_setting('server_version_num') AS v"
  );
  return Math.floor(Number(rows[0]!.v) / 10_000);
}

function plan(ctx: Context, steps: string[]): void {
  ctx.io.log(`[cutover:${ctx.phase}] plan:`);
  steps.forEach((step, index) => ctx.io.log(`  ${index + 1}. ${step}`));
}

function say(ctx: Context, line: string): void {
  ctx.io.log(`[cutover:${ctx.phase}] ${line}`);
}

// ---------------------------------------------------------------------------
// Source role administration (freeze, rollback)

/** `problems` concern the admin itself; `roleProblems` one application role each. */
type AdminFacts = {
  me: string;
  database: string;
  problems: string[];
  roleProblems: Map<string, string>;
};

/**
 * What the admin role must be able to do on the source, checked before
 * anything changes. `apiRoles` are reset through the Neon API, so the admin
 * may be one of them; it must still be able to alter every other role.
 */
async function adminPreflight(
  client: Client,
  sqlRoles: string[],
  apiRoles: string[] = []
): Promise<AdminFacts> {
  const facts = await client.query<{
    me: string;
    database: string;
    superuser: boolean;
    owns_database: boolean;
    can_signal: boolean;
    major: string;
  }>(
    `SELECT current_user AS me, current_database() AS database,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'USAGE') AS owns_database,
            pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS can_signal,
            current_setting('server_version_num') AS major`
  );
  const { me, database, superuser, owns_database, can_signal } = facts.rows[0]!;
  const major = Math.floor(Number(facts.rows[0]!.major) / 10_000);
  const problems: string[] = [];
  const roleProblems = new Map<string, string>();
  // Only the SQL path locks a role out with NOLOGIN; the API path rotates the
  // admin's own password and carries on with the new one.
  if (sqlRoles.includes(me)) {
    roleProblems.set(
      me,
      `this phase runs as ${me}, which is a SQL-path application role it would lock out; put it on --api-roles`
    );
  }
  if (!superuser && !owns_database) problems.push(`${me} does not own database ${database}`);
  if (!superuser && !can_signal) problems.push(`${me} is not a member of pg_signal_backend`);
  for (const role of [...sqlRoles, ...apiRoles.filter((apiRole) => apiRole !== me)]) {
    if (roleProblems.has(role)) continue;
    const { rows } = await client.query<{
      exists: boolean;
      super: boolean;
      admin: boolean;
      createrole: boolean;
    }>(
      `SELECT r.rolname IS NOT NULL AS exists, coalesce(r.rolsuper, false) AS super,
              r.rolname IS NOT NULL AND pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION') AS admin,
              (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS createrole
       FROM (SELECT $1::text AS name) wanted LEFT JOIN pg_roles r ON r.rolname = wanted.name`,
      [role]
    );
    const row = rows[0]!;
    if (!row.exists) roleProblems.set(role, `role ${role} does not exist`);
    else if (row.super && !superuser)
      roleProblems.set(role, `role ${role} is a superuser and cannot be locked by ${me}`);
    else if (!superuser && !(major >= 16 ? row.admin : row.createrole)) {
      roleProblems.set(
        role,
        `${me} cannot alter role ${role} (needs ADMIN OPTION on it, or CREATEROLE before PostgreSQL 16)`
      );
    }
  }
  return { me, database, problems, roleProblems };
}

/**
 * Another role's session shows its backend type and state only to a member
 * of pg_read_all_stats, which pg_monitor includes: without it, a held
 * session would read as none.
 */
async function sessionVisibilityProblem(client: Client): Promise<string | undefined> {
  const { rows } = await client.query<{ me: string; sees: boolean }>(
    "SELECT current_user AS me, pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS sees"
  );
  return rows[0]!.sees
    ? undefined
    : `${rows[0]!.me} cannot see other roles' sessions: grant it pg_monitor (or pg_read_all_stats); ` +
        "Neon's console roles have pg_monitor through neon_superuser";
}

/**
 * Login roles, other than this session's and the named application roles,
 * that could write to this database: a member of pg_write_all_data (every
 * Neon console role, through neon_superuser), a role with a write privilege
 * on a table, or one that can create in a schema. The freeze locks out only
 * the roles it names, so each of these could still write after FROZEN.
 */
async function unlistedWriters(client: Client, roles: string[]): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string }>(
    `SELECT r.rolname FROM pg_roles r
     WHERE r.rolcanlogin AND NOT r.rolsuper AND r.rolname <> current_user
       AND r.rolname <> ALL($1::text[])
       AND has_database_privilege(r.oid, current_database(), 'CONNECT')
       AND (pg_has_role(r.oid, 'pg_write_all_data', 'MEMBER')
         OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p')
                      AND has_table_privilege(r.oid, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
         OR EXISTS (SELECT 1 FROM pg_namespace n
                    WHERE ${USER_SCHEMA} AND has_schema_privilege(r.oid, n.oid, 'CREATE')))
     ORDER BY 1`,
    [roles]
  );
  return rows.map((row) => row.rolname);
}

function unlistedWritersProblem(writers: string[], database: string): string {
  return (
    `login role(s) ${writers.join(", ")} can write to ${database} but are not in --app-roles: ` +
    "add each with its CUTOVER_ROLE_URL_<ROLE>, or take away its LOGIN if no consumer uses it"
  );
}

/** Every other client session of this database, whatever its role. */
const OTHER_CLIENT_SESSIONS = `a.datname = current_database() AND a.backend_type = 'client backend'
  AND a.pid <> pg_backend_pid()`;
/** Only a superuser may end a superuser's session; on Neon those are its own control plane's. */
const SUPERUSER_SESSION =
  "coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.oid = a.usesysid), false)";

/**
 * The other client sessions of this database, by role, with the superuser
 * sessions counted apart. A session that has just closed can linger in
 * pg_stat_activity for a moment, so a non-empty answer is rechecked for up
 * to five seconds.
 */
async function otherClientSessions(
  client: Client
): Promise<{ others: string[]; superuser: number }> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await client.query<{
      usename: string | null;
      superuser: boolean;
      n: number;
    }>(
      `SELECT a.usename, ${SUPERUSER_SESSION} AS superuser, count(*)::int AS n
       FROM pg_stat_activity a WHERE ${OTHER_CLIENT_SESSIONS} GROUP BY 1, 2 ORDER BY 1`
    );
    const others = rows
      .filter((row) => !row.superuser)
      .map((row) => `${row.usename ?? "?"} (${row.n})`);
    const superuser = rows.filter((row) => row.superuser).reduce((sum, row) => sum + row.n, 0);
    if (others.length === 0 || Date.now() > deadline) return { others, superuser };
    await new Promise((done) => setTimeout(done, 250));
  }
}

function appRoleUrls(ctx: Context): Array<{ role: string; url: string }> {
  const roles = ctx.options.appRoles;
  if (roles.length === 0) throw new CutoverError(`${ctx.phase} needs --app-roles`);
  const missing = roles.filter((role) => !ctx.env[roleUrlEnvName(role)]).map(roleUrlEnvName);
  if (missing.length > 0) {
    throw new CutoverError(
      `${ctx.phase} needs each role's pre-freeze credential: set ${missing.join(", ")}`
    );
  }
  return roles.map((role) => {
    const url = envUrl(ctx, roleUrlEnvName(role));
    const user = decodeURIComponent(new URL(url).username);
    if (user !== role)
      throw new CutoverError(`${roleUrlEnvName(role)} logs in as ${user}, not ${role}`);
    return { role, url };
  });
}

// ---------------------------------------------------------------------------
// Phases

async function inventory(ctx: Context): Promise<number> {
  const url = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", url);
  const { expectFrozen } = ctx.options;
  if (expectFrozen && ctx.options.appRoles.length === 0) {
    throw new CutoverError("--expect-frozen needs --app-roles");
  }
  // With --app-roles, every role's credential is part of the answer.
  const targets = ctx.options.appRoles.length > 0 ? appRoleUrls(ctx) : [];
  const roles = targets.map((target) => target.role);
  plan(ctx, [
    `read-only catalog queries against ${describeUrl(url)}; nothing is changed`,
    ...(targets.length > 0 && !expectFrozen
      ? ["log in with each CUTOVER_ROLE_URL_<ROLE>: every login must succeed (step 1's go/no-go)"]
      : []),
    ...(expectFrozen
      ? [
          "with --expect-frozen, a login with each CUTOVER_ROLE_URL_<ROLE> must be refused, and no other client session may remain",
        ]
      : []),
  ]);
  const client = await connectSourceAdmin(ctx, "neon-cutover-inventory");
  try {
    const blind = await sessionVisibilityProblem(client);
    if (blind) throw new CutoverError(`${blind}; without it the session list would be incomplete`);
    const about = await client.query<{
      version: string;
      me: string;
      database: string;
      read_only: string | null;
    }>(
      `SELECT current_setting('server_version') AS version, current_user AS me, current_database() AS database,
              (SELECT substring(setting FROM '^default_transaction_read_only=(.*)$')
                 FROM pg_db_role_setting s, unnest(s.setconfig) AS setting
                WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND s.setrole = 0 AND setting LIKE 'default_transaction_read_only=%') AS read_only`
    );
    const { version, me, database, read_only } = about.rows[0]!;
    say(ctx, `server ${version}; connected as ${me} to ${database}`);
    say(ctx, `database default_transaction_read_only: ${read_only ?? "unset (off)"}`);

    const schemas = await client.query<{ nspname: string; tables: number; sequences: number }>(
      `SELECT n.nspname, count(c.oid) FILTER (WHERE c.relkind IN ('r', 'p'))::int AS tables,
              count(c.oid) FILTER (WHERE c.relkind = 'S')::int AS sequences
       FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
       WHERE ${USER_SCHEMA} GROUP BY n.nspname ORDER BY n.nspname`
    );
    say(ctx, "schemas (tables, sequences):");
    for (const row of schemas.rows)
      ctx.io.log(`  ${row.nspname.padEnd(32)} ${row.tables} ${row.sequences}`);

    const extensions = await client.query<{
      extname: string;
      extversion: string;
      trusted: boolean | null;
    }>(
      `SELECT e.extname, e.extversion,
              (SELECT v.trusted OR NOT v.superuser FROM pg_available_extension_versions v
                WHERE v.name = e.extname AND v.version = e.extversion) AS trusted
       FROM pg_extension e ORDER BY e.extname`
    );
    say(ctx, "extensions:");
    for (const row of extensions.rows) {
      const note = row.trusted === false ? "  (needs a superuser to create: restore blocker)" : "";
      ctx.io.log(`  ${row.extname.padEnd(24)} ${row.extversion}${note}`);
    }

    const blockers = await client.query<{ kind: string; n: number }>(
      `SELECT 'publication' AS kind, count(*)::int AS n FROM pg_publication
       UNION ALL SELECT 'event trigger', count(*)::int FROM pg_event_trigger
       UNION ALL SELECT 'large object', count(*)::int FROM pg_largeobject_metadata
       UNION ALL SELECT 'foreign server', count(*)::int FROM pg_foreign_server`
    );
    const found = blockers.rows.filter((row) => row.n > 0);
    say(
      ctx,
      found.length === 0
        ? "restore blockers: none (no publications, event triggers, large objects or foreign servers)"
        : `restore blockers: ${found.map((row) => `${row.n} ${row.kind}(s)`).join(", ")}`
    );

    const logins = await client.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
       WHERE (rolcanlogin OR rolname = ANY($1::text[])) AND rolname NOT LIKE 'pg\\_%' ORDER BY rolname`,
      [roles]
    );
    say(ctx, "login roles (can log in, superuser):");
    for (const row of logins.rows) {
      const tag = roles.includes(row.rolname)
        ? "  [application role]"
        : row.rolname === me
          ? "  [this session]"
          : "";
      ctx.io.log(`  ${row.rolname.padEnd(32)} ${row.rolcanlogin} ${row.rolsuper}${tag}`);
    }
    const unlisted = logins.rows.filter(
      (row) =>
        row.rolcanlogin && !row.rolsuper && row.rolname !== me && !roles.includes(row.rolname)
    );
    const writers = roles.length > 0 ? await unlistedWriters(client, roles) : [];
    if (roles.length > 0 && unlisted.length > 0) {
      say(
        ctx,
        `note: login roles not named in --app-roles: ${unlisted.map((row) => row.rolname).join(", ")}; ` +
          "each must be the dump role or a role no consumer uses, and none may be able to write"
      );
    }

    const sessions = await client.query<{
      usename: string | null;
      datname: string | null;
      application_name: string;
      client_addr: string | null;
      state: string | null;
      n: number;
    }>(
      `SELECT usename, datname, application_name, host(client_addr) AS client_addr, state, count(*)::int AS n
       FROM pg_stat_activity
       WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
       GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`
    );
    say(ctx, "client sessions (role, database, application, address, state, count):");
    if (sessions.rows.length === 0) ctx.io.log("  none");
    for (const row of sessions.rows) {
      ctx.io.log(
        `  ${row.usename ?? "?"} ${row.datname ?? "?"} "${row.application_name}" ${row.client_addr ?? "local"} ${row.state ?? "?"} ${row.n}`
      );
    }

    if (targets.length === 0) return 0;
    const failures: string[] = [];
    if (writers.length > 0) failures.push(unlistedWritersProblem(writers, database));

    if (!expectFrozen) {
      // Step 1's go/no-go: a credential that does not log in now would later
      // pass for a lockout, and rollback would restore it.
      for (const { role, url: roleUrl } of targets) {
        const refusal = await loginRefusal(roleUrl, "neon-cutover-inventory-probe");
        if (refusal === undefined) ctx.io.log(`  OK   ${role}: its CUTOVER_ROLE_URL logs in`);
        else {
          ctx.io.log(`  FAIL ${role}: its CUTOVER_ROLE_URL does not log in (${refusal})`);
          failures.push(`${role}'s credential does not log in`);
        }
      }
      if (failures.length > 0) {
        say(ctx, `NO-GO: ${failures.join("; ")}`);
        return 2;
      }
      say(ctx, `GO: every CUTOVER_ROLE_URL of ${roles.join(", ")} logs in`);
      return 0;
    }

    if (read_only !== "on") failures.push("the database read-only default is not on");
    const { others, superuser } = await otherClientSessions(client);
    if (others.length > 0)
      failures.push(`other client session(s) of ${database} remain: ${others.join(", ")}`);
    if (superuser > 0)
      ctx.io.log(`  note ${superuser} superuser session(s) on ${database}, which only a superuser can end`);
    for (const { role, url: roleUrl } of targets) {
      const row = logins.rows.find((candidate) => candidate.rolname === role);
      // The admin's own API-path role keeps LOGIN: only its password changed.
      const keepsLogin = role === me && ctx.options.apiRoles.includes(role);
      if (!row) failures.push(`role ${role} does not exist`);
      else if (row.rolcanlogin && !keepsLogin)
        failures.push(`role ${role} can log in; rerun freeze`);
      // A compute restart that re-applied a role's old settings shows here.
      const code = await preFreezeLoginRefusal(roleUrl);
      if (code) ctx.io.log(`  OK   ${role}: its pre-freeze credential is refused (${code})`);
      else
        failures.push(`role ${role}'s pre-freeze credential logs in or the attempt was inconclusive`);
    }
    if (failures.length > 0) {
      say(ctx, `NOT FROZEN: ${failures.join("; ")}`);
      return 2;
    }
    say(
      ctx,
      `FROZEN: ${roles.join(", ")} locked out, no other client session, read-only default on`
    );
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function freeze(ctx: Context): Promise<number> {
  const baseAdminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl]]);
  const api = apiPathInputs(ctx);
  const targets = appRoleUrls(ctx);
  const roles = targets.map((target) => target.role);
  const apiRoles = ctx.options.apiRoles;
  const sqlRoles = roles.filter((role) => !apiRoles.includes(role));
  // Before any Neon call: the file that must record every reset, and the branch.
  const fd = api ? openRotatedPasswordFile(api.file) : undefined;
  let client: Client | undefined;
  let admin = "";
  try {
    if (api) await requireEndpointOnBranch(ctx, api, baseAdminUrl);
    try {
      client = await connectSourceAdmin(ctx, "neon-cutover-freeze");
    } catch (error) {
      if (errorCode(error) !== "28P01") throw error;
      throw new CutoverError(
        `CUTOVER_SOURCE_ADMIN_URL's password is refused, and no recorded one logs in. ${LOST_RESET}`
      );
    }
    // A rerun meets a database whose default is already read-only, and ALTER
    // ROLE and ALTER DATABASE are refused inside a read-only transaction.
    await client.query("SET default_transaction_read_only = off");
    const facts = await adminPreflight(client, sqlRoles, apiRoles);
    const problems = [...facts.problems, ...facts.roleProblems.values()];
    const blind = await sessionVisibilityProblem(client);
    if (blind) problems.push(blind);
    const writers = await unlistedWriters(client, roles);
    if (writers.length > 0) problems.push(unlistedWritersProblem(writers, facts.database));
    if (problems.length > 0)
      throw new CutoverError(`freeze preflight failed: ${problems.join("; ")}`);
    admin = facts.me;

    // Each role's credential is proven by a login in this run, before
    // anything changes: a stale one would pass for a lockout, and rollback
    // would restore it. An API role whose newest recorded password is live
    // was rotated by an earlier run; its pre-freeze credential died then.
    const recorded = api ? readRotatedPasswords(api.file) : new Map<string, string>();
    const rotatedEarlier: string[] = [];
    const unproven: string[] = [];
    for (const { role, url } of targets) {
      const password = apiRoles.includes(role) ? recorded.get(role) : undefined;
      if (password) {
        const refusal = await loginRefusal(withPassword(url, password), "neon-cutover-freeze-probe");
        if (refusal === undefined || refusal === "28000") {
          rotatedEarlier.push(role);
          continue;
        }
      }
      const refusal = await loginRefusal(url, "neon-cutover-freeze-probe");
      if (refusal !== undefined) unproven.push(`${role} (${refusal})`);
    }
    if (unproven.length > 0) {
      throw new CutoverError(
        `the pre-freeze credential of ${unproven.join(", ")} does not log in; nothing was changed. ` +
          "Fix a stale CUTOVER_ROLE_URL_<ROLE>. If an earlier freeze of this window rotated a " +
          `SQL-path role, run rollback, then freeze again. For an API-path role: ${LOST_RESET}`
      );
    }
    // The API path's extra layer: NOLOGIN too, on every API role but the admin's own.
    const extraNologin = apiRoles.filter((role) => role !== admin);
    const toRotate = apiRoles.filter((role) => !rotatedEarlier.includes(role));
    plan(ctx, [
      ...(api
        ? [
            `reset the password of ${apiRoles.join(", ")} through the Neon API ` +
              (rotatedEarlier.length === 0 ? "" : `(already rotated: ${rotatedEarlier.join(", ")}) `) +
              `and record it only in ${api.file} (0600, never printed)`,
          ]
        : []),
      ...(sqlRoles.length > 0
        ? [`ALTER ROLE ... NOLOGIN PASSWORD <random, never printed> for ${sqlRoles.join(", ")}`]
        : []),
      ...(extraNologin.length > 0 ? [`ALTER ROLE ... NOLOGIN for ${extraNologin.join(", ")}`] : []),
      `ALTER DATABASE ${facts.database} SET default_transaction_read_only = on`,
      `then terminate every other client session of ${facts.database}, whatever its role`,
      "prove it: every pre-freeze credential is refused at login, an API role's rotated password is the one recorded, and no other client session remains",
    ]);

    if (api) {
      for (const role of toRotate) {
        await rotateNeonRolePassword({
          transport: api.transport,
          projectId: api.projectId,
          branchId: api.branchId,
          role,
          record: (password) => appendRotatedPassword(fd!, role, password),
        });
        say(ctx, `${role}: password reset through the Neon API and recorded in ${api.file}`);
      }
      // The admin may be one of them: carry on in a session opened with its new password.
      await client.end().catch(() => undefined);
      client = await connectSourceAdmin(ctx, "neon-cutover-freeze");
      await client.query("SET default_transaction_read_only = off");
    }
    for (const role of sqlRoles) {
      // The random password is hashed here and discarded: nobody ever learns it.
      const verifier = scramSha256Verifier(randomBytes(32).toString("base64url"));
      await client.query(
        `ALTER ROLE ${client.escapeIdentifier(role)} WITH NOLOGIN PASSWORD ${client.escapeLiteral(verifier)}`
      );
      say(ctx, `${role}: NOLOGIN, password rotated`);
    }
    for (const role of extraNologin) {
      await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} WITH NOLOGIN`);
      say(ctx, `${role}: NOLOGIN`);
    }
    // The default first, so a session that connects during the sweep starts read-only.
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(facts.database)} SET default_transaction_read_only = on`
    );
    say(ctx, `${facts.database}: default_transaction_read_only = on`);
    const terminated = await terminateOtherSessions(client);
    say(ctx, `terminated ${terminated} other client session(s) of ${facts.database}`);
  } finally {
    await client?.end().catch(() => undefined);
    if (fd !== undefined) closeSync(fd);
  }
  return proveFrozen(ctx, targets, admin);
}

/**
 * Terminates every other client session of this database, whatever its
 * role (the admin's other sessions too), until none is left. A superuser's
 * session is left alone: only a superuser may end it.
 */
async function terminateOtherSessions(client: Client): Promise<number> {
  let terminated = 0;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { rows } = await client.query<{ done: boolean }>(
      `SELECT pg_terminate_backend(a.pid) AS done FROM pg_stat_activity a
       WHERE ${OTHER_CLIENT_SESSIONS} AND NOT ${SUPERUSER_SESSION}`
    );
    if (rows.length === 0) return terminated;
    terminated += rows.filter((row) => row.done).length;
    if (Date.now() > deadline)
      throw new CutoverError("client sessions of the database survived 30 s of termination");
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Where a lost reset leaves a role, and the way back (the runbook's freeze step). */
const LOST_RESET =
  "If an earlier freeze's reset lost its response, nobody holds the role's live password: " +
  "reset it in the Neon console, set CUTOVER_SOURCE_ADMIN_URL (for the admin) and the role's " +
  "CUTOVER_ROLE_URL_<ROLE> to the console's connection string, and rerun freeze";

/**
 * The same connection string, with the read-only default overridden the way
 * any client could. A Neon pooled host is swapped for its direct endpoint:
 * the pooler may reject the `options` startup parameter, and the compute
 * behind both is what enforces the lockout.
 */
export function withReadWriteOverride(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/^([^.]+)-pooler\./, "$1.");
  const options = parsed.searchParams.get("options");
  parsed.searchParams.set(
    "options",
    `${options ? `${options} ` : ""}-c default_transaction_read_only=off`
  );
  return parsed.toString();
}

/**
 * Attempts a writable login with a pre-freeze credential. Returns the
 * SQLSTATE when the server refuses it at login (28P01 wrong password,
 * 28000 NOLOGIN), or undefined when it logged in or the attempt was
 * inconclusive, which is never evidence of a lockout.
 */
async function preFreezeLoginRefusal(url: string): Promise<string | undefined> {
  const code = await loginRefusal(url, "neon-cutover-freeze-probe");
  return code === "28000" || code === "28P01" ? code : undefined;
}

/**
 * Logs in with `url` on the direct endpoint, then out again: undefined when
 * the login succeeded, else why it did not (a SQLSTATE such as 28P01, or a
 * connection error's code).
 */
async function loginRefusal(url: string, applicationName: string): Promise<string | undefined> {
  try {
    const probe = await connect(withReadWriteOverride(url), applicationName);
    await probe.end().catch(() => undefined);
    return undefined;
  } catch (error) {
    return errorCode(error) ?? "no SQLSTATE";
  }
}

/**
 * The freeze counts only once it is proven:
 * - each role's pre-freeze credential is refused at login, even when the
 *   client overrides the read-only default;
 * - an API role's recorded password is the live one: the admin's own role
 *   logs in with it, and any other API role is refused only by NOLOGIN;
 * - no other client session of the database remains, and a new session is
 *   read-only.
 */
async function proveFrozen(
  ctx: Context,
  targets: Array<{ role: string; url: string }>,
  admin: string
): Promise<number> {
  const roles = targets.map((target) => target.role);
  const apiRoles = ctx.options.apiRoles;
  const mustBeNologin = roles.filter((role) => !(role === admin && apiRoles.includes(role)));
  const rotated = rotatedPasswords(ctx);
  const failures: string[] = [];
  const check = await connectSourceAdmin(ctx, "neon-cutover-freeze-proof");
  try {
    const setting = await check.query<{ value: string }>(
      "SELECT current_setting('default_transaction_read_only') AS value"
    );
    if (setting.rows[0]!.value !== "on") failures.push("a new session is not read-only");
    try {
      await check.query("CREATE TEMP TABLE neon_cutover_freeze_probe (x int)");
      failures.push("a new session could still write");
    } catch (error) {
      if (errorCode(error) !== "25006")
        failures.push(`the read-only probe failed unexpectedly (${errorCode(error)})`);
    }
    const locked = await check.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
      [mustBeNologin]
    );
    for (const row of locked.rows)
      if (row.rolcanlogin) failures.push(`${row.rolname} can still log in`);
    const { others, superuser } = await otherClientSessions(check);
    if (others.length > 0) failures.push(`other client session(s) remain: ${others.join(", ")}`);
    if (superuser > 0)
      say(ctx, `note ${superuser} superuser session(s), which only a superuser can end, were left`);
  } finally {
    await check.end().catch(() => undefined);
  }

  for (const { role, url } of targets) {
    const code = await preFreezeLoginRefusal(url);
    if (code)
      say(
        ctx,
        `OK   ${role}: a write with its pre-freeze credential is refused at login (${code})`
      );
    else
      failures.push(`${role}: its pre-freeze credential logs in, or the attempt was inconclusive`);
    if (!apiRoles.includes(role)) continue;

    const password = rotated.get(role);
    if (!password) {
      failures.push(`${role}: no rotated password is recorded`);
      continue;
    }
    try {
      const session = await connect(withPassword(url, password), "neon-cutover-freeze-proof");
      await session.end().catch(() => undefined);
      if (role === admin) say(ctx, `OK   ${role}: logs in with its rotated password only`);
      else failures.push(`${role} logs in with its rotated password although it should be NOLOGIN`);
    } catch (error) {
      const refused = errorCode(error);
      if (role !== admin && refused === "28000") {
        say(ctx, `OK   ${role}: its rotated password is live and NOLOGIN refuses it (28000)`);
      } else {
        failures.push(
          `${role}: its recorded rotated password does not log in (${refused ?? "no SQLSTATE"})`
        );
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) ctx.io.log(`  FAIL ${failure}`);
    say(ctx, "FREEZE NOT PROVEN: do not dump; see the runbook's freeze step");
    return 2;
  }
  say(
    ctx,
    `FROZEN: every pre-freeze credential of ${roles.join(", ")} is refused, no other client session remains, and new sessions are read-only`
  );
  return 0;
}

/**
 * Creates the dump role named by CUTOVER_SOURCE_DUMP_URL, with that URL's
 * password sent as a SCRAM verifier, so the plaintext reaches neither a
 * command line nor the server log. Then grants it pg_read_all_data and logs
 * in as it.
 */
async function createDumpRole(ctx: Context): Promise<number> {
  const adminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  const dumpUrl = envUrl(ctx, "CUTOVER_SOURCE_DUMP_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", adminUrl);
  refuseTransactionPooler("CUTOVER_SOURCE_DUMP_URL", dumpUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", adminUrl]]);
  const role = decodeURIComponent(new URL(dumpUrl).username);
  const verifier = scramSha256Verifier(decodeURIComponent(new URL(dumpUrl).password));
  const client = await connect(adminUrl, "neon-cutover-create-dump-role");
  try {
    const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existing.rowCount) throw new CutoverError(`role ${role} already exists; it is left as it is`);
    plan(ctx, [
      `CREATE ROLE ${role} LOGIN PASSWORD <CUTOVER_SOURCE_DUMP_URL's password, sent as a SCRAM verifier>`,
      `GRANT pg_read_all_data TO ${role}`,
      `log in with CUTOVER_SOURCE_DUMP_URL (${describeUrl(dumpUrl)})`,
    ]);
    await client.query(
      `CREATE ROLE ${client.escapeIdentifier(role)} LOGIN PASSWORD ${client.escapeLiteral(verifier)}`
    );
    say(ctx, `${role}: created`);
    try {
      await client.query(`GRANT pg_read_all_data TO ${client.escapeIdentifier(role)}`);
    } catch (error) {
      if (errorCode(error) !== "42501") throw error;
      say(
        ctx,
        `the server refused GRANT pg_read_all_data (42501); have the tables' owner grant ${role} ` +
          "USAGE and SELECT on every schema, table and sequence instead (see the runbook)"
      );
      return 2;
    }
    say(ctx, `${role}: granted pg_read_all_data`);
  } finally {
    await client.end().catch(() => undefined);
  }
  const probe = await connect(dumpUrl, "neon-cutover-create-dump-role");
  await probe.end().catch(() => undefined);
  say(ctx, `${role}: logs in with CUTOVER_SOURCE_DUMP_URL`);
  return 0;
}

async function dump(ctx: Context): Promise<number> {
  const url = envUrl(ctx, "CUTOVER_SOURCE_DUMP_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_DUMP_URL", url);
  const archive = ctx.options.archive ? resolve(ctx.options.archive) : undefined;
  if (!archive) throw new CutoverError("dump needs --archive=<path>");
  if (existsSync(archive) || existsSync(`${archive}.sha256`)) {
    throw new CutoverError(
      `${archive} (or its .sha256) already exists; an archive is never overwritten`
    );
  }
  const client = await connect(url, "neon-cutover-dump");
  let sourceVersion: string;
  try {
    const major = await serverMajor(client);
    const dumpMajor = await toolMajor(ctx, "pg_dump");
    if (dumpMajor < major) {
      throw new CutoverError(
        `pg_dump ${dumpMajor} is older than the source server's major version ${major}`
      );
    }
    const state = await client.query<{ read_only: string; me: string; version: string }>(
      "SELECT current_setting('default_transaction_read_only') AS read_only, current_user AS me, current_setting('server_version') AS version"
    );
    sourceVersion = state.rows[0]!.version;
    if (state.rows[0]!.read_only !== "on" && !ctx.options.allowUnfrozen) {
      throw new CutoverError(
        "the source is not frozen (a new session is not read-only); run freeze first, or pass --allow-unfrozen for a timing trial"
      );
    }
    const unreadable = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'S', 'm')
         AND NOT (has_schema_privilege(n.oid, 'USAGE') AND CASE WHEN c.relkind = 'S'
           THEN has_sequence_privilege(c.oid, 'SELECT') ELSE has_table_privilege(c.oid, 'SELECT') END)
       ORDER BY 1`
    );
    if (unreadable.rows.length > 0) {
      throw new CutoverError(
        `${state.rows[0]!.me} cannot read ${unreadable.rows.length} relation(s): ` +
          unreadable.rows.map((row) => row.name).join(", ")
      );
    }
    plan(ctx, [
      `${toolPath(ctx, "pg_dump")} (major ${dumpMajor}) --format=custom --no-owner --no-acl of ${describeUrl(url)} (server ${sourceVersion}) as ${state.rows[0]!.me}`,
      `write ${archive} and ${archive}.sha256`,
    ]);
  } finally {
    await client.end().catch(() => undefined);
  }

  const result = await run(
    toolPath(ctx, "pg_dump"),
    ["--format=custom", "--no-owner", "--no-acl", "--no-password", `--file=${archive}`],
    libpqEnv(ctx, url, "neon-cutover-dump")
  );
  if (result.code !== 0) {
    ctx.io.error(result.stderr.trim());
    // Only this run could have created it: the phase refused an existing file.
    rmSync(archive, { force: true });
    throw new CutoverError(`pg_dump exited with status ${result.code}; no archive was kept`);
  }
  const digest = await sha256File(archive);
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  say(
    ctx,
    `wrote ${archive}: ${statSync(archive).size} bytes, sha256 ${digest}, source server ${sourceVersion}`
  );
  return 0;
}

type ArchiveToc = { dumpedFrom: number; dumpedBy: number; schemas: string[]; tables: number };

async function readToc(ctx: Context, archive: string): Promise<ArchiveToc> {
  const { code, stdout, stderr } = await run(
    toolPath(ctx, "pg_restore"),
    ["--list", archive],
    libpqToolEnv(ctx)
  );
  if (code !== 0) {
    ctx.io.error(stderr.trim());
    throw new CutoverError(`pg_restore --list could not read ${archive}`);
  }
  const dumpedFrom = /Dumped from database version: (\d+)/.exec(stdout)?.[1];
  const dumpedBy = /Dumped by pg_dump version: (\d+)/.exec(stdout)?.[1];
  if (!dumpedFrom || !dumpedBy) throw new CutoverError(`${archive} has no version header`);
  const schemas = new Set<string>(["public"]);
  let tables = 0;
  for (const line of stdout.split("\n")) {
    // "TABLE <schema> <name> <owner>"; a table's rows are a separate "TABLE DATA" entry.
    const table = /^\d+; \d+ \d+ TABLE (?!DATA )(\S+) \S+/.exec(line);
    if (table) {
      schemas.add(table[1]!);
      tables += 1;
    }
    const schema = /^\d+; \d+ \d+ SCHEMA - (\S+)/.exec(line);
    if (schema) schemas.add(schema[1]!);
  }
  return {
    dumpedFrom: Number(dumpedFrom),
    dumpedBy: Number(dumpedBy),
    schemas: [...schemas].sort(),
    tables,
  };
}

/** The target session runs as substrate_owner, which owns the target database. */
async function requireTargetOwner(client: Client): Promise<void> {
  const { rows } = await client.query<{ me: string; owner: string }>(
    `SELECT current_user AS me, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`
  );
  const { me, owner } = rows[0]!;
  if (me !== TARGET_OWNER)
    throw new CutoverError(`CUTOVER_TARGET_OWNER_URL logs in as ${me}, not ${TARGET_OWNER}`);
  if (owner !== TARGET_OWNER)
    throw new CutoverError(`the target database is owned by ${owner}, not ${TARGET_OWNER}`);
}

async function restore(ctx: Context): Promise<number> {
  const url = envUrl(ctx, "CUTOVER_TARGET_OWNER_URL");
  refuseTransactionPooler("CUTOVER_TARGET_OWNER_URL", url);
  const archive = ctx.options.archive ? resolve(ctx.options.archive) : undefined;
  if (!archive) throw new CutoverError("restore needs --archive=<path>");
  if (!existsSync(archive) || !existsSync(`${archive}.sha256`)) {
    throw new CutoverError(`${archive} and ${archive}.sha256 must both exist`);
  }
  const recorded = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actual = await sha256File(archive);
  if (recorded !== actual)
    throw new CutoverError(`${archive} does not match its recorded sha256 checksum`);

  const toc = await readToc(ctx, archive);
  const restoreMajor = await toolMajor(ctx, "pg_restore");
  if (restoreMajor < toc.dumpedBy) {
    throw new CutoverError(
      `pg_restore ${restoreMajor} is older than the pg_dump ${toc.dumpedBy} that wrote the archive`
    );
  }
  const client = await connect(url, "neon-cutover-restore");
  try {
    await requireTargetOwner(client);
    const major = await serverMajor(client);
    if (major < toc.dumpedFrom) {
      throw new CutoverError(
        `the target server (major ${major}) is older than the source (major ${toc.dumpedFrom})`
      );
    }
    const occupied = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       ORDER BY 1 LIMIT 5`,
      [toc.schemas]
    );
    if (occupied.rows.length > 0) {
      throw new CutoverError(
        `the target is not empty in the schemas the archive restores (${toc.schemas.join(", ")}): ` +
          occupied.rows.map((row) => row.name).join(", ")
      );
    }
    plan(ctx, [
      `sha256 of ${archive} matches (${actual})`,
      `${toolPath(ctx, "pg_restore")} (major ${restoreMajor}) --no-owner --no-acl --single-transaction --exit-on-error ` +
        `into ${describeUrl(url)} (server major ${major}): ${toc.tables} table(s) in ${toc.schemas.join(", ")}`,
    ]);
  } finally {
    await client.end().catch(() => undefined);
  }

  const result = await run(
    toolPath(ctx, "pg_restore"),
    [
      "--no-owner",
      "--no-acl",
      "--single-transaction",
      "--exit-on-error",
      "--no-password",
      `--dbname=${databaseOf(new URL(url))}`,
      archive,
    ],
    libpqEnv(ctx, url, "neon-cutover-restore")
  );
  if (result.code !== 0) {
    ctx.io.error(result.stderr.trim());
    throw new CutoverError(
      `pg_restore exited with status ${result.code}; the single transaction rolled back`
    );
  }
  say(ctx, `restored ${toc.tables} table(s) as ${TARGET_OWNER}`);
  return 0;
}

async function grants(ctx: Context): Promise<number> {
  const url = envUrl(ctx, "CUTOVER_TARGET_OWNER_URL");
  refuseTransactionPooler("CUTOVER_TARGET_OWNER_URL", url);
  const client = await connect(url, "neon-cutover-grants");
  try {
    await requireTargetOwner(client);
    const tracking = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present"
    );
    if (!tracking.rows[0]!.present)
      throw new CutoverError("the target has no schema_migrations; restore first");
    const applied = new Set(
      (
        await client.query<{ version: string }>("SELECT version FROM public.schema_migrations")
      ).rows.map((row) => row.version)
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    const pending = files.filter((name) => !applied.has(name));
    const unknown = [...applied].filter((name) => !files.includes(name));
    if (pending.length > 0 || unknown.length > 0) {
      throw new CutoverError(
        "the restored schema and this checkout disagree " +
          `(pending here: ${pending.join(", ") || "none"}; applied there only: ${unknown.join(", ") || "none"}); ` +
          "run the cutover from the commit production runs"
      );
    }
    const roles = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
      [TARGET_ROLES]
    );
    const missing = TARGET_ROLES.filter((role) => !roles.rows.some((row) => row.rolname === role));
    if (missing.length > 0) {
      throw new CutoverError(
        `roles ${missing.join(", ")} do not exist on the target; the grants script would skip them`
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  plan(ctx, [
    `scripts/migrate.ts against ${describeUrl(url)}: no migration is pending, so it applies only scripts/exomem-cloud-grants.sql`,
    "check the D7 role shape as substrate_app, exomem_cellctl and exomem_gateway",
  ]);
  await applyMigrations({
    databaseUrl: nodePgConnectionString(url),
    migrationsDir: MIGRATIONS_DIR,
    grantsFile: GRANTS_FILE,
  });

  const check = await connect(url, "neon-cutover-grants");
  try {
    const failures = await roleShapeFailures(check);
    if (failures.length > 0) {
      for (const failure of failures) ctx.io.log(`  FAIL ${failure}`);
      say(ctx, `${failures.length} role check(s) failed`);
      return 2;
    }
    say(
      ctx,
      "role checks passed: substrate_app has full DML outside C1-C1d, the C1 table holds, defaults are in place"
    );
    return 0;
  } finally {
    await check.end().catch(() => undefined);
  }
}

/** The role shape the cloud-grants integration test proves, checked through the catalog. */
async function roleShapeFailures(client: Client): Promise<string[]> {
  const failures: string[] = [];
  const schema = await client.query<{ ok: boolean }>(
    "SELECT has_schema_privilege('substrate_app', 'public', 'USAGE') AS ok"
  );
  if (!schema.rows[0]!.ok) failures.push("substrate_app lacks USAGE on schema public");

  const tables = await client.query<{
    relname: string;
    s: boolean;
    i: boolean;
    u: boolean;
    d: boolean;
  }>(
    `SELECT c.relname,
            has_table_privilege('substrate_app', c.oid, 'SELECT') AS s,
            has_table_privilege('substrate_app', c.oid, 'INSERT') AS i,
            has_table_privilege('substrate_app', c.oid, 'UPDATE') AS u,
            has_table_privilege('substrate_app', c.oid, 'DELETE') AS d
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND ${NOT_EXTENSION_MEMBER}
     ORDER BY c.relname`
  );
  for (const row of tables.rows) {
    if ((C1_TABLES as readonly string[]).includes(row.relname)) {
      if (!row.s) failures.push(`substrate_app cannot SELECT ${row.relname}`);
      if (row.d)
        failures.push(`substrate_app can DELETE ${row.relname}, beyond the C1 privilege table`);
    } else if (row.relname !== "schema_migrations" && !(row.s && row.i && row.u && row.d)) {
      failures.push(`substrate_app lacks full DML on ${row.relname}`);
    }
  }
  const present = new Set(tables.rows.map((row) => row.relname));
  for (const name of C1_TABLES) if (!present.has(name)) failures.push(`${name} is missing`);

  const sequences = await client.query<{ relname: string; ok: boolean }>(
    `SELECT c.relname, has_sequence_privilege('substrate_app', c.oid, 'USAGE')
              AND has_sequence_privilege('substrate_app', c.oid, 'SELECT') AS ok
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'`
  );
  for (const row of sequences.rows)
    if (!row.ok) failures.push(`substrate_app cannot use sequence ${row.relname}`);

  if (present.has("exomem_cloud_cells")) {
    const cloud = await client.query<{
      cellctl: boolean;
      gateway_routing: boolean;
      gateway_observed: boolean;
    }>(
      `SELECT has_table_privilege('exomem_cellctl', 'public.exomem_cloud_cells', 'SELECT') AS cellctl,
              has_column_privilege('exomem_gateway', 'public.exomem_cloud_cells', 'desired_state', 'SELECT') AS gateway_routing,
              has_column_privilege('exomem_gateway', 'public.exomem_cloud_cells', 'observed_state', 'SELECT') AS gateway_observed`
    );
    const row = cloud.rows[0]!;
    if (!row.cellctl) failures.push("exomem_cellctl cannot SELECT exomem_cloud_cells");
    if (!row.gateway_routing)
      failures.push("exomem_gateway cannot read exomem_cloud_cells.desired_state");
    if (row.gateway_observed)
      failures.push("exomem_gateway can read exomem_cloud_cells.observed_state");
  }

  const defaults = await client.query<{ objtype: string; privilege_type: string }>(
    `SELECT d.defaclobjtype::text AS objtype, a.privilege_type
     FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
     WHERE d.defaclrole = '${TARGET_OWNER}'::regrole AND n.nspname = 'public' AND a.grantee = 'substrate_app'::regrole`
  );
  const granted = new Set(defaults.rows.map((row) => `${row.objtype}:${row.privilege_type}`));
  for (const expected of ["r:SELECT", "r:INSERT", "r:UPDATE", "r:DELETE", "S:USAGE", "S:SELECT"]) {
    if (!granted.has(expected))
      failures.push(`default privilege ${expected} for substrate_app is missing`);
  }
  return failures;
}

async function verify(ctx: Context): Promise<number> {
  const sourceUrl = envUrl(ctx, "CUTOVER_SOURCE_DUMP_URL");
  const targetUrl = envUrl(ctx, "CUTOVER_TARGET_OWNER_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_DUMP_URL", sourceUrl);
  refuseTransactionPooler("CUTOVER_TARGET_OWNER_URL", targetUrl);
  plan(ctx, [
    `compare ${describeUrl(sourceUrl)} with ${describeUrl(targetUrl)}, read-only`,
    "extensions and versions; schemas; per table its columns, constraints, indexes, triggers, defaults and NOT NULL, row count and content checksum; sequences, whose target position must be at least the source's",
  ]);
  const source = await connect(sourceUrl, "neon-cutover-verify");
  let target: Client | undefined;
  try {
    target = await connect(targetUrl, "neon-cutover-verify");
    await Promise.all([pinVerifySession(source), pinVerifySession(target)]);
    let failed = 0;
    const report = (ok: boolean, subject: string, detail: string): void => {
      if (!ok) failed += 1;
      ctx.io.log(`  ${ok ? "OK  " : "FAIL"} ${subject}  ${detail}`);
    };

    const [sourceExtensions, targetExtensions] = await Promise.all([
      extensionVersions(source),
      extensionVersions(target),
    ]);
    for (const [name, version] of sourceExtensions) {
      const other = targetExtensions.get(name);
      if (other === undefined) report(false, `extension ${name}`, "missing on target");
      else
        report(
          other === version,
          `extension ${name}`,
          other === version ? version : `${version} != ${other}`
        );
    }
    for (const name of targetExtensions.keys()) {
      if (!sourceExtensions.has(name))
        ctx.io.log(`  note extension ${name} exists only on the target`);
    }

    const [sourceSchemas, targetSchemas] = await Promise.all([
      userSchemas(source),
      userSchemas(target),
    ]);
    for (const [name, relations] of targetSchemas) {
      if (sourceSchemas.has(name)) continue;
      // PgBouncer's auth schema is the target's own, and holds only a function.
      if (relations === 0)
        ctx.io.log(`  note schema ${name} exists only on the target (no tables or sequences)`);
      else report(false, `schema ${name}`, "exists only on the target");
    }

    const sourceTables = await userTables(source);
    const targetTables = new Map((await userTables(target)).map((table) => [table.key, table]));
    for (const table of sourceTables) {
      const other = targetTables.get(table.key);
      targetTables.delete(table.key);
      if (!other) {
        report(false, table.key, "missing on target");
        continue;
      }
      if (JSON.stringify(other.columns) !== JSON.stringify(table.columns)) {
        report(false, table.key, "columns differ");
        continue;
      }
      const differ = Object.keys(table.definition).filter(
        (part) =>
          JSON.stringify(table.definition[part]) !== JSON.stringify(other.definition[part])
      );
      if (differ.length > 0) {
        report(false, table.key, `definition differs: ${differ.join(", ")}`);
        continue;
      }
      const [left, right] = await Promise.all([
        tableDigest(source, table),
        tableDigest(target, table),
      ]);
      const sameRows = left.rows === right.rows;
      const sameSum = left.checksum === right.checksum;
      report(
        sameRows && sameSum,
        table.key,
        `rows ${left.rows} ${sameRows ? "=" : "!="} ${right.rows}  checksum ${left.checksum.slice(0, 12)}` +
          (sameSum ? "" : ` != ${right.checksum.slice(0, 12)}`)
      );
    }
    for (const key of targetTables.keys()) report(false, key, "exists only on the target");

    const [sourceSequences, targetSequences] = await Promise.all([
      sequencePositions(source),
      sequencePositions(target),
    ]);
    for (const [key, position] of sourceSequences) {
      const other = targetSequences.get(key);
      if (!other) {
        report(false, key, "missing on target");
        continue;
      }
      const ahead =
        position.increment > BigInt(0) ? other.next >= position.next : other.next <= position.next;
      report(
        ahead,
        key,
        ahead
          ? `next ${other.next} (source ${position.next})`
          : `next ${other.next} behind source ${position.next}`
      );
    }
    for (const key of targetSequences.keys())
      if (!sourceSequences.has(key)) report(false, key, "exists only on the target");

    const summary = `${sourceSchemas.size} schema(s), ${sourceTables.length} table(s), ${sourceSequences.size} sequence(s), ${sourceExtensions.size} extension(s)`;
    if (failed > 0) {
      say(ctx, `MISMATCH: ${failed} check(s) failed across ${summary}; do not switch`);
      return 2;
    }
    say(ctx, `VERIFIED: ${summary} match`);
    return 0;
  } finally {
    await source.end().catch(() => undefined);
    await target?.end().catch(() => undefined);
  }
}

/**
 * Both sides render row text identically only under the same settings, and
 * see one consistent snapshot only inside one read-only transaction.
 */
async function pinVerifySession(client: Client): Promise<void> {
  await client.query(`SET TimeZone = 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres';
    SET extra_float_digits = 3; SET bytea_output = 'hex'; SET lc_monetary = 'C'; SET search_path = pg_catalog;
    BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
}

async function extensionVersions(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ extname: string; extversion: string }>(
    "SELECT extname, extversion FROM pg_extension ORDER BY extname"
  );
  return new Map(rows.map((row) => [row.extname, row.extversion]));
}

/** Every user schema, with the number of tables, views, sequences and foreign tables it holds. */
async function userSchemas(client: Client): Promise<Map<string, number>> {
  const { rows } = await client.query<{ nspname: string; relations: number }>(
    `SELECT n.nspname, count(c.oid)::int AS relations
     FROM pg_namespace n
     LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND ${NOT_EXTENSION_MEMBER}
     WHERE ${USER_SCHEMA} GROUP BY n.nspname`
  );
  return new Map(rows.map((row) => [row.nspname, row.relations]));
}

type UserTable = {
  key: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string }>;
  /** What pg_restore rebuilds around the rows, as the server renders it. */
  definition: Record<string, unknown>;
};

async function userTables(client: Client): Promise<UserTable[]> {
  const { rows } = await client.query<{
    schema: string;
    name: string;
    columns: Array<{ name: string; type: string }>;
    definition: Record<string, unknown>;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name,
            (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod))
                     ORDER BY a.attnum), '[]')
               FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
            json_build_object(
              'defaults and NOT NULL', (SELECT coalesce(json_agg(json_build_array(a.attname, a.attnotnull,
                  pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum), '[]')
                FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
              'constraints', (SELECT coalesce(json_agg(json_build_array(o.conname, pg_get_constraintdef(o.oid))
                  ORDER BY o.conname), '[]')
                FROM pg_constraint o WHERE o.conrelid = c.oid),
              'indexes', (SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid) ORDER BY x.relname), '[]')
                FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid WHERE i.indrelid = c.oid),
              'triggers', (SELECT coalesce(json_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname), '[]')
                FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
            ) AS definition
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p') AND ${NOT_EXTENSION_MEMBER}
     ORDER BY n.nspname, c.relname`
  );
  return rows.map((row) => ({ ...row, key: `${row.schema}.${row.name}` }));
}

/**
 * Row count and a content checksum: the md5 of every row's text, with the
 * row digests sorted bytewise so the order depends on neither the physical
 * layout nor the collation. Only the aggregate leaves the database.
 */
async function tableDigest(
  client: Client,
  table: UserTable
): Promise<{ rows: string; checksum: string }> {
  const columns = table.columns
    .map((column) => `t.${client.escapeIdentifier(column.name)}`)
    .join(", ");
  const relation = `${client.escapeIdentifier(table.schema)}.${client.escapeIdentifier(table.name)}`;
  const { rows } = await client.query<{ rows: string; checksum: string }>(
    `SELECT count(*)::text AS rows, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS checksum
     FROM (SELECT md5(ROW(${columns})::text) AS h FROM ONLY ${relation} t) digests`
  );
  return rows[0]!;
}

async function sequencePositions(
  client: Client
): Promise<Map<string, { next: bigint; increment: bigint }>> {
  const { rows } = await client.query<{ schema: string; name: string; increment: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, s.seqincrement::text AS increment
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_sequence s ON s.seqrelid = c.oid
     WHERE ${USER_SCHEMA} AND c.relkind = 'S' AND ${NOT_EXTENSION_MEMBER}
     ORDER BY 1, 2`
  );
  const positions = new Map<string, { next: bigint; increment: bigint }>();
  for (const row of rows) {
    const relation = `${client.escapeIdentifier(row.schema)}.${client.escapeIdentifier(row.name)}`;
    const state = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM ${relation}`
    );
    const increment = BigInt(row.increment);
    const last = BigInt(state.rows[0]!.last_value);
    positions.set(`${row.schema}.${row.name}`, {
      next: state.rows[0]!.is_called ? last + increment : last,
      increment,
    });
  }
  return positions;
}

function switchPlan(ctx: Context): number {
  const host = ctx.options.targetHost ?? "<postgres_database_hostname>";
  const file = ctx.options.rotatedPasswordFile ?? "$ROTATED";
  plan(ctx, ["print the commands below; this phase runs nothing and reads no secret"]);
  const lines = [
    "# Run from a checkout linked to the production Vercel project (vercel link).",
    "# Compose the two URLs in this shell from the SOPS-held role passwords; never on a command line:",
    `#   NEW_DATABASE_URL           postgresql://substrate_app:<password>@${host}:6432/exomem_control?sslmode=verify-full`,
    `#   NEW_DATABASE_MIGRATION_URL postgresql://substrate_owner:<password>@${host}:6432/exomem_control_session?sslmode=verify-full`,
    "",
    "# 0. Record the deployment that is production now; it is the Vercel rollback target.",
    "vercel ls --prod",
    "",
    "# 1. Switch. rm deletes the whole record: one that also targets preview or development",
    "#    loses those too (vercel/vercel#16622), which is wanted when they name production Neon.",
    "vercel env rm DATABASE_URL production --yes",
    "printf '%s' \"$NEW_DATABASE_URL\" | vercel env add DATABASE_URL production --sensitive",
    "vercel env rm DATABASE_MIGRATION_URL production --yes   # 'not found' is fine if it was never set",
    "printf '%s' \"$NEW_DATABASE_MIGRATION_URL\" | vercel env add DATABASE_MIGRATION_URL production --sensitive",
    "# Only if P3 found a separate preview or development record that names production Neon:",
    "vercel env rm DATABASE_URL preview --yes; vercel env rm DATABASE_URL development --yes",
    "vercel env ls | grep -E 'DATABASE_(MIGRATION_)?URL'   # production only",
    "",
    "# 2. Redeploy production so the new environment takes effect (the build runs migrations and grants).",
    "vercel redeploy <current-production-deployment-url> --target=production",
    "",
    "# Switch back (rollback), after the rollback phase: point both variables at Neon again, then redeploy.",
    "vercel env rm DATABASE_URL production --yes",
    "# Vercel's role on the Neon API path: its pre-freeze password is gone, so feed the rotated one on stdin.",
    `node --import tsx scripts/neon-cutover.ts switch-back-url --role=<role> --rotated-password-file="${file}" | vercel env add DATABASE_URL production --sensitive`,
    "# Vercel's role on the SQL path instead: rollback restored its pre-freeze password.",
    "printf '%s' \"$NEON_DATABASE_URL\" | vercel env add DATABASE_URL production --sensitive",
    "vercel env rm DATABASE_MIGRATION_URL production --yes",
    "# only if it was set before the window, the same way (switch-back-url, or $NEON_DATABASE_MIGRATION_URL):",
    "printf '%s' \"$NEON_DATABASE_MIGRATION_URL\" | vercel env add DATABASE_MIGRATION_URL production --sensitive",
    "vercel redeploy <recorded-pre-switch-deployment-url> --target=production",
    "# On the SQL path only, vercel rollback <recorded-pre-switch-deployment-url> is faster: that deployment",
    "# holds the pre-freeze password. On the API path it holds a password Neon no longer accepts.",
  ];
  for (const line of lines) ctx.io.log(line);
  return 0;
}

/**
 * Writes an API-path role's pre-freeze Neon URL with its rotated password to
 * stdout, without a newline, for `vercel env add` to read. It refuses a
 * terminal, so the password is never printed.
 */
function switchBackUrl(ctx: Context): number {
  const role = ctx.options.role;
  if (!role) throw new CutoverError("switch-back-url needs --role=<role>");
  const file = ctx.options.rotatedPasswordFile;
  if (!file) throw new CutoverError("switch-back-url needs --rotated-password-file");
  const base = envUrl(ctx, roleUrlEnvName(role));
  const user = decodeURIComponent(new URL(base).username);
  if (user !== role)
    throw new CutoverError(`${roleUrlEnvName(role)} logs in as ${user}, not ${role}`);
  const password = readRotatedPasswords(resolve(file)).get(role);
  if (!password) throw new CutoverError(`${file} holds no rotated password for ${role}`);
  const out = ctx.io.stdout ?? process.stdout;
  if (out.isTTY) {
    throw new CutoverError(
      "switch-back-url writes a password; pipe it into vercel env add, never to a terminal"
    );
  }
  ctx.io.error(
    `[cutover:switch-back-url] plan: write ${describeUrl(base)} with ${role}'s rotated password to stdout, for vercel env add`
  );
  out.write(withPassword(base, password));
  return 0;
}

async function rollback(ctx: Context): Promise<number> {
  const baseAdminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl]]);
  const targets = appRoleUrls(ctx);
  const roles = targets.map((target) => target.role);
  const apiRoles = ctx.options.apiRoles;
  const stray = apiRoles.filter((role) => !roles.includes(role));
  if (stray.length > 0) {
    throw new CutoverError(`--api-roles must be a subset of --app-roles (${stray.join(", ")})`);
  }
  if (apiRoles.length > 0 && !ctx.options.rotatedPasswordFile) {
    throw new CutoverError("rollback of an API-path role needs --rotated-password-file");
  }
  const rotated = rotatedPasswords(ctx);
  const sqlRoles = roles.filter((role) => !apiRoles.includes(role));
  // Each role is restored, proven and reported on its own: one that cannot
  // be restored never holds back the others.
  const failures = new Map<string, string>();
  const describeError = (error: unknown): string =>
    `${errorCode(error) ?? "error"} ${error instanceof Error ? error.message : String(error)}`;
  const client = await connectSourceAdmin(ctx, "neon-cutover-rollback");
  let database = "";
  try {
    // The database default is read-only by now, and ALTER ROLE and ALTER
    // DATABASE are refused inside a read-only transaction.
    await client.query("SET default_transaction_read_only = off");
    const facts = await adminPreflight(client, sqlRoles, apiRoles);
    database = facts.database;
    for (const [role, problem] of facts.roleProblems) failures.set(role, problem);
    const relogin = apiRoles.filter((role) => role !== facts.me);
    plan(ctx, [
      `ALTER DATABASE ${facts.database} RESET default_transaction_read_only`,
      ...(sqlRoles.length > 0
        ? [
            `ALTER ROLE ... LOGIN PASSWORD <each role's pre-freeze password, sent as a SCRAM verifier> for ${sqlRoles.join(", ")}`,
          ]
        : []),
      ...(relogin.length > 0 ? [`ALTER ROLE ... LOGIN for ${relogin.join(", ")}`] : []),
      ...(apiRoles.length > 0
        ? [
            `keep the newest recorded password of ${apiRoles.join(", ")}: the pre-freeze one cannot be restored, so their consumers switch to it (switch-back-url); a role Neon never reset keeps its pre-freeze one`,
          ]
        : []),
      "prove it, role by role: each logs in with the credential its consumers will use, and gets a read-write session",
    ]);
    try {
      await client.query(
        `ALTER DATABASE ${client.escapeIdentifier(facts.database)} RESET default_transaction_read_only`
      );
    } catch (error) {
      say(ctx, `FAIL ${facts.database}: RESET default_transaction_read_only: ${describeError(error)}`);
    }
    for (const { role, url } of targets) {
      if (failures.has(role) || !(sqlRoles.includes(role) || relogin.includes(role))) continue;
      try {
        const password = sqlRoles.includes(role)
          ? ` PASSWORD ${client.escapeLiteral(scramSha256Verifier(decodeURIComponent(new URL(url).password)))}`
          : "";
        await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN${password}`);
      } catch (error) {
        failures.set(role, describeError(error));
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  for (const { role, url } of targets) {
    const failure = failures.get(role);
    if (failure) {
      say(ctx, `FAIL ${role}: ${failure}`);
      continue;
    }
    // An API role logs in with its newest recorded password. One that Neon
    // never reset, or whose reset never took effect, still has its pre-freeze one.
    const recorded = apiRoles.includes(role) ? rotated.get(role) : undefined;
    const candidates: Array<[credential: string, url: string]> = [
      ...(recorded
        ? [["its rotated password", withPassword(url, recorded)] as [string, string]]
        : []),
      ["its pre-freeze credential", url],
    ];
    for (const [credential, candidate] of candidates) {
      try {
        const probe = await connect(candidate, "neon-cutover-rollback-probe");
        try {
          const { rows } = await probe.query<{ value: string }>(
            "SELECT current_setting('transaction_read_only') AS value"
          );
          if (rows[0]!.value !== "off") throw new Error("session is read-only");
        } finally {
          await probe.end().catch(() => undefined);
        }
        say(ctx, `OK   ${role} logs in with ${credential} and can write`);
        failures.delete(role);
        break;
      } catch (error) {
        failures.set(role, describeError(error));
        if (errorCode(error) !== "28P01") break;
      }
    }
    if (failures.has(role)) say(ctx, `FAIL ${role}: ${failures.get(role)}`);
  }
  if (failures.size > 0) {
    say(ctx, `${failures.size} role(s) not restored: ${[...failures.keys()].join(", ")}`);
    return 2;
  }
  say(ctx, `ROLLED BACK: application roles log in again and ${database} accepts writes`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point

function parseArgs(argv: string[]): { phase: Phase; options: Options } {
  const [phase, ...rest] = argv;
  if (!phase || !(PHASES as readonly string[]).includes(phase)) throw new CutoverError(USAGE);
  const options: Options = {
    appRoles: [],
    apiRoles: [],
    confirmProduction: false,
    expectFrozen: false,
    allowUnfrozen: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new CutoverError(`unexpected argument ${arg}\n${USAGE}`);
    const [, name, inline] = match;
    const value = (): string => {
      const next = inline ?? rest[++index];
      if (next === undefined || next === "") throw new CutoverError(`--${name} needs a value`);
      return next;
    };
    switch (name) {
      case "app-roles":
        options.appRoles = value()
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean);
        break;
      case "api-roles":
        // Empty (--api-roles=) means no role takes the API path.
        options.apiRoles = (inline ?? value())
          .split(",")
          .map((role) => role.trim())
          .filter(Boolean);
        break;
      case "rotated-password-file":
        options.rotatedPasswordFile = value();
        break;
      case "role":
        options.role = value();
        break;
      case "archive":
        options.archive = value();
        break;
      case "pg-bin-dir":
        options.pgBinDir = value();
        break;
      case "target-host":
        options.targetHost = value();
        break;
      case "confirm-production":
        options.confirmProduction = true;
        break;
      case "expect-frozen":
        options.expectFrozen = true;
        break;
      case "allow-unfrozen":
        options.allowUnfrozen = true;
        break;
      default:
        throw new CutoverError(`unknown option --${name}\n${USAGE}`);
    }
  }
  return { phase: phase as Phase, options };
}

/** Runs one phase and returns its exit status; every refusal is reported, never thrown. */
export async function runCutover(
  argv: string[],
  env: CutoverEnv = process.env as CutoverEnv,
  io: CutoverIo = { log: (line) => console.log(line), error: (line) => console.error(line) },
  deps: CutoverDeps = {}
): Promise<number> {
  let phase: Phase | undefined;
  try {
    const parsed = parseArgs(argv);
    phase = parsed.phase;
    const ctx: Context = { env, options: parsed.options, io, phase, deps };
    switch (phase) {
      case "inventory":
        return await inventory(ctx);
      case "create-dump-role":
        return await createDumpRole(ctx);
      case "freeze":
        return await freeze(ctx);
      case "dump":
        return await dump(ctx);
      case "restore":
        return await restore(ctx);
      case "grants":
        return await grants(ctx);
      case "verify":
        return await verify(ctx);
      case "switch-plan":
        return switchPlan(ctx);
      case "rollback":
        return await rollback(ctx);
      case "switch-back-url":
        return switchBackUrl(ctx);
    }
  } catch (error) {
    const prefix = phase ? `[cutover:${phase}]` : "[cutover]";
    if (error instanceof CutoverError) io.error(`${prefix} refused: ${error.message}`);
    else
      io.error(
        `${prefix} failed: ${errorCode(error) ?? ""} ${error instanceof Error ? error.message : String(error)}`
      );
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCutover(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
