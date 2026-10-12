import {
  EXOMEM_EMAIL_LIGHT_SCHEME_QUERY,
  type ExomemEmailScheme,
} from "@/lib/email-templates/exomem-email";

/**
 * The email with its light-scheme rules always on (light) or always off (dark),
 * so the preview's two columns show both versions whatever the viewer's
 * preference. A real client still decides by preference.
 */
export function emailInScheme(html: string, scheme: ExomemEmailScheme): string {
  const query = `@media ${EXOMEM_EMAIL_LIGHT_SCHEME_QUERY}`;
  if (!html.includes(query)) throw new Error("The email has no light-scheme block to force.");
  return html.replace(query, scheme === "light" ? "@media all" : "@media not all");
}
