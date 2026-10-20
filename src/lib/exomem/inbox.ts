import providers from "./inbox-providers.json";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";

export function inboxProvider(id: string | null) {
  return providers.find((provider) => provider.id === id) ?? null;
}

export function inboxProviderForDomain(domain: string) {
  return providers.find((provider) => provider.domains.includes(domain.toLowerCase())) ?? null;
}

/** The registry owns provider links; submitted text can fill only encoded URL values. */
export function inboxUrl(providerId: string | null, address: string): string | null {
  const provider = inboxProvider(providerId);
  return provider
    ? provider.urlTemplate
        .replaceAll("{address}", encodeURIComponent(address))
        .replaceAll("{sender}", encodeURIComponent(EXOMEM_SENDER.senderEmail))
    : null;
}

/**
 * The phone's own mail app, for an address whose provider is unknown. A desktop gets no link:
 * `mailto:` opens a new message, not the inbox.
 */
export function phoneMailApp(userAgent: string): string | null {
  // User-agent platform tokens, because Safari and Firefox expose no client hints. An iPad in
  // desktop mode reports a Mac and gets the desktop behaviour.
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return "message://";
  if (/\bAndroid\b/.test(userAgent))
    return "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_EMAIL;end";
  return null;
}
