// The AGPL-3.0 section 13 source offer that every signed-in Exomem Cloud page shows. The two
// repositories are the whole service: the memory server and this control plane.
export const SOURCE_OFFER_LINKS = [
  { label: "Exomem", href: "https://github.com/Artexis10/exomem" },
  { label: "Substrate", href: "https://github.com/substrate-systems/substrate" },
] as const;

export type SourceOfferRelease =
  | { state: "loading" }
  | { state: "known"; release: string }
  | { state: "unknown" }
  | { state: "unavailable" };

/** What the offer says about the running release. Loading shows nothing; the rest never guess. */
export function sourceOfferReleaseText(release: SourceOfferRelease): string | null {
  switch (release.state) {
    case "loading":
      return null;
    case "known":
      return `release ${release.release}`;
    case "unknown":
      return "release not recorded";
    case "unavailable":
      return "release unavailable";
  }
}
