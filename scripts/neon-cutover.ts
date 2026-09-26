/**
 * Neon-to-self-hosted control database cutover (design D8 of
 * `adopt-exomem-cloud-plain-cells`, task 4.1). The operator procedure,
 * timings and rollback are in docs/runbooks/neon-cutover.md; read it first.
 *
 *   tsx scripts/neon-cutover.ts <phase> [options]
 *
 * Every phase runs alone and prints its plan before it acts:
 *
 *   inventory    read-only: versions, schemas, extensions, the database ACL, login
 *                roles, sessions and restore blockers on the source; with --app-roles,
 *                each consumer's credential must log in (step 1's go/no-go);
 *                --expect-frozen checks the lock instead
 *   create-dump-role  create the dump role through Neon's API, which returns its
 *                password, record it, and grant it pg_read_all_data (or, where
 *                that is refused, USAGE and SELECT object by object); an existing
 *                role gets the grants again
 *   freeze       record the database's ACL, then take CONNECT from PUBLIC and from
 *                every role but the owner, and give it to the dump role; reset the
 *                owner's password through Neon's API when a consumer connects as
 *                the owner; set the read-only default; end every other client
 *                session; then prove it
 *   dump         pg_dump --no-owner --no-acl as the dump role, custom format, with a
 *                sha256 file beside the archive
 *   restore      pg_restore into the empty target as substrate_owner, in one transaction
 *   grants       scripts/exomem-cloud-grants.sql through scripts/migrate.ts, then the
 *                D7 role checks
 *   verify       extensions, schemas, sequences, and per table its definition, row
 *                count and content checksum
 *   switch-plan  print the Vercel commands for the switch and the switch back; runs nothing
 *   rollback     restore the recorded ACL entry by entry, reset the read-only default,
 *                and prove every consumer connects and can write; it sets no password
 *   switch-back-url  write the owner's Neon URL, with its rotated password, to a pipe
 *                into `vercel env add`; never to a terminal
 *
 * The password file (--password-file, 0600, never printed) is this window's
 * only record of what Neon generated: the dump role's password, the owner's
 * rotated one, and the database's ACL before the freeze. Every entry is
 * timestamped and only ever appended; a role's newest entry is its password.
 * create-dump-role and freeze open and check it before any Neon call, and
 * freeze refuses a file whose first entry is more than 24 h old, since each
 * window starts a new one. Freeze and rollback hold an exclusive flock on it
 * throughout.
 *
 * Connection strings come only from the environment, never from arguments,
 * and are never printed (only user@host:port/database is):
 *
 *   CUTOVER_SOURCE_ADMIN_URL   Neon, the database owner (or a role that can act as it)
 *   CUTOVER_TARGET_OWNER_URL   the new server as substrate_owner, through PgBouncer's
 *                              session alias or directly on 5432
 *   CUTOVER_ROLE_URL_<ROLE>    each consumer's connection string, as it holds it (role
 *                              name upper-cased, every other character as "_")
 *   CUTOVER_SOURCE_DUMP_URL    optional, dump only: another database to dump (by
 *                              default the dump role on the admin's host, with its
 *                              recorded password)
 *   NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID
 *                              the API's key (never printed), project and branch; the
 *                              branch must be the one the admin host's ep-... endpoint
 *                              serves (NEON_ENDPOINT_ID names the endpoint for a local host)
 *
 * Options:
 *   --app-roles=<a,b>      the roles the consumers connect as (inventory, freeze, rollback)
 *   --password-file=<path> the window's password file
 *   --dump-role=<role>     the dump role (default neon_cutover_dump)
 *   --role=<role>          switch-back-url: the role whose URL to write
 *   --archive=<path>       dump output / restore input
 *   --pg-bin-dir=<dir>     directory holding pg_dump and pg_restore (default: PATH)
 *   --target-host=<host>   the new server's public PgBouncer hostname (switch-plan)
 *   --confirm-production   required by freeze, rollback and create-dump-role against a
 *                          non-local host (restore and grants are bounded by an empty
 *                          target and an exact migration match instead)
 *   --expect-frozen        inventory: exit 2 unless the lock holds
 *   --allow-unfrozen       dump: permit a dump of a source that is not frozen (timing trials)
 *
 * Exit status: 0 success, 1 refused or failed to run, 2 a check failed.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const DEFAULT_DUMP_ROLE = "neon_cutover_dump";
/** Each window writes a new password file; an older one belongs to another window. */
const PASSWORD_FILE_MAX_AGE_MS = 24 * 3_600_000;

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
  passwordFile?: string;
  dumpRole: string;
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

