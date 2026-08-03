# Producing the next invoice

`Invoice.dc.html` is the template. All content lives in the `INVOICE` object at the
top of its script; layout is never edited.

1. Copy the file (`Invoice-2026-002.dc.html`) or edit in place if you keep PDFs, not sources.
2. Set `number` by hand — sequential, human-managed. Never derive it from a date or counter.
   Set `payment.reference` to the same string.
3. Set `issued`, `due` (issued + terms), `period.from/to`.
4. Set `payment.route`: `"domestic"` for Estonian clients (LHV) or `"international"`
   (Wise EUR) for everyone else. The coordinates themselves live in `PAYMENT_ROUTES`
   and are not per-invoice fields.
5. Replace the `buyer` block. If the client has no VAT number, write `"—"` — don't leave the token.
6. Rewrite `items`. The model is general: `qty` × `rate` with a free-text `unit`
   (`hours`, `engagement`, `item`, `days`, `licence`). `amount` is derived; `detail` is optional.
7. `annex` is optional — delete the key or empty `rows` and page 2 disappears, including
   the "Page 1 of 2" footer.
8. Any `[[token]]` still present renders as an inverted black block and a
   "Not ready to send" banner counts them. Zero blocks = sendable.
9. Print to PDF: A4, margins handled by `@page` (20mm) — use the browser's default margins
   setting, scale 100%, background graphics **on** (hairlines and placeholder blocks need it).

## Formatting conventions (locked)

**Dates.** ISO `YYYY-MM-DD` in the data object and in filenames — sortable, unambiguous.
Rendered as `03 Aug 2026`. Never numeric slashes. This also applies to ISO dates written
inside line-item `detail` text: the renderer rewrites them, so keep writing ISO in data.

**Numbers.** Dot decimal. Thousands grouped with a narrow no-break space (U+202F), as is
the gap after the currency symbol, so a figure can never wrap. Money always two decimals,
including whole amounts. Negatives use a real minus sign (U+2212), never parentheses.

**Hours and quantities.** Two decimals, never one — the time ledger reports to two, and at
one decimal the annex stops reconciling with the line item.

**Invoice numbers.** `YYYY-NNN`, zero-padded to three, sequential within the calendar
year, resetting each January (`2027-001`). Never reused, never regressed, never derived.

**Annex.** Optional. Include it only when there is supporting evidence the client needs —
an hours breakdown, a milestone ledger, an expense list. Omit the `annex` key and page 2
plus the "Page 1 of 2" footer disappear. Never add an annex to look thorough.

## Page one must fit one page

The footer labels come from whether an annex exists, not from measuring the render, so
they assume page one fits. Enough line items will push it over and the footer will then
claim "Page 1 of 2" on a three-page document. After rendering, confirm the PDF has
exactly two pages (one without an annex). If it does not, shorten `detail` text or move
the breakdown into the annex until it does.

## What must never be invented

Buyer identity (legal name, address, company number, VAT number) and the billing email
stay `[[tokens]]` and are filled from records per invoice. Seller registry code, address
and both bank routes are now filled from the Estonian business register, Wise business
details and LHV's published bank coordinates.

## PAYMENT_ROUTES

Both routes are held by **Substrate Systems OÜ**, verified 2026-08-03:

- `"domestic"` — LHV business account, `EE93 7700 7710 1246 8228`. **The default.**
- `"international"` — Wise business account, `BE79 9674 8443 4433`.

Choose per client for the payer's convenience, not for correctness: a SEPA payer is
usually easiest on the LHV route, a non-SEPA payer on Wise. Either is a valid company
account.

The one rule that does not bend: the beneficiary named on an invoice must be the
legal entity that owns the receiving account. Never put a personally-held account on
a company invoice, and never label an account with a beneficiary name it is not
registered under — an accountant can refuse to pay it, and it blurs the separation
between you and the OÜ that having an OÜ exists to maintain.

## Design note — the print surface (umbrella extension)

Substrate is specified dark-mode only; that covers screens, not paper. This document
resolves it explicitly: the umbrella translated to a light ground — warm-black ink
(`#1c1917`) on white, Inter 300, sentence case, 0.2em uppercase eyebrow labels,
architectural whitespace and hairline rules doing the work that atmosphere does on
screen. No chroma: Endstate's teal→green/copper and Exomem's amber are sibling-scoped
and do not appear. No aurora plate — decoration behind an invoice is the thing the
philosophy rejects. The sheet is white in every theme; only the screen chrome around
it is dark, like a print preview.
