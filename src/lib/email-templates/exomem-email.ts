/**
 * The one Exomem email template (design README §3.4; boards R28-Emails and
 * R12-Lifecycle). Every Exomem email is these ten slots with different words:
 *
 *  1. sender and subject   2. preheader   3. state band   4. wordmark
 *  5. headline   6. body   7. a note or facts   8. one action
 *  9. small print   10. footer
 *
 * The HTML is 600 px wide on solid dark grounds with color-scheme dark, so a
 * client that forces light mode still reads it, and it carries a light
 * version in a prefers-color-scheme block (Apple Mail, iOS Mail, Outlook for
 * Mac). Layout is tables with inline styles, because Gmail and Outlook ignore
 * flex and most of <style>. The band and the wordmark are PNGs, because Gmail
 * strips SVG. Every email has a plain-text part with the same words.
 *
 * Colours are the Exomem tokens, read from the one tokens stylesheet
 * (src/lib/exomem/design-tokens.ts). Server only.
 */

import { exomemTokens, type ExomemTokenMap } from "@/lib/exomem/design-tokens";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

/** The account's state, as the web in slot 3 shows it (R28 "The band follows the account"). */
export type ExomemEmailBand = "arrive" | "live" | "readonly" | "kept" | "fading" | "gone";

export const EXOMEM_EMAIL_BANDS: readonly ExomemEmailBand[] = [
  "arrive",
  "live",
  "readonly",
  "kept",
  "fading",
  "gone",
];

export type ExomemEmailScheme = "dark" | "light";

/** Where the state bands and the wordmark are served, under the public base URL. */
export const EXOMEM_EMAIL_ASSET_PATH = "/exomem/email";

export function exomemEmailBandFile(band: ExomemEmailBand, scheme: ExomemEmailScheme): string {
  return `band-${band}-${scheme}.png`;
}

export function exomemEmailWordmarkFile(scheme: ExomemEmailScheme): string {
  return `wordmark-${scheme}.png`;
}

/** The wordmark's drawn size in CSS pixels: 16 px tall, the E-initial wordmark's aspect. */
export const EXOMEM_EMAIL_WORDMARK = { width: 79, height: 16 } as const;

export type ExomemEmailFact = {
  label: string;
  value: string;
  /** A replaced value shown struck through before the value (a usual price). */
  struck?: string;
};

export type ExomemEmailSlots = {
  /** Slot 1: "Exomem", or "<name> via Exomem" when a person sent it. */
  sentBy?: { personName: string } | null;
  /** Slot 1: 45 characters or fewer. */
  subject: string;
  /** Slot 2: the one fact that matters next. Empty leaves the client's own preview. */
  preheader: string;
  band: ExomemEmailBand;
  /** Slot 5: six words or fewer; names the state. */
  headline: string;
  /** Slot 6: one or two short paragraphs. */
  body: readonly string[];
  /** Slot 7: a person's own words with their name, or label/value rows. Never both. */
  detail?:
    | { kind: "note"; text: string; author: string }
    | { kind: "facts"; rows: readonly ExomemEmailFact[] }
    | null;
  /** Slot 8: one button, and at most one text link beside it. */
  action?: {
    label: string;
    url: string;
    link?: { label: string; url: string } | null;
  } | null;
  /** Slot 9: every time limit, and what happens if the reader ignores it. */
  smallPrint: string;
};

export type RenderedExomemEmail = {
  subject: string;
  htmlContent: string;
  textContent: string;
  /** The sender's display name for this email. */
  senderName: string;
};

const FOOTER = "Exomem by Substrate Systems";
const SENDER = "Exomem";

// The board's delivery note: web fonts often don't load in mail, so IBM Plex
// Mono falls back to Menlo or Consolas, and Inter to Helvetica or Arial.
const MONO = "'IBM Plex Mono', Menlo, Consolas, monospace";
const SANS = "Inter, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MAX_SENDER_NAME = 60;

/**
 * A person's name as a sender display name: "<name> via Exomem". Control and
 * format characters (line breaks, bidi overrides) and the characters that
 * delimit an address header are dropped, whitespace collapses, and the name
 * is cut to 60 characters. An empty result sends as "Exomem".
 */
