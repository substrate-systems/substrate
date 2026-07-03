import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Endstate Terms, Privacy & Refund Policy",
  description:
    "Terms of Service, Privacy Policy, and Refund Policy for Endstate by Substrate Systems OÜ. How we handle data, licensing, and refunds.",
  path: "/terms",
});

export default function TermsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
