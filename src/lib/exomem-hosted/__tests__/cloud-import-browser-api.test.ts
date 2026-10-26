import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { readBrowserImport, requestBrowserImport } from "../cloud-import-browser-api";
import { HostedBrowserError } from "../hosted-browser";
import { importStopFrom } from "../cloud-import-stop";

const importId = "2495eb8e-01ba-445f-ac61-e481c51b68b5";
const csrfToken = "synthetic-csrf";
let originalDocument: PropertyDescriptor | undefined;
beforeEach(() => {
  originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: `exomem_csrf=${csrfToken}` },
  });
});
afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});
const status = {
  import_id: importId,
  kind: "adopt",
  declared_bytes: 19,
  declared_files: 3,
  requested_state: "uploaded",
  observed_state: "importing",
  recipient: null,
  part_urls: null,
  urls_expire_at: null,
  error_code: null,
  ciphertext_sha256: "a".repeat(64),
  ciphertext_bytes: 1024,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

test("only a fetch TypeError reads as a dropped connection", async () => {
  const network = mock.method(globalThis, "fetch", async () => {
    throw new TypeError("network failure");
  });
  try {
    await assert.rejects(readBrowserImport(csrfToken), { code: "CONNECTION" });
    assert.equal(importStopFrom(new TypeError("application defect"))?.code, "STOPPED");
  } finally {
    network.mock.restore();
  }
});

test("an accepted upload remains importing and retains the controller observation", async () => {
  const receive: typeof fetch = async (_input, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    return Response.json({ import: status });
  };
  const network = mock.method(globalThis, "fetch", receive);
  try {
    assert.equal((await readBrowserImport(csrfToken, importId))?.observed_state, "importing");
  } finally {
    network.mock.restore();
  }
});

test("a failed status read does not turn into an empty import history", async () => {
  const network = mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: "UNAVAILABLE", message: "Try later." } }, { status: 503 })
  );
  try {
    await assert.rejects(readBrowserImport(csrfToken), HostedBrowserError);
  } finally {
    network.mock.restore();
  }
});

test("an unknown controller state is retained rather than reported as completed", async () => {
  const network = mock.method(globalThis, "fetch", async () =>
    Response.json({ import: { ...status, observed_state: "future_controller_phase" } })
  );
  try {
    assert.equal((await readBrowserImport(csrfToken))?.observed_state, "future_controller_phase");
  } finally {
    network.mock.restore();
  }
});

test("a mutation binds its reply to the same import and keeps session credentials on the account origin", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "exomem_csrf=synthetic-csrf" },
  });
  const receive: typeof fetch = async (input, init) => {
    assert.equal(String(input), "/api/exomem/cloud/imports");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-exomem-csrf"), "synthetic-csrf");
    assert.equal(JSON.parse(String(init?.body)).import_id, importId);
    return Response.json({
      import: { ...status, import_id: "c64f5378-866f-4e5a-9006-acb21f24dc8a" },
    });
  };
  const network = mock.method(globalThis, "fetch", receive);
  try {
    await assert.rejects(
      requestBrowserImport(csrfToken, importId, "create", {
        kind: "adopt",
        declared_bytes: 19,
        declared_files: 3,
      }),
      /did not match/
    );
  } finally {
    network.mock.restore();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("an account switch after selection refuses creation before sending the selected account's files", async () => {
  document.cookie = "exomem_csrf=another-account";
  const network = mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  try {
    await assert.rejects(
      requestBrowserImport(csrfToken, importId, "create", {
        kind: "adopt",
        declared_bytes: 19,
        declared_files: 3,
      }),
      (error: unknown) =>
        error instanceof HostedBrowserError && error.code === "IMPORT_ACCOUNT_CHANGED"
    );
    assert.equal(network.mock.callCount(), 0);
  } finally {
    network.mock.restore();
  }
});

test("a status response from a newly signed-in account cannot replace the original account's import", async () => {
  const network = mock.method(globalThis, "fetch", async () => {
    document.cookie = "exomem_csrf=another-account";
    return Response.json({ import: status });
  });
  try {
    await assert.rejects(
      readBrowserImport(csrfToken),
      (error: unknown) =>
        error instanceof HostedBrowserError && error.code === "IMPORT_ACCOUNT_CHANGED"
    );
  } finally {
    network.mock.restore();
  }
});
