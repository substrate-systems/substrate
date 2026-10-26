# Design

## Decisions

1. Close and Esc hide the dialog and keep the work running. The Home row shows the measured progress. A pause comes only from the Pause button, from new uploads becoming unavailable, or from leaving the page. Leaving the page during encryption or upload asks the browser to confirm first.
2. The ciphertext file in origin-private storage is named `<import ID>.age`, in a folder for the account's stable support reference. The name is the mapping, so a reload, a remount after a new sign-in, or another tab finds the same file. A Web Lock on the import ID keeps a second tab from writing the same file.
3. A page removes one of its account's copies only while it can take that import's lock and a fresh status read shows that the import is absent or no longer waits for an upload. A page's own view can be stale, and a copy can be the only way to continue an open import. Names that are not `<UUID>.age`, such as a browser's `.crswap` file, are never touched. Other accounts' folders, and copies from before account folders, are only counted; the owner discards them with an explicit action, which still skips copies that a tab holds.
4. Before an import has an upload report, a resumed page encrypts again from the same folder chosen again. Creation is idempotent only for the same declaration, so the dialog compares the selection's file count and bytes with the declared values before it creates.
5. After an import has an upload report, the report is fixed. The page checks the kept file's size and SHA-256 against the report before it repeats `prepare-upload` and sends the parts again. A missing or different file leaves cancellation as the only route.
6. The encrypted size comes from the libraries themselves: a TAR pass with the real headers and zero bodies gives the archive size, and age's stream size function gives the ciphertext size. A throwaway X25519 recipient stands in until the cell issues its recipient; the encryption step measures again with the issued recipient.
7. The browser-space check refuses before creation. The vault check only warns, because its reading can be stale. The cell sets the part size, so the browser checks the 10,000-part ceiling when the upload links arrive, not in the preflight.
8. Hidden items (a path segment that starts with a dot) and the folder's own `.gitignore` matches are left out by default. Each left-out file counts once, under the first reason that still applies. A `.gitignore` larger than 4 MiB is not read as rules, the same limit as the Exomem CLI, and the dialog says that its rules are not applied.
9. A browser's fetch reports an upload body that it cannot read as a network failure. When a part fails that way, the page reads one byte of the part: a failed read means the kept copy is lost, and the import stops with `LOCAL_COPY_MISSING` instead of offering a resume that cannot succeed.

## Not in this change

- The cell's member, path and name limits and the 24-hour upload window. They need a published limits contract before the website can show them.
- Symbolic links. A folder input does not tell the page which entries are links.
