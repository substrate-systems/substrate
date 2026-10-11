## Why

Every Exomem tenant now runs on Exomem Cloud. Home's capture, recall, memory overview, file upload and verified export call routes that reach only the retired Hosted cells, so each of those controls fails for every tenant. Home is being redesigned; until that redesign ships, Home offers only what works.

## What Changes

- Home no longer shows capture, recall, the memory overview, file upload or self-serve export.
- Home keeps connecting an assistant, service status, billing, sign-out and product-scoped deletion.
- A tenant asks support for a portable export, as the privacy page already says.

## Capabilities

### Modified Capabilities

- `exomem-home`: the capture, recall, overview and transfer requirements are removed, and the account controls drop self-serve export.

## Impact

- `src/app/exomem/home/home-client.tsx` and `home-sections.ts`, with their tests.
- The Hosted routes these controls called stay in place until the Hosted code retirement removes them.
