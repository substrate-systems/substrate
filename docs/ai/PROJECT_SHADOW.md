# Project Shadow

Architectural truths about the Substrate repository.

## What This Repo Is

Substrate is a **Next.js landing page** for the Substrate Systems brand. It serves as the public-facing marketing and information site.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS v4
- **Animation:** Framer Motion
- **Deployment:** Vercel
- **Analytics:** Vercel Analytics + Speed Insights

## Build and Run

- **Development:** `npm run dev` (launches dev server with custom script)
- **Production build:** `npm run build`
- **Start production:** `npm run start`

## Project Structure

```
src/           # Application source
public/        # Static assets
scripts/       # Build and utility scripts
openspec/      # Behavioral specifications
docs/          # Documentation and governance
```

## Procedures

For operational procedures, see:
- [OPENSPEC_ENFORCEMENT.md](../runbooks/OPENSPEC_ENFORCEMENT.md) - Spec enforcement setup
