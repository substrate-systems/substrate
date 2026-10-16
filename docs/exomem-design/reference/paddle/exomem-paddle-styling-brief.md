# Paddle checkout styling: brief for the agent

Round 42 of the Exomem design. This brief is for the agent (Codex, Claude Code or another) that drives Paddle's dashboard in the operator's browser, and for the code that opens the checkout. The design source is the canvas board **R42-Inputs-Focus** (proposal; the operator said yes to the look on 2026-10-13) and **R42-Checkout-States**.

## Ground rules

- the operator signs in to Paddle himself. Never type or read credentials.
- Change only **Checkout › Checkout configuration › Styling** (and nothing in Catalog, Payouts, Taxes, Customers, Notifications or Developer tools).
- Set **both modes**: the Styling page has a Light / Dark switch at the top. Every value below has a light and a dark version.
- Leave **Brand colour (overlay)** alone. It applies to the overlay checkout only; we use inline.
- Take a screenshot of each mode's preview before changing anything and after. Save both sets with the handoff.
- Use the **One page** preview tab, since that is the variant we use.
- If a value below has no matching option in the dashboard, skip it and list it in your report. Don't approximate with a different element.
- Save once both modes match the board. Then reload the page and check the values stuck.

## Values

Colours are exact. "Ink" is our text colour. Amber means focus only.

| Paddle option (as grouped in the dashboard) | Dark mode | Light mode |
|---|---|---|
| General · Font | A system font (pick the plain system UI font; Inter isn't offered) | same |
| General · Checkout padding | No (our panel gives the padding) | same |
| General · Focus state, border colour | `#FFB000` | `#A86E00` |
| General · Focus state, shadow colour | `rgba(255,176,0,0.20)`, about 3 px spread if a size is offered | `rgba(255,176,0,0.30)` |
| Background (if offered) | transparent; if not, `#12100E` | transparent; if not, `#FFFFFF` |
| Text · labels | `#A39E93`, 13 px | `#6B665C`, 13 px |
| Text · input text | `#ECE9E2`, 15 px | `#1A1814`, 15 px |
| Text · placeholder (if offered) | `#858075` | `#757068` |
| Inputs · background (if offered) | `#0C0A09` | `#FAF8F4` |
| Borders · colour | `rgba(236,233,226,0.14)` | `rgba(26,24,20,0.14)` |
| Borders · colour on hover (if offered) | `rgba(236,233,226,0.34)` | `rgba(26,24,20,0.34)` |
| Borders · width | 1 px | 1 px |
| Borders · roundness | 8 px | 8 px |
| Messages · roundness | 8 px | 8 px |
| Inputs · label position | Top (Paddle always puts labels top-left on phones) | same |
| Checkboxes | ink border; checked fill `#FFB000` if a checked colour is offered | checked `#A86E00` |
| Buttons · fill (if offered) | `#ECE9E2` | `#1A1814` |
| Buttons · text | `#0A0908` | `#FFFFFF` |
| Buttons · roundness | 8 px | 8 px |
| Buttons · hover | fill a little dimmer (90%) | fill `#2A2724` |
| Buttons · focus | same as the focus state above | same |
| Links · colour | `#A39E93`, underlined | `#6B665C`, underlined |
| Links · hover and focus | `#ECE9E2` | `#1A1814` |

Why these: they are the same values our own fields use, so the fields inside Paddle's frame read as part of the Exomem page. Every text colour passes 4.5:1 and the focus border passes 3:1 in both modes (numbers on the board).

## Opening the checkout (for the code, not the dashboard)

- `displayMode: 'inline'`, `variant: 'one-page'`, `frameTarget` our frame element, `frameInitialHeight: 450`.
- `frameStyle`: `width: 100%; min-width: 312px; background-color: transparent; border: none;`
- `theme`: the site's current theme. The site follows the device's colour scheme until the person picks one, and dark applies when the device says nothing. Re-open the checkout if they switch.
- Prefill the customer email from the Exomem account.
- `showAddDiscounts: false`. No discount codes. The friend price comes from the invitation.
- `showAddTaxId: true`, so an EU business can add its VAT number (reverse charge).
- Prices: base price in EUR with country price overrides for USD and GBP at round amounts (the operator to confirm the amounts; the board uses €15 / $15 / £13 and the friend price €10 / $10 / £9 as samples). Leave automatic currency conversion on for the rest.

## Paddle events → our states

| Event | Our state |
|---|---|
| frame opened, no `checkout.loaded` yet | Loading (blanks held at their final width) |
| `checkout.loaded` | Ready (all numbers from the event) |
| `checkout.updated` | Ready, numbers redraw in place |
| `checkout.payment.initiated` | Paying; after 8 s with no answer, Slow bank |
| `checkout.payment.failed` | Payment failed (Paddle explains inside its frame) |
| `checkout.completed` | Paid, setting up, until our server says the subscription is active; then Paid. After 30 s, the "still setting up, we'll email you" version |
| `checkout.error`, or no `checkout.loaded` after 15 s | Paddle didn't load, with Try again |

## Report back

- Screenshots of both modes, before and after.
- Any option from the table that didn't exist, and what you did instead (nothing).
- Anything Paddle shows that the board doesn't (new fields, text, a marketing checkbox setting).
