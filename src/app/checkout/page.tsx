import Link from "next/link";
import Footer from "@/components/Footer";
import SiteHeader from "@/components/SiteHeader";
import { PADDLE_TRANSACTION_ID } from "@/lib/paddle-transaction-id";
import { buildMetadata } from "@/lib/seo";
import { CheckoutOpener } from "./CheckoutOpener";

export const metadata = buildMetadata({
  title: "Checkout",
  description: "Opens a Substrate Systems checkout.",
  path: "/checkout",
  noIndex: true,
});

/**
 * Paddle's account-level default payment link. Paddle sends a buyer here when a
 * transaction carries no checkout URL of its own, whichever product it is for.
 */
export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { _ptxn } = await searchParams;
  // The opener ignores anything that is not a Paddle transaction id, so the page does too.
  const hasTransaction = typeof _ptxn === "string" && PADDLE_TRANSACTION_ID.test(_ptxn);

  return (
    <div className="min-h-screen bg-bg-base">
      <SiteHeader />

      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="text-display-sm font-light tracking-tight text-fg-primary sm:text-display">
          Checkout
        </h1>
        {hasTransaction ? (
          <CheckoutOpener transactionId={_ptxn} />
        ) : (
          <>
            <p className="mt-3 text-body-lg font-light text-fg-secondary">
              There is no checkout to open here.
            </p>
            <Link
              href="/"
              className="mt-6 inline-block text-sm font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
            >
              Go to the home page →
            </Link>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
