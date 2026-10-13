import Link from "next/link";
import { loadExportTtlHours } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { buildMetadata } from "@/lib/seo";
import { ExomemPublicPage } from "../public-page";

export const metadata = buildMetadata({
  title: "Exomem Cloud Privacy Policy",
  description:
    "How Substrate Systems OÜ collects, processes, and protects data in Exomem Cloud, covering your knowledge store, account records, OAuth session metadata, and your rights as a data subject.",
  path: "/exomem/privacy",
});

export default function ExomemPrivacyPage() {
  const exportTtlHours = loadExportTtlHours();
  // Home offers the export only while the export flag is on (design.md deviation (s)). This
  // page is static, so it reads the flag at build, and a flag change takes a deploy.
  const exportOffered = cloudExportsEnabled();
  return (
    <ExomemPublicPage title="Exomem Cloud privacy" eyebrow="Revised 13 October 2026">
      <p>
        This policy covers the Exomem Cloud service and its public product, account, OAuth, and
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
          Ordinary Cloud sign-in is passwordless. Directory reviewers use dedicated credentials for
          a separate sample account; the authentication database stores a password hash, not the raw
          password.
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
          <strong>Billing data:</strong> Paddle customer, transaction, subscription, product, and
          status identifiers. Paddle handles payment-card details; Exomem does not receive them.
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
        Each Exomem Cloud account runs in its own isolated cell. Other accounts cannot reach your
        data. Your knowledge store and its backups are encrypted at rest, and connections to the
        service are encrypted in transit. The internet-facing edge that receives connections cannot
        read the keys that protect your stored data.
      </p>
      <p>
        Exomem Cloud is not zero-knowledge or end-to-end encrypted. To search and serve your
        knowledge, your cell processes it in plaintext, and our edge and gateway see requests and
        responses as they pass through. We hold the encryption keys for your cell&apos;s storage and
        backups on the server that runs it, so we could deliberately read your content. We do not
        claim otherwise.
      </p>
      <p>
        What we have built is that nobody sees your content by accident. The access our operators
        use day to day cannot read your data or its keys, and it cannot open a session inside your
        cell. Reaching your content means deliberately stepping outside that access, with an
        emergency credential that expires within an hour or with administrator access to the server
        itself. Actions taken through the cluster, including issuing and using that credential, are
        recorded in an audit log on the server. That log sits on a server we control, so it is a
        record of what happened, not tamper-proof evidence. We use such access only where necessary
        to operate, support, or secure the service, or where the law requires it. Our services are
        designed to keep your content out of their logs, and we test that they do.
      </p>

      <h2>AI clients and service providers</h2>
      <p>
        When you connect Claude, ChatGPT, Codex, or another MCP client, that client sends authorized
        tool requests to Exomem and receives the requested results. The client provider processes
        those prompts and results under its own terms and privacy policy; disconnecting the client
        revokes its future Exomem access but does not delete data already handled by that provider.
      </p>
      <p>
        We use service providers only as needed to operate Exomem: Vercel for the public web,
        sign-in and account service; Hetzner for the servers in Germany that run your cell, hold its
        encrypted storage, and host the account database; Backblaze for encrypted backups in its EU
        region, and for exports until they expire; Cloudflare for DNS and Turnstile bot protection;
        Brevo for transactional email; and Paddle as merchant of record. Until 10 October 2026, Neon
        also held a frozen copy of the account database from before it moved to our own servers;
        that copy is now deleted. The public site may use privacy-filtered Vercel/PostHog analytics;
        Exomem account identifiers, email, knowledge content, tokens, and private routes are
        filtered from those events. Providers may process data outside the EEA under the safeguards
        required by applicable data-protection law.
      </p>
      <p>
        Turnstile checks technical signals such as your IP address, browser information and
        connection characteristics to protect the start form from automated abuse. Our server sends
        Cloudflare the challenge token and your IP address to verify the check. Cloudflare acts as
        our processor for that protection and as an independent controller when it uses these
        signals to improve Turnstile. We do not send your knowledge content to Turnstile. See{" "}
        <a href="https://www.cloudflare.com/turnstile-privacy-policy/">
          Cloudflare&apos;s Turnstile privacy policy
        </a>{" "}
        for its data practices.
      </p>

      <h2>Retention, export, and deletion</h2>
      {exportOffered ? (
        <p>
          Your canonical knowledge content remains yours and is kept while your Cloud account is
          active. You can start an export from Home. An export is a plain ZIP of your Markdown notes
          and files, not encrypted to a key of your own. We keep it in our object storage, which the
          storage provider encrypts at rest, for up to {exportTtlHours} hours, and then we delete
          it. You can download it only from Home, through a link that works for 5 minutes.
        </p>
      ) : (
        <p>
          Your canonical knowledge content remains yours and is kept while your Cloud account is
          active. For an export, use the address on the{" "}
          <Link href="/exomem/support">support page</Link>, which takes privacy, export, and
          deletion requests.
        </p>
      )}
      <p>
        You can start verified account deletion from the product. Access credentials expire on their
        stated schedule. On deletion we revoke sessions and client access, close routing, and
        destroy the tenant&apos;s compute, storage, and keys through the verified deletion workflow
        rather than merely hiding the account. Minimal billing, security, deletion-proof, and legal
        records may be retained for the period required to resolve disputes, prevent abuse,
        demonstrate deletion, or meet accounting and legal duties; they do not contain the deleted
        knowledge store.
      </p>
      <p>
        When you ask to start Exomem, we keep your email address with your place on the waitlist or
        with your start link. If you do not open an account, we delete it 180 days after your last
        request or after your last start link expires, whichever is later. We keep the address and
        content of each email we send you for 30 days after we send it or stop trying, and then we
        remove them.
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
