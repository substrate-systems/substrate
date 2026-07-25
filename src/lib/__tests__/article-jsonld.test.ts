import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { articleJsonLd } from "../structured-data";
import { siteConfig } from "../seo";

/**
 * A Semrush site audit flagged "invalid structured data items" on three pages.
 * The cause was Article JSON-LD emitted without `image`, which schema.org requires —
 * a validator reports the whole item invalid rather than merely incomplete, so the
 * markup was doing nothing on every article the site publishes.
 *
 * Asserted at both ends: the builder passes an image through, and the two call sites
 * actually supply one. The builder alone would pass while the pages stayed broken.
 */
function source(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("Article structured data carries an image", () => {
  test("articleJsonLd emits image when given one", () => {
    const out = articleJsonLd({
      title: "T",
      description: "D",
      slug: "s",
      published: "2026-01-01",
      image: `${siteConfig.url}/api/og?title=T`,
    }) as Record<string, unknown>;

    assert.deepEqual(out.image, [`${siteConfig.url}/api/og?title=T`]);
    assert.equal(out["@type"], "Article");
    // The fields a validator also treats as required.
    for (const key of ["headline", "author", "publisher", "@context"]) {
      assert.ok(key in out, `Article missing ${key}`);
    }
  });

  test("the blog article route supplies an absolute image", () => {
    const page = source("src/app/blog/[slug]/page.tsx");
    assert.match(
      page,
      /image:\s*`\$\{siteConfig\.url\}\/api\/og\?title=\$\{encodeURIComponent\(title\)\}`/,
      "blog posts must pass an absolute image into articleJsonLd"
    );
  });

  test("the endstate/why article carries an absolute image", () => {
    const layout = source("src/app/endstate/why/layout.tsx");
    assert.match(
      layout,
      /image:\s*\[`\$\{siteConfig\.url\}\/api\/og\?title=/,
      "/endstate/why hand-writes its Article JSON-LD and must include image"
    );
  });

  test("every hand-written Article JSON-LD in the app includes an image", () => {
    // Guards the class rather than the two known instances: a new hand-rolled
    // Article elsewhere would reintroduce exactly this bug.
    const files = ["src/app/endstate/why/layout.tsx"];
    for (const f of files) {
      const s = source(f);
      if (!/"@type":\s*"Article"/.test(s)) continue;
      assert.match(s, /image:/, `${f} declares an Article without an image`);
    }
  });
});