export function exomemSenderName(personName: string | null | undefined): string {
  // A format check on one header field, not a reading of what the name means.
  const cleaned = (personName ?? "")
    .replace(/[\p{Cc}\p{Cf}"<>@,;:\\]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = [...cleaned].slice(0, MAX_SENDER_NAME).join("").trim();
  return name ? `${name} via ${SENDER}` : SENDER;
}

type TokenName = keyof ExomemTokenMap & `--${string}`;

/**
 * Each colour role in the template: the CSS property it sets and the token it
 * takes in each scheme. The light tokens follow the board's light cards
 * (R28 "Light inboxes"): small print and labels there are the light
 * --fg-secondary, where dark uses --fg-muted.
 */
const ROLES = {
  frame: { property: "background-color", dark: "--bg-frame", light: "--bg-frame" },
  card: { property: "background-color", dark: "--bg-base", light: "--bg-base" },
  cardBorder: { property: "border-color", dark: "--exo-border-card", light: "--exo-border-card" },
  primary: { property: "color", dark: "--fg-primary", light: "--fg-primary" },
  body: { property: "color", dark: "--fg-body", light: "--fg-body" },
  quiet: { property: "color", dark: "--fg-muted", light: "--fg-secondary" },
  noteRule: { property: "border-left-color", dark: "--exo-amber", light: "--exo-amber" },
  rowRule: { property: "border-bottom-color", dark: "--exo-rule", light: "--exo-rule" },
  footerRule: { property: "border-top-color", dark: "--exo-rule", light: "--exo-rule" },
  footer: { property: "color", dark: "--fg-footer", light: "--fg-footer" },
  buttonFill: { property: "background-color", dark: "--fg-primary", light: "--fg-primary" },
  buttonText: { property: "color", dark: "--bg-base", light: "--bg-base" },
} as const satisfies Record<
  string,
  { property: string; dark: TokenName; light: TokenName }
>;

type Role = keyof typeof ROLES;

function roleClass(role: Role): string {
  return `x-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

type Palette = { dark: ExomemTokenMap; light: ExomemTokenMap };

function token(tokens: ExomemTokenMap, name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`exomem email: no token ${name}`);
  return value;
}

/** class="…" plus the dark inline declarations for a set of roles. */
function paint(palette: Palette, roles: readonly Role[]): { cls: string; css: string } {
  return {
    cls: roles.map(roleClass).join(" "),
    css: roles
      .map((role) => `${ROLES[role].property}: ${token(palette.dark, ROLES[role].dark)};`)
      .join(" "),
  };
}

function lightRules(palette: Palette): string {
  const rules = (Object.keys(ROLES) as Role[]).map(
    (role) =>
      `.${roleClass(role)} { ${ROLES[role].property}: ${token(palette.light, ROLES[role].light)} !important; }`
  );
  rules.push(".x-img-dark { display: none !important; }");
  rules.push(
    ".x-img-light { display: block !important; max-height: none !important; overflow: visible !important; }"
  );
  return rules.join("\n    ");
}

/**
 * A dark image shown by default and its light twin, hidden until the light
 * block applies. Outlook for Windows never sees the twin.
 */
function schemeImages(
  assetBaseUrl: string,
  files: Record<ExomemEmailScheme, string>,
  attributes: { width: number; height: number; alt: string; style: string }
): string {
  const img = (scheme: ExomemEmailScheme) =>
    `<img src="${escapeHtml(`${assetBaseUrl}${EXOMEM_EMAIL_ASSET_PATH}/${files[scheme]}`)}" width="${attributes.width}" height="${attributes.height}" alt="${escapeHtml(attributes.alt)}" style="${attributes.style}">`;
  return (
    `<div class="x-img-dark">${img("dark")}</div>` +
    `<!--[if !mso]><!--><div class="x-img-light" style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">${img("light")}</div><!--<![endif]-->`
  );
}

function textPart(slots: ExomemEmailSlots): string {
  const blocks: string[] = [slots.headline, ...slots.body];
  const detail = slots.detail;
  if (detail?.kind === "note") blocks.push(`“${detail.text}”\n${detail.author}`);
  if (detail?.kind === "facts") {
    blocks.push(
      detail.rows
        .map((row) =>
          row.struck
            ? `${row.label}: ${row.value}, instead of ${row.struck}`
            : `${row.label}: ${row.value}`
        )
        .join("\n")
    );
  }
  if (slots.action) {
    const lines = [`${slots.action.label}: ${slots.action.url}`];
    if (slots.action.link) lines.push(`${slots.action.link.label}: ${slots.action.link.url}`);
    blocks.push(lines.join("\n"));
  }
  if (slots.smallPrint) blocks.push(slots.smallPrint);
  blocks.push(FOOTER);
  return blocks.join("\n\n");
}

// Enough invisible filler (combining grapheme joiner, zero-width non-joiner,
// no-break space) that a client's preview shows the preheader alone, not the
// start of the body after it.
const PREHEADER_FILLER = "\u034f\u200c\u00a0".repeat(60);

/**
 * Renders the ten slots as one HTML part and one plain-text part. The band
 * and the wordmark load from the configured public base URL.
 */
export function renderExomemEmail(slots: ExomemEmailSlots): RenderedExomemEmail {
  const palette = exomemTokens();
  const assetBaseUrl = exomemPublicBaseUrlFromEnv();
  const p = (...roles: Role[]) => paint(palette, roles);
  const schemeBlock = `@media (prefers-color-scheme: light) {\n    ${lightRules(palette)}\n  }`;

  const frame = p("frame");
  const card = p("card", "cardBorder", "primary");
  const headline = p("primary");
  const body = p("body");
  const quiet = p("quiet");

  const rows: string[] = [];
  const row = (content: string, style = "", cls = "") =>
    rows.push(
      `<tr><td${cls ? ` class="${cls}"` : ""} style="padding: 0 0 16px 0; ${style}">${content}</td></tr>`
    );

  row(
    schemeImages(
      assetBaseUrl,
      { dark: exomemEmailWordmarkFile("dark"), light: exomemEmailWordmarkFile("light") },
      {
        ...EXOMEM_EMAIL_WORDMARK,
        alt: "Exomem",
        style: `display: block; border: 0; width: ${EXOMEM_EMAIL_WORDMARK.width}px; height: ${EXOMEM_EMAIL_WORDMARK.height}px;`,
      }
    ),
    "line-height: 0; font-size: 0;"
  );
  row(
    escapeHtml(slots.headline),
    `font-family: ${MONO}; font-weight: 500; font-size: 24px; letter-spacing: -0.02em; line-height: 1.25; ${headline.css}`,
    headline.cls
  );
  for (const paragraph of slots.body) {
    row(
      escapeHtml(paragraph),
      `font-family: ${SANS}; font-size: 15px; line-height: 1.6; ${body.css}`,
      body.cls
    );
  }

  const detail = slots.detail;
  if (detail?.kind === "note") {
    const rule = p("noteRule");
    const text = p("primary");
    row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="${rule.cls}" style="border-left: 2px solid; ${rule.css} padding: 2px 0 2px 16px;">` +
        `<div class="${text.cls}" style="font-family: ${SANS}; font-size: 15px; line-height: 1.6; ${text.css}">“${escapeHtml(detail.text)}”</div>` +
        `<div class="${quiet.cls}" style="padding-top: 6px; font-family: ${MONO}; font-size: 12px; ${quiet.css}">${escapeHtml(detail.author)}</div>` +
        `</td></tr></table>`
    );
  }
  if (detail?.kind === "facts" && detail.rows.length > 0) {
    const box = p("cardBorder");
    const rule = p("rowRule");
    const value = p("primary");
    const factRows = detail.rows
      .map((fact, index) => {
        const last = index === detail.rows.length - 1;
        const divider = last ? "" : `border-bottom: 1px solid; ${rule.css}`;
        const struck = fact.struck
          ? `<span class="${quiet.cls}" style="${quiet.css} text-decoration: line-through; padding-right: 10px;">${escapeHtml(fact.struck)}</span>`
          : "";
        return (
          `<tr>` +
          `<td class="${quiet.cls}${last ? "" : ` ${rule.cls}`}" style="padding: 10px 16px 10px 0; font-family: ${MONO}; font-size: 13px; ${quiet.css} ${divider}" valign="top">${escapeHtml(fact.label)}</td>` +
          `<td class="${value.cls}${last ? "" : ` ${rule.cls}`}" style="padding: 10px 0; font-family: ${MONO}; font-size: 13px; text-align: right; ${value.css} ${divider}" align="right" valign="top">${struck}${escapeHtml(fact.value)}</td>` +
          `</tr>`
        );
      })
      .join("");
    row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="${box.cls}" style="border: 1px solid; ${box.css} border-collapse: separate; border-radius: ${token(palette.dark, "--r-card")};">` +
        `<tr><td style="padding: 4px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${factRows}</table></td></tr></table>`
    );
  }

  if (slots.action) {
    const fill = p("buttonFill");
    const label = p("buttonText");
    const link = p("primary");
    const radius = token(palette.dark, "--r-ctl");
    const textLink = slots.action.link
      ? `<td class="x-aside" style="padding-left: 18px;"><a class="${link.cls}" href="${escapeHtml(slots.action.link.url)}" style="font-family: ${MONO}; font-size: 13px; text-decoration: underline; ${link.css}">${escapeHtml(slots.action.link.label)}</a></td>`
      : "";
    row(
      `<table role="presentation" class="x-action" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td class="${fill.cls}" style="${fill.css} border-radius: ${radius}; mso-padding-alt: 13px 20px;">` +
        `<a class="${label.cls}" href="${escapeHtml(slots.action.url)}" style="display: inline-block; padding: 13px 20px; font-family: ${MONO}; font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; border-radius: ${radius}; ${label.css}">${escapeHtml(slots.action.label)}</a>` +
        `</td>${textLink}</tr></table>`,
      "padding-top: 6px;"
    );
  }

  if (slots.smallPrint) {
    row(
      escapeHtml(slots.smallPrint),
      `font-family: ${SANS}; font-size: 13px; line-height: 1.55; ${quiet.css}`,
      quiet.cls
    );
  }

  const footer = p("footer", "footerRule");
  rows.push(
    `<tr><td class="${footer.cls}" style="border-top: 1px solid; ${footer.css} padding-top: 14px; font-family: ${MONO}; font-size: 11.5px;">${FOOTER}</td></tr>`
  );

  const cardRadius = token(palette.dark, "--r-pop");
  const band = schemeImages(
    assetBaseUrl,
    { dark: exomemEmailBandFile(slots.band, "dark"), light: exomemEmailBandFile(slots.band, "light") },
    {
      width: 600,
      height: 120,
      alt: "",
      style: "display: block; border: 0; width: 100%; max-width: 600px; height: auto;",
    }
  );

  const htmlContent = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <title>${escapeHtml(slots.subject)}</title>
  <style>
  :root { color-scheme: dark light; supported-color-schemes: dark light; }
  body { margin: 0; padding: 0; }
  ${schemeBlock}
  @media (max-width: 480px) {
    .x-pad { padding: 24px 24px 32px 24px !important; }
    .x-action td { display: block !important; }
    .x-aside { padding: 12px 0 0 0 !important; }
  }
  </style>
</head>
<body class="${frame.cls}" style="margin: 0; padding: 0; ${frame.css}">
  ${slots.preheader ? `<div style="display: none; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(slots.preheader)}${PREHEADER_FILLER}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="${frame.cls}" style="${frame.css}">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="${card.cls}" style="width: 100%; max-width: 600px; border: 1px solid; border-collapse: separate; border-radius: ${cardRadius}; ${card.css}">
          <tr><td style="padding: 0; line-height: 0; font-size: 0; border-radius: ${cardRadius} ${cardRadius} 0 0; overflow: hidden;">${band}</td></tr>
          <tr>
            <td class="x-pad" style="padding: 26px 40px 34px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows.join("\n                ")}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: slots.subject,
    htmlContent,
    textContent: textPart(slots),
    senderName: slots.sentBy ? exomemSenderName(slots.sentBy.personName) : SENDER,
  };
}
