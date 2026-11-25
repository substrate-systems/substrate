import { Fragment } from "react";
import {
  sourceOfferLicenceTerms,
  sourceOfferLinks,
  sourceOfferReleaseText,
} from "@/lib/exomem-hosted/source-offer";
import styles from "./SourceOffer.module.css";

/** Lines break only between words, so a licence identifier never splits at one of its hyphens. */
function Words({ text }: { text: string }) {
  return text.split(" ").map((word, index) => (
    <Fragment key={index}>
      {index > 0 ? " " : null}
      <span className={styles.word}>{word}</span>
    </Fragment>
  ));
}

/**
 * The "Source code" offer, which names the licence of each repository. Give `release` only where the page has read the cell's own
 * release. `pinned` drops the offer's own spacing for the journey pages, whose foot pins it out of
 * the page's flow under the request's origin; `align="center"` is for pages without a padded column.
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
  const terms = sourceOfferLicenceTerms(release);
  const classes = [
    styles.offer,
    align === "center" ? styles.center : "",
    pinned ? styles.pinned : "",
  ];
  return (
    <p className={classes.filter(Boolean).join(" ")}>
      <span className={styles.text}>
        Source code:{" "}
        {sourceOfferLinks(release).map((link, index) => (
          <span key={link.href}>
            {index > 0 ? " · " : null}
            <a href={link.href} target="_blank" rel="noreferrer noopener">
              <Words text={link.label} />
            </a>
          </span>
        ))}
        {text === null ? null : ` · ${text}`}
        {terms === null ? null : (
          <>
            {" · "}
            <a href={terms.href} target="_blank" rel="noreferrer noopener">
              <Words text={terms.label} />
            </a>
          </>
        )}
      </span>
    </p>
  );
}
