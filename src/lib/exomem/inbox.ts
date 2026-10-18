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