/** `url` with its password replaced; a password never travels any other way. */
function withPassword(url: string, password: string): string {
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** `url` logging in as `role` with `password`. */
function asRole(url: string, role: string, password: string): string {
  const parsed = new URL(withPassword(url, password));
  parsed.username = encodeURIComponent(role);
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Neon's API
//
// Neon's control plane owns the spec of a role created in its console or API
// and re-applies it when a compute restarts, so the owner's password is reset
// and the dump role created through it, never with SQL alone.
//   https://api-docs.neon.tech/reference/getprojectendpoint
//   https://api-docs.neon.tech/reference/createprojectbranchrole
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

type RolePasswordRequest = {
  transport: NeonTransport;
  projectId: string;
  branchId: string;
  role: string;
  /** Receives the password as soon as Neon issues it, so a failure while waiting never loses it. */
  record?: (password: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

/**
 * Sends a request that answers with `role` and its new password, and
 * returns the password once every operation it started has finished, which
 * is when Neon says the password is ready.
 */
async function neonRolePassword(
  input: RolePasswordRequest,
  path: string,
  init: RequestInit,
  purpose: string,
  recovery: string
): Promise<string> {
  const { transport, role, record, pollIntervalMs = 1_000, timeoutMs = 120_000 } = input;
  const answer = await neonJson(transport, path, init, purpose);
  const returned = answer.role as { name?: unknown; password?: unknown } | undefined;
  if (
    !returned ||
    returned.name !== role ||
    typeof returned.password !== "string" ||
    !/^[\x20-\x7e]{8,}$/.test(returned.password)
  ) {
    throw new CutoverError(
      `the Neon API did not return the new password for ${role}; it may now hold a password nobody knows, so ${recovery}`
    );
  }
  const password = returned.password;
  record?.(password);
  const branch = (answer.role as { branch_id?: unknown }).branch_id;
  if (branch !== input.branchId) {
    throw new CutoverError(
      `the Neon API answered for ${role} on branch ${String(branch)}, not ${input.branchId}; ` +
        "its new password is recorded, but stop and check NEON_BRANCH_ID"
    );
  }

  const project = encodeURIComponent(input.projectId);
  const deadline = Date.now() + timeoutMs;
  const operations = Array.isArray(answer.operations) ? answer.operations : [];
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

function branchPath(input: RolePasswordRequest): string {
  return `/projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`;
}

/** Resets `role`'s password on the branch and returns the new one. */
export function rotateNeonRolePassword(input: RolePasswordRequest): Promise<string> {
  return neonRolePassword(
    input,
    `${branchPath(input)}/roles/${encodeURIComponent(input.role)}/reset_password`,
    { method: "POST" },
    `reset the password of ${input.role}`,
    "rerun the phase with the same --password-file to reset it again"
  );
}

/** Creates `role` on the branch; Neon generates its password and returns it. */
export function createNeonRole(input: RolePasswordRequest): Promise<string> {
  return neonRolePassword(
    input,
    `${branchPath(input)}/roles`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: { name: input.role } }),
    },
    `create role ${input.role}`,
    "rerun create-dump-role with the same --password-file, which resets the password of a role that exists"
  );
}

type NeonApi = { transport: NeonTransport; projectId: string; branchId: string };

/** The Neon API's inputs, all checked before anything connects. */
function neonApi(ctx: Context): NeonApi {
  const missing = ["NEON_API_KEY", "NEON_PROJECT_ID", "NEON_BRANCH_ID"].filter(
    (name) => !ctx.env[name]
  );
  if (!ctx.options.passwordFile) missing.push("--password-file");
  if (missing.length > 0) {
    throw new CutoverError(`${ctx.phase} calls the Neon API and needs ${missing.join(", ")}`);
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
  };
}

/**
 * Proves NEON_BRANCH_ID is the branch the admin URL's compute serves, before
 * any Neon change: a stale branch ID (P5's, say) would otherwise change the
 * roles of whichever branch it names. The endpoint is the admin host's first
 * label (ep-...); a local host (the rehearsal) names it with NEON_ENDPOINT_ID.
 */
async function requireEndpointOnBranch(ctx: Context, api: NeonApi, adminUrl: string): Promise<void> {
  const label = hostOf(new URL(adminUrl)).split(".")[0]!;
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
      `endpoint ${endpoint} serves branch ${String(branch)}, not NEON_BRANCH_ID ${api.branchId}; nothing was changed`
    );
  }
}

// ---------------------------------------------------------------------------
// The password file
//
// One JSON object per line, each with the time it was written ("at"): a
// role's password ({"role", "password"}), a database's ACL before the
// freeze ({"database", "datacl"}), or a completed rollback of it
// ({"database", "rolledBack": true}). Only ever appended to; a role's newest
// password is the one that counts, and the older entries stay as the history.

type EntryBody = { at: string } & (
  | { role: string; password: string }
  | { database: string; datacl: string | null }
  | { database: string; rolledBack: true }
);
/** One valid line of the password file. */
export type PasswordFileEntry = { line: number } & EntryBody;

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

function parseEntry(line: string): EntryBody | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const { at, role, password, database, datacl, rolledBack } = value as Record<string, unknown>;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  if (typeof role === "string" && typeof password === "string") return { at, role, password };
  if (typeof database === "string" && rolledBack === true) return { at, database, rolledBack };
  if (typeof database === "string" && (typeof datacl === "string" || datacl === null))
    return { at, database, datacl };
  return undefined;
}

/** Every valid entry in file order, and the line numbers of those skipped as invalid. */
export function readPasswordFile(path: string): { entries: PasswordFileEntry[]; skipped: number[] } {
  let fd: number;
  try {
    fd = openPrivateFile(path, fsConstants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { entries: [], skipped: [] };
    throw error;
  }
  let text: string;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const entries: PasswordFileEntry[] = [];
  const skipped: number[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry) entries.push({ line: index + 1, ...entry });
    else skipped.push(index + 1);
  }
  return { entries, skipped };
}

function passwordsOf(entries: PasswordFileEntry[]): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const entry of entries) if ("role" in entry) passwords.set(entry.role, entry.password);
  return passwords;
}

/** Each role's newest recorded password. */
export function readPasswords(path: string): Map<string, string> {
  return passwordsOf(readPasswordFile(path).entries);
}

/**
 * The ACL to restore: the first record made since the last completed
 * rollback, so no rerun of a freeze can replace it with a locked ACL. With
 * `orEarlier`, a rollback rerun after a completed one finds the record of
 * the lock it undid.
 */
function aclRecordOf(
  entries: PasswordFileEntry[],
  database: string,
  { orEarlier = false } = {}
): { at: string; datacl: string | null } | undefined {
  let current: { at: string; datacl: string | null } | undefined;
  let earlier: { at: string; datacl: string | null } | undefined;
  for (const entry of entries) {
    if (!("database" in entry) || entry.database !== database) continue;
    if ("rolledBack" in entry) {
      earlier = current ?? earlier;
      current = undefined;
    } else current ??= { at: entry.at, datacl: entry.datacl };
  }
  return current ?? (orEarlier ? earlier : undefined);
}

/** Opens the password file for appending, creating it 0600. */
export function openPasswordFile(path: string): number {
  return openPrivateFile(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND);
}

