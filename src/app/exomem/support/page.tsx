import type { Metadata } from "next";
import { ExomemPublicPage } from "../public-page";

export const metadata: Metadata = {
  title: "Exomem Hosted Support",
  description: "Setup, account, privacy, and incident support for Exomem Hosted.",
};

export default function ExomemSupportPage() {
  return (
    <ExomemPublicPage title="Exomem Hosted support" eyebrow="Subscriber support">
      <p>
        For access, setup, privacy, or service issues, email{" "}
        <a href="mailto:founder@substratesystems.io">founder@substratesystems.io</a> with a short
        description and any non-sensitive error or request reference. You can also report a
        reproducible public-client problem in the{" "}
        <a href="https://github.com/Artexis10/exomem/issues">Exomem issue tracker</a>. Do not send
        knowledge content, access tokens, invite links, private connection URLs, or screenshots
        containing them.
      </p>
      <h2>Before writing</h2>
      <p>
        Confirm that you are using the approved client entry and have completed the OAuth sign-in.
        If a client cannot connect, include the time, client name, and a content-free error code. We
        will never ask you to paste a token or manually edit a tenant connection URL.
      </p>
      <p>
        For privacy, export, or deletion requests, use the same address. The service is
        capacity-limited; account recovery and support require verification of the account owner.
      </p>
      <h2>Security reports</h2>
      <p>
        Send suspected cross-tenant access, token exposure, or another security issue privately by
        email rather than opening a public issue. Include the client, approximate UTC time, and a
        content-free request reference if one is visible. We will never ask you to send a bearer
        token or another user&apos;s data.
      </p>
    </ExomemPublicPage>
  );
}
