## Why

A virgin Hosted install cannot authorize the first marketplace reviewer because
normal OAuth admission requires a live cohort or an already attributed internal
canary. The bootstrap must create that first attributed graph without opening a
public selector or a legacy-unmetered invite path.

## What Changes

- Add an operator-created, one-shot reviewer OAuth bootstrap authority bound to
  one delivered reviewer invite, one pending 0.39.2 candidate, one staged
  release, and one pinned loopback client.
- Atomically redeem its only OAuth continuation into a nonlegacy reviewer
  tenant, capacity allocation, preparing assignment, pre-snapshotted initial
  operation, setup session/grant/code, and durable outcome IDs.
- Fence client re-enablement, setup-code token exchange, and internal-canary
  issuance around that authority.

## Impact

The change is additive to Hosted OAuth and leaves normal live-cohort and
already-attributed internal-canary paths unchanged.
