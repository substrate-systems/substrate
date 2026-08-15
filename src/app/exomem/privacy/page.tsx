import Link from "next/link";
import { buildMetadata } from "@/lib/seo";
import { ExomemPublicPage } from "../public-page";

export const metadata = buildMetadata({
  title: "Exomem Hosted Privacy Policy",
  description:
    "How Substrate Systems OÜ collects, processes, and protects data in Exomem Hosted, covering your knowledge store, account records, OAuth session metadata, and your rights as a data subject.",
  path: "/exomem/privacy",
});

export default function ExomemPrivacyPage() {
  return (
    <ExomemPublicPage title="Exomem Hosted privacy" eyebrow="Revised 28 July 2026">
      <p>
        This policy covers the Exomem Hosted service and its public product, account, OAuth, and
        support pages. The data controller is Substrate Systems OÜ (Estonian registry code
        17394552), Siidisaba tn 13/2-14, 11311 Tallinn, Estonia. Privacy questions and rights
        requests can be sent to{" "}
        <a href="mailto:founder@substratesystems.io">founder@substratesystems.io</a>.
      </p>

      <h2>Data we process</h2>
      <ul>
        <li>
          <strong>Account and authorization data:</strong> email address, invitation and consent
          state, client registration metadata, session and OAuth token digests, and account status.
          Raw passwords are not used for the Hosted OAuth flow.
        </li>
        <li>
          <strong>Your knowledge store:</strong> Markdown, media, links, metadata, searches, and
          changes you send through an authorized Exomem client. Search indexes and caches are
          derived from this content.
        </li>
        <li>
          <strong>Operations and security data:</strong> timestamps, coarse counts and sizes,
          client/protocol version, opaque request and resource identifiers, rate-limit records,
          service health, and security events. Operational logging is designed to exclude note
          content, queries, filenames, email addresses, tokens, and private endpoints.
        </li>
        <li>
          <strong>Billing data, when a paid plan is enabled:</strong> Paddle customer, transaction,
          subscription, product, and status identifiers. Paddle handles payment-card details; Exomem
          does not receive them.
        </li>
        <li>
          <strong>Support data:</strong> messages and content-free diagnostics you choose to send
          us. Please do not send knowledge content, tokens, invite links, or screenshots containing
          them.
        </li>
      </ul>

      <h2>Purposes and legal bases</h2>
      <p>
        We process account and knowledge-store data to provide the service you request and perform
        our agreement with you. We process limited security, reliability, support, and abuse data
        for our legitimate interests in operating and protecting Exomem and its users. We process
        billing and business records where necessary for our agreement and legal obligations. If we
        ask for optional consent, you can withdraw it without affecting earlier lawful processing.
      </p>

      <h2>The security boundary</h2>
      <p>
        Hosted Exomem is encrypted in transit and at rest, with tenant-isolated cells. It is not
        zero-knowledge or end-to-end encrypted: the isolated cell processes plaintext to search and
        serve your knowledge store. A tightly controlled operator could access a running cell only
        where necessary to operate, support, or secure the service. Access is restricted, and the
        operational design minimizes content-bearing logs and shared infrastructure.
      </p>

      <h2>AI clients and service providers</h2>
      <p>
        When you connect Claude, ChatGPT, Codex, or another MCP client, that client sends authorized
        tool requests to Exomem and receives the requested results. The client provider processes
        those prompts and results under its own terms and privacy policy; disconnecting the client
        revokes its future Exomem access but does not delete data already handled by that provider.
      </p>
      <p>
        We use service providers only as needed to operate Exomem: Vercel for the public web and
        control plane, Neon for PostgreSQL, Cloudflare for protected networking and transfer
        ingress, contracted compute and object-storage providers for tenant cells and encrypted
        exports, Brevo for transactional email, and Paddle as merchant of record when billing is
        enabled. The public site may use privacy-filtered Vercel/PostHog analytics; Exomem account
        identifiers, email, knowledge content, tokens, and private routes are filtered from those
        events. Providers may process data outside the EEA under the safeguards required by
        applicable data-protection law.
      </p>

      <h2>Retention, export, and deletion</h2>
      <p>
        Your canonical knowledge content remains yours and is kept while your Hosted account is
        active. You can create a portable export and start verified account deletion from the
        product. Exports and access credentials expire on their stated schedule. On deletion we
        revoke sessions and client access, close routing, and destroy the tenant&apos;s compute,
        storage, and keys through the verified deletion workflow rather than merely hiding the
        account. Minimal billing, security, deletion-proof, and legal records may be retained for
        the period required to resolve disputes, prevent abuse, demonstrate deletion, or meet
        accounting and legal duties; they do not contain the deleted knowledge store.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        Depending on applicable law, you can ask to access, correct, delete, restrict, or receive a
        portable copy of your personal data, and object to processing based on legitimate interests.
        You can withdraw consent where processing relies on it. We do not use Exomem data for solely
        automated decisions with legal or similarly significant effects. You may also complain to
        the Estonian Data Protection Inspectorate or your local supervisory authority.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We will update the revision date when this policy changes and give appropriate notice of a
        material change. Contact{" "}
        <a href="mailto:founder@substratesystems.io">founder@substratesystems.io</a> or see the{" "}
        <Link href="/exomem/support">support page</Link> for help with privacy, export, or deletion.
      </p>
    </ExomemPublicPage>
  );
}
