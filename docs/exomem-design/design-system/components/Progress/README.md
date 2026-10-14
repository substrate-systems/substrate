# Progress

A status line for any process: the writing E beside what is happening now, cross-fading as each step passes.

**You provide** `steps` (one short label per step, in order), `step` (0-based; `steps.length` = done), `doneLabel`, and `failed` (a message) when it fails. `count` adds "2 of 4 · ". `size` defaults to 22 (the small cut).

**Use it** for payments, imports, restores, exports, connecting an assistant. Labels say what is happening in the person's terms ("Your bank approves"), never how our system works inside.
