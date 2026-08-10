# Naming

Public names and the internal identifiers that deliberately do not match them.

## Current public names

| Thing                                                | Public name                | Never write                                |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------ |
| The Windows setup and restore product                | **Endstate**               | — (unchanged; the product was not renamed) |
| The managed encrypted backup service                 | **Endstate Cloud**         | "Hosted Backup"                            |
| Voluntary one-time contributions to the project      | **Support Endstate**       | "Supporter License"                        |
| Funding deeper migration support for one application | **Sponsor an integration** | —                                          |

Endstate Cloud was previously called Hosted Backup. Terms keeps a
"(previously Hosted Backup)" parenthetical on first use so existing customers
can reconcile the name against their receipts. That parenthetical is the only
place the old name belongs in ordinary public copy.

Support Endstate is not a licence. It creates no key, entitlement, feature
flag, or recurring obligation, and nothing in the product checks whether a user
has contributed. Copy that implies otherwise is a defect, not a rewording
opportunity.

## Deliberately retained internal identifiers

These were **not** renamed. Renaming any of them breaks compatibility with data,
configuration, or another repository that is already in the field. They are
internal surfaces, so the public name and the identifier are allowed to differ.

### Environment variables

| Variable                                            | Why it stays                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PADDLE_PRICE_ID_HOSTED_BACKUP`                     | Configured in the hosting environment; renaming silently unconfigures billing.                                                                                                  |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` | Same, and inlined into already-deployed client bundles.                                                                                                                         |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY`  | Same.                                                                                                                                                                           |
| `HOSTED_BACKUP_QUOTA_BYTES`                         | Operational override read by the storage layer.                                                                                                                                 |
| `HOSTED_BACKUP_TEST_EMAIL_PATTERN`                  | Test-bypass configuration.                                                                                                                                                      |
| `PADDLE_HOSTED_BACKUP_WEBHOOK_SECRET`               | Registered against a live Paddle webhook destination.                                                                                                                           |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER`    | The €89 price predates the Support Endstate framing. Every existing support record is attached to it, so it keeps its name even though the tier is now presented as **Patron**. |

### Directories, routes, and modules

| Identifier               | Why it stays                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `src/lib/hosted-backup/` | Module path referenced throughout the server; a rename is churn with no public effect.     |
| `/api/backups/*`         | Called by shipped Endstate clients. Changing the path breaks them.                         |
| `/api/license/webhook`   | Registered in Paddle. Kept stable for the same reason, despite no longer issuing licences. |

### TypeScript symbols

| Symbol                     | Where                       | Why it stays                                                    |
| -------------------------- | --------------------------- | --------------------------------------------------------------- |
| `HostedBackupCadence`      | `src/lib/paddle.ts`         | Names the same cadence union the storage and billing code uses. |
| `openHostedBackupCheckout` | `src/lib/paddle.ts`         | Pairs with the retained env vars above.                         |
| `"paddle-hosted-backup"`   | `src/app/endstate/page.tsx` | Pricing-tier CTA discriminant; internal only.                   |

### Cross-repo and data contracts

| Identifier                           | Why it stays                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostedBackup` capabilities JSON key | Wire contract with the Endstate engine. The engine and GUI gate features on this key; renaming it is a breaking change in another repository. |
| Database columns and enums           | Existing rows. A rename is a migration with no user-visible benefit, and migrations are owned elsewhere.                                      |

### Analytics identifiers

| Identifier                                       | Why it stays                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `hosted_backup`, `supporter` (`CheckoutProduct`) | Event property values already written to historical PostHog data. Renaming splits one funnel into two series. |
| `supporter_purchased` (`ServerEvent`)            | Same.                                                                                                         |

### In-app section label

The current desktop app labels the section **Endstate Cloud**. Claim instructions
use that name, followed by "shown as Hosted Backup in older versions", so buyers
running an older desktop release can still find the correct section without
reintroducing the retired name as the current service name.

The compatibility wording lives in:

- `src/lib/email-templates/claim.ts` — the fallback instruction in both the HTML
  and plaintext bodies (pinned by `src/lib/email-templates/__tests__/claim.test.ts`)
- `src/app/endstate/claim/[token]/page.tsx` — the "02 — FALLBACK" step card

### Historical blog prose

`content/blog/we-cannot-decrypt-your-data.md` keeps the old name in its body. It
is a dated first-person account of designing the service, and it quotes the
architectural commitment as it was written at the time:

> Endstate cannot decrypt user data uploaded to Hosted Backup. This is a
> structural property, not a policy.

Rewriting a quoted commitment to match a later name falsifies the record. The
essay therefore keeps its period language, with one bridging clause where the
service is first introduced so a reader arriving today can connect the two
names, and a name-neutral frontmatter description for the link preview.

The other blog posts were updated, because their occurrences are present-tense
instructions and FAQ answers — a reader following them today would look for a
service under a name that no longer exists. Historical narrative stays;
present-tense instructions do not.

## Rule of thumb

Rename what a user reads. Keep what a machine reads.
