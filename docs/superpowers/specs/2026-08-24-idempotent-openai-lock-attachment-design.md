# Idempotent OpenAI Lock Attachment

## Context

The hosted-promotion `prepare` command attaches operator-signed OpenAI package
and archive locks to a pending contract candidate before it creates any staged
release, OAuth client, or invite. The attachment is permanent. If `prepare`
stops after that first write, its retry currently receives `attached: false`
even when the stored locks are byte-for-byte equivalent JSON values. The
harness then refuses to continue, leaving a valid pending candidate unusable by
the encoded promotion workflow.

## Contract

`attachOpenAiContractLocks` returns `true` in either of two cases:

1. the pending candidate has no OpenAI locks and the supplied, validated,
   correctly signed locks are attached; or
2. the pending candidate already contains exactly the supplied package and
   archive locks.

It returns `false` when the candidate does not exist, is not pending, its
contract digests do not match the supplied locks, only one lock is present, or
either stored lock differs from the supplied value. Existing locks are never
overwritten with different content.

Signature and lock-shape validation remain unchanged and happen before the
database operation.

## Implementation

Keep the behavior in the existing single database statement. Extend its row
eligibility from “both locks are null” to “both locks are null or both equal the
validated supplied JSONB values.” The statement may assign the same values on
an identical retry; this preserves atomicity under concurrent calls and avoids
a read-then-write race.

No route or response-shape change is needed: the existing
`{ "attached": boolean }` response now describes whether the requested exact
lock state is established safely.

## Verification

Add a regression test that performs the same signed attachment twice and
expects both calls to succeed. Add or preserve coverage proving a second call
with validly signed but different locks returns `false` and leaves the first
locks intact. Run the focused unit and PostgreSQL integration tests, then the
repository's normal test command before delivery.

## Scope

This change does not alter candidate creation, lock validation, signing,
promotion, Paddle billing, or invitation behavior. Its only purpose is to make
the already-safe preparation step retryable.
