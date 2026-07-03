import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import sitemap from "@/app/sitemap";
import { siteConfig } from "@/lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// IndexNow key is public by design — it must also be hosted at
// https://<host>/<key>.txt so search engines can confirm ownership.
const INDEXNOW_KEY = "1b94c9c33de9f70939d73474021048bf";
const HOST = new URL(siteConfig.url).host;

// Notifies IndexNow-participating engines (Bing, Yandex, and others — which in
// turn feed answer engines like Copilot) of the site's current URLs. Triggered by
// the weekly Vercel cron; can also be hit manually with the cron auth header.
export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const urlList = sitemap().map((entry) => entry.url);

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key: INDEXNOW_KEY,
      keyLocation: `${siteConfig.url}/${INDEXNOW_KEY}.txt`,
      urlList,
    }),
  });

  // IndexNow returns 200/202 on success. Report status back for cron logs.
  return NextResponse.json(
    { ok: res.ok, status: res.status, submitted: urlList.length },
    { status: res.ok ? 200 : 502 },
  );
}
