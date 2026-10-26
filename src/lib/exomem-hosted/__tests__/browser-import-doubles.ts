// Stand-ins at the browser import's two boundaries: the browser's origin-private storage and
// the C5 import API with its storage parts. The code under test runs unchanged against them.

/** An in-memory origin-private file system: a writable commits only when it closes. */
export function browserStorageDouble(quota = 1e12) {
  const files = new Map<string, Uint8Array[]>();
  const notFound = () => new DOMException("No such entry", "NotFoundError");
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw notFound();
        files.set(name, []);
      }
      return {
        async createWritable() {
          const pending: Uint8Array[] = [];
          return new WritableStream<Uint8Array>({
            write(chunk) {
              pending.push(Uint8Array.from(chunk));
            },
            close() {
              files.set(name, pending);
            },
          });
        },
        async getFile() {
          const chunks = files.get(name);
          if (!chunks) throw notFound();
          return new File(chunks as BlobPart[], name);
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw notFound();
    },
    async *keys() {
      yield* [...files.keys()];
    },
  };
  const usage = () =>
    [...files.values()].flat().reduce((total, chunk) => total + chunk.byteLength, 0);
  return {
    files,
    storage: {
      getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
      estimate: async () => ({ quota, usage: usage() }),
      persist: async () => true,
    },
  };
}

type Row = Record<string, unknown> & { import_id: string };

/**
 * C5's import routes as the server and controller answer them: creation and the upload report
 * are idempotent, part links follow the report, and completion moves the import to importing.
 */
export function importApiDouble(recipient: string, partBytes = 128) {
  const rows = new Map<string, Row>();
  const requests: { path: string; body?: Record<string, unknown> }[] = [];
  const parts: { url: string; bytes: Uint8Array }[] = [];
  const refusals = new Set<string>();
  let held: Promise<void> | null = null;
  const receive: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("https://storage.example.test/")) {
      const body = init?.body as Blob;
      const signal = init?.signal;
      // A held part waits like a slow network until it is released or the browser aborts it.
      if (held)
        await Promise.race([
          held,
          new Promise((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          ),
        ]);
      parts.push({ url: path, bytes: new Uint8Array(await body.arrayBuffer()) });
      const part = path.split("/").pop()!;
      if (refusals.delete(part)) return new Response(null, { status: 503 });
      return new Response(null, { headers: { etag: `"${part}"` } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    if (path === "/api/exomem/cloud/imports" && init?.method !== "POST") {
      // Status without an ID prefers the open import, as the route does.
      const open = [...rows.values()].find((row) => row.requested_state === "requested");
      return Response.json({ import: open ?? [...rows.values()].at(-1) ?? null });
    }
    if (path === "/api/exomem/cloud/imports" && init?.method === "POST") {
      const existing = rows.get(body.import_id);
      if (!existing)
        rows.set(body.import_id, {
          ...body,
          requested_state: "requested",
          observed_state: "key_ready",
          recipient,
          part_urls: null,
          urls_expire_at: null,
          error_code: null,
          ciphertext_sha256: null,
          ciphertext_bytes: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        });
      return Response.json({ import: rows.get(body.import_id) });
    }
    const id = path.split("/")[5];
    const row = rows.get(id);
    if (!row) return Response.json({ error: { code: "IMPORT_NOT_FOUND" } }, { status: 404 });
    if (path.endsWith("/prepare-upload")) {
      if (row.ciphertext_sha256 === null) {
        const total = body.ciphertext_bytes as number;
        const urls = [];
        for (let offset = 0, n = 1; offset < total; offset += partBytes, n += 1)
          urls.push({
            part_number: n,
            url: `https://storage.example.test/${id}/${n}`,
            part_size_bytes: Math.min(partBytes, total - offset),
          });
        Object.assign(row, body, {
          part_urls: urls,
          urls_expire_at: new Date(Date.now() + 60_000).toISOString(),
        });
      } else if (row.ciphertext_sha256 !== body.ciphertext_sha256) {
        return Response.json({ error: { code: "IMPORT_CONFLICT" } }, { status: 409 });
      }
    } else if (path.endsWith("/complete")) {
      Object.assign(row, { requested_state: "uploaded", observed_state: "importing" });
    }
    return Response.json({ import: row });
  };
  return {
    rows,
    requests,
    parts,
    receive,
    /** Storage answers this part number's next upload with a server error. */
    refusePartOnce(partNumber: number) {
      refusals.add(String(partNumber));
    },
    /** Holds every storage upload until the returned function releases them. */
    holdParts(): () => void {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
  };
}
