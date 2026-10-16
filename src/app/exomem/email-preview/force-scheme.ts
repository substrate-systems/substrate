import {
  EXOMEM_EMAIL_SCHEMES,
  exomemEmailSchemeQuery,
  type ExomemEmailScheme,
} from "@/lib/email-templates/exomem-email";

/**
 * The email in one scheme whatever the viewer's preference, so the preview's two
 * columns show both versions. An email carries one media block, for the scheme that
 * is not its base: the block is always on when that scheme is asked for, and always
 * off when the base is. A real client still decides by preference.
 */
export function emailInScheme(html: string, scheme: ExomemEmailScheme): string {
  for (const blockScheme of EXOMEM_EMAIL_SCHEMES) {
    const query = `@media ${exomemEmailSchemeQuery(blockScheme)}`;
    if (html.includes(query)) {
      return html.replace(query, blockScheme === scheme ? "@media all" : "@media not all");
    }
  }
  throw new Error("The email has no colour-scheme block to force.");
}