/** Appends one timestamped entry through `fd`, on a line of its own, and syncs it to disk. */
function appendEntry(
  fd: number,
  entry:
    | { role: string; password: string }
    | { database: string; datacl: string | null }
    | { database: string; rolledBack: true }
): void {
  const size = fstatSync(fd).size;
  const last = Buffer.alloc(1);
  const newline = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  writeSync(fd, `${newline ? "\n" : ""}${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  fsyncSync(fd);
}

export function recordPassword(path: string, role: string, password: string): void {
  const fd = openPasswordFile(path);
  try {
    appendEntry(fd, { role, password });
  } finally {
    closeSync(fd);
  }
}

function passwordFilePath(ctx: Context): string {
  if (!ctx.options.passwordFile) throw new CutoverError(`${ctx.phase} needs --password-file`);
  return resolve(ctx.options.passwordFile);
}

/** Reads the password file, naming every line it skipped. */
function readWindowFile(
  ctx: Context,
  path: string
): { entries: PasswordFileEntry[]; skipped: number[] } {
  const file = readPasswordFile(path);
  if (file.skipped.length > 0)
    say(ctx, `note: ${path} line(s) ${file.skipped.join(", ")} hold no valid entry and were skipped`);
  return file;
}

/**
 * An exclusive flock(2) on the open password file, held until `fd` is
 * closed: util-linux flock takes it on the open file description it shares
 * with this process, and the lock outlives it.
 */
async function lockPasswordFile(fd: number, path: string): Promise<void> {
  const status = await new Promise<number>((done, fail) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    child.on("error", (error) =>
      fail(new CutoverError(`could not run flock (util-linux) to lock ${path}: ${error.message}`))
    );
    child.on("close", (code) => done(code ?? 1));
  });
  if (status === 75) {
    throw new CutoverError(`${path} is locked by another freeze or rollback; let it finish first`);
  }
  if (status !== 0) throw new CutoverError(`flock could not lock ${path} (exit ${status})`);
}

/** The file's first line dates the window it belongs to. */
function requireFreshFile(path: string, { entries, skipped }: ReturnType<typeof readPasswordFile>): void {
  if (skipped.length > 0 && (entries.length === 0 || skipped[0]! < entries[0]!.line)) {
    throw new CutoverError(
      `${path} line ${skipped[0]} is not a valid entry, so the file cannot be dated. ` +
        "Name a new file, and run create-dump-role with it first; nothing was changed"
    );
  }
  const first = entries[0];
  if (first && Date.now() - Date.parse(first.at) > PASSWORD_FILE_MAX_AGE_MS) {
    throw new CutoverError(
      `${path} starts with an entry written at ${first.at}, more than 24 h old: it belongs to an earlier ` +
        "window. Name a new file, and run create-dump-role with it first; nothing was changed"
    );
  }
}

/** The dump role's connection string: the admin's host and database, with its recorded password. */
function dumpRoleUrl(ctx: Context, path: string, passwords: Map<string, string>): string {
  const role = ctx.options.dumpRole;
  const password = passwords.get(role);
  if (!password) {
    throw new CutoverError(
      `${path} holds no password for the dump role ${role}: run create-dump-role with this --password-file first`
    );
  }
  return asRole(envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL"), role, password);
}

/**
 * A session as the source admin: with its newest recorded password once
 * the freeze has rotated the admin's own role, or with
 * CUTOVER_SOURCE_ADMIN_URL as it is when Neon refuses that one (a reset
 * that never took effect).
 */
async function connectSourceAdmin(ctx: Context, applicationName: string): Promise<Client> {
  const url = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  const file = ctx.options.passwordFile;
  const rotated = file
    ? readPasswords(resolve(file)).get(decodeURIComponent(new URL(url).username))
    : undefined;
  if (rotated) {
    try {
      return await connect(withPassword(url, rotated), applicationName);
    } catch (error) {
      if (errorCode(error) !== "28P01") throw error;
    }
  }
  return connect(url, applicationName);
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
// The source database's lock (freeze, rollback, inventory)

type SourceFacts = {
  me: string;
  database: string;
  owner: string;
  superuser: boolean;
  actsAsOwner: boolean;
  canSignal: boolean;
  datacl: string | null;
};

async function sourceFacts(client: Client): Promise<SourceFacts> {
  const { rows } = await client.query<{
    me: string;
    database: string;
    owner: string;
    superuser: boolean;
    acts_as_owner: boolean;
    can_signal: boolean;
    datacl: string | null;
  }>(
    `SELECT current_user AS me, d.datname AS database, pg_get_userbyid(d.datdba) AS owner,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            pg_has_role(current_user, d.datdba, 'USAGE') AS acts_as_owner,
            pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS can_signal,
            d.datacl::text AS datacl
     FROM pg_database d WHERE d.datname = current_database()`
  );
  const row = rows[0]!;
  return {
    me: row.me,
    database: row.database,
    owner: row.owner,
    superuser: row.superuser,
    actsAsOwner: row.acts_as_owner,
    canSignal: row.can_signal,
    datacl: row.datacl,
  };
}

/** What the admin must be able to do on the source, checked before anything changes. */
function adminProblems(facts: SourceFacts): string[] {
  const problems: string[] = [];
  if (!facts.superuser && !facts.actsAsOwner)
    problems.push(`${facts.me} does not own database ${facts.database}`);
  if (!facts.superuser && !facts.canSignal)
    problems.push(`${facts.me} is not a member of pg_signal_backend`);
  return problems;
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

/** A superuser passes every CONNECT check, so no lockout can stop a consumer that connects as one. */
async function superuserConsumers(client: Client, roles: string[]): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolsuper AND rolname = ANY($1::text[]) ORDER BY 1",
    [roles]
  );
  return rows.map(
    (row) =>
      `${row.rolname} is a superuser, which no CONNECT lockout stops: stop, and give that consumer a role of its own`
  );
}

/**
 * The lock leaves CONNECT with the owner and the dump role, so a login role
 * that inherits either one's privileges keeps it and could still write.
 */
async function inheritedConnect(client: Client, dumpRole: string): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string; heir_of: string }>(
    `SELECT r.rolname, h.rolname AS heir_of
     FROM pg_roles r, pg_database d, pg_roles h
     WHERE d.datname = current_database() AND (h.oid = d.datdba OR h.rolname = $1)
       AND r.rolcanlogin AND NOT r.rolsuper AND r.oid <> h.oid AND r.rolname <> current_user
       AND r.oid <> d.datdba AND pg_has_role(r.oid, h.oid, 'USAGE')
     ORDER BY 1, 2`,
    [dumpRole]
  );
  return rows.map(
    (row) =>
      `${row.rolname} inherits ${row.heir_of}'s privileges, so it would keep CONNECT: revoke that membership, or make the role NOINHERIT, first`
  );
}

type AclEntry = { grantee: string; grantor: string; privilege: string; grantable: boolean };

/** `datacl`, or the database's default ACL when it is null, one entry per privilege. */
async function aclEntries(client: Client, datacl: string | null): Promise<AclEntry[]> {
  const { rows } = await client.query<AclEntry>(
    `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
            pg_get_userbyid(a.grantor) AS grantor, a.privilege_type AS privilege, a.is_grantable AS grantable
     FROM pg_database d, aclexplode(coalesce($1::aclitem[], acldefault('d', d.datdba))) a
     WHERE d.datname = current_database() ORDER BY 1, 2, 3`,
    [datacl]
  );
  return rows;
}

const aclText = (entry: AclEntry): string =>
  `${entry.grantee}=${entry.privilege}${entry.grantable ? "*" : ""}/${entry.grantor}`;

/** The grantees, PUBLIC included, that hold CONNECT on the database other than its owner. */
function connectGrantees(entries: AclEntry[], owner: string): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.privilege === "CONNECT" && entry.grantee !== owner)
        .map((entry) => entry.grantee)
    ),
  ];
}

const grantee = (client: Client, name: string): string =>
  name === "PUBLIC" ? "PUBLIC" : client.escapeIdentifier(name);

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

