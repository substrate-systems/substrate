"use client";

import { useEffect, useState } from "react";
import {
  SOURCE_OFFER_LINKS,
  sourceOfferReleaseText,
  type SourceOfferRelease,
} from "@/lib/exomem-hosted/source-offer";
import styles from "./SourceOffer.module.css";

async function readRelease(signal: AbortSignal): Promise<SourceOfferRelease> {
  try {
    const response = await fetch("/api/exomem/source", { signal });
    const body: unknown = await response.json();
    if (response.ok && typeof body === "object" && body !== null && "state" in body) {
      if (body.state === "known" && "release" in body && typeof body.release === "string")
        return { state: "known", release: body.release };
      if (body.state === "unknown") return { state: "unknown" };
    }
  } catch {
    // An aborted or failed read leaves the release unavailable, never guessed.
  }
  return { state: "unavailable" };
}

/**
 * The "Source code (AGPL-3.0)" offer, naming the release this service runs. `center` is for the
 * journey pages, whose content is centred; the others sit in a padded column and start-align.
 */
export function SourceOffer({ align = "start" }: { align?: "start" | "center" }) {
  const [release, setRelease] = useState<SourceOfferRelease>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void readRelease(controller.signal).then((next) => {
      if (!controller.signal.aborted) setRelease(next);
    });
    return () => controller.abort();
  }, []);
  const text = sourceOfferReleaseText(release);
  return (
    <p className={`${styles.offer} ${align === "center" ? styles.center : ""}`}>
      Source code (AGPL-3.0):{" "}
      {SOURCE_OFFER_LINKS.map((link, index) => (
        <span key={link.href}>
          {index > 0 ? " · " : null}
          <a href={link.href} target="_blank" rel="noreferrer noopener">
            {link.label}
          </a>
        </span>
      ))}
      {text === null ? null : ` · ${text}`}
    </p>
  );
}
