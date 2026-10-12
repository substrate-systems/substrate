import type { Metadata } from "next";
import { unknownAppCopy } from "../../_journey/copy";
import { JourneyPage } from "../../_journey/JourneyPage";
import { StepHeading } from "../../_journey/parts";

export const metadata: Metadata = {
  title: "Authorize Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * Where the authorization endpoint sends an app Exomem does not know or no longer
 * admits. Nothing about the request is shown: none of it can be trusted.
 */
export default function UnknownAppPage() {
  return (
    <JourneyPage kind="stop" stepKey="unknown-app">
      <StepHeading title={unknownAppCopy.title} lede={unknownAppCopy.lede} />
    </JourneyPage>
  );
}
