import assert from "node:assert/strict";
import test, { mock } from "node:test";

function containsTag(node: unknown, tag: string): boolean {
  if (Array.isArray(node)) return node.some((child) => containsTag(child, tag));
  if (!node || typeof node !== "object") return false;
  const element = node as { type?: unknown; props?: { children?: unknown } };
  return element.type === tag || containsTag(element.props?.children, tag);
}

function textContent(node: unknown): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return textContent((node as { props?: { children?: unknown } }).props?.children);
}

test("does not render authorization controls for an invalid continuation", async (context) => {
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: () => undefined }),
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      EXOMEM_OAUTH_CONTINUITY_COOKIE: "exomem_oauth_tx",
      EXOMEM_OAUTH_FORM_NONCE_COOKIE: "exomem_oauth_form_nonce",
      matchesOAuthConfirmationHandle: () => false,
      oauthFormNonceFromCookie: () => null,
      resolveOAuthContinuationToken: async () => null,
    },
  });
  mock.module("../../private-shell", {
    namedExports: {
      PrivateShell: ({ children }: { children: unknown }) => children,
    },
  });
  mock.module("../authorize-client", { defaultExport: () => null });
  context.after(() => mock.reset());

  const page = await import("../page");
  const rendered = await page.default({
    searchParams: Promise.resolve({ confirmation: "opaque-confirmation" }),
  });

  assert.match(textContent(rendered), /connection request is no longer active/i);
  assert.equal(containsTag(rendered, "form"), false);
  assert.equal(containsTag(rendered, "button"), false);
});
