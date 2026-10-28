import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  discardOtherKeptCiphertext,
  otherKeptCiphertext,
  sweepKeptCiphertext,
  holdImport,
} from "../cloud-import-browser-file";
import { browserStorageDouble, webLocksDouble } from "./browser-import-doubles";

let saved: PropertyDescriptor | undefined;
beforeEach(() => {
  saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
});
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, "navigator", saved);
  else Reflect.deleteProperty(globalThis, "navigator");
});

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

test("a slow sweep status read leaves the import lock free for a resuming tab", async () => {
  const browser = browserStorageDouble();
  const tabs = webLocksDouble();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: browser.storage, locks: tabs.locks },
  });
  const importId = id("1");
  const mine = browser.files("exomem-import-uploads", "account-MINE");
  mine.set(`${importId}.age`, [new Uint8Array(10)]);
  let finishRead!: (retired: boolean) => void;
  const read = new Promise<boolean>((resolve) => {
    finishRead = resolve;
  });
  const sweeping = sweepKeptCiphertext("MINE", null, () => read);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await holdImport(importId, async () => {
    finishRead(false);
    await sweeping;
  });
  assert.ok(mine.has(`${importId}.age`));
});

test("a sweep removes only this account's ended, unheld copies; other accounts' copies wait for a discard", async () => {
  const browser = browserStorageDouble();
  const tabs = webLocksDouble();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: browser.storage, locks: tabs.locks },
  });
  const [open, ended, endedButHeld, otherAccount, beforeFolders] = ["1", "2", "3", "4", "5"].map(
    id
  );
  const mine = browser.files("exomem-import-uploads", "account-MINE");
  for (const importId of [open, ended, endedButHeld])
    mine.set(`${importId}.age`, [new Uint8Array(10)]);
  // A write in progress shows its swap file beside the copy.
  mine.set(`${open}.age.crswap`, [new Uint8Array(3)]);
  browser
    .files("exomem-import-uploads", "account-OTHER")
    .set(`${otherAccount}.age`, [new Uint8Array(700)]);
  browser.files("exomem-import-uploads").set(`${beforeFolders}.age`, [new Uint8Array(300)]);
  tabs.held.add(`exomem-import:${endedButHeld}`);

  // A stale page knows no open import; only the fresh read keeps the open import's copy.
  await sweepKeptCiphertext("MINE", null, async (importId) => importId !== open);

  assert.deepEqual(
    [...mine.keys()].sort(),
    [`${open}.age`, `${open}.age.crswap`, `${endedButHeld}.age`].sort()
  );
  assert.deepEqual(await otherKeptCiphertext("MINE"), { files: 2, bytes: 1000 });

  tabs.held.add(`exomem-import:${otherAccount}`);
  assert.deepEqual(await discardOtherKeptCiphertext("MINE"), { kept: 1 });
  assert.deepEqual(await otherKeptCiphertext("MINE"), { files: 1, bytes: 700 });
  assert.equal(mine.size, 3);
});
