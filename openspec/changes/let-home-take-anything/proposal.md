# Let Home take anything

## Why

Home's import takes one folder from a desktop browser and stops at "staged". A person then has to ask ChatGPT or Claude to file the staged files. A person who wants to add a few photos from their phone, a zip from another app, or some loose files cannot do it from Home. A person without an assistant gets nothing searchable at all.

The cell can now file an import by itself and record where it came from (evermatter change `file-imports-on-the-cell`). Home needs to send what the person chose, ask the cell to file it, and show the result.

## What changes

- **Any selection.** Home accepts loose files, several files, a folder or zips, by drag-and-drop or by picker. On a phone the multi-file picker opens the photo library and files. A `.zip` is expanded in the browser into a folder named after it; its encrypted or unsupported entries are left out with a reason in the preflight.
- **Filing on the cell.** Home writes the series file with `"filing": "cell"` and an `origin`: the person's optional label ("Where is this from?") and the coarse device and browser family. Each archive member carries the file's modification time. Home keeps the chosen folder's name as the collection name. The hidden-files opt-in leaves this route, because the cell never files hidden files.
- **The result.** Home reads the cell's filing view and shows progress while the cell files, then what was filed and what was left out with each reason. A time left appears only as "at the measured rate". On a cell without the filer, Home keeps today's assistant prompt.

## Capabilities

### Modified Capabilities

- `exomem-home`: Home accepts any selection, asks the cell to file it with its origin, and shows what was filed.

## Impact

- **Code:** `src/app/exomem/home/home-import*.tsx`, `src/lib/exomem-hosted/cloud-import-browser*.ts`, `cloud-import-selection.ts`, the Home status read in `cloud-home-mcp.ts`, and a zip reader dependency (`@zip.js/zip.js`).
- **Depends on:** a cell release that carries `file-imports-on-the-cell`. Home detects an older cell and falls back.
- **Unchanged:** the C5 import contract, encryption, the presigned upload and the control plane.
- **Out of scope:** admission against published limits (#292), and undoing a filed import (its own change).