/** Each consumer's connection string, from CUTOVER_ROLE_URL_<ROLE>. */
function consumerUrls(ctx: Context): Array<{ role: string; url: string }> {
  const roles = ctx.options.appRoles;
  if (roles.length === 0) throw new CutoverError(`${ctx.phase} needs --app-roles`);
  const missing = roles.filter((role) => !ctx.env[roleUrlEnvName(role)]).map(roleUrlEnvName);
  if (missing.length > 0) {
    throw new CutoverError(
      `${ctx.phase} needs each consumer's credential: set ${missing.join(", ")}`
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
 * Logs in with `url` on the direct endpoint, overriding the read-only
 * default, then out again: undefined when the login succeeded, else why it
 * did not (a SQLSTATE such as 28P01 or 42501, or a connection error's code).
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

/** Where a lost reset leaves the owner, and the way back (the runbook's freeze step). */
const LOST_RESET =
  "If an earlier freeze's reset lost its response, nobody holds the owner's live password: " +
  "reset it in the Neon console, set CUTOVER_SOURCE_ADMIN_URL (when it logs in as the owner) and " +
  "the owner's CUTOVER_ROLE_URL_<ROLE> to the console's connection string, and rerun freeze";

// ---------------------------------------------------------------------------
// Phases

async function inventory(ctx: Context): Promise<number> {
  const url = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", url);
  const { expectFrozen } = ctx.options;
  if (expectFrozen && ctx.options.appRoles.length === 0) {
    throw new CutoverError("--expect-frozen needs --app-roles");
  }
  const path = expectFrozen ? passwordFilePath(ctx) : undefined;
  // With --app-roles, every consumer's credential is part of the answer.
  const targets = ctx.options.appRoles.length > 0 ? consumerUrls(ctx) : [];
  const roles = targets.map((target) => target.role);
  const dumpRole = ctx.options.dumpRole;
  plan(ctx, [
    `read-only catalog queries against ${describeUrl(url)}; nothing is changed`,
    ...(targets.length > 0 && !expectFrozen
      ? ["log in with each CUTOVER_ROLE_URL_<ROLE>: every login must succeed (step 1's go/no-go)"]
      : []),
    ...(expectFrozen
      ? [
          "with --expect-frozen, prove the lock as the freeze does: every consumer is refused, the dump role connects, no other client session remains, and a new session cannot write",
        ]
      : []),
  ]);
  const failures: string[] = [];
  const client = await connectSourceAdmin(ctx, "neon-cutover-inventory");
  let facts: SourceFacts;
  try {
    const blind = await sessionVisibilityProblem(client);
    if (blind) throw new CutoverError(`${blind}; without it the session list would be incomplete`);
    facts = await sourceFacts(client);
    const about = await client.query<{ version: string; read_only: string | null }>(
      `SELECT current_setting('server_version') AS version,
              (SELECT substring(setting FROM '^default_transaction_read_only=(.*)$')
                 FROM pg_db_role_setting s, unnest(s.setconfig) AS setting
                WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND s.setrole = 0 AND setting LIKE 'default_transaction_read_only=%') AS read_only`
    );
    const { version, read_only } = about.rows[0]!;
    say(ctx, `server ${version}; connected as ${facts.me} to ${facts.database}, owned by ${facts.owner}`);
    say(ctx, `database default_transaction_read_only: ${read_only ?? "unset (off)"}`);
    say(
      ctx,
      `database ACL: ${(await aclEntries(client, facts.datacl)).map(aclText).join(" ")}${facts.datacl === null ? " (the default)" : ""}`
    );

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
      const tags = [
        row.rolname === facts.owner ? "[owner]" : "",
        roles.includes(row.rolname) ? "[consumer]" : "",
        row.rolname === dumpRole ? "[dump role]" : "",
        row.rolname === facts.me ? "[this session]" : "",
      ].filter(Boolean);
      ctx.io.log(
        `  ${row.rolname.padEnd(32)} ${row.rolcanlogin} ${row.rolsuper}${tags.length > 0 ? `  ${tags.join(" ")}` : ""}`
      );
    }
    failures.push(...(await superuserConsumers(client, roles)));

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
  } finally {
    // Closed before the lock is proven: it would count as another session.
    await client.end().catch(() => undefined);
  }

  if (targets.length === 0) return 0;
  if (!expectFrozen) {
    // Step 1's go/no-go: a credential that does not log in now is not the
    // one the consumer holds.
    for (const { role, url: roleUrl } of targets) {
      const refusal = await loginRefusal(roleUrl, "neon-cutover-inventory-probe");
      if (refusal === undefined) say(ctx, `OK   ${role}: its CUTOVER_ROLE_URL logs in`);
      else {
        say(ctx, `FAIL ${role}: its CUTOVER_ROLE_URL does not log in (${refusal})`);
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

  const passwords = passwordsOf(readWindowFile(ctx, path!).entries);
  failures.push(...(await frozenFailures(ctx, targets, facts.owner, dumpRoleUrl(ctx, path!, passwords), passwords)));
  if (failures.length > 0) {
    for (const failure of failures) say(ctx, `FAIL ${failure}`);
    say(ctx, `NOT FROZEN: ${failures.join("; ")}`);
    return 2;
  }
  say(ctx, `FROZEN: only ${facts.owner} and ${dumpRole} can connect, no other client session, new sessions cannot write`);
  return 0;
}

async function freeze(ctx: Context): Promise<number> {
  const baseAdminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl]]);
  const targets = consumerUrls(ctx);
  const api = neonApi(ctx);
  const path = passwordFilePath(ctx);
  const dumpRole = ctx.options.dumpRole;
  // Before any Neon call: the file that must record the owner's new password
  // and the ACL, locked for the whole phase.
  const fd = openPasswordFile(path);
  let client: Client | undefined;
  try {
    await lockPasswordFile(fd, path);
    const file = readWindowFile(ctx, path);
    requireFreshFile(path, file);
    const entries = file.entries;
    const recorded = passwordsOf(entries);
    const dumpUrl = dumpRoleUrl(ctx, path, recorded);
    await requireEndpointOnBranch(ctx, api, baseAdminUrl);
    try {
      client = await connectSourceAdmin(ctx, "neon-cutover-freeze");
    } catch (error) {
      if (errorCode(error) !== "28P01") throw error;
      throw new CutoverError(
        `CUTOVER_SOURCE_ADMIN_URL's password is refused, and no recorded one logs in. ${LOST_RESET}`
      );
    }
    // A rerun meets a database whose default is already read-only, and
    // GRANT, REVOKE and ALTER DATABASE are refused inside a read-only transaction.
    await client.query("SET default_transaction_read_only = off");
    const facts = await sourceFacts(client);
    const { owner, database } = facts;
    const problems = adminProblems(facts);
    const blind = await sessionVisibilityProblem(client);
    if (blind) problems.push(blind);
    const dumpExists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [dumpRole]);
    if (!dumpExists.rowCount) problems.push(`the dump role ${dumpRole} does not exist: run create-dump-role first`);
    problems.push(...(await superuserConsumers(client, targets.map((target) => target.role))));
    problems.push(...(await inheritedConnect(client, dumpRole)));
    if (problems.length > 0)
      throw new CutoverError(`freeze preflight failed: ${problems.join("; ")}`);

    // Each consumer's credential is proven before anything changes. A 42501
    // comes only after the password is accepted: an earlier freeze took
    // CONNECT. The owner's newest recorded password, when it logs in, was
    // set by an earlier freeze of this window, whose reset is not repeated.
    let ownerRotatedEarlier = false;
    const unproven: string[] = [];
    for (const { role, url } of targets) {
      const password = role === owner ? recorded.get(role) : undefined;
      if (password && (await loginRefusal(withPassword(url, password), "neon-cutover-freeze-probe")) === undefined) {
        ownerRotatedEarlier = true;
        continue;
      }
      const refusal = await loginRefusal(url, "neon-cutover-freeze-probe");
      if (refusal !== undefined && !(refusal === "42501" && role !== owner))
        unproven.push(`${role} (${refusal})`);
    }
    if (unproven.length > 0) {
      throw new CutoverError(
        `the credential of ${unproven.join(", ")} does not log in; nothing was changed. ` +
          `Fix a stale CUTOVER_ROLE_URL_<ROLE>. For the owner: ${LOST_RESET}`
      );
    }
    const rotateOwner = targets.some((target) => target.role === owner) && !ownerRotatedEarlier;

    // The ACL to restore is the one before this window's first freeze: once
    // it is recorded, a rerun never records again, whatever it finds.
    const current = await aclEntries(client, facts.datacl);
    const revoke = connectGrantees(current, owner).filter((name) => name !== dumpRole);
    const locked = revoke.length === 0;
    const record = aclRecordOf(entries, database);
    if (locked && !record) {
      throw new CutoverError(
        `${database} is locked already, and ${path} holds no record of its ACL before the freeze; ` +
          "name the password file of the freeze that locked it; nothing was changed"
      );
    }
    plan(ctx, [
      record
        ? `keep the ACL recorded at ${record.at} as the one rollback restores`
        : `record ${database}'s ACL (${current.map(aclText).join(" ")}) in ${path}`,
      ...(rotateOwner
        ? [`reset the password of the owner ${owner}, which a consumer connects as, through the Neon API, and record it only in ${path} (0600, never printed)`]
        : ownerRotatedEarlier
          ? [`already rotated: ${owner}, whose recorded password logs in`]
          : []),
      ...(locked ? [] : [`REVOKE CONNECT ON DATABASE ${database} FROM ${revoke.join(", ")} CASCADE`]),
      `GRANT CONNECT ON DATABASE ${database} TO ${dumpRole}; ${owner}, the owner, keeps CONNECT`,
      `ALTER DATABASE ${database} SET default_transaction_read_only = on`,
      `then terminate every other client session of ${database}, whatever its role`,
      "prove it: every consumer is refused at login, the dump role connects, no other client session remains, and a new session cannot write",
    ]);

    if (!record) {
      appendEntry(fd, { database, datacl: facts.datacl });
      say(ctx, `${database}: ACL recorded in ${path}`);
    }
    if (rotateOwner) {
      await rotateNeonRolePassword({
        transport: api.transport,
        projectId: api.projectId,
        branchId: api.branchId,
        role: owner,
        record: (password) => appendEntry(fd, { role: owner, password }),
      });
      say(ctx, `${owner}: password reset through the Neon API and recorded in ${path}`);
      if (facts.me === owner) {
        // Carry on in a session opened with the admin's new password.
        await client.end().catch(() => undefined);
        client = await connectSourceAdmin(ctx, "neon-cutover-freeze");
        await client.query("SET default_transaction_read_only = off");
      }
    }
    await client.query("BEGIN");
    if (!locked) {
      await client.query(
        `REVOKE CONNECT ON DATABASE ${client.escapeIdentifier(database)} FROM ${revoke.map((name) => grantee(client!, name)).join(", ")} CASCADE`
      );
    }
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(database)} TO ${client.escapeIdentifier(dumpRole)}`
    );
    await client.query("COMMIT");
    say(ctx, `${database}: CONNECT held by ${owner} and ${dumpRole} only`);
    // The default first, so a session that connects during the sweep starts read-only.
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(database)} SET default_transaction_read_only = on`
    );
    say(ctx, `${database}: default_transaction_read_only = on`);
    const terminated = await terminateOtherSessions(client);
    say(ctx, `terminated ${terminated} other client session(s) of ${database}`);
    // Closed before the proof: it would count as another session.
    await client.end().catch(() => undefined);
    client = undefined;

    const failures = await frozenFailures(ctx, targets, owner, dumpUrl, readPasswords(path));
    if (failures.length > 0) {
      for (const failure of failures) say(ctx, `FAIL ${failure}`);
      say(ctx, "FREEZE NOT PROVEN: do not dump; see the runbook's freeze step");
      return 2;
    }
    say(
      ctx,
      `FROZEN: only ${owner} and ${dumpRole} can connect to ${database}, every consumer is refused, no other client session remains, and new sessions cannot write`
    );
    return 0;
  } finally {
    await client?.end().catch(() => undefined);
    // Closing the file releases the lock.
    closeSync(fd);
  }
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

/**
 * The lock, proven (freeze's last step and inventory --expect-frozen):
 * - a new admin session defaults to read-only, and a write in it gets 25006;
 * - no other non-superuser client session of the database remains;
 * - no login role but the owner, the dump role and this session's holds CONNECT;
 * - every consumer is refused at login: 28P01 for the owner, whose password
 *   was rotated (its recorded one logs in), and 42501 for every other, which
 *   Postgres returns only after accepting the password;
 * - the dump role connects.
 * Returns the failures; each success is printed as it is proven.
 */
async function frozenFailures(
  ctx: Context,
  targets: Array<{ role: string; url: string }>,
  owner: string,
  dumpUrl: string,
  passwords: Map<string, string>
): Promise<string[]> {
  const dumpRole = ctx.options.dumpRole;
  const failures: string[] = [];
  const check = await connectSourceAdmin(ctx, "neon-cutover-freeze-proof");
  try {
    const setting = await check.query<{ value: string }>(
      "SELECT current_setting('default_transaction_read_only') AS value"
    );
    if (setting.rows[0]!.value !== "on") failures.push("a new session is not read-only");
    try {
      await check.query("CREATE TEMP TABLE neon_cutover_freeze_probe (x int)");
      failures.push("a write from a new admin session succeeded");
    } catch (error) {
      if (errorCode(error) === "25006") say(ctx, "OK   a write from a new admin session is refused (25006)");
      else failures.push(`the read-only probe failed unexpectedly (${errorCode(error) ?? "no SQLSTATE"})`);
    }
    const { others, superuser } = await otherClientSessions(check);
    if (others.length > 0) failures.push(`other client session(s) remain: ${others.join(", ")}`);
    if (superuser > 0)
      say(ctx, `note ${superuser} superuser session(s), which only a superuser can end, were left`);
    const { rows } = await check.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_roles r, pg_database d
       WHERE d.datname = current_database() AND r.rolcanlogin AND NOT r.rolsuper
         AND r.oid <> d.datdba AND r.rolname <> $1 AND r.rolname <> current_user
         AND has_database_privilege(r.oid, d.oid, 'CONNECT')
       ORDER BY 1`,
      [dumpRole]
    );
    if (rows.length > 0)
      failures.push(`login role(s) ${rows.map((row) => row.rolname).join(", ")} can still connect`);
  } finally {
    await check.end().catch(() => undefined);
  }

  for (const { role, url } of targets) {
    const code = await loginRefusal(url, "neon-cutover-freeze-probe");
    if (role === owner) {
      if (code === "28P01") say(ctx, `OK   ${role}: its pre-freeze password is refused (28P01)`);
      else failures.push(`${role}: its pre-freeze password is not refused (${code ?? "it logs in"})`);
      const rotated = passwords.get(role);
      if (!rotated) failures.push(`${role}: no rotated password is recorded`);
      else {
        const refused = await loginRefusal(withPassword(url, rotated), "neon-cutover-freeze-proof");
        if (refused === undefined) say(ctx, `OK   ${role}: logs in with its recorded, rotated password only`);
        else failures.push(`${role}: its recorded password does not log in (${refused})`);
      }
    } else if (code === "42501") say(ctx, `OK   ${role}: refused at login (42501)`);
    else failures.push(`${role}: not refused with 42501 (${code ?? "it logs in"})`);
  }
  const dumpRefusal = await loginRefusal(dumpUrl, "neon-cutover-freeze-proof");
  if (dumpRefusal === undefined) say(ctx, `OK   ${dumpRole} connects`);
  else failures.push(`${dumpRole} cannot connect (${dumpRefusal})`);
  return failures;
}

/**
 * Gives the dump role read access as each object's owner would: the admin
 * grants what it owns, and acts as the owner of the rest when it may.
 */
async function grantReadPerObject(client: Client, me: string, role: string): Promise<string[]> {
  const { rows } = await client.query<{ kind: string; name: string; owner: string }>(
    `SELECT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, pg_get_userbyid(n.nspowner) AS owner
     FROM pg_namespace n WHERE ${USER_SCHEMA}
     UNION ALL
     SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
            format('%I.%I', n.nspname, c.relname), pg_get_userbyid(c.relowner)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'S', 'm') AND ${NOT_EXTENSION_MEMBER}
     ORDER BY 1, 2`
  );
  const failed: string[] = [];
  const target = client.escapeIdentifier(role);
  for (const row of rows) {
    const statement =
      row.kind === "SCHEMA"
        ? `GRANT USAGE ON SCHEMA ${row.name} TO ${target}`
        : `GRANT SELECT ON ${row.kind === "SEQUENCE" ? "SEQUENCE " : "TABLE "}${row.name} TO ${target}`;
    try {
      await client.query(statement);
    } catch (error) {
      if (errorCode(error) !== "42501" || row.owner === me) {
        failed.push(`${row.name} (${errorCode(error) ?? "error"})`);
        continue;
      }
      try {
        await client.query(`SET ROLE ${client.escapeIdentifier(row.owner)}`);
        await client.query(statement);
      } catch (retry) {
        failed.push(`${row.name} (${errorCode(retry) ?? "error"} as ${row.owner})`);
      } finally {
        await client.query("RESET ROLE");
      }
    }
  }
  return failed;
}

/**
 * Creates the dump role through Neon's API, which generates its password
 * and returns it once, so it is recorded before anything else. A role that
 * exists already is kept; when the file holds no working password for it,
 * its password is reset through the API instead. Either way it is then
 * granted pg_read_all_data, or, where the server refuses that (42501), USAGE
 * on each user schema and SELECT on every table and sequence.
 */
async function createDumpRole(ctx: Context): Promise<number> {
  const adminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", adminUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", adminUrl]]);
  const api = neonApi(ctx);
  const path = passwordFilePath(ctx);
  const role = ctx.options.dumpRole;
  // Before any Neon call: the file that must record the generated password.
  const fd = openPasswordFile(path);
  let client: Client | undefined;
  let unreadable: string[] = [];
  try {
    await lockPasswordFile(fd, path);
    const recorded = passwordsOf(readWindowFile(ctx, path).entries).get(role);
    await requireEndpointOnBranch(ctx, api, adminUrl);
    client = await connectSourceAdmin(ctx, "neon-cutover-create-dump-role");
    await client.query("SET default_transaction_read_only = off");
    const me = (await sourceFacts(client)).me;
    const exists = Boolean(
      (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount
    );
    const reset =
      exists &&
      (!recorded ||
        (await loginRefusal(asRole(adminUrl, role, recorded), "neon-cutover-create-dump-role")) === "28P01");
    plan(ctx, [
      exists
        ? reset
          ? `${role} exists, and ${path} holds no password that logs in: reset it through the Neon API and record it there (0600, never printed)`
          : `${role} exists, and its recorded password logs in: keep it`
        : `create ${role} through the Neon API, and record the password Neon generates only in ${path} (0600, never printed)`,
      `GRANT pg_read_all_data TO ${role}; if that is refused, USAGE on each user schema and SELECT on every table and sequence, as each one's owner`,
      `log in as ${role} with its recorded password`,
    ]);
    const request = {
      transport: api.transport,
      projectId: api.projectId,
      branchId: api.branchId,
      role,
      record: (password: string) => appendEntry(fd, { role, password }),
    };
    if (!exists) {
      await createNeonRole(request);
      say(ctx, `${role}: created through the Neon API; its password is recorded in ${path}`);
    } else {
      say(ctx, `${role} already exists; it is kept`);
      if (reset) {
        await rotateNeonRolePassword(request);
        say(ctx, `${role}: password reset through the Neon API and recorded in ${path}`);
      }
    }
    try {
      await client.query(`GRANT pg_read_all_data TO ${client.escapeIdentifier(role)}`);
      say(ctx, `${role}: granted pg_read_all_data`);
    } catch (error) {
      if (errorCode(error) !== "42501") throw error;
      say(
        ctx,
        `the server refused GRANT pg_read_all_data (42501); granting ${role} USAGE and SELECT object by object`
      );
      const failed = await grantReadPerObject(client, me, role);
      if (failed.length > 0) say(ctx, `FAIL could not grant: ${failed.join(", ")}`);
    }
    const { rows } = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_SCHEMA} AND c.relkind IN ('r', 'p', 'S', 'm')
         AND NOT (has_schema_privilege($1, n.oid, 'USAGE') AND CASE WHEN c.relkind = 'S'
           THEN has_sequence_privilege($1, c.oid, 'SELECT') ELSE has_table_privilege($1, c.oid, 'SELECT') END)
       ORDER BY 1`,
      [role]
    );
    unreadable = rows.map((row) => row.name);
  } finally {
    await client?.end().catch(() => undefined);
    closeSync(fd);
  }
  const probe = await connect(
    dumpRoleUrl(ctx, path, readPasswords(path)),
    "neon-cutover-create-dump-role"
  );
  await probe.end().catch(() => undefined);
  say(ctx, `${role}: logs in with its recorded password`);
  if (unreadable.length > 0) {
    say(ctx, `FAIL ${role} cannot read ${unreadable.length} relation(s): ${unreadable.join(", ")}`);
    return 2;
  }
  return 0;
}

/**
 * What dump and verify read the source as: CUTOVER_SOURCE_DUMP_URL when it
 * is set (a dump of the new server after a rollback), else the dump role
 * with its recorded password.
 */
function sourceReadUrl(ctx: Context): string {
  const url = ctx.env.CUTOVER_SOURCE_DUMP_URL
    ? envUrl(ctx, "CUTOVER_SOURCE_DUMP_URL")
    : dumpRoleUrl(ctx, passwordFilePath(ctx), readPasswords(passwordFilePath(ctx)));
  refuseTransactionPooler("the source connection", url);
  return url;
}

async function dump(ctx: Context): Promise<number> {
  const url = sourceReadUrl(ctx);
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
  const sourceUrl = sourceReadUrl(ctx);
  const targetUrl = envUrl(ctx, "CUTOVER_TARGET_OWNER_URL");
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
  const file = ctx.options.passwordFile ?? "$PASSWORDS";
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
    "# When Vercel connects as the Neon owner, the freeze rotated that password: feed the rotated one on stdin.",
    `node --import tsx scripts/neon-cutover.ts switch-back-url --role=<owner> --password-file="${file}" | vercel env add DATABASE_URL production --sensitive`,
    "# When Vercel connects as another role, its password never changed.",
    "printf '%s' \"$NEON_DATABASE_URL\" | vercel env add DATABASE_URL production --sensitive",
    "vercel env rm DATABASE_MIGRATION_URL production --yes",
    "# only if it was set before the window, the same way (switch-back-url, or $NEON_DATABASE_MIGRATION_URL):",
    "printf '%s' \"$NEON_DATABASE_MIGRATION_URL\" | vercel env add DATABASE_MIGRATION_URL production --sensitive",
    "vercel redeploy <recorded-pre-switch-deployment-url> --target=production",
    "# When Vercel's role is not the owner, vercel rollback <recorded-pre-switch-deployment-url> is faster:",
    "# that deployment holds a password that still works. The owner's no longer does.",
  ];
  for (const line of lines) ctx.io.log(line);
  return 0;
}

/**
 * Writes a role's Neon URL with its newest recorded password (the owner's
 * rotated one) to stdout, without a newline, for `vercel env add` to read.
 * It refuses a terminal, so the password is never printed.
 */
function switchBackUrl(ctx: Context): number {
  const role = ctx.options.role;
  if (!role) throw new CutoverError("switch-back-url needs --role=<role>");
  const file = passwordFilePath(ctx);
  const base = envUrl(ctx, roleUrlEnvName(role));
  const user = decodeURIComponent(new URL(base).username);
  if (user !== role)
    throw new CutoverError(`${roleUrlEnvName(role)} logs in as ${user}, not ${role}`);
  const password = readPasswords(file).get(role);
  if (!password) throw new CutoverError(`${file} holds no password for ${role}`);
  const out = ctx.io.stdout ?? process.stdout;
  if (out.isTTY) {
    throw new CutoverError(
      "switch-back-url writes a password; pipe it into vercel env add, never to a terminal"
    );
  }
  ctx.io.error(
    `[cutover:switch-back-url] plan: write ${describeUrl(base)} with ${role}'s recorded password to stdout, for vercel env add`
  );
  out.write(withPassword(base, password));
  return 0;
}

