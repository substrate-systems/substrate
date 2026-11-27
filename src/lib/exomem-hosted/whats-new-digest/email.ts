/**
 * The monthly digest email, from an ordered list of notes
 * (`send-monthly-whats-new-digest`, D0): each note its title, then its
 * sentence (the sentence alone when the note has no title), ending with a link
 * to Evermatter's public release list. Server only.
 *
 * Its look is provisional and follows the other Evermatter emails through the
 * shared template (email-templates/exomem-email.ts). The final design arrives
 * from a design artifact and replaces this module's slots and the template's
 * `items` block. The unsubscribe link sits beside the release-list button, and
 * its small print follows: every digest carries both, the approval page's
 * preview included.
 */

import {
  renderExomemEmail,
  type ExomemEmailScheme,
  type RenderedExomemEmail,
} from "@/lib/email-templates/exomem-email";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";
import { EVERMATTER_RELEASES_URL } from "./config";
import type { DigestNote } from "./notes";
import { UNSUBSCRIBE_PAGE_PATH } from "./unsubscribe-paths";

export type WhatsNewDigestEmailInput = {
  /** `YYYY-MM`, the month the notes come from. */
  month: string;
  /** The month's picked notes in the order they show. */
  notes: readonly DigestNote[];
  /** The page where the owner turns this email off (`unsubscribe.ts`). */
  unsubscribeUrl: string;
};

export type WhatsNewDigestAppearance = {
  /** The scheme the inline styles take: the recipient's, or dark when it is unknown. */
  base: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
};

function monthName(month: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`)
  );
}

export function renderWhatsNewDigestEmail(
  input: WhatsNewDigestEmailInput,
  appearance: WhatsNewDigestAppearance
): RenderedExomemEmail {
  const name = monthName(input.month);
  return renderExomemEmail({
    base: appearance.base,
    themeChoice: appearance.themeChoice,
    subject: `What's new in Evermatter, ${name}`,
    preheader: `${input.notes.length} changes from ${name} that you may notice.`,
    band: "live",
    headline: "What's new",
    body: [`The changes from ${name} that you are most likely to notice.`],
    detail: { kind: "items", items: input.notes.map(({ title, text }) => ({ title, text })) },
    action: {
      label: "See every change",
      url: EVERMATTER_RELEASES_URL,
      link: { label: "Turn this email off", url: input.unsubscribeUrl },
    },
    smallPrint:
      "You get this email once a month. You can also turn it off on Home, under Monthly update email.",
  });
}

/**
 * The email as the approval page shows it: forced light and forced dark, and the plain-text part.
 * Its unsubscribe link is the page's path with no token: a preview signs nothing for an owner.
 */
export function previewWhatsNewDigestEmail(
  input: Omit<WhatsNewDigestEmailInput, "unsubscribeUrl">
) {
  const withLink = { ...input, unsubscribeUrl: UNSUBSCRIBE_PAGE_PATH };
  const light = renderWhatsNewDigestEmail(withLink, { base: "light", themeChoice: "light" });
  const dark = renderWhatsNewDigestEmail(withLink, { base: "dark", themeChoice: "dark" });
  return {
    subject: light.subject,
    light: light.htmlContent,
    dark: dark.htmlContent,
    text: light.textContent,
  };
}
