import { Resolver } from "node:dns/promises";
import type { MxRecord } from "node:dns";
import { domainToASCII } from "node:url";
import providers from "@/lib/exomem/inbox-providers.json";
import { inboxProviderForDomain } from "@/lib/exomem/inbox";

const CACHE_TTL_MS = 5 * 60 * 1_000;
const CACHE_ENTRIES = 256;
const MAX_ACTIVE_LOOKUPS = 8;
const LOOKUP_DEADLINE_MS = 750;

function dnsDomain(input: string): string | null {
  // These expressions check DNS label shape, never a person's meaning or identity.
  if (input.length > 253 || !/^[\p{L}\p{M}\p{N}.-]+$/u.test(input)) return null;
  const domain = domainToASCII(input.toLowerCase());
  const labels = domain.split(".");
  return domain.length <= 253 &&
    labels.length > 1 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? domain
    : null;
}

async function lookupMx(domain: string): Promise<MxRecord[]> {
  const resolver = new Resolver({ timeout: LOOKUP_DEADLINE_MS, tries: 1 });
  const deadline = setTimeout(() => resolver.cancel(), LOOKUP_DEADLINE_MS);
  try {
    return await resolver.resolveMx(domain);
  } finally {
    clearTimeout(deadline);
  }
}

/** Public DNS hints only: this module never reads account or admission state. */
export function createInboxProviderLookup(resolveMx = lookupMx, now = Date.now) {
  const cache = new Map<string, { expiresAt: number; result: Promise<string | null> }>();
  let active = 0;
  return async (input: string): Promise<string | null> => {
    const domain = dnsDomain(input);
    if (!domain) return null;
    const direct = inboxProviderForDomain(domain);
    if (direct) return direct.id;
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > now()) return cached.result;
    cache.delete(domain);
    // Bound optional DNS work; overload costs only the inbox shortcut, never sign-in.
    if (active >= MAX_ACTIVE_LOOKUPS) return null;
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    active += 1;
    const result = Promise.resolve()
      .then(() => resolveMx(domain))
      .then((records) => {
        for (const record of records.toSorted((a, b) => a.priority - b.priority)) {
          const host = record.exchange.toLowerCase().replace(/\.$/, "");
          // Match DNS suffix boundaries from provider data, not arbitrary substrings.
          const provider = providers.find((item) =>
            item.mxSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
          );
          if (provider) return provider.id;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        active -= 1;
      });
    cache.set(domain, { expiresAt: now() + CACHE_TTL_MS, result });
    return result;
  };
}

export const resolveInboxProvider = createInboxProviderLookup();
