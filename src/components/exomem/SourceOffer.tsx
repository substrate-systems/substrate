import {
  sourceOfferLicenceNote,
  sourceOfferLinks,
  sourceOfferReleaseText,
} from "@/lib/exomem-hosted/source-offer";
import styles from "./SourceOffer.module.css";

/**
 * The "Source code" offer, which names the licence of each repository. Give `release` only where the page has read the cell's own
 * release. `pinned` takes the line out of the page's flow, for the journey pages, whose content
 * is centred between two equal spacers; `align="center"` is for pages without a padded column.
 */
export function SourceOffer({
  release,
  align = "start",
  pinned = false,
}: {
  release?: string | null;
  align?: "start" | "center";
  pinned?: boolean;
}) {
  const text = sourceOfferReleaseText(release);
  const note = sourceOfferLicenceNote(release);
  const classes = [
    styles.offer,
    align === "center" ? styles.center : "",
    pinned ? styles.pinned : "",
  ];
  return (
    <p className={classes.filter(Boolean).join(" ")}>
      Source code:{" "}
      {sourceOfferLinks(release).map((link, index) => (
        <span key={link.href}>
          {index > 0 ? " · " : null}
          <a href={link.href} target="_blank" rel="noreferrer noopener">
            {link.label}
          </a>
        </span>
      ))}
      {text === null ? null : ` · ${text}`}
      {note === null ? null : (
        <>
          <br />
          {note}
        </>
      )}
    </p>
  );
}