/**
 * Restores the recorded ACL entry by entry: an entry the freeze took away
 * is granted again, and one the record lacks (the dump role's CONNECT, or
 * anything granted since) is revoked. Only the owner's grants are touched;
 * an entry another grantor made is named for the operator. Each entry
 * succeeds or fails on its own.
 */
async function restoreAcl(
  ctx: Context,
  client: Client,
  facts: SourceFacts,
  recorded: AclEntry[]
): Promise<string[]> {
  const failures: string[] = [];
  const key = (entry: AclEntry) => `${entry.grantee}|${entry.grantor}|${entry.privilege}`;
  const current = new Map((await aclEntries(client, facts.datacl)).map((entry) => [key(entry), entry]));
  const wanted = new Map(recorded.map((entry) => [key(entry), entry]));
  const database = client.escapeIdentifier(facts.database);
  const steps: Array<[description: string, grantor: string, statement: string]> = [];
  for (const [id, entry] of wanted) {
    const now = current.get(id);
    if (now && now.grantable === entry.grantable) continue;
    if (now && now.grantable && !entry.grantable) {
      steps.push([
        `take back the grant option of ${aclText(now)}`,
        entry.grantor,
        `REVOKE GRANT OPTION FOR ${entry.privilege} ON DATABASE ${database} FROM ${grantee(client, entry.grantee)} CASCADE`,
      ]);
      continue;
    }
    steps.push([
      `grant ${aclText(entry)}`,
      entry.grantor,
      `GRANT ${entry.privilege} ON DATABASE ${database} TO ${grantee(client, entry.grantee)}${entry.grantable ? " WITH GRANT OPTION" : ""}`,
    ]);
  }
  for (const [id, entry] of current) {
    if (wanted.has(id)) continue;
    steps.push([
      `revoke ${aclText(entry)}`,
      entry.grantor,
      `REVOKE ${entry.privilege} ON DATABASE ${database} FROM ${grantee(client, entry.grantee)} CASCADE`,
    ]);
  }
  for (const [description, grantor, statement] of steps) {
    if (grantor !== facts.owner) {
      say(ctx, `FAIL ${description}: granted by ${grantor}, not the owner; restore it by hand`);
      failures.push(`the ACL entry ${description.replace(/^\S+ /, "")}`);
      continue;
    }
    try {
      await client.query(statement);
      say(ctx, `OK   ${description}`);
    } catch (error) {
      say(ctx, `FAIL ${description}: ${errorCode(error) ?? "error"} ${error instanceof Error ? error.message : String(error)}`);
      failures.push(`the ACL entry ${description.replace(/^\S+ /, "")}`);
    }
  }
  return failures;
}

