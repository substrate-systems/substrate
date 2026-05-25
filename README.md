# Substrate

Public homepage for Substrate — a foundational systems company.

## Development

```bash
npm install
npm run dev
```

### Windows Development

On Windows, `npm run dev` automatically handles stale lock files and process cleanup. The dev server will:

- Detect and kill any existing Next.js dev processes for this repo
- Remove stale `.next/dev/lock` files
- Start cleanly on port 3000 every time

This prevents "unable to acquire lock" errors and port hopping after crashes or forced terminal closes.

## Build

```bash
npm run build
npm start
```

## Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4

This single codebase serves the marketing site, the blog, the Hosted Backup API, and the account surface. There is no separate backend service.

## Content discipline

Public copy on this site must match the canonical product facts. The source of truth for product positioning lives in the Knowledge Base under `Identity/` (notably `Identity/Tech Stack.md` and `Identity/Products.md`). Check those before adding or editing any product description.

### Endstate

- **Scope.** Endstate is a **Windows** machine setup and restore tool today. The Go engine is structured for cross-platform use, and macOS/Linux support is coming via Nix. Never write "cross-platform machine provisioning" as an unqualified headline; if cross-platform is mentioned, qualify it as forward work.
- **Stack.** Go end-to-end engine (CLI). The desktop GUI is **shipped** — Tauri shell in Rust + TypeScript with shadcn/ui (`github.com/Artexis10/endstate-gui`). Don't describe the GUI as planned or coming.
- **Hosted Backup.** The Hosted Backup API is part of this Next.js codebase — see the "Hosted Backup" section below. There is no separate "Substrate backend" service and no Elixir backend anywhere. If copy implies a separate service, fix it.
- **Roadmap framing.** The cross-platform path is Nix via the Go engine, not "additional platform drivers" or "winget/apt/brew expansion". `winget` is the current Windows install mechanism, not a roadmap item.

### Q

- When a count is needed, write "around 500 testers" — without "active". Don't write "active testers" or "active users". `useq.ai` is not controlled from this repo; if it states something different, surface the conflict rather than silently editing it from here.

### Hugo's personal stack

If the site references languages he writes day-to-day, the defendable list is **Elixir, PHP, Python, TypeScript**. Go, Rust, and PowerShell appear in product context (Endstate engine, GUI shell, etc.) and may be described that way, but should not be claimed as personal language depth.

## SEO / link previews

Every page emits Open Graph and Twitter Card meta tags so previews render on LinkedIn, X, Slack, Discord, and iMessage.

**Where the tags come from**

- Site-wide defaults: `src/app/layout.tsx` exports a `metadata` object with `metadataBase`, a title template (`%s · Substrate`), `openGraph`, and `twitter` defaults. Relative URLs (e.g. `/api/og`) are resolved against `metadataBase` at render time.
- Per-route overrides: a route segment can export `metadata` from `layout.tsx` (e.g. `src/app/work/layout.tsx`) or `generateMetadata` from `page.tsx`. The closest definition wins.
- Per-post: `src/app/blog/[slug]/page.tsx` pulls `title` / `description` / `published` from the post frontmatter and passes the title into the OG image URL.

**Dynamic OG images**

`src/app/api/og/route.tsx` renders a 1200×630 PNG with `next/og` (Satori). It reads a `?title=...` query param; missing or empty title falls back to the site default.

Example URLs:

- `https://substratesystems.io/api/og` — default
- `https://substratesystems.io/api/og?title=Proof%20of%20work` — per-page

**Adding metadata to a new page**

For a static page, export `metadata` from the route's `page.tsx` (or `layout.tsx` if you also want the children to inherit). Set at minimum a `title` and `description`; add `openGraph.images` and `twitter.images` pointing to `/api/og?title=<urlencoded title>` so the link preview renders the right card:

```ts
import type { Metadata } from "next";

const TITLE = "Example";
const DESCRIPTION = "One-line summary.";
const OG_IMAGE = `/api/og?title=${encodeURIComponent(TITLE)}`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: `${TITLE} · Substrate`,
    description: DESCRIPTION,
    url: "/example",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: TITLE }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
};
```

For a new blog post, do nothing extra — drop a `.md` file in `content/blog/` with `title` / `description` / `published` frontmatter and the OG image is generated automatically.

**Verifying previews post-deploy**

- LinkedIn Post Inspector: <https://www.linkedin.com/post-inspector/> — paste the URL; LinkedIn caches aggressively, so use this to force a re-scrape after any metadata change.
- X / Twitter Card Validator: <https://cards-dev.twitter.com/validator>
- Slack: paste the link into any channel; if the preview is stale, edit the message and re-paste, or use `/remind` to unfurl.
- Quick local check:

  ```bash
  npm run build && npx next start
  curl -s http://localhost:3000/blog/<slug> | grep -E 'og:|twitter:'
  open http://localhost:3000/api/og?title=Test+Title
  ```

## Hosted Backup

The substrate also serves as the auth issuer + metadata store + presigned-URL minter for **Endstate Hosted Backup v2**. Protocol locked in [`hosted-backup-contract.md`](./hosted-backup-contract.md) (OIDC discovery, EdDSA JWTs, Argon2id-derived `serverPassword + masterKey` split, R2 storage with 5-version retention).

**Migrations.**

```bash
npm run migrate         # apply pending migrations from migrations/*.sql
npm run migrate:dry     # list pending migrations without applying
```

The runner auto-creates a `schema_migrations` tracking table on first invocation.

**JWT signing key.** Generate the active EdDSA keypair (and optionally insert the public-key row into `signing_keys`):

```bash
tsx scripts/generate-jwt-keypair.ts            # print env vars only
tsx scripts/generate-jwt-keypair.ts --commit   # also INSERT the public key row
```

Then set `ENDSTATE_JWT_PRIVATE_KEY_HEX` and `ENDSTATE_JWT_ACTIVE_KID` in your environment.

**Env vars (Hosted Backup-specific).**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `ENDSTATE_OIDC_ISSUER_URL` | OIDC issuer URL (`iss` claim, JWKS URL prefix). Defaults to `https://substratesystems.io`. |
| `ENDSTATE_JWT_PRIVATE_KEY_HEX` | 32-byte seed (hex) for the active JWT signing key |
| `ENDSTATE_JWT_ACTIVE_KID` | `kid` for the active signing key (matches a row in `signing_keys`) |

**R2 (object storage).** Hosted Backup uses Cloudflare R2 for encrypted blob storage. Create a bucket; mint an R2 token scoped to that bucket; set:

| Variable | Purpose |
|---|---|
| `ENDSTATE_R2_ACCESS_KEY_ID` | R2 token's access key |
| `ENDSTATE_R2_SECRET_ACCESS_KEY` | R2 token's secret |
| `ENDSTATE_R2_BUCKET` | Bucket name (e.g. `endstate-backups`) |
| `ENDSTATE_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `HOSTED_BACKUP_QUOTA_BYTES` | Optional override of the 1 GiB per-user quota |

The server only mints presigned PUT/GET URLs (5-minute TTL); chunks transit directly between client and R2.

**Paddle webhook.** Hosted Backup adds a second webhook receiver at `/api/webhooks/paddle` for subscription events. It reuses the existing `PADDLE_WEBHOOK_SECRET` and `PADDLE_API_KEY`. Configure Paddle to deliver subscription events to this URL in addition to the existing license webhook.

See the configured env vars in your hosting environment for the full list.
