---
name: substrate-invoice
description: Render a Substrate Systems OÜ client invoice as a print-first A4 PDF. Triggers when the user wants to invoice a client, produce the next monthly invoice, add an hours annex, or change invoice wording. Not for expense claims, quotes, or Fourthwall/consumer receipts.
---

# Substrate invoice

One template, edited monthly. **All content lives in the `INVOICE` object at the top of
`Invoice.dc.html`. Layout is never edited.** Full procedure in `INVOICING.md`.

## Files

| File | Role |
|---|---|
| `Invoice.dc.html` | Source of truth. Edit the `INVOICE` object; everything else is fixed. |
| `invoice.html` | Standalone single-file build (440 KB, offline, no deps). What gets committed and opened to print. |
| `INVOICING.md` | Procedure, locked formatting conventions, payment routes. |
| `assets/substrate-logo-black.png` | Wordmark source (already inlined as a data URI in the template). |

## Procedure

1. Set `number` by hand: `YYYY-NNN`, zero-padded to three, sequential within the calendar
   year, resetting each January. Never reused, never regressed, never derived from a date
   or counter. Set `payment.reference` to the same string.
2. Set `issued`, `due` (issued + terms), `period.from`/`to` — ISO `YYYY-MM-DD`.
3. Set `payment.route`: `"domestic"` (LHV) or `"international"` (Wise EUR). See the
   constraint below.
4. Fill the `buyer` block. If the client has no VAT number write `"—"` — don't leave the
   token.
5. Rewrite `items`: `qty` × `rate` with a free-text `unit` (`hours`, `engagement`,
   `item`, `days`, `licence`). `amount` is derived. `detail` is optional.
6. `annex` only when the client needs supporting evidence (hours breakdown, milestone
   ledger, expense list). Omit the key and page 2 plus the "Page 1 of 2" footer disappear.
   Never add an annex to look thorough.
7. Rebuild `invoice.html` from `Invoice.dc.html` (single-file bundle).
8. Print: A4, scale 100%, **background graphics on** — hairlines and placeholder blocks
   need it. Margins come from `@page` (20mm); use the browser's default margin setting.
9. Save as `YYYY-NNN-client-slug.pdf`.

## Hard constraints

1. **Never invent legal or banking data.** Unknown values stay `[[token]]` and render as
   inverted black blocks with a "Not ready to send" banner counting them. Zero blocks =
   sendable. Never fill a token with a plausible guess.
2. **The VAT line is frozen literal text in the template**, not a data field:
   *"Not registered for VAT. No VAT is charged on this invoice."* Change it only on written
   sign-off from an accountant. Do not add a threshold reference (discloses turnover to the
   client) or an Article 44 / reverse-charge sentence (asserts a tax obligation on the
   client that does not exist — Estonian tax is handled here).
3. **Numbering is human-managed.** Never auto-generate.
4. **PAYMENT_ROUTES:** default `"domestic"` (LHV business account, beneficiary Substrate
   Systems OÜ — verified against the LHV business portal 2026-08-03). `"international"`
   is the Wise business account, also the OÜ's. Both are valid; pick per client for the
   payer's convenience. The beneficiary named on an invoice must always be the legal
   entity that owns the receiving account — never a personally-held account, and never an
   account labelled with a name it is not registered under.

## Locked formatting

- **Dates:** ISO `YYYY-MM-DD` in data and filenames; rendered `03 Aug 2026`. Never numeric
  slashes. ISO dates inside `detail` text are rewritten by the renderer — keep writing ISO.
- **Money:** dot decimal, always 2dp including whole amounts, thousands and the gap after
  the currency symbol are narrow no-break spaces (U+202F) so figures never wrap, negatives
  use a real minus (U+2212) never parentheses.
- **Hours/quantities:** 2dp, never 1 — the time ledger reports to two and the annex must
  reconcile with the line item.
- `font-variant-numeric: tabular-nums` on every figure; all amounts right-aligned.

## Design contract — the print surface

Substrate is specified dark-mode only; that covers screens, not paper. This is the
umbrella's **print surface**: warm-black ink (`#1c1917`) on white, Inter 300, sentence
case, 0.2em uppercase eyebrow labels, architectural whitespace and hairline rules doing
the work atmosphere does on screen.

Umbrella level means **no chroma** — Endstate's teal→green and copper, Exomem's amber are
sibling-scoped and never appear. No aurora plate: decoration behind a legally binding
figure is what the philosophy rejects. The sheet is white in every theme; only the screen
chrome around it is dark, like a print preview.

**Never:** coloured header band, rounded cards, accent stripe, centred layout, serif
display face, logo tinted or rotated. These are what form-generator invoices look like.
