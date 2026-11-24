## 1. Quiet apps on Home

- [x] 1.1 `appMeta` reads a signed-in app unused for 72 hours or more as quiet, with the date and the reconnect line.
- [x] 1.2 Unit tests: the 72-hour boundary, a signed-out or unknown row with an old use, a row without a recorded use.
- [x] 1.3 `openspec validate --all --strict`; tsc; eslint; scoped tests.
