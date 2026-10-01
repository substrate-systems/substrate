import assert from "node:assert/strict";
import test, { mock } from "node:test";

test("passes reviewer access only for an active authorization continuation", async (context) => {
  const AuthorizeClient = () => null;
  let cloud = false;
  let enabled = true;
  let resource = "https://cloud.example.test/mcp/v1";
  mock.module("@/lib/exomem-hosted/cloud-config", {
    namedExports: {
      exomemCloudEnabled: () => cloud,
      loadExomemCloudResource: () => ({
        mcpUrl: "https://cloud.example.test/mcp/v1",
        mcpPath: "/api/exomem/cloud/mcp/v1",
      }),
    },
  });
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({
        get: (name: string) => ({ value: name === "exomem_oauth_tx" ? "transaction" : "nonce" }),
      }),
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      EXOMEM_OAUTH_CONTINUITY_COOKIE: "exomem_oauth_tx",
      EXOMEM_OAUTH_FORM_NONCE_COOKIE: "exomem_oauth_form_nonce",
      matchesOAuthConfirmationHandle: () => true,
      oauthFormNonceFromCookie: () => "nonce",
      resolveOAuthContinuationToken: async () => ({
        clientId: "reviewer-client",
        scopes: ["exomem.read"],
        resource,
      }),
    },
  });
  mock.module("@/lib/exomem-hosted/reviewer-access", {
    namedExports: { marketplaceReviewerAccessEnabled: () => enabled },
  });
  mock.module("../../private-shell", {
    namedExports: { PrivateShell: ({ children }: { children: unknown }) => children },
  });
  mock.module("../authorize-client", {
    defaultExport: AuthorizeClient,
  });
  context.after(() => mock.reset());

  const page = await import("../page");
  const rendered = await page.default({
    searchParams: Promise.resolve({ confirmation: "opaque-confirmation" }),
  });
  const stack = [rendered as unknown];
  let clientProps: { reviewerEnabled?: boolean } | null = null;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const element = node as {
      type?: unknown;
      props?: { children?: unknown; reviewerEnabled?: boolean };
    };
    if (element.type === AuthorizeClient) {
      clientProps = element.props ?? null;
      break;
    }
    const children = element.props?.children;
    if (Array.isArray(children)) stack.push(...children);
    else stack.push(children);
  }

  assert.equal(clientProps?.reviewerEnabled, true);
  const reviewerEnabled = async () => {
    const result = await page.default({
      searchParams: Promise.resolve({ confirmation: "opaque-confirmation" }),
    });
    const pending = [result as unknown];
    while (pending.length) {
      const node = pending.pop() as {
        type?: unknown;
        props?: { children?: unknown; reviewerEnabled?: boolean };
      } | null;
      if (!node || typeof node !== "object") continue;
      if (node.type === AuthorizeClient) return node.props?.reviewerEnabled;
      const children = node.props?.children;
      if (Array.isArray(children)) pending.push(...children);
      else pending.push(children);
    }
  };
  cloud = true;
  assert.equal(await reviewerEnabled(), true);
  resource = "https://hosted.example.test/mcp";
  assert.equal(await reviewerEnabled(), false);
  resource = "https://cloud.example.test/mcp/v1";
  enabled = false;
  assert.equal(await reviewerEnabled(), false);
});
