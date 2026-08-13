## Why

Everything downstream of checkout is built and drilled — provisioning, lifecycle, export, deletion, billing portal. Nothing upstream of it is. A stranger cannot buy Exomem Hosted today, and every signup begins with the operator issuing an invite by hand.

Three specific walls:

- `/exomem` presents an invite-only private alpha with conditional pricing ("if paid access opens"). OpenAI's plugin guidelines reject trial/private-alpha listings outright, and both platforms' listings point at this page and `/exomem/setup`, so a reviewer on either finds no ordinary way in.
- The Paddle webhook rejects any event whose `custom_data` lacks internal `user_id` and `tenant_id` (`EXOMEM_PADDLE_CORRELATION_INVALID`). Payment can only ever *update* a tenant an operator already created; it cannot create one. Endstate solved the same problem with `ensurePreAccount(email)` behind a Paddle customer lookup, and Exomem has no equivalent.
- After paying, nothing tells the customer how to reach their memory from Claude or ChatGPT. `/exomem/home` contains no MCP or connector reference at all, the only Exomem emails are bare single-CTA links, and there is no post-checkout page.

## The ordering constraint

Hosted cell capacity is bound by volume attachments per server, not memory: `provider_volume_attachment_limit` (16) minus `minimum_unused_provider_headroom` (10) yields 6 attachments, spent as 4 user cells and 2 recovery cells. Auto-provisioning creates cells on an existing server; it does not create servers.

So admission MUST be decided before money changes hands. A flow that takes payment and then discovers there is no attachment left produces a refund, an apology, and a support burden — precisely the onboarding pain self-serve exists to remove. The capacity gate is not step four of this change; it is the precondition for enabling checkout at all.

## What Changes

- Decide admission before checkout. A visitor is admitted, or waitlisted with an honest position, before a payment surface is offered. Capacity exhaustion is a queue, never an error after payment.
- Correlate an anonymous purchase to a new tenant. Resolve the buyer's email from the Paddle customer record and create the user and tenant, mirroring Endstate's resolver, so a first subscription event no longer requires pre-existing internal identifiers. Transient lookup failures must escape and let Paddle retry rather than collapse into a successful no-op.
- Sell the product publicly. Replace the interest form and private-alpha framing with a real offer at a stated price, add a pricing page, list it in the sitemap, and correct the `price: "0"` JSON-LD.
- Carry the founder price honestly. €12/month is a founder rate intended to hold for roughly 6–12 months; existing subscriptions are grandfathered by Paddle when a later list price is added to the same product, and the public copy should say so rather than let the increase surprise anyone.
- Close the loop after payment. A post-checkout page and a welcome email that both carry the client install action, and an install surface in the account home, which today mentions neither MCP nor connectors.

## Capabilities

### New Capabilities

- `exomem-hosted-self-serve`: Public admission, capacity-gated waitlisting, anonymous purchase correlation, and post-purchase onboarding to a working client connection.

### Modified Capabilities

None. Provisioning, lifecycle, entitlement, export, deletion, and the billing portal are reused unchanged.

## Impact

- Affects the public `/exomem` route, a new pricing page, the Exomem Paddle webhook correlation path, the account home install surface, a post-checkout route, and the Exomem email templates.
- Requires the €12 price (`pri_01kzg6vetcjpkrqazm59s5a1hj`) wired via `EXOMEM_PADDLE_PRICE_ID`, alongside `EXOMEM_PADDLE_PRODUCT_ID`, before `paidCheckoutEnabled` can turn on.
- Depends on the capacity ceiling being known and raised deliberately. Opening self-serve against a six-attachment ceiling without a working waitlist is the one failure mode this change must not ship.
- The three Exomem cron jobs are excluded from `vercel.json` and run from an external scheduler. If that scheduler is down, provisioning silently never advances — self-serve makes that failure customer-visible for the first time, so it needs a health signal.
