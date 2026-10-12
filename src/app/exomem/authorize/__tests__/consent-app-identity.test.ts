import assert from "node:assert/strict";
import test, { mock } from "node:test";

function textContent(node: unknown): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return textContent((node as { props?: { children?: unknown } }).props?.children);
}

// Any client can declare any name, "Claude" included. A page that shows only
// that name lets a lookalike collect a code at its own host while the owner
// believes they are connecting Claude.
test("shows where the code goes whenever Exomem does not vouch for the app's name", async (context) => {
  let app = {
    displayName: "Claude",
    displayNameSource: "client_metadata",
    platform: null as string | null,
    loopback: false,
    redirectHost: "evil.example.test",
  };
  mock.module("next/headers", {
    namedExports: { cookies: async () => ({ get: () => undefined }) },
  });
  mock.module("@/lib/exomem-hosted/consent-view", {
    namedExports: {
      loadConsentView: async () => ({
        step: "sign-in",
        app,
        scopes: ["exomem.read", "exomem.write"],
        confirmation: "confirmation",
        nonce: "nonce",
        cellStarting: false,
        reviewerEnabled: false,
      }),
    },
  });
  mock.module("../../private-shell", {
    namedExports: { PrivateShell: ({ children }: { children: unknown }) => children },
  });
  mock.module("../authorize-client", { defaultExport: () => null });
  context.after(() => mock.reset());
  const page = await import("../page");
  const render = async () =>
    textContent(await page.default({ searchParams: Promise.resolve({ confirmation: "c" }) }));

  const selfNamed = await render();
  assert.match(selfNamed, /evil\.example\.test/);
  assert.match(selfNamed, /Claude \(the name this app gives itself\)/);

  app = {
    displayName: "localhost",
    displayNameSource: "redirect_host",
    platform: null,
    loopback: true,
    redirectHost: "localhost",
  };
  assert.match(await render(), /this computer/);
});
