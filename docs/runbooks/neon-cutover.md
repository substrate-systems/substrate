# Neon cutover

This moves the production control database from Neon to the self-hosted
PostgreSQL 17 server (design D8, `adopt-exomem-cloud-plain-cells`). The whole
database moves as one unit: Substrate, Endstate, OAuth, Paddle and Exomem
tables. No write is lost. Neon stays locked and read-only as the rollback until
retirement.

Run it once, in one announced maintenance window, from one shell.
`scripts/neon-cutover.ts` does the database work. Each phase prints its plan
before it acts, and each can be rerun alone. `freeze`, `rollback` and
`create-dump-role` change Neon, and refuse a non-local host without
`--confirm-production`. `restore` and `grants` need no flag, because an empty
target and an exact migration match bound them. The script never prints a
connection string or a password. The one phase that outputs one,
`switch-back-url`, writes it to a pipe and refuses a terminal. No step here
puts a secret on a command line: secrets travel in the environment or on
stdin.

The script's exit status is `0` for success, `1` for a refusal or a failure to
run, and `2` for a failed check. Only `0` lets you continue.

The script, the grants and the whole sequence are rehearsed on disposable
containers by `npm run rehearse:neon-cutover`. That needs Docker.

## Consumers of the Neon database

Every consumer below must be stopped, or locked out by the freeze, before the
dump. Step 1 confirms from the database side that nothing else is connected.

| Consumer | Connects with | Stopped by |
|---|---|---|
| Vercel production: website, API routes, the `claim-followups`, `backup-gc` and `indexnow` crons | `DATABASE_URL`; the build's migration step uses `DATABASE_MIGRATION_URL`, falling back to `DATABASE_URL` | the freeze locks its role |
| Vercel preview and development, if their `DATABASE_URL` names production Neon | as above | the freeze, since the role is shared; check in P3, and remove in step 7 |
| Old platform gateway, Deployment `exomem-gateway` | Secret `exomem-gateway-database` | scaled to zero in step 0 |
| Old platform provisioner: Deployments `exomem-provisioner-api`, `exomem-provisioner-worker`, `exomem-volume-worker` | Secret `exomem-provisioner-database`: role `exomem_provisioner_runtime`, schema `exomem_provisioner` | scaled to zero in step 0 |
| Old platform node CronJobs: `exomem-database-backup`, `exomem-durability-backup`, `exomem-durability-actions`, `exomem-export-gc`, `exomem-deletion-dispatcher` | Secret `exomem-provisioner-database` | suspended in step 0 |
| Helm hook Job `exomem-provisioner-database-migration` | Secret `exomem-provisioner-database` | do not run `helm upgrade` on the old platform during the window |
| This repository's operator scripts: `migrate.ts`, `generate-jwt-keypair.ts --commit`, `exomem-d1-expand-preflight.ts`, `reconcile-legacy-generations.ts`, `strict-generation-visibility-cutover.ts`, `import-legacy-patron.ts` | a local `DATABASE_URL`, often from `.env.production.local` | not run during the window; delete local `.env.production.local` copies after it |
| Exomem repository: `scripts/promotion_evidence.py` | `SUBSTRATE_DATABASE_URL` | not run during the window |
| People: `psql` sessions and the Neon SQL editor | the owner role | closed before step 1; the freeze ends any left open |

The old platform's own hosted scheduler reaches Substrate over HTTPS, not the
database. Its calls fail during the window and succeed after the switch.

## Preconditions (the days before)

- [ ] **P1. The new server is up and backed up.** This is Exomem task 6.1. The
  role apply is done, PostgreSQL and PgBouncer are active, the four roles
  exist, and `exomem_control` is owned by `substrate_owner`. A pgBackRest full
  backup has completed, and the restore-verify script passes.
- [ ] **P2. Tools.** Have pg_dump and pg_restore at major 17, from
  `postgresql-client-17`. The major must be at least Neon's major, and Neon's
  major must be at most 17. P5 checks both. You also need psql, Node 24, a
  checkout of this repository at the commit production runs with `npm ci`
  done, the Vercel CLI linked to the production project, and kubectl for the
  old cluster. From the Exomem repository you need `sops` and the operator age
  key. For the Neon API path (P4) you need a Neon API key with access to the
  production project, kept in the password manager.
- [ ] **P3. Vercel environment.** Do P6's capture first: once this step re-adds
  a variable, Vercel stores it as sensitive, and a sensitive value cannot be
  read back. Then run `vercel env ls` and note:
  - which environments define `DATABASE_URL`, and which of them share one
    record. `vercel env ls` shows each record once, with all its environments;
  - whether a preview or development `DATABASE_URL` names production Neon;
  - whether `DATABASE_MIGRATION_URL` exists, and the same for it.

  If Vercel shows `DATABASE_URL` as managed by the Neon integration, disconnect
  that store from the project's production environment in the Vercel
  dashboard, under Storage. Only disconnect it. Never delete the integration
  or the store, because that can delete the Neon database. Then add the
  variable back by hand, as a production-only record, with the value P6
  captured:
  `printf '%s' "$NEON_DATABASE_URL" | vercel env add DATABASE_URL production --sensitive`,
  with `NEON_DATABASE_URL` read as in the shell setup. After that,
  `vercel env rm` and `vercel env add` will work in the window.
