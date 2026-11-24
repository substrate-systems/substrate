import type { MetadataRoute } from "next";
import { getPublishedPostsMeta } from "@/lib/blog";
import { PRODUCT_PUBLIC_PAGES, type ProductPublicPage } from "@/lib/exomem/product-pages";
import { productPageUrl } from "@/lib/exomem/product-site";

const baseUrl = "https://substratesystems.io";

// Static routes deliberately carry no `lastModified`. Stamping them with
// `new Date()` marked every page as freshly-changed on every deploy, which
// teaches crawlers the field is noise and gets it discounted site-wide —
// including for the blog entries below, where the date is real. An absent
// lastmod is better than a false one; the field is optional in the protocol.
type Route = {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
};

// One entry per public product page: the type makes a page missing here a build error.
const productPages: Record<ProductPublicPage, Omit<Route, "path">> = {
  docs: { changeFrequency: "monthly", priority: 0.5 },
  benchmarks: { changeFrequency: "monthly", priority: 0.7 },
  privacy: { changeFrequency: "yearly", priority: 0.3 },
  terms: { changeFrequency: "yearly", priority: 0.3 },
  support: { changeFrequency: "monthly", priority: 0.4 },
};

const staticRoutes: Route[] = [
  { path: "", changeFrequency: "monthly", priority: 1 },
  { path: "/endstate", changeFrequency: "weekly", priority: 0.9 },
  { path: "/exomem", changeFrequency: "monthly", priority: 0.8 },
  { path: "/q", changeFrequency: "monthly", priority: 0.7 },
  ...PRODUCT_PUBLIC_PAGES.map((page) => ({ path: `/exomem/${page}`, ...productPages[page] })),
  { path: "/endstate/apps", changeFrequency: "weekly", priority: 0.7 },
  { path: "/endstate/why", changeFrequency: "monthly", priority: 0.7 },
  { path: "/endstate/supporters", changeFrequency: "monthly", priority: 0.4 },
  { path: "/endstate/sponsor-an-integration", changeFrequency: "monthly", priority: 0.5 },
  { path: "/work", changeFrequency: "monthly", priority: 0.8 },
  { path: "/photography", changeFrequency: "monthly", priority: 0.5 },
  { path: "/photography/iceland-aurora", changeFrequency: "yearly", priority: 0.5 },
  { path: "/blog", changeFrequency: "weekly", priority: 0.7 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // post.slug is the filename (see getAllPostsMeta), the same source
  // generateStaticParams uses — so a sitemap URL can never point at a slug
  // the [slug] route won't build, which would 404 under dynamicParams = false.
  const blogEntries: MetadataRoute.Sitemap = getPublishedPostsMeta().map((post) => {
    const lastModified = post.updated ?? post.published;
    return {
      url: `${baseUrl}/blog/${post.slug}`,
      lastModified: lastModified ? new Date(lastModified) : undefined,
      changeFrequency: "yearly",
      priority: 0.6,
    };
  });

  const staticEntries: MetadataRoute.Sitemap = staticRoutes.map((route) => ({
    // Product pages carry their canonical URL, which moves to the product site when it is on.
    url: route.path.startsWith("/exomem") ? productPageUrl(route.path) : `${baseUrl}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  return [...staticEntries, ...blogEntries];
}
