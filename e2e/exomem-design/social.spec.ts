import { expect, test } from "@playwright/test";

test("shared Exomem links advertise the product with its canonical brand image", async ({
  page,
  request,
}) => {
  for (const path of ["/exomem", "/exomem/home", "/exomem/support"]) {
    const response = await request.get(path, { headers: { "user-agent": "Discordbot/2.0" } });
    expect(response.ok()).toBe(true);
    const metadata = await page.evaluate(
      (html) => {
        const document = new DOMParser().parseFromString(html, "text/html");
        const content = (selector: string) =>
          document.querySelector<HTMLMetaElement>(selector)?.content;
        return {
          title: content('meta[property="og:title"]'),
          description: content('meta[property="og:description"]'),
          site: content('meta[property="og:site_name"]'),
          image: content('meta[property="og:image"]'),
          twitterImage: content('meta[name="twitter:image"]'),
        };
      },
      await response.text()
    );
    expect(metadata.title).toContain("Exomem");
    expect(metadata.site).toBe("Exomem");
    expect(metadata.description).toBeTruthy();
    expect(metadata.image).toBe("https://substratesystems.io/exomem/social/og-image.png");
    expect(metadata.twitterImage).toBe(metadata.image);
  }
});