- [ ] **P4. Roles and their rotation path.** The freeze locks each application
  role out by changing its password, one of two ways:
  - **SQL path.** The admin session sets `NOLOGIN` and a random password that
    nobody learns. Rollback restores the pre-freeze password.
  - **Neon API path.** The script resets the role's password through Neon's
    API, and records the new one only in the rotated-password file. Neon then
    holds that password, so a compute restart re-applies the new password
    rather than undoing the rotation. Rollback cannot restore the pre-freeze
    password, so consumers switch back with the new one.

  The script calls three Neon endpoints. The key goes only in the
  `Authorization` header, and nothing prints it.
  - [Get endpoint](https://api-docs.neon.tech/reference/getprojectendpoint)
    (`GET /projects/{project_id}/endpoints/{endpoint_id}`), before any reset.
    The endpoint is the first label of the admin URL's host (`ep-...`), and
    the answer's `endpoint.branch_id` must equal `NEON_BRANCH_ID`. That stops
    a stale branch ID, such as P5's, from resetting another branch's roles.
  - [Reset role password](https://api-docs.neon.tech/reference/resetprojectbranchrolepassword)
    (`POST /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password`).
    Its answer's `role.branch_id` must equal `NEON_BRANCH_ID` too.
  - [Get operation](https://api-docs.neon.tech/reference/getprojectoperation),
    polled until every operation the reset started has finished. Neon's
    [operations guide](https://neon.com/docs/manage/operations) lists
    `finished` and `skipped` as the successful terminal statuses, and
    `failed`, `error` and `cancelled` as the unsuccessful ones; the script
    stops on any of those, and waits two minutes at most.

  Choose each role's path with this table. P5 confirms the choice:

  | Role | Path | Why |
  |---|---|---|
  | The owner role the freeze runs as, such as `neondb_owner`, when a consumer logs in as it (likely Vercel's `DATABASE_URL`) | API | `NOLOGIN` would lock the freeze out. Its lockout is the password change alone, and it keeps `LOGIN` |
  | Another role created in the Neon console or API | API | Neon holds its password, and a compute restart can re-apply it |
  | A role created with SQL `CREATE ROLE`, such as the old provisioner's `exomem_provisioner_runtime` | SQL | Neon does not hold its password |
  | Any role whose lockout P5's compute restart undid | API | That is the evidence Neon re-applies its settings |

  Every API-path role except the admin also gets `NOLOGIN`, as a second
  layer. The admin can never be on the SQL path, because the freeze refuses
  to lock itself out. If P5's freeze reports that the Neon API refused a
  role's reset, Neon does not manage that role: put it on the SQL path.

  The freeze locks out only the roles it names. So every login role that can
  write to the database must be in `ROLES`, and both `inventory` and `freeze`
  refuse while one is not. A role can write if it is a member of
  `pg_write_all_data`, holds a write privilege on a table, or can create in a
  schema. Every Neon console role is such a role, through `neon_superuser`.
  Add each one with its credential, or take away its `LOGIN` if no consumer
  uses it. The admin must also see every session, so it needs `pg_monitor`.
  A Neon console role has it through `neon_superuser`.

  Create the dump role now, before P5, so the branch inherits it. Generate its
  password in the password manager, 64 hex characters, and save it as
  `NEON_CUTOVER_DUMP_PW`. Read it, the admin's connection string and the dump
  URL as the shell setup below does (`DUMP_PW`, `CUTOVER_SOURCE_ADMIN_URL`,
  `CUTOVER_SOURCE_DUMP_URL`). Then:

  ```bash
  npm run cutover:neon -- create-dump-role --confirm-production
  ```

  It creates the role that `CUTOVER_SOURCE_DUMP_URL` names,
  `neon_cutover_dump`. Its password goes to Neon as a SCRAM verifier, so the
  plaintext reaches neither a command line nor the server log. It grants the
  role `pg_read_all_data`, and then logs in as it. If Neon refuses the grant,
  the phase exits `2`. Then have the role that owns the tables run this
  instead:
  `GRANT USAGE ON SCHEMA public TO neon_cutover_dump; GRANT SELECT ON ALL TABLES IN SCHEMA public TO neon_cutover_dump; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO neon_cutover_dump;`
  Do the same for every other schema that `inventory` lists. The `dump` phase
  refuses if any relation is unreadable.
- [ ] **P5. Dress rehearsal on a Neon branch.** This is a hard precondition:
  the window does not start until it passes. Create a branch of production in
  the Neon console. It is a disposable copy with the same roles and data.
  Take its direct connection strings and its branch ID. Do the shell setup
  below against the branch, with `NEON_BRANCH_ID` set to the branch's ID and
  `ROTATED` set to `$CUTOVER_DIR/p5-rotated.jsonl`. The API resets then change
  only the branch's passwords, and the freeze's endpoint check proves it.
  Run steps 1 to 6 against the branch, verify included, with a local
  `postgres:17` container as the target. Set the container up the way the
  rehearsal test does: the four roles, `exomem_control` owned by
  `substrate_owner`, and a `pgbouncer` schema owned by `postgres`. Then
  restart the branch's compute from the Neon console, and run the retention
  check (under "Retention until retirement" below) against the branch. It
  probes every role's pre-freeze credential again. Then run `rollback`, and
  delete the branch. Record:
  - the `dump`, `restore` and `verify` durations, and the archive size. The
    window's table below takes its dump, restore and verify times from these;
  - that `inventory` printed `GO`, with every role's credential logging in;
  - that `freeze` exited `0` with every probe `OK`, which proves Neon lets the
    admin alter the application roles and end every other session, and that
    the API resets finished;
  - that `verify` printed `VERIFIED`;
  - that the lockout survived the compute restart, role by role. If a
    SQL-path role fails the check after the restart, Neon re-applied its
    settings. Move it to `API_ROLES`, and repeat P5 on a new branch. If an
    API-path role fails, stop and get a ruling before the window;
  - each role's final path. That fixes `ROLES` and `API_ROLES` for the window.

  Never reuse `p5-rotated.jsonl` in the window. It holds the branch's
  passwords, and the window writes a new file.
- [ ] **P6. Record the pre-window state.** Do this before P3 re-adds any
  variable. Record the production deployment URL and its Git SHA with
  `vercel ls --prod`. Then put every value the window needs into the password
  manager:
  - the current `DATABASE_URL`, and `DATABASE_MIGRATION_URL` if it exists, as
    `NEON_DATABASE_URL` and `NEON_DATABASE_MIGRATION_URL`;
  - `PADDLE_API_KEY` and `EXOMEM_ADMIN_TOKEN`, for the post-checks.

  Pull the production values to tmpfs, copy each one into the password
  manager, and delete the file:

  ```bash
  vercel env pull "$XDG_RUNTIME_DIR/neon-cutover.env" --environment=production --yes
  ```

  Vercel stores a sensitive value
  [unreadably once created](https://vercel.com/docs/environment-variables/sensitive-environment-variables),
  so the pull writes it empty, and every variable P3 re-adds becomes
  sensitive. Take an empty one from where it was made: the Neon URLs from the
  Neon console, the Paddle key from the Paddle dashboard, and the admin token
  from the record kept when it was generated. For a SQL-path role, the two
  Neon URLs are the switch-back values, and once the freeze has rotated the
  role's password they are the only copy of the pre-freeze one. For an
  API-path role, the freeze makes their password useless. The switch-back
  keeps the rest of the URL, and takes the password from the rotated-password
  file.
- [ ] **P7. Announce the window.** Freeze merges to `main` for the whole
  window: a push deploys production, and its build runs migrations.

## Shell setup (at the start of the window)

Work in one shell, from the repository root at the production commit. Put the
archive on an encrypted disk:

```bash
export PGSSLROOTCERT=system CUTOVER_DIR="$HOME/neon-cutover" && mkdir -p -m 700 "$CUTOVER_DIR"
```

Read every value P6 put in the password manager with `read -rsp`, one per
line, so none reaches the screen, the shell history or a command line. Paste
each one at its prompt. Skip `NEON_DATABASE_MIGRATION_URL` if P3 found no
`DATABASE_MIGRATION_URL`:

```bash
read -rsp 'NEON_DATABASE_URL: ' NEON_DATABASE_URL && echo && export NEON_DATABASE_URL
```
```bash
read -rsp 'NEON_DATABASE_MIGRATION_URL: ' NEON_DATABASE_MIGRATION_URL && echo && export NEON_DATABASE_MIGRATION_URL
```
```bash
read -rsp 'PADDLE_API_KEY: ' PADDLE_API_KEY && echo && export PADDLE_API_KEY
```
```bash
read -rsp 'EXOMEM_ADMIN_TOKEN: ' EXOMEM_ADMIN_TOKEN && echo && export EXOMEM_ADMIN_TOKEN
```
```bash
read -rsp 'NEON_CUTOVER_DUMP_PW: ' DUMP_PW && echo
```
```bash
node -e 'for (const n of ["NEON_DATABASE_URL","NEON_DATABASE_MIGRATION_URL"]) if (process.env[n]) { const u=new URL(process.env[n]); console.log(n, u.username, u.hostname, u.pathname) }'
```

The last command prints the role each URL logs in as, without its password.
If `NEON_DATABASE_MIGRATION_URL` names another role, that role is an
application role too. Export one `CUTOVER_ROLE_URL_<ROLE>` per application
role. Write the role name in upper case, with every other character as `_`.
For Vercel's role:

```bash
export CUTOVER_ROLE_URL_<ROLE>="$NEON_DATABASE_URL"
```

For an old-platform role that step 1 shows logging in to this database, take
its Secret and convert the SQLAlchemy URL form:

```bash
export CUTOVER_ROLE_URL_EXOMEM_PROVISIONER_RUNTIME="$(kubectl -n exomem-platform get secret exomem-provisioner-database -o jsonpath='{.data.url}' | base64 -d | sed -e 's#^postgresql+asyncpg://#postgresql://#' -e 's#ssl=require#sslmode=require#')"
```

Neon, using the direct endpoint with no `-pooler` in the host. The admin role
comes from the Neon console, and the dump role from P4. Keep the admin's
pre-freeze URL here even after the freeze. Once the API path has rotated the
admin's own password, every phase takes the new one from the rotated-password
file. Paste the admin's direct connection string, with `sslmode=verify-full`,
at the prompt:

```bash
read -rsp 'Neon admin connection string: ' CUTOVER_SOURCE_ADMIN_URL && echo && export CUTOVER_SOURCE_ADMIN_URL
```
```bash
export CUTOVER_SOURCE_DUMP_URL="postgresql://neon_cutover_dump:$DUMP_PW@<neon direct host>/<database>?sslmode=verify-full"
```

The Neon API path reads three variables. The project ID and the production
branch ID (`br-...`) come from the Neon console. The branch must be the one
the admin host's `ep-...` endpoint serves, and the freeze checks that. Read
the API key without echoing it, so it reaches neither the screen nor the shell
history:

```bash
read -rsp 'Neon API key: ' NEON_API_KEY && echo && export NEON_API_KEY
```
```bash
export NEON_PROJECT_ID='<project id>' NEON_BRANCH_ID='<production branch id>'
```

The new server goes through PgBouncer's session alias `exomem_control_session`
on 6432, never the transaction alias `exomem_control`. The only other path is
port 5432 on the control server itself, because `pg_hba.conf` admits
`substrate_owner` from loopback only. Passwords come from the Exomem SOPS
files. Get `CONTROL_DB_HOST` from the control node's
`postgres_database_hostname`, and `SECRET_VERSION` from the active slot in
`infra/contracts/secret-destinations-v1.json`:

```bash
export EXOMEM_REPO=/path/to/exomem CONTROL_DB_HOST='<postgres_database_hostname>' SECRET_VERSION='<version>'
```
```bash
export CUTOVER_TARGET_OWNER_URL="postgresql://substrate_owner:$(sops -d --extract '["postgres_substrate_owner_password"]' "$EXOMEM_REPO/infra/secrets/ansible/control-db-substrate-owner-password.$SECRET_VERSION.sops.json" | node -e 'let p="";process.stdin.on("data",d=>p+=d).on("end",()=>process.stdout.write(encodeURIComponent(p.replace(/\n$/,""))))')@$CONTROL_DB_HOST:6432/exomem_control_session?sslmode=verify-full"
```
```bash
export NEW_DATABASE_URL="postgresql://substrate_app:$(sops -d --extract '["postgres_substrate_app_password"]' "$EXOMEM_REPO/infra/secrets/ansible/control-db-substrate-app-password.$SECRET_VERSION.sops.json" | node -e 'let p="";process.stdin.on("data",d=>p+=d).on("end",()=>process.stdout.write(encodeURIComponent(p.replace(/\n$/,""))))')@$CONTROL_DB_HOST:6432/exomem_control?sslmode=verify-full"
```
```bash
export NEW_DATABASE_MIGRATION_URL="$CUTOVER_TARGET_OWNER_URL"
```

Set `ROLES` to the comma-separated application roles: Vercel's role, plus
every old-platform role that logs in to this database, plus every other login
role that can write to it (P4). Include the admin whenever a consumer logs in
as it. Set `API_ROLES` to the roles that P5 put on the Neon API path, or leave
it empty. Set `ROTATED` to this window's rotated-password file, named for the
window's date. Every later command, the daily check included, uses the same
name:

```bash
export ROLES='<role>,<role>' API_ROLES='<role>' ROTATED="$CUTOVER_DIR/neon-rotated-<window date>.jsonl"
```

The rotated-password file is the only copy of every API-path role's live
password. The freeze opens it before any Neon call: it creates it with mode
`0600`, and refuses a missing directory, a symbolic link, or a file with any
other mode or owner. So a reset can always be recorded. The script never
prints the file, and only ever appends to it. A role's newest entry is its
live password, and the older ones stay as its history.

Each window starts a fresh rotated-password file. Never reuse one from P5 or
from an earlier window: its passwords belong to another branch, or to a
freeze that a rollback has since undone. Keep the file in `$CUTOVER_DIR` until
retirement, and never edit it. Rollback, the switch-back and the daily check
all read it.

## The window

| Step | Typical duration | Go/no-go before the next step |
|---|---|---|
| 0. Stop the old platform | 5 min | `kubectl get` shows 0 replicas, and every CronJob suspended with no running Job |
| 1. Inventory | 1 min | `GO`, exit 0: every role's credential logs in, and every login role with sessions is in `ROLES`, is the admin, or is the dump role |
| 2. Freeze | 1 min | `FROZEN`, exit 0 |
| 3. Dump | P5's measurement | exit 0; archive and `.sha256` written |
| 4. Restore | P5's measurement | exit 0 |
| 5. Grants | 1 min | `role checks passed`, exit 0 |
| 6. Verify | P5's measurement | `VERIFIED`, exit 0 |
| 7. Switch and redeploy | 5 to 10 min, one Vercel build | The new deployment is `Ready` and serves production |
| 8. Post-checks | 10 min | All three pass |

Size the window from P5's dump, restore and verify times, plus the fixed
steps. The rehearsal, on a few hundred seeded rows, measured freeze 2.4 s,
dump 0.6 s, restore 1.5 s, grants 0.1 s and verify 0.06 s. Two one-second
polls of its fake Neon operation account for most of the freeze. Those
numbers say nothing about production; P5's do.

Between the freeze and the switch, the website, the Endstate API, OAuth and the
Paddle webhook return errors. Nothing they reject was acknowledged, so nothing
is lost. Paddle retries non-2xx deliveries for up to three days, and the
retries land on the new database after the switch.

### 0. Stop the old platform

```bash
kubectl -n exomem-platform scale deployment exomem-gateway exomem-provisioner-api exomem-provisioner-worker exomem-volume-worker --replicas=0
```
```bash
kubectl -n exomem-platform get cronjob -o name | xargs -I@ kubectl -n exomem-platform patch @ -p '{"spec":{"suspend":true}}'
```
```bash
kubectl -n exomem-platform get deployment,cronjob,job,pod
```

They stay stopped. Retirement removes them.

### 1. Inventory

```bash
npm run cutover:neon -- inventory --app-roles="$ROLES"
```

It refuses unless the admin can see every session (`pg_monitor`, P4). It
then logs in with each `CUTOVER_ROLE_URL_<ROLE>`, and ends with `GO` and exit
`0` only when every login succeeds and no unlisted login role can write. A
credential that does not log in is a no-go: after the freeze it would pass
for a lockout, and rollback would restore it, locking the real consumer out.
Find the credential the consumer really holds.

Read these sections of the output:

- **Server version.** The major must be at most 17, and no newer than your
  pg_dump.
- **Schemas.** Every schema listed travels. `exomem_provisioner`, if present,
  is the old provisioner's, and its role must be in `ROLES`.
- **Extensions.** Only trusted ones may appear, normally `citext`, `pgcrypto`
  and `plpgsql`.
- **Restore blockers.** This must read `none`.
- **Client sessions.** No role may show sessions unless it is in `ROLES`, is
  the admin, or is the dump role. A `note:` line lists login roles outside
  `ROLES`, and each one must be accounted for.

No-go on any surprise. Stop, find the consumer, and restart the window later.

### 2. Freeze Neon

```bash
npm run cutover:neon -- freeze --app-roles="$ROLES" --api-roles="$API_ROLES" --rotated-password-file="$ROTATED" --confirm-production
```

Before it changes anything, the freeze checks, and refuses on any failure:

- it opens `$ROTATED` and checks it, before any Neon call;
- the admin URL's endpoint serves `NEON_BRANCH_ID` (P4);
- the admin can alter every application role, end sessions, and see them all;
- no login role outside `ROLES` can write to the database;
- each role's `CUTOVER_ROLE_URL_<ROLE>` logs in now. An API-path role that an
  earlier freeze of this window rotated is the exception: its newest recorded
  password logs in instead, and it is not reset again.

It then locks the application roles out of Neon:

- It resets each `API_ROLES` password through the Neon API, and appends the
  new password to `$ROTATED` as soon as Neon returns it. It waits until Neon
  reports every resulting operation finished. If the admin was one of them,
  it then reconnects with the admin's new password.
- On each SQL-path role, it sets `NOLOGIN` and a random password that is never
  printed. On each API-path role except the admin, it sets `NOLOGIN`.
- It sets `default_transaction_read_only = on` for the database. A session
  that connects from now on starts read-only.
- It then terminates every other client session of the database, whatever
  its role, the admin's own included. Only a superuser's session is left,
  because only a superuser may end it; on Neon those are its control plane's.
  The dump role's session starts in step 3, after the freeze, so never run a
  freeze while a dump runs.

The script then proves the lockout:

- Each role's pre-freeze credential is refused at login, even when it
  overrides the read-only default as any client could. The refusal is `28P01`
  or `28000`.
- Each API-path role's recorded password is live. The admin logs in with it,
  and every other API-path role is refused only by `NOLOGIN` (`28000`).
- No other client session of the database remains, and a new session is
  read-only.

It then prints `FROZEN` and exits `0`.

If it prints `FREEZE NOT PROVEN` and exits `2`, or refuses, or a Neon API call
fails, do not dump. Fix the named failure, then:

- **Nothing was locked yet** (a preflight refusal, or a failed API reset before
  any `NOLOGIN`): rerun the same command. A reset whose Neon operation failed
  is reset again, because its recorded password does not log in while the
  pre-freeze one still does. The newest entry in `$ROTATED` is the one that
  counts.
- **A SQL-path role was already locked**: the rerun refuses, because that
  role's pre-freeze credential no longer logs in and cannot be proven again.
  Run `rollback`, then the same freeze command. The rerun does not reset an
  API-path role whose recorded password still logs in.
- **A reset's response was lost or timed out**: Neon may hold a password
  nobody recorded, and the rerun refuses with a message naming the Neon
  console. Reset that role's password in the Neon console, which shows the new
  connection string once. Read it into `CUTOVER_SOURCE_ADMIN_URL` if the role
  is the admin, and into the role's `CUTOVER_ROLE_URL_<ROLE>`, each with
  `read -rsp` as in the shell setup. Then rerun freeze: it resets the role
  once more through the API and records that password.

If you cannot fix it, run `rollback` and end the window. Nothing has been
lost.

### 3. Dump

```bash
npm run cutover:neon -- dump --archive="$CUTOVER_DIR/neon.dump"
```

The dump runs as `neon_cutover_dump`, with
`pg_dump --format=custom --no-owner --no-acl`. It refuses in these cases:

- the pg_dump major version is older than Neon's;
- a new session on Neon is not read-only, meaning the source is not frozen;
- any relation is unreadable by the dump role;
- the archive already exists.

It writes `neon.dump` and `neon.dump.sha256`. A failed dump keeps no archive,
so you can rerun it. Add `--pg-bin-dir=<dir>` if pg_dump 17 is not first on
`PATH`.

### 4. Restore

```bash
npm run cutover:neon -- restore --archive="$CUTOVER_DIR/neon.dump"
```

Before it restores, the phase checks:

- the archive against its checksum;
- that pg_restore is at least as new as the pg_dump that wrote the archive;
- that the target server is at least as new as the source;
- that the connection is `substrate_owner`, and that `substrate_owner` owns
  the database;
- that the target is empty in every schema the archive holds.

It then runs
`pg_restore --no-owner --no-acl --single-transaction --exit-on-error`. A
failure rolls the whole restore back, so it is safe to fix the problem and
rerun. The restore never goes through the transaction-mode alias
`exomem_control`, and the script refuses it.

### 5. Grants

```bash
npm run cutover:neon -- grants
```

First the phase checks two things:

- The restored `schema_migrations` must equal this checkout's `migrations/`.
  Otherwise you are on the wrong commit.
- `substrate_app`, `exomem_gateway` and `exomem_cellctl` must exist. The grants
  script silently skips a missing role.

It then runs `scripts/migrate.ts` against the target. With nothing pending,
that applies only `scripts/exomem-cloud-grants.sql`. Last, it checks the D7
role shape from the catalog:

- `substrate_app` has full DML on every table outside C1 to C1d and
  `schema_migrations`, and can use every sequence;
- on C1 to C1d, `substrate_app` can `SELECT` but not `DELETE`;
- `exomem_gateway` reads only the C1 routing columns;
- the default privileges for later migrations exist.

### 6. Verify

```bash
npm run cutover:neon -- verify
```

Verify runs one read-only, repeatable-read snapshot on each side. Both
sessions are pinned to `TimeZone=UTC`, ISO `DateStyle`, `IntervalStyle`,
`extra_float_digits=3`, hex `bytea_output` and `search_path`. It compares:

- every source extension and its version;
- every schema. One that exists only on the target fails if it holds a table
  or sequence. An empty one is a note: that is how PgBouncer's `pgbouncer`
  auth schema, which holds only a function, shows;
- every table, on both sides: its column list; its definition, meaning its
  constraints, indexes, triggers, column defaults and `NOT NULL`s as the server
  renders them; its row count; and its content checksum. The checksum is the
  md5 of every row's text in collation-free bytewise order. A table on one side
  only fails;
- every sequence, whose next value on the target must be at least the
  source's. A sequence on one side only fails.

The checksum aggregates a table's row digests with `string_agg`, whose 1 GB
limit caps one table at about 33 million rows. `backup_chunks` holds only
keys, sizes and hashes, one row per chunk, so alpha scale is far below it.

It prints one `OK` or `FAIL` line per object, without row contents, and ends
`VERIFIED` with exit `0`, or `MISMATCH` with exit `2`. On a mismatch, do not
switch: run `rollback` and end the window. Nothing has been lost. Keep the
output for the investigation.

### 7. Switch Vercel and redeploy

```bash
npm run cutover:neon -- switch-plan --target-host="$CONTROL_DB_HOST"
```

This phase prints the commands and runs nothing. Run them yourself, one at a
time.

`vercel env rm <name> production` deletes the whole record that targets
production. If that record also targets preview or development, as P3 noted,
those lose the variable too
([vercel/vercel#16622](https://github.com/vercel/vercel/issues/16622)). Here
that is wanted: a preview or development `DATABASE_URL` that names production
Neon must go. The CLI cannot remove one target from a shared record, so the
order below removes the record, adds production back on its own, and then
removes any separate preview or development record:

```bash
vercel env rm DATABASE_URL production --yes
```
```bash
printf '%s' "$NEW_DATABASE_URL" | vercel env add DATABASE_URL production --sensitive
```
```bash
vercel env rm DATABASE_MIGRATION_URL production --yes
```

The last command reports "not found" if the variable was never set. That is
fine.

```bash
printf '%s' "$NEW_DATABASE_MIGRATION_URL" | vercel env add DATABASE_MIGRATION_URL production --sensitive
```

If P3 found a separate preview or development record whose `DATABASE_URL` or
`DATABASE_MIGRATION_URL` names production Neon, remove each now. The new
production records target production alone, so these commands cannot reach
them:

```bash
vercel env rm DATABASE_URL preview --yes
```
```bash
vercel env rm DATABASE_URL development --yes
```

Do the same for `DATABASE_MIGRATION_URL`. Then check that only production
defines the two variables. Give preview or development a non-production
database later, in a record of its own, if they need one:

```bash
vercel env ls | grep -E 'DATABASE_(MIGRATION_)?URL'
```
```bash
vercel redeploy <production deployment URL recorded in P6> --target=production
```

The build's migration step runs against the new server through the session
alias. It applies no migration, and reapplies the grants idempotently. Wait
until `vercel ls --prod` shows the new deployment as `Ready` and serving
production.

### 8. Post-checks

These run against the new database through the deployed site.

1. **Paddle webhook replay.** In the Paddle dashboard, go to Developer tools,
   then Notifications, then the production destination for
   `/api/webhooks/paddle`. Replay the most recent notification delivered
   before the window. Or use the API. `printf` is a shell builtin, and curl
   reads the header from stdin (`-H @-`), so the key reaches no command line:

   ```bash
   printf 'Authorization: Bearer %s\n' "$PADDLE_API_KEY" | curl -fsS -X POST -H @- https://api.paddle.com/notifications/<ntf_id>/replay
   ```

   The log must show HTTP 200 and `{"ok":true,"deduped":true}`. That proves
   the carried dedupe ledger answered from the new database. Then check that
   the notifications that failed during the window now show as delivered.
2. **Endstate backup read.** Run the round-trip recipe in
   `production-keys-and-storage.md`, under "Verify the bypass is wired",
   step 4. It signs up, pushes, lists, pulls and deletes. Its green-light JSON
   must match exactly. Then open an existing Endstate Cloud account in the
   desktop app, and confirm that its newest backup lists and restores.
3. **Exomem admission dry run.** Cloud admission stays off until task 4.3.
   The deployed site reads its inputs as `substrate_app`:

   ```bash
   printf 'Authorization: Bearer %s\n' "$EXOMEM_ADMIN_TOKEN" | curl -fsS -H @- https://substratesystems.io/api/exomem/admin/cloud-release
   ```

   It must return `"success":true`, with capacity and rollout as they were on
   Neon. The redemption itself, as `substrate_app` in a rolled-back
   transaction, is proven by the rehearsal.

Close the window. Keep the merge freeze until all three checks pass. Close
the shell, which drops every value read into it, and delete any
`.env.production.local` that names Neon.

## Rollback

**Before the switch** (steps 2 to 6 failed, or you chose to stop), rollback
loses nothing. The new database has served no traffic.

```bash
npm run cutover:neon -- rollback --app-roles="$ROLES" --api-roles="$API_ROLES" --rotated-password-file="$ROTATED" --confirm-production
```

This resets the database read-only default, and gives each role `LOGIN` back:

- A SQL-path role gets its pre-freeze password back, from its
  `CUTOVER_ROLE_URL_<ROLE>`. The password is sent as a SCRAM verifier, so it
  never reaches the logs. That credential is the one step 1 and the freeze
  proved by logging in, so it is the one the consumer holds.
- An API-path role keeps its newest recorded password. Neon's API resets a
  password to a new random one, and cannot set the old one back. An API-path
  role that Neon never reset, such as one whose reset returned 404, still has
  its pre-freeze password, and rollback proves that one instead.

The phase restores, proves and reports each role on its own, so a role that
cannot be restored never holds back the others. Each role must log in to a
read-write session with the credential its consumers will use: `OK` or `FAIL`
per role. It prints `ROLLED BACK` and exits `0` when every role passed, or
exits `2` and names every role it could not restore. Fix each named role, then
rerun the same command; a rerun is safe. It never calls the Neon API.

On the API path, every consumer of an API-path role still holds the dead
pre-freeze password, even before the switch. If Vercel's role is on the API
path, give Vercel the rotated one, then redeploy the production deployment
recorded in P6. `switch-back-url` writes the Neon URL with the rotated
password to the pipe. Nothing reaches the screen, and it refuses to write to a
terminal:

```bash
vercel env rm DATABASE_URL production --yes
```
```bash
node --import tsx scripts/neon-cutover.ts switch-back-url --role=<Vercel's role> --rotated-password-file="$ROTATED" | vercel env add DATABASE_URL production --sensitive
```
```bash
vercel redeploy <production deployment URL recorded in P6> --target=production
```

It runs the script with `node`, not `npm run`, so no npm banner lands in the
variable. Do the same for `DATABASE_MIGRATION_URL` if it existed and logs in as
an API-path role. If P3 left `DATABASE_URL` in one record with preview or
development, the `rm` removes their copy too (step 7).

A later window starts again from the shell setup, with a new `ROTATED` file.
An API-path role's consumer now holds its rotated password, so that is the
role's pre-freeze credential for the new window. Take it from the old
window's file. A command substitution is a pipe, so nothing reaches the
screen:

```bash
export CUTOVER_ROLE_URL_<ROLE>="$(node --import tsx scripts/neon-cutover.ts switch-back-url --role=<role> --rotated-password-file="<the earlier window's file>")"
```

If that role is the admin, set `CUTOVER_SOURCE_ADMIN_URL` to the same value.

If `restore` completed, empty the target before a later window. This drops
everything the restore and the grants created. It leaves the database, the
public schema and PgBouncer's `pgbouncer` schema in place. The Exomem Ansible
role creates that schema `AUTHORIZATION postgres`, so `substrate_owner` does
not own it, and `DROP OWNED BY` cannot break PgBouncer's auth. The password
goes to psql in `PGPASSWORD`, not on its command line:

```bash
PGPASSWORD="$(sops -d --extract '["postgres_substrate_owner_password"]' "$EXOMEM_REPO/infra/secrets/ansible/control-db-substrate-owner-password.$SECRET_VERSION.sops.json")" psql "host=$CONTROL_DB_HOST port=6432 dbname=exomem_control_session user=substrate_owner sslmode=verify-full sslrootcert=system" -c 'DROP OWNED BY substrate_owner'
```

**After the switch**, rollback discards every write the new database accepted
between the new deployment going live and the rollback:

| What | Effect of the rollback |
|---|---|
| New Endstate accounts and credential or recovery changes | gone |
| Backup versions and chunk rows written after the switch | gone; their R2 objects become orphans that no row references |
| Refresh-token rotations | lost, so those clients must sign in again |
| Account deletions | undone; the account reappears on Neon and must be deleted again |
| Paddle webhook effects | gone: subscription changes, supporter contributions, Exomem entitlement changes. Paddle will not resend events it delivered |
| OAuth grants, codes and tokens issued, and Exomem invite redemptions and sessions | gone, so those clients must authorize again |
| Exomem Cloud cell rows | none, if Cloud is still off |

So before rolling back after traffic, keep what the new database holds:

1. Lock `substrate_app` out on the control server, as `postgres`:

   ```bash
   sudo -u postgres psql exomem_control -c "ALTER ROLE substrate_app NOLOGIN" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'substrate_app'"
   ```

2. Dump the new database with the same `dump` phase. Set
   `CUTOVER_SOURCE_DUMP_URL` to the new server as `substrate_owner`, and pass
   `--allow-unfrozen` and a new `--archive`. Nothing is destroyed.
3. Run `rollback` as above.
4. Switch Vercel back. `switch-plan` prints these commands:
   - `vercel env rm` and `vercel env add` for `DATABASE_URL`. On the SQL path,
     the new value is `$NEON_DATABASE_URL`. On the API path, use the
     `switch-back-url` pipeline above;
   - remove `DATABASE_MIGRATION_URL`, or restore it the same way if it
     existed;
   - `vercel redeploy <deployment recorded in P6> --target=production`, which
     builds that deployment again with the restored values.

   On the SQL path only, `vercel rollback <deployment recorded in P6>` is
   faster. It serves traffic from Neon at once, because that deployment was
   built with the pre-freeze password. After an instant rollback, Vercel stops
   promoting new production deployments automatically until you promote one.
   On the API path, that deployment holds a password Neon no longer accepts,
   so redeploy instead.
5. Replay from Paddle's notification log every notification delivered since
   the switch. Forward-port the other lost rows from the step 2 archive, table
   by table, by their `created_at` and `updated_at`. Tell affected users to
   sign in again, and to rerun backups made during that time.

## Retention until retirement

Neon stays as the rollback, locked out and read-only, until task 5.3 deletes
it after seven clean days on the new server.

- Once a day, run the check below, with `CUTOVER_SOURCE_ADMIN_URL`, each
  `CUTOVER_ROLE_URL_<ROLE>` and the window's `ROTATED` set as in the shell
  setup. A Neon compute restart must not have re-enabled a role. The check
  tries every role's pre-freeze credential again, and requires `NOLOGIN` on
  every role except the admin on the API path. It also requires that no other
  client session of the database remains, and that no login role outside
  `ROLES` can write.

  ```bash
  npm run cutover:neon -- inventory --app-roles="$ROLES" --api-roles="$API_ROLES" --rotated-password-file="$ROTATED" --expect-frozen
  ```

  If it fails, fix what it names. For a leftover session, close it. For a
  role that can log in again, run `rollback` and then the step 2 `freeze`
  command, back to back: a bare freeze rerun refuses, because the SQL-path
  credentials no longer log in to be proven. Neither touches the new database.
- Keep `neon.dump`, `neon.dump.sha256` and the window's rotated-password file
  in the encrypted `$CUTOVER_DIR`, and the `NEON_*` values in the password
  manager. They are the second rollback path, since the archive restores
  anywhere with steps 4 to 6.
- The old platform stays scaled to zero, with its CronJobs suspended.
- At retirement, delete the Neon project (task 5.3). Drop
  `neon_cutover_dump` with it. Destroy the archive, every rotated-password file
  and the `NEON_*` records, and revoke the Neon API key.
