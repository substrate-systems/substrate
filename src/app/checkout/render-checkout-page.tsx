import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

/** Renders the checkout page for a query string into a jsdom document; returns the unmount. */
export async function renderCheckoutPage(query: string) {
  const { default: CheckoutPage } = await import("./page");
  const element = await CheckoutPage({
    searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(query))),
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
    url: `https://substratesystems.io/checkout${query ? `?${query}` : ""}`,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(element));
  return async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