async function rollback(ctx: Context): Promise<number> {
  const baseAdminUrl = envUrl(ctx, "CUTOVER_SOURCE_ADMIN_URL");
  refuseTransactionPooler("CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl);
  requireLocalOrConfirmed(ctx, [["CUTOVER_SOURCE_ADMIN_URL", baseAdminUrl]]);
  const targets = consumerUrls(ctx);
  const path = passwordFilePath(ctx);
  let fd: number;
  try {
    fd = openPrivateFile(path, fsConstants.O_RDWR | fsConstants.O_APPEND);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new CutoverError(`${path} does not exist; name the freeze's password file`);
    throw error;
  }
  // Each consumer and each ACL entry is restored and reported on its own:
  // one that fails never holds back the others.
  const failures: string[] = [];
  try {
    await lockPasswordFile(fd, path);
    const entries = readWindowFile(ctx, path).entries;
    const passwords = passwordsOf(entries);
    const client = await connectSourceAdmin(ctx, "neon-cutover-rollback");
    let facts: SourceFacts;
    try {
      // The database default is read-only by now, and GRANT, REVOKE and
      // ALTER DATABASE are refused inside a read-only transaction.
      await client.query("SET default_transaction_read_only = off");
      facts = await sourceFacts(client);
      const problems = adminProblems(facts);
      if (problems.length > 0) throw new CutoverError(`rollback preflight failed: ${problems.join("; ")}`);
      const record = aclRecordOf(entries, facts.database, { orEarlier: true });
      if (!record) {
        throw new CutoverError(
          `${path} holds no record of ${facts.database}'s ACL, so rollback cannot restore it; nothing was changed`
        );
      }
      let recorded: AclEntry[];
      try {
        recorded = await aclEntries(client, record.datacl);
      } catch (error) {
        // A role named in the record has been dropped since, so its aclitem no longer parses.
        throw new CutoverError(
          `the ACL recorded at ${record.at} no longer parses (${errorCode(error) ?? "error"} ${error instanceof Error ? error.message : String(error)}); ` +
            "restore it by hand from that entry of the password file; nothing was changed"
        );
      }
      plan(ctx, [
        `restore ${facts.database}'s ACL as recorded at ${record.at}, entry by entry: ${recorded.map(aclText).join(" ")}`,
        `ALTER DATABASE ${facts.database} RESET default_transaction_read_only`,
        "no password changes: the owner's rotated one stays, and its consumers switch to it (switch-back-url)",
        "prove it: the ACL equals the record (a default ACL comes back as its explicit equivalent), and every consumer connects to a read-write session",
      ]);
      failures.push(...(await restoreAcl(ctx, client, facts, recorded)));
      try {
        await client.query(
          `ALTER DATABASE ${client.escapeIdentifier(facts.database)} RESET default_transaction_read_only`
        );
        say(ctx, `OK   ${facts.database}: default_transaction_read_only reset`);
      } catch (error) {
        say(ctx, `FAIL ${facts.database}: RESET default_transaction_read_only: ${errorCode(error) ?? "error"}`);
        failures.push(`${facts.database}'s read-only default`);
      }
      const now = (await sourceFacts(client)).datacl;
      const after = (await aclEntries(client, now)).map(aclText);
      const expected = recorded.map(aclText);
      const missing = expected.filter((entry) => !after.includes(entry));
      const extra = after.filter((entry) => !expected.includes(entry));
      if (missing.length === 0 && extra.length === 0) {
        say(ctx, `OK   ${facts.database}: ACL restored exactly`);
        // A later freeze in this file records the ACL afresh.
        appendEntry(fd, { database: facts.database, rolledBack: true });
      }
      else {
        say(ctx, `FAIL ${facts.database}: ACL differs from the record: missing ${missing.join(" ") || "nothing"}; extra ${extra.join(" ") || "nothing"}`);
        if (!failures.includes(`${facts.database}'s ACL`)) failures.push(`${facts.database}'s ACL`);
      }
    } finally {
      await client.end().catch(() => undefined);
    }

    for (const { role, url } of targets) {
      // The owner's consumers switch to its rotated password; every other
      // consumer's password never changed.
      const rotated = role === facts.owner ? passwords.get(role) : undefined;
      const credential = rotated ? " with its rotated password" : "";
      try {
        const probe = await connect(rotated ? withPassword(url, rotated) : url, "neon-cutover-rollback-probe");
        try {
          const { rows } = await probe.query<{ value: string }>(
            "SELECT current_setting('transaction_read_only') AS value"
          );
          if (rows[0]!.value !== "off") throw new Error("its session is read-only");
        } finally {
          await probe.end().catch(() => undefined);
        }
        say(ctx, `OK   ${role} connects${credential} to a read-write session`);
      } catch (error) {
        say(ctx, `FAIL ${role}: ${errorCode(error) ?? "error"} ${error instanceof Error ? error.message : String(error)}`);
        failures.push(role);
      }
    }
    if (failures.length > 0) {
      say(ctx, `not proven: ${failures.join(", ")}`);
      return 2;
    }
    say(
      ctx,
      `ROLLED BACK: ${facts.database}'s ACL is the recorded one, its read-only default is reset, and every consumer connects to a read-write session`
    );
    return 0;
  } finally {
    // Closing the file releases the lock.
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Entry point

function parseArgs(argv: string[]): { phase: Phase; options: Options } {
  const [phase, ...rest] = argv;
  if (!phase || !(PHASES as readonly string[]).includes(phase)) throw new CutoverError(USAGE);
  const options: Options = {
    appRoles: [],
    dumpRole: DEFAULT_DUMP_ROLE,
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
      case "password-file":
        options.passwordFile = value();
        break;
      case "dump-role":
        options.dumpRole = value();
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.dumpRole))
          throw new CutoverError("--dump-role must be a lower-case role name");
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
