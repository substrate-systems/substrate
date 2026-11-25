## 1. Selection

- [ ] 1.1 Add a drop zone and a multi-file picker beside the folder picker, for desktop and phone. Verify: component tests for files, a folder and a mix, and a Chrome DevTools pass at desktop and phone widths in both themes.
- [ ] 1.2 Expand `.zip` files in the browser with `@zip.js/zip.js`, streamed, under `<zip stem>/`. Leave out encrypted and unsupported entries with reasons. Verify: tests with a ZIP64 fixture, an encrypted entry and a `.docx` that stays whole.

## 2. Filing request and origin

- [ ] 2.1 Write `filing` and `origin` into the series file. Set member `mtime` from `lastModified`. Keep the folder name as the collection name. Remove the hidden-files opt-in from this route. Verify: a test decrypts a built archive with a test key and checks the series file, the member times and the collection name against the selection.

## 3. Result

- [ ] 3.1 Read the cell's filing view through the Home owner channel and show working, paused, done and unknown, with counts and left-out reasons. Fall back to the assistant prompt when the cell refuses the view. Verify: component tests for each state against a synthetic API, and a Chrome DevTools pass of each state.

## 4. Delivery

- [ ] 4.1 Run the Playwright import spec against the shared golden fixture, the independent review and the merge, after a cell release with `file-imports-on-the-cell`.
- [ ] 4.2 On real phones (iOS Safari, Android Chrome), import photos into a sandbox cell and confirm that they are filed with their origin. This needs the operator's hands.
