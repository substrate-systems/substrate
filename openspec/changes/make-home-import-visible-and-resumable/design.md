# Design

## Decisions

1. Close and Esc hide the dialog and keep the work running. The Home row shows the measured progress. A pause comes only from the Pause button, from new uploads becoming unavailable, or from leaving the page. Leaving the page during encryption or upload asks the browser to confirm first.
2. The ciphertext file in origin-private storage is named `<import ID>.age`. The name is the mapping, so a reload, a remount after a new sign-in, or another tab finds the same file. A Web Lock on the import ID keeps a second tab from writing the same file.
3. Before an import has an upload report, a resumed page encrypts again from the same folder chosen again. Creation is idempotent only for the same declaration, so the dialog compares the selection's file count and bytes with the declared values before it creates.
4. After an import has an upload report, the report is fixed. The page checks the kept file's size and SHA-256 against the report before it repeats `prepare-upload` and sends the parts again. A missing or different file leaves cancellation as the only route.
5. The encrypted size comes from the libraries themselves: a TAR pass with the real headers and zero bodies gives the archive size, and age's stream size function gives the ciphertext size. A throwaway X25519 recipient stands in until the cell issues its recipient; the encryption step measures again with the issued recipient.
6. The browser-space check refuses before creation. The vault check only warns, because its reading can be stale. The part ceiling is shown, and the browser checks it when the upload links arrive, because the cell sets the part size.
7. Hidden items (a path segment that starts with a dot) and the folder's own `.gitignore` matches are left out by default. Each left-out file counts once, under the first reason that still applies.

## Not in this change

- The cell's member, path and name limits and the 24-hour upload window. They need a published limits contract before the website can show them.
- Symbolic links. A folder input does not tell the page which entries are links.
