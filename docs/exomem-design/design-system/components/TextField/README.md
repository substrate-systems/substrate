# TextField

A text field that follows the Exomem validation rules: judged when you leave it, re-checked as you fix it.

**You provide** `label`, `value`/`onChange` (or let it hold its own), `validate(value)` returning a message under about 45 characters that says what to do, `hint`, `error` for a server error on this field, `optional`, and `checkSignal` (bump it on submit). `onChangeRequest` makes it read-only with a real Change button inside.

**Rules.** Forms use `novalidate`; the browser never shows its bubbles. Never judge while someone types for the first time. Once an error shows, it goes the moment the value is fixed. On submit, focus the first field with an error and clear nothing. Never say whether an account exists. Errors are ink, not red or amber; amber is focus. Mark the rare optional field "(optional)"; no asterisks.
