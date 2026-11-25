## ADDED Requirements

### Requirement: Home accepts files, folders and zips from any device

Home's import SHALL accept one or more files, a folder, or zips, chosen by drag-and-drop or by picker, in a desktop or phone browser.

#### Scenario: A person adds photos from a phone

- **WHEN** a person on a phone browser chooses twelve photos from the photo library
- **THEN** the preflight shows twelve files and their total size, and the import sends them

### Requirement: Home expands zips in the browser

A file whose name ends in `.zip` SHALL be expanded in the browser into a folder named after the zip, streamed without loading the whole zip into memory. An entry that is encrypted or uses an unsupported compression method SHALL be left out and listed with its reason in the preflight. Other archive-like formats, such as `.docx` and `.epub`, SHALL be sent as files.

#### Scenario: A person drops a zip and two loose files

- **WHEN** a person drops `notes.zip` and two PDFs on Home
- **THEN** the preflight counts the zip's entries under `notes/` plus the two PDFs, and lists any entry it left out with its reason

### Requirement: Home asks the cell to file an import and states its origin

Home SHALL write the series file with `"filing": "cell"` and an `origin` holding the person's optional label, the device family and the browser family. The device and browser family SHALL each be one value from a fixed set taken from the browser's client hints, else `other`. Each archive member SHALL carry the file's last-modified time. A folder selection SHALL keep the folder's name as the collection name. Home SHALL NOT offer to include hidden files on this route.

#### Scenario: A labelled upload

- **WHEN** a person types "Notion export" in "Where is this from?" and imports a folder named `Workspace`
- **THEN** the series file carries the label, the device and browser family and `"filing": "cell"`, and the collection is named `Workspace`

### Requirement: Home names the collection of a selection without one folder

A selection of loose files, or of several folders and zips, SHALL take the person's label from "Where is this from?" as its collection name. Without a label it SHALL carry no collection name.

#### Scenario: Loose photos with a label

- **WHEN** a person labels twelve loose photos "Holiday 2026" and imports them
- **THEN** the series file names the collection "Holiday 2026"

### Requirement: Home shows what the cell filed

After the upload, Home SHALL read the cell's filing view and show its state: working with the filed and remaining counts, paused with its reason and next step, done, or unknown. It SHALL show a time left only when the cell reports a rate, labelled "at the measured rate". When filing is done, Home SHALL show the filed count, the skipped duplicates, and each left-out file with its reason.

#### Scenario: Filing finishes without an assistant

- **WHEN** the cell reports `done` for an import of 40 files, 38 filed and 2 left out
- **THEN** Home shows 38 filed and lists the 2 left-out files with their reasons, and asks for no assistant step

### Requirement: Home falls back on a cell without the filer

When the cell does not offer the filing view, Home SHALL show that the files are staged and SHALL offer the assistant prompt it shows today.

#### Scenario: An older cell

- **WHEN** the cell refuses the filing view
- **THEN** Home shows that the files are staged and offers the assistant prompt
