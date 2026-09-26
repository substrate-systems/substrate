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
dump. The freeze locks out every role at once: it takes `CONNECT` on the
database from every role but the owner and the dump role. So no consumer's
role has to be found for the lock to hold. `ROLES` names the roles these
consumers log in as only so that the freeze can prove each one is refused.
Step 1 confirms from the database side that nothing else is connected.

| Consumer | Connects with | Stopped by |
|---|---|---|
| Vercel production: website, API routes, the `claim-followups`, `backup-gc` and `indexnow` crons | `DATABASE_URL`; the build's migration step uses `DATABASE_MIGRATION_URL`, falling back to `DATABASE_URL` | the freeze: `CONNECT` is taken from its role, or, when it logs in as the owner, the owner's password is reset through Neon's API |
| Vercel preview and development, if their `DATABASE_URL` names production Neon | as above | the freeze, since the role is shared; check in P3, and remove in step 7 |
| Old platform gateway, Deployment `exomem-gateway` | Secret `exomem-gateway-database` | scaled to zero in step 0 |
| Old platform provisioner: Deployments `exomem-provisioner-api`, `exomem-provisioner-worker`, `exomem-volume-worker` | Secret `exomem-provisioner-database`: role `exomem_provisioner_runtime`, schema `exomem_provisioner` | scaled to zero in step 0 |
| Old platform node CronJobs: `exomem-database-backup`, `exomem-durability-backup`, `exomem-durability-actions`, `exomem-export-gc`, `exomem-deletion-dispatcher` | Secret `exomem-provisioner-database` | suspended in step 0 |
| Helm hook Job `exomem-provisioner-database-migration` | Secret `exomem-provisioner-database` | do not run `helm upgrade` on the old platform during the window |
| This repository's operator scripts: `migrate.ts`, `generate-jwt-keypair.ts --commit`, `exomem-d1-expand-preflight.ts`, `reconcile-legacy-generations.ts`, `strict-generation-visibility-cutover.ts`, `import-legacy-patron.ts` | a local `DATABASE_URL`, often from `.env.production.local` | not run during the window; delete local `.env.production.local` copies after it |
| Exomem repository: `scripts/promotion_evidence.py` | `SUBSTRATE_DATABASE_URL` | not run during the window |
| People: `psql` sessions and the Neon SQL editor | the owner role | closed before step 1; the freeze ends any left open, and the owner's new password is only in the password file |

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
  key. For the Neon API (P4) you need a Neon API key with access to the
  production project, kept in the password manager. The freeze and rollback
  lock the password file with `flock` from util-linux, which Linux and WSL
  have.
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
- [ ] **P4. The lockout and the Neon API.** The freeze locks Neon with the
  database's `CONNECT` privilege, not role by role:
  - It records the database's ACL (`datacl`) in the password file.
  - It revokes `CONNECT` from `PUBLIC` and from every role that holds it, and
    grants it only to the dump role. A role that cannot connect cannot write,
    whatever its table privileges, so no writer has to be found. No role's
    password or `LOGIN` changes.
  - The database owner keeps `CONNECT`. When a consumer logs in as the owner,
    which is the Vercel–Neon default (`neondb_owner`), the freeze resets the
    owner's password through Neon's API and records the new one only in the
    password file. Neon owns that role, so its compute keeps the new password.
  - Rollback restores the recorded ACL entry by entry, and resets the
    read-only default. It changes no password: the owner's stays rotated, and
    the switch-back hands it to Vercel on stdin.

  The admin role, whose connection string is `CUTOVER_SOURCE_ADMIN_URL`, is the
  database owner from the Neon console. It must be able to end sessions
  (`pg_signal_backend`) and see them all (`pg_monitor`). A Neon console role
  has both through `neon_superuser`. A consumer that logs in as a superuser
  cannot be locked out by `CONNECT`. `inventory` calls that a no-go and the
  freeze refuses: stop, and give that consumer a role of its own before the
  window.

  The script calls four Neon endpoints. The key goes only in the
  `Authorization` header, and nothing prints it.
  - [Get endpoint](https://api-docs.neon.tech/reference/getprojectendpoint)
    (`GET /projects/{project_id}/endpoints/{endpoint_id}`), before any change.
    The endpoint is the first label of the admin URL's host (`ep-...`), and
    the answer's `endpoint.branch_id` must equal `NEON_BRANCH_ID`. That stops
    a stale branch ID, such as P5's, from changing another branch's roles.
  - [Create role](https://api-docs.neon.tech/reference/createprojectbranchrole)
    (`POST /projects/{project_id}/branches/{branch_id}/roles`, body
    `{"role":{"name":"neon_cutover_dump"}}`). It answers `201` with
    `role.password`, the password Neon generated, and the `operations` that
    apply it. `create-dump-role` records the password before it waits for
    them.
  - [Reset role password](https://api-docs.neon.tech/reference/resetprojectbranchrolepassword)
    (`POST /projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password`),
    for the owner, and for a dump role whose password the window's file does
    not hold.
  - [Get operation](https://api-docs.neon.tech/reference/getprojectoperation),
    polled until every operation a create or reset started has finished.
    Neon's [operations guide](https://neon.com/docs/manage/operations) lists
    `finished` and `skipped` as the successful terminal statuses, and
    `failed`, `error` and `cancelled` as the unsuccessful ones; the script
    stops on any of those, and waits two minutes at most.

  Every answer's `role.branch_id` must equal `NEON_BRANCH_ID` too.

  The dump role, `neon_cutover_dump`, is created in the window, as the first
  command of step 2, because its password goes into the window's password
  file. `create-dump-role` then grants it `pg_read_all_data`. If Neon refuses
  that grant (`42501`), the phase grants the role `USAGE` on each user schema
  and `SELECT` on every table and sequence instead, acting as each object's
  owner, and exits `2` naming anything it still cannot read. When the role
  exists already, the phase keeps it and grants again. When the window's file
  holds no working password for it, the phase resets the password through the
  API and records the new one.
- [ ] **P5. Dress rehearsal on a Neon branch.** This is a hard precondition:
  the window does not start until it passes. Create a branch of production in
  the Neon console. It is a disposable copy with the same roles and data.
  Take its direct connection strings and its branch ID. Do the shell setup
  below against the branch, with `NEON_BRANCH_ID` set to the branch's ID and
  `PASSWORDS` set to `$CUTOVER_DIR/p5-passwords.jsonl`. The API calls then
  change only the branch, and the endpoint check proves it. Run steps 1 to 6
  against the branch, `create-dump-role` and verify included, with a local
  `postgres:17` container as the target. Set the container up the way the
  rehearsal test does: the four roles, `exomem_control` owned by
  `substrate_owner`, and a `pgbouncer` schema owned by `postgres`.

  Then restart the branch's compute from the Neon console, and run the
  retention check (under "Retention until retirement" below) against the
  branch. It must print `FROZEN`. That proves the two things a restart could
  undo: the `CONNECT` lockout, and the owner's rotated password. Then run
  `rollback`, and delete the branch. Record:
  - the `dump`, `restore` and `verify` durations, and the archive size. The
    window's table below takes its dump, restore and verify times from these;
  - that `inventory` printed `GO`, with every consumer's credential logging
    in;
  - that `create-dump-role` exited `0`, and whether Neon took the
    `pg_read_all_data` grant;
  - that `freeze` exited `0` with every probe `OK`. That proves the owner can
    take `CONNECT` from `PUBLIC`, and end every other session, and that the
    API reset finished;
  - that `verify` printed `VERIFIED`;
  - that the retention check after the restart printed `FROZEN`. If it did
    not, stop and get a ruling before the window.

  Never reuse `p5-passwords.jsonl` in the window. It holds the branch's
  passwords, and the freeze refuses a file older than 24 hours anyway.
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
  from the record kept when it was generated. When Vercel's role is not the
  owner, the two Neon URLs are the switch-back values: the freeze never
  changes that role's password. When it is the owner, the freeze makes their
  password useless. The switch-back keeps the rest of the URL, and takes the
  password from the password file.
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
node -e 'for (const n of ["NEON_DATABASE_URL","NEON_DATABASE_MIGRATION_URL"]) if (process.env[n]) { const u=new URL(process.env[n]); console.log(n, u.username, u.hostname, u.pathname) }'
```

The last command prints the role each URL logs in as, without its password.
If `NEON_DATABASE_MIGRATION_URL` names another role, that role is a consumer
role too. Export one `CUTOVER_ROLE_URL_<ROLE>` per consumer role. Write the role name in upper case, with every other character as `_`.
For Vercel's role:

```bash
export CUTOVER_ROLE_URL_<ROLE>="$NEON_DATABASE_URL"
```

For an old-platform role that step 1 shows logging in to this database, take
its Secret and convert the SQLAlchemy URL form:

```bash
export CUTOVER_ROLE_URL_EXOMEM_PROVISIONER_RUNTIME="$(kubectl -n exomem-platform get secret exomem-provisioner-database -o jsonpath='{.data.url}' | base64 -d | sed -e 's#^postgresql+asyncpg://#postgresql://#' -e 's#ssl=require#sslmode=require#')"
```

Neon, using the direct endpoint with no `-pooler` in the host. The admin is
the database owner from the Neon console (P4). Keep the admin's pre-freeze URL
here even after the freeze. Once the freeze has rotated the owner's password,
every phase takes the new one from the password file. The dump role needs no
variable: `dump` and `verify` connect as it with the admin's host and the
password `create-dump-role` recorded. Paste the admin's direct connection
string, with `sslmode=verify-full`, at the prompt:

```bash
read -rsp 'Neon admin connection string: ' CUTOVER_SOURCE_ADMIN_URL && echo && export CUTOVER_SOURCE_ADMIN_URL
```

The Neon API calls read three variables. The project ID and the production
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

Set `ROLES` to the comma-separated roles the consumers log in as: Vercel's
role, plus every old-platform role that step 1 shows logging in to this
database. The lock does not depend on this list; the freeze uses it to prove
that each consumer is refused, and rollback to prove that each can write
again. Set `PASSWORDS` to this window's password file, named for the window's
date. Every later command, the daily check included, uses the same name:

```bash
export ROLES='<role>,<role>' PASSWORDS="$CUTOVER_DIR/neon-passwords-<window date>.jsonl"
```

The password file is the only copy of the dump role's password, of the
owner's rotated password, and of the database's ACL before the freeze.
`create-dump-role` and `freeze` open it before any Neon call: they create it
with mode `0600`, and refuse a missing directory, a symbolic link, or a file
with any other mode or owner. So a password Neon generates can always be
recorded. The script never prints the file, and only ever appends to it. Every
entry carries the time it was written. A role's newest entry is its password,
and the older ones stay as its history. A line that is not a valid entry is
skipped, and the phase names its line number. `create-dump-role`, `freeze` and
`rollback` hold an exclusive lock on the file while they run, so two of them
never overlap.

Each window starts a fresh password file. The freeze refuses a file whose
first entry is more than 24 hours old, or whose first line is not a valid
entry and so cannot be dated, before it changes anything: its passwords
belong to another branch, or to an earlier window. Keep the file in
`$CUTOVER_DIR` until retirement, and never edit it. Rollback, the switch-back
and the daily check all read it.

## The window

| Step | Typical duration | Go/no-go before the next step |
|---|---|---|
| 0. Stop the old platform | 5 min | `kubectl get` shows 0 replicas, and every CronJob suspended with no running Job |
| 1. Inventory | 1 min | `GO`, exit 0: every consumer's credential logs in, none is a superuser, and every role with sessions is a consumer in `ROLES` or the admin |
| 2. Create the dump role, then freeze | 1 min | `create-dump-role` exit 0, then `FROZEN`, exit 0 |
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
`0` only when every login succeeds and no consumer is a superuser. A
credential that does not log in is a no-go: it is not the one the consumer
holds, so the freeze could not prove it refused. Find the credential the
consumer really holds. A superuser consumer is a stop: `CONNECT` cannot lock
it out (P4).

Read these sections of the output:

- **Server version.** The major must be at most 17, and no newer than your
  pg_dump.
- **Database ACL.** The entries the freeze records and rollback restores.
- **Schemas.** Every schema listed travels. `exomem_provisioner`, if present,
  is the old provisioner's, and its role must be in `ROLES`.
- **Extensions.** Only trusted ones may appear, normally `citext`, `pgcrypto`
  and `plpgsql`.
- **Restore blockers.** This must read `none`.
- **Login roles.** The owner, the consumers and this session are tagged.
- **Client sessions.** No role may show sessions unless it is a consumer in
  `ROLES` or the admin. A session of any other role is a consumer you have
  not found: add its role to `ROLES`, or stop it.

No-go on any surprise. Stop, find the consumer, and restart the window later.

### 2. Freeze Neon

First create the dump role (P4). Its password goes into `$PASSWORDS`:

```bash
npm run cutover:neon -- create-dump-role --password-file="$PASSWORDS" --confirm-production
```

It must exit `0`. Then freeze:

```bash
npm run cutover:neon -- freeze --app-roles="$ROLES" --password-file="$PASSWORDS" --confirm-production
```

Before it changes anything, the freeze checks, and refuses on any failure:

- it opens `$PASSWORDS`, checks it and locks it, before any Neon call. The
  file's first entry must be less than 24 hours old, and it must hold the
  dump role's password;
- the admin URL's endpoint serves `NEON_BRANCH_ID` (P4);
- the admin owns the database, can end sessions, and can see them all; the
  dump role exists; no consumer is a superuser; and no login role inherits
  the owner's or the dump role's privileges, since it would keep their
  `CONNECT`;
- each consumer's `CUTOVER_ROLE_URL_<ROLE>` logs in now, or is refused with
  `42501`, which Postgres returns only after accepting the password, so an
  earlier freeze of this window took its `CONNECT`. When the owner is a
  consumer and an earlier freeze of this window rotated it, its newest
  recorded password logs in instead, and it is not reset again.

It then locks Neon:

- It records the database's ACL in `$PASSWORDS`. Once that record exists, a
  rerun never records again, even if it finds `CONNECT` granted again and
  revokes it: the first record is the ACL rollback must restore. Only a
  completed rollback lets a later freeze in the same file record afresh.
- When a consumer logs in as the owner, it resets the owner's password
  through the Neon API, and appends the new password to `$PASSWORDS` as soon
  as Neon returns it. It waits until Neon reports every resulting operation
  finished. If the admin is the owner, it then reconnects with the new
  password.
- In one transaction, it revokes `CONNECT` from `PUBLIC` and from every role
  that holds it, except the owner, and grants it to the dump role.
- It sets `default_transaction_read_only = on` for the database. A session
  that connects from now on starts read-only.
- It then terminates every other client session of the database, whatever
  its role, the admin's own and the dump role's included. Only a superuser's
  session is left, because only a superuser may end it; on Neon those are its
  control plane's. The dump role's session starts in step 3, after the
  freeze, so never run a freeze while a dump runs.

The script then proves the lock:

- A write from a new admin session is refused with `25006`.
- No other non-superuser client session of the database remains, and no
  login role but the owner, the dump role and the admin can connect.
- Every consumer is refused at login: the owner's pre-freeze password with
  `28P01`, while its recorded one logs in, and every other consumer with
  `42501`.
- The dump role connects.

It then prints `FROZEN` and exits `0`.

If it prints `FREEZE NOT PROVEN` and exits `2`, or refuses, or a Neon API call
fails, do not dump. Fix the named failure, then:

- **A refusal, a stale credential, or a failed API reset**: rerun the same
  command. A rerun is safe at any point. A reset whose Neon operation failed
  is reset again, because its recorded password does not log in while the
  pre-freeze one still does. The newest entry in `$PASSWORDS` is the one that
  counts.
- **A reset's response was lost or timed out**: Neon may hold an owner
  password nobody recorded, and the rerun refuses with a message naming the
  Neon console. Reset the owner's password in the Neon console, which shows
  the new connection string once. Read it into `CUTOVER_SOURCE_ADMIN_URL` and
  into the owner's `CUTOVER_ROLE_URL_<ROLE>`, each with `read -rsp` as in the
  shell setup. Then rerun freeze: it resets the password once more through
  the API and records that one.

If you cannot fix it, run `rollback` and end the window. Nothing has been
lost.

### 3. Dump

```bash
npm run cutover:neon -- dump --archive="$CUTOVER_DIR/neon.dump" --password-file="$PASSWORDS"
```

The dump runs as `neon_cutover_dump`, with its recorded password and
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
npm run cutover:neon -- verify --password-file="$PASSWORDS"
```

Verify reads Neon as the dump role. It runs one read-only, repeatable-read
snapshot on each side. Both
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
npm run cutover:neon -- rollback --app-roles="$ROLES" --password-file="$PASSWORDS" --confirm-production
```

It locks `$PASSWORDS` like the freeze. Then it restores the database's ACL
from the record the freeze made, entry by entry. It grants back each entry
the freeze revoked, and revokes each entry the record lacks, such as the dump
role's `CONNECT`. It prints `OK` or `FAIL` for each. It then resets the
database's read-only default, and checks that the ACL now equals the record
entry for entry. A database whose recorded ACL was the default (`NULL`)
comes back with the same entries written out, which Postgres treats
identically. When the ACL matches, rollback notes that in `$PASSWORDS`, so a
later freeze with the same file records the ACL afresh. If a role named in
the record has been dropped since, rollback refuses before changing
anything, and you restore that entry by hand.

Rollback sets no password. The owner's password stays rotated, because
Neon's API resets a password to a new random one and cannot set the old one
back. Every other consumer's password never changed. So a stale
`CUTOVER_ROLE_URL_<ROLE>` cannot break a consumer: it only fails that
consumer's proof.

The phase then proves each consumer on its own. The owner must log in with
its rotated password, and every other consumer with its
`CUTOVER_ROLE_URL_<ROLE>`, each to a read-write session. No consumer's table
privileges changed, so a read-write session is the proof that it can write. It prints
`ROLLED BACK` and exits `0` when the ACL and every consumer passed. Otherwise
it exits `2` and names everything it could not prove. Fix each named item,
then rerun the same command; a rerun is safe. It never calls the Neon API.

When Vercel logs in as the owner, it still holds the dead pre-freeze password,
even before the switch. Give Vercel the rotated one, then redeploy the
production deployment recorded in P6. `switch-back-url` writes the Neon URL
with the rotated password to the pipe. Nothing reaches the screen, and it
refuses to write to a terminal:

```bash
vercel env rm DATABASE_URL production --yes
```
```bash
node --import tsx scripts/neon-cutover.ts switch-back-url --role=<owner> --password-file="$PASSWORDS" | vercel env add DATABASE_URL production --sensitive
```
```bash
vercel redeploy <production deployment URL recorded in P6> --target=production
```

It runs the script with `node`, not `npm run`, so no npm banner lands in the
variable. Do the same for `DATABASE_MIGRATION_URL` if it existed and logs in as
the owner. If P3 left `DATABASE_URL` in one record with preview or
development, the `rm` removes their copy too (step 7).

A later window starts again from the shell setup, with a new `PASSWORDS` file.
The owner's consumer now holds its rotated password, so that is the owner's
pre-freeze credential for the new window. Take it from the old window's file.
A command substitution is a pipe, so nothing reaches the screen:

```bash
export CUTOVER_ROLE_URL_<OWNER>="$(node --import tsx scripts/neon-cutover.ts switch-back-url --role=<owner> --password-file="<the earlier window's file>")"
```

If the admin is the owner, set `CUTOVER_SOURCE_ADMIN_URL` to the same value.

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
   - `vercel env rm` and `vercel env add` for `DATABASE_URL`. When Vercel's
     role is not the owner, the new value is `$NEON_DATABASE_URL`. When it is
     the owner, use the `switch-back-url` pipeline above;
   - remove `DATABASE_MIGRATION_URL`, or restore it the same way if it
     existed;
   - `vercel redeploy <deployment recorded in P6> --target=production`, which
     builds that deployment again with the restored values.

   When Vercel's role is not the owner, `vercel rollback <deployment recorded
   in P6>` is faster. It serves traffic from Neon at once, because that
   deployment was built with a password that still works. After an instant
   rollback, Vercel stops promoting new production deployments automatically
   until you promote one. When Vercel logs in as the owner, that deployment
   holds a password Neon no longer accepts, so redeploy instead.
5. Replay from Paddle's notification log every notification delivered since
   the switch. Forward-port the other lost rows from the step 2 archive, table
   by table, by their `created_at` and `updated_at`. Tell affected users to
   sign in again, and to rerun backups made during that time.

## Retention until retirement

Neon stays as the rollback, locked out and read-only, until task 5.3 deletes
it after seven clean days on the new server.

- Once a day, run the check below, with `CUTOVER_SOURCE_ADMIN_URL`, each
  `CUTOVER_ROLE_URL_<ROLE>` and the window's `PASSWORDS` set as in the shell
  setup. It proves the lock exactly as the freeze does: a write from a new
  admin session gets `25006`, no other client session remains, no login role
  but the owner, the dump role and the admin can connect, every consumer is
  refused (`28P01` for the owner, `42501` for the others), and the dump role
  connects. A Neon compute restart must not have undone any of it.

  ```bash
  npm run cutover:neon -- inventory --app-roles="$ROLES" --password-file="$PASSWORDS" --expect-frozen
  ```

  If it fails, fix what it names. For a leftover session, close it. If the
  lock itself did not hold, a consumer could connect: P5 should have caught
  that, so stop and get a ruling. To lock Neon again, run `rollback` with the
  window's file, then `create-dump-role` and `freeze` with a new file, back to
  back, as a later window does (Rollback, above). Neither touches the new
  database.
- Keep `neon.dump`, `neon.dump.sha256` and the window's password file
  in the encrypted `$CUTOVER_DIR`, and the `NEON_*` values in the password
  manager. They are the second rollback path, since the archive restores
  anywhere with steps 4 to 6.
- The old platform stays scaled to zero, with its CronJobs suspended.
- At retirement, delete the Neon project (task 5.3). Drop
  `neon_cutover_dump` with it. Destroy the archive, every password file
  and the `NEON_*` records, and revoke the Neon API key.
