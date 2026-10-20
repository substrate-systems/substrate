import assert from "node:assert/strict";
import test from "node:test";
import { inboxUrl, phoneMailApp } from "@/lib/exomem/inbox";
import { createInboxProviderLookup } from "../inbox-provider";

test("a public provider domain supplies its inbox even when DNS is unavailable", async () => {
  const lookup = createInboxProviderLookup(async () => {
    throw new Error("DNS unavailable");
  });
  assert.equal(await lookup("GMAIL.COM"), "gmail");
  assert.equal(await lookup("hotmail.com"), "outlook");
  assert.equal(await lookup("example.test"), null);
});

test("a custom domain uses its public mail host and caches the hint until expiry", async () => {
  let time = 0;
  let exchange = "aspmx.l.google.com";
  const lookup = createInboxProviderLookup(
    async () => [{ priority: 10, exchange }],
    () => time
  );
  assert.equal(await lookup("example.test"), "gmail");
  exchange = "example-test.mail.protection.outlook.com";
  assert.equal(await lookup("example.test"), "gmail");
  time += 5 * 60 * 1_000;
  assert.equal(await lookup("example.test"), "outlook-work");
});

test("lookalike mail hosts and addresses do not identify a provider", async () => {
  const lookup = createInboxProviderLookup(async () => [
    { priority: 0, exchange: "google.com.unrelated.test" },
  ]);
  assert.equal(await lookup("example.test"), null);
  assert.equal(await lookup("person@gmail.com"), null);
  assert.equal(await lookup("gmail.com/path"), null);
});

test("an inbox link keeps submitted text inside URL values", () => {
  const address = "name+tag&other=value@gmail.com";
  const url = new URL(inboxUrl("gmail", address)!);
  assert.equal(url.origin, "https://mail.google.com");
  assert.equal(url.searchParams.get("authuser"), address);
  assert.equal(url.searchParams.get("other"), null);
  assert.equal(inboxUrl("outlook-work", address), "https://outlook.office.com/mail/");
  assert.equal(inboxUrl("unknown", address), null);
});

test("an unknown provider opens each phone's own mail app and gives a desktop no link", () => {
  assert.equal(
    phoneMailApp(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
    ),
    "message://"
  );
  assert.match(
    phoneMailApp("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Mobile Safari/537.36")!,
    /^intent:#Intent;.*category=android\.intent\.category\.APP_EMAIL;end$/
  );
  assert.equal(
    phoneMailApp("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0"),
    null
  );
});
