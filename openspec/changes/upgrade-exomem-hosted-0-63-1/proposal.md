## Why

Exomem Hosted still serves the `0.57.2` `hosted-alpha-agent-v1` contract, which limits Claude and ChatGPT to 13 tools even though stable Exomem `0.63.1` contains the reviewed `hosted-alpha-agent-v4` 25-tool surface. The paid private alpha needs that exact stable release and profile now, using the existing same-cell rollforward and paired-review promotion flow rather than another bespoke migration.

## What Changes

- Trust exact Exomem release `0.63.1` at commit `35f6d7bb` and import its signed `hosted-alpha-agent-v4` Claude and OpenAI artifacts.
- Make the selected candidate profile authoritative throughout contract generation, gateway routing, OAuth admission, lifecycle observation, reviewer evidence, and promotion so the v4 profile can expose all 25 registered commands.
- Retain earlier v1 releases and artifacts as explicit rollback/catalog units; do not reinterpret them as v4.
- Update the hosted-alpha runbook and operational harness pins for the exact 0.63.1/v4 rollforward, paired Claude/ChatGPT review, and one-shot promotion.
- Reject profile downgrades, mismatched contract artifacts, stale reviewer evidence, and reuse of the expired 0.57.2 promotion ceremony.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-gateway`: The gateway must serve and execute the exact registry-derived contract for the candidate's selected release and profile, including the v4 25-tool surface, without hand-maintained command allowlists.
- `exomem-tenant-control-plane`: Admission, same-cell rollforward, review evidence, and promotion must remain bound to the candidate's exact release/profile tuple while preserving retained legacy release/profile units.

## Impact

This affects the hosted contract generator and catalog, gateway command and contract routes, OAuth and lifecycle stores, promotion/runtime evidence, generated Claude and OpenAI fixtures, release/profile trust reports, tests, and the hosted-alpha operations runbook. Production deployment uses the existing control-plane deployment and same-cell runtime rollforward mechanisms; the public self-serve Exomem product is out of scope.
