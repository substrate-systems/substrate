import type { Metadata } from "next";
import Link from "next/link";
import { ExomemPublicPage } from "../public-page";

export const metadata: Metadata = {
  title: "Exomem Hosted Terms of Service",
  description: "Terms for the Exomem Hosted subscription service from Substrate Systems OÜ.",
};

export default function ExomemTermsPage() {
  return (
    <ExomemPublicPage title="Exomem Hosted terms" eyebrow="Revised 8 August 2026">
      <p>
        These terms are an agreement between you and Substrate Systems OÜ (Estonian registry code
        17394552), Siidisaba tn 13/2-14, 11311 Tallinn, Estonia, for Exomem Hosted. They apply when
        you create an account, subscribe, or use the Hosted service. The open-source Exomem software
        remains governed by the license in its repository.
      </p>

      <h2>Eligibility and availability</h2>
      <p>
        Hosted Exomem is open to anyone who can subscribe, subject to available capacity. Because
        each subscriber runs in an isolated cell on finite infrastructure, we admit new subscribers
        up to that capacity and place further requests on a waitlist; we do not take payment for a
        place we cannot provide. You must be legally able to enter this agreement, provide accurate
        account information, keep access to your email and connected clients secure, and promptly
        tell us about suspected unauthorized use. An account is personal and may not be sold or
        transferred.
      </p>

      <h2>The service</h2>
      <p>
        Hosted Exomem provides an isolated managed knowledge store through approved MCP clients.
        Client availability and model behavior are partly controlled by third-party providers such
        as Anthropic and OpenAI and remain subject to their terms. We may change features, limits,
        compatible clients, or infrastructure as the service develops. We do not promise a
        service-level agreement, but we will operate the service with reasonable care and
        communicate material changes where practicable.
      </p>

      <h2>Your data</h2>
      <p>
        You retain ownership of the knowledge content you provide. You grant Substrate Systems OÜ a
        limited, non-exclusive permission to host, copy, process, index, transmit to your authorized
        clients, secure, export, and delete that content only as needed to provide and protect
        Hosted Exomem. You are responsible for having the right to store and process the content you
        submit. The privacy policy explains the plaintext-in-cell boundary and how service providers
        handle data.
      </p>

      <h2>Acceptable use and availability</h2>
      <p>
        Do not use Hosted Exomem to break the law; infringe privacy, confidentiality, or
        intellectual property rights; distribute malware; harm or deceive others; probe another
        tenant; bypass quotas, access, or security controls; interfere with the service; or use
        automated traffic that creates unreasonable load. We may apply reasonable storage, request,
        and rate limits. We may suspend access immediately where needed to protect users, data,
        infrastructure, or third parties, and will give notice where lawful and practicable.
      </p>

      <h2>Fees, cancellation, export, and deletion</h2>
      <p>
        Hosted Exomem is €12 per month, billed monthly and renewing automatically until cancelled.
        That is a time-limited founder price: we may raise the price for new subscribers, and if we
        do, your existing subscription keeps the price you signed up at for as long as it remains
        active. Paddle acts as merchant of record, shows the final price including any applicable
        VAT before you pay, and issues your invoice. Some subscribers hold complimentary access,
        which carries no fee.
      </p>
      <p>
        You can cancel at any time from your account; cancellation stops the next renewal and access
        continues to the end of the paid period. Consumers in the EU have a statutory 14-day right
        of withdrawal; because the service is made available immediately, you are asked to consent
        to that immediate start at checkout, and refund requests are handled by Paddle as merchant
        of record. You can stop using the service, disconnect clients, export your canonical data,
        and request verified account deletion at any time. Ending access does not erase information
        already sent to a third-party client; manage that information with the client provider.
      </p>

      <h2>Intellectual property and feedback</h2>
      <p>
        These terms do not transfer ownership of your content or the open-source rights granted by
        Exomem&apos;s repository license. Substrate Systems OÜ retains rights in the Hosted service,
        site, branding, and non-open-source materials. If you send feedback, you allow us to use it
        without obligation, but it does not give us rights to your knowledge content.
      </p>

      <h2>Warranty and liability</h2>
      <p>
        The service is provided on an as-available basis. To the extent permitted by law, we
        disclaim implied warranties and are not liable for indirect, incidental, special, or
        consequential loss. Our aggregate liability for the Hosted service is limited to the amount
        you paid for it in the twelve months before the event giving rise to the claim. Nothing in
        these terms excludes liability or consumer rights that applicable law does not allow us to
        exclude or limit.
      </p>

      <h2>Termination, law, and changes</h2>
      <p>
        You may terminate by cancelling your subscription or requesting deletion. We may end an
        account for material breach, security risk, legal requirement, or discontinuation of the
        service. If we discontinue the service we will give reasonable notice, refund any prepaid
        period not yet used, and keep export available through that notice period. Provisions that
        by their nature survive termination—including ownership, retained legal records, warranty,
        and liability terms—continue to apply. Estonian law governs these terms, without depriving
        consumers of mandatory protections available in their country. Disputes are subject to the
        competent Estonian courts unless mandatory consumer law provides otherwise.
      </p>
      <p>
        We will update the revision date and provide appropriate notice before a material change
        takes effect. Questions or legal notices go to{" "}
        <a href="mailto:founder@substratesystems.io">founder@substratesystems.io</a>. See the{" "}
        <Link href="/exomem/privacy">privacy policy</Link> and{" "}
        <Link href="/exomem/support">support page</Link> for the related service details.
      </p>
    </ExomemPublicPage>
  );
}
