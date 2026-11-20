// The AGPL-3.0 section 13 source offer that signed-in Exomem Cloud pages show. The two
// repositories are the whole service: the memory server and this control plane.
export const SOURCE_OFFER_LINKS = [
  { label: "Exomem", href: "https://github.com/Artexis10/exomem" },
  { label: "Substrate", href: "https://github.com/substrate-systems/substrate" },
] as const;

/**
 * What the offer says about the release this account's cell runs. `undefined` means the page has
 * no reading (no session, or the first poll has not returned), and the offer then says nothing
 * about a release; `null` means the reading found no recorded release for the cell's image.
 */
export function sourceOfferReleaseText(release: string | null | undefined): string | null {
  if (release === undefined) return null;
  return release === null ? "release not recorded" : `running release ${release}`;
}
