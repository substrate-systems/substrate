import assert from "node:assert/strict";
import { it } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChallengeError, useTurnstile } from "../turnstile";

async function mountChallenge() {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', { url: "http://localhost" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  type Options = Parameters<NonNullable<Window["turnstile"]>["render"]>[1];
  let options: Options | undefined;
  let issued = 0;
  let challenge: ReturnType<typeof useTurnstile> | undefined;
  const provider: NonNullable<Window["turnstile"]> = {
    render: (_container, configuration) => {
      options = configuration;
      return "widget";
    },
    execute: () => {
      const token = `provider-token-${++issued}`;
      queueMicrotask(() => options!.callback(token));
    },
    reset: () => {},
    remove: () => {},
  };
  window.turnstile = provider;
  function Form() {
    challenge = useTurnstile("provider-test-key");
    return createElement("div", { ref: challenge.mount });
  }
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(createElement(Form)));
  return {
    challenge: challenge!,
    provider,
    issued: () => issued,
    expire: () => options!["expired-callback"](),
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

it("prepares a token before submit and replaces it when a slow typist's token expires", async () => {
  const { challenge, issued, expire, close } = await mountChallenge();
  try {
    assert.equal(issued(), 0, "initial page load must not run the challenge");
    await act(async () => {
      await challenge.start();
    });
    assert.equal(issued(), 1, "typing must prepare a token before submit");
    assert.equal(await challenge.token(), "provider-token-1");
    await act(async () => expire());
    assert.equal(
      await challenge.token(),
      "provider-token-2",
      "submit must never use the expired token"
    );
    challenge.reset();
    assert.equal(
      await challenge.token(),
      "provider-token-3",
      "a retry needs a token that has not been spent"
    );
  } finally {
    await close();
  }
});

it(
  "reports a provider startup failure instead of leaving Sending pending, and allows retry",
  { timeout: 1000 },
  async () => {
    const { challenge, provider, close } = await mountChallenge();
    const execute = provider.execute;
    try {
      provider.execute = () => {
        throw new Error("provider failed to start");
      };
      await assert.rejects(challenge.token(), ChallengeError);
      provider.execute = execute;
      assert.equal(await challenge.token(), "provider-token-1");
    } finally {
      await close();
    }
  }
);
