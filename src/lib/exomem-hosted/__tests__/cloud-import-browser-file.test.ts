import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  discardOtherKeptCiphertext,
  otherKeptCiphertext,
  sweepKeptCiphertext,
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

test("a sweep removes only this account's ended, unheld copies and labels; other accounts' wait for a discard", async () => {
  const browser = browserStorageDouble();
  const tabs = webLocksDouble();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: browser.storage, locks: tabs.locks },
  });
  const [open, ended, endedButHeld, otherAccount, beforeFolders, otherLabelOnly] = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ].map(id);
  const mine = browser.files("exomem-import-uploads", "account-MINE");
  for (const importId of [open, ended, endedButHeld])
    mine.set(`${importId}.age`, [new Uint8Array(10)]);
  // A label stays beside its import's copy only while the import is open, even once the copy
  // has gone after an interrupted encryption.
  for (const importId of [open, ended, id("7")]) mine.set(`${importId}.label`, [new Uint8Array(3)]);
  // A write in progress shows its swap file beside the copy.
  mine.set(`${open}.age.crswap`, [new Uint8Array(3)]);
  const other = browser.files("exomem-import-uploads", "account-OTHER");
  other.set(`${otherAccount}.age`, [new Uint8Array(700)]);
  for (const importId of [otherAccount, otherLabelOnly])
    other.set(`${importId}.label`, [new Uint8Array(3)]);
  browser.files("exomem-import-uploads").set(`${beforeFolders}.age`, [new Uint8Array(300)]);
  tabs.held.add(`exomem-import:${endedButHeld}`);

  // A stale page knows no open import; only the fresh read keeps the open import's copy.
  await sweepKeptCiphertext("MINE", null, async (importId) => importId !== open);

  assert.deepEqual(
    [...mine.keys()].sort(),
    [`${open}.age`, `${open}.age.crswap`, `${open}.label`, `${endedButHeld}.age`].sort()
  );
  // Labels are no copies: they count neither as files nor as bytes.
  assert.deepEqual(await otherKeptCiphertext("MINE"), { files: 2, bytes: 1000 });

  tabs.held.add(`exomem-import:${otherAccount}`);
  assert.deepEqual(await discardOtherKeptCiphertext("MINE"), { kept: 1 });
  assert.deepEqual(await otherKeptCiphertext("MINE"), { files: 1, bytes: 700 });
  assert.deepEqual(
    [...other.keys()].sort(),
    [`${otherAccount}.age`, `${otherAccount}.label`].sort()
  );
  assert.equal(mine.size, 4);
});
