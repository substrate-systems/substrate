// Stand-ins at the browser import's two boundaries: the browser's origin-private storage and
// the C5 import API with its storage parts. The code under test runs unchanged against them.

type Folder = { files: Map<string, Uint8Array[]>; folders: Map<string, Folder> };

/** An in-memory origin-private file system: a writable commits only when it closes. */
export function browserStorageDouble(quota = 1e12) {
  const root: Folder = { files: new Map(), folders: new Map() };
  const notFound = () => new DOMException("No such entry", "NotFoundError");
  const folderHandle = (folder: Folder, name: string) => ({
    kind: "directory" as const,
    name,
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      if (!folder.folders.has(child)) {
        if (!options?.create) throw notFound();
        folder.folders.set(child, { files: new Map(), folders: new Map() });
      }
      return folderHandle(folder.folders.get(child)!, child);
    },
    async getFileHandle(file: string, options?: { create?: boolean }) {
      if (!folder.files.has(file)) {
        if (!options?.create) throw notFound();
        folder.files.set(file, []);
      }
      return {
        kind: "file" as const,
        name: file,
        async createWritable() {
          const pending: Uint8Array[] = [];
          return new WritableStream<Uint8Array>({
            write(chunk) {
              pending.push(Uint8Array.from(chunk));
            },
            close() {
              folder.files.set(file, pending);
            },
          });
        },
        async getFile() {
          const chunks = folder.files.get(file);
          if (!chunks) throw notFound();
          return new File(chunks as BlobPart[], file);
        },
      };
    },
    async removeEntry(entry: string) {
      if (!folder.files.delete(entry) && !folder.folders.delete(entry)) throw notFound();
    },
    async *entries() {
      for (const file of [...folder.files.keys()])
        yield [file, { kind: "file" as const, name: file }] as const;
      for (const [child, nested] of [...folder.folders])
        yield [child, folderHandle(nested, child)] as const;
    },
  });
  /** The files of the folder at this path, made on first use like the browser's own folders. */
  const files = (...path: string[]) => {
    let folder = root;
    for (const name of path) {
      if (!folder.folders.has(name))
        folder.folders.set(name, { files: new Map(), folders: new Map() });
      folder = folder.folders.get(name)!;
    }
    return folder.files;
  };
  const usage = (folder: Folder): number =>
    [...folder.files.values()].flat().reduce((total, chunk) => total + chunk.byteLength, 0) +
    [...folder.folders.values()].reduce((total, nested) => total + usage(nested), 0);
  return {
    files,
    storage: {
      getDirectory: async () => folderHandle(root, ""),
      estimate: async () => ({ quota, usage: usage(root) }),
      persist: async () => true,
    },
  };
}

/** Web Locks as the browser grants them to `ifAvailable` requests; `held` stands for other tabs. */
export function webLocksDouble() {
  const held = new Set<string>();
  return {
    held,
    locks: {
      async request<T>(
        name: string,
        _options: { ifAvailable: boolean },
        callback: (lock: { name: string } | null) => T | Promise<T>
      ): Promise<T> {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      },
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
