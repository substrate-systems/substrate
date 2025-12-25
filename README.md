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
