import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { previewWhatsNewDigestEmail, renderWhatsNewDigestEmail } from "../email";

const UNSUBSCRIBE_URL = "https://app.example.test/exomem/unsubscribe/monthly-update#token";

const notes = [
  { title: "Faster search", text: "Search answers in about half the time on large memories." },
  { title: null, text: "The assistant now says when a memory was last changed." },
  { title: "Tags <b>stay</b>", text: "A note's own text is shown as written & never as markup." },
];

describe("the monthly digest email", () => {
  it("shows each note's title then its sentence, an untitled note as its sentence alone", () => {
    const { textContent } = renderWhatsNewDigestEmail(
      { month: "2026-11", notes, unsubscribeUrl: UNSUBSCRIBE_URL },
      { base: "light", themeChoice: "light" }
    );
    assert.ok(
      textContent.includes(
        "Faster search\nSearch answers in about half the time on large memories.\n\nThe assistant now says when a memory was last changed.\n\nTags <b>stay</b>\n"
      )
    );
  });

  it("ends with the link to Evermatter's public release list, after every note", () => {
    const { htmlContent, textContent } = renderWhatsNewDigestEmail(
      { month: "2026-11", notes, unsubscribeUrl: UNSUBSCRIBE_URL },
      { base: "dark", themeChoice: "dark" }
    );
    const link = "https://github.com/substrate-systems/evermatter/releases";
    assert.ok(textContent.indexOf(link) > textContent.indexOf("Tags <b>stay</b>"));
    const hrefs = [...new JSDOM(htmlContent).window.document.querySelectorAll("a")].map((a) =>
      a.getAttribute("href")
    );
    assert.ok(hrefs.includes(link));
  });

  it("escapes a note's text in the HTML and names the month in the subject", () => {
    const { htmlContent, subject } = renderWhatsNewDigestEmail(
      { month: "2026-11", notes, unsubscribeUrl: UNSUBSCRIBE_URL },
      { base: "light", themeChoice: "light" }
    );
    assert.equal(subject, "What's new in Evermatter, November");
    assert.ok(htmlContent.includes("Tags &lt;b&gt;stay&lt;/b&gt;"));
    assert.ok(!htmlContent.includes("<b>stay</b>"));
  });

  it("carries the unsubscribe link and its small print, in the preview too", () => {
    const real = renderWhatsNewDigestEmail(
      { month: "2026-11", notes, unsubscribeUrl: UNSUBSCRIBE_URL },
      { base: "light", themeChoice: "light" }
    );
    assert.ok(real.htmlContent.includes(UNSUBSCRIBE_URL));
    const preview = previewWhatsNewDigestEmail({ month: "2026-11", notes });
    for (const part of [preview.light, preview.dark, preview.text]) {
      assert.ok(part.includes("Turn this email off"));
      assert.ok(part.includes("You get this email once a month."));
    }
  });

  it("previews one light and one dark HTML, each on its own scheme", () => {
    const preview = previewWhatsNewDigestEmail({ month: "2026-11", notes });
    assert.ok(preview.light.includes('name="color-scheme" content="light"'));
    assert.ok(preview.dark.includes('name="color-scheme" content="dark"'));
    assert.notEqual(preview.light, preview.dark);
  });
});
