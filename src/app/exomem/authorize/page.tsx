import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PrivateShell } from "../private-shell";
import {
  EXOMEM_OAUTH_FORM_NONCE_COOKIE,
  oauthFormNonceFromCookie,
} from "@/lib/exomem-hosted/oauth-continuity";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Authorize Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ExomemAuthorizePage() {
  const cookieStore = await cookies();
  const nonce =
    oauthFormNonceFromCookie(cookieStore.get(EXOMEM_OAUTH_FORM_NONCE_COOKIE)?.value) ?? "";
  return (
    <PrivateShell>
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Continue to Exomem</h1>
        <p className="mt-3 text-neutral-600">
          Confirm to connect this client to your Exomem account. If you are not signed in, use your
          existing Exomem access link first, then return here.
        </p>
        <form action="/api/exomem/oauth/authorize/complete" className="mt-8" method="post">
          <input name="nonce" type="hidden" value={nonce} />
          <button className="rounded bg-black px-4 py-2 text-white" type="submit">
            Continue
          </button>
        </form>
      </main>
    </PrivateShell>
  );
}
