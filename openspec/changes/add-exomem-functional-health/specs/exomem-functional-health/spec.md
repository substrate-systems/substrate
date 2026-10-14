# Functional health

## Purpose

Publish recent evidence that control, transactional email and synthetic memory operations work without revealing account data or changing customer admission.

## ADDED Requirements

### Requirement: Public health reads recent functional evidence
Public GET readers SHALL return 200 with `{"ok":true}` only for the latest successful, fresh proof of their component. Missing, stale, failed, malformed or unreadable evidence SHALL return 503 with `{"ok":false}`. Reads SHALL finish within one second and SHALL perform no sends or mutations. Responses SHALL disable caching and reveal no account or synthetic content.

#### Scenario: A newer failure supersedes success
- **WHEN** a component has a recent successful proof and a newer failed proof
- **THEN** its public reader returns 503 instead of presenting the older success as current health

#### Scenario: Evidence cannot be read
- **WHEN** the database is unavailable or the proof has expired
- **THEN** the public reader returns 503 within its deadline without exposing an exception

### Requirement: Scheduled checks prove their named operation
Protected scheduled checks SHALL prove a PostgreSQL write/read round trip for control, provider acceptance of a transactional test email, and persistence of a fresh nonce through write/read on one dedicated synthetic memory page. Email evidence SHALL expire within one hour. Memory evidence SHALL describe only the checked synthetic cell and responding gateway, rather than all customer vaults.

#### Scenario: Email provider accepts the test send
- **WHEN** the configured provider accepts the synthetic email with a message identifier
- **THEN** the check records send acceptance without claiming inbox delivery

#### Scenario: Memory write is not returned by the read
- **WHEN** a fresh nonce is written but the subsequent read returns different content
- **THEN** the check records a failed memory proof

### Requirement: Synthetic authority cannot reach customer data
Anonymous callers SHALL have read-only health access. Scheduled checks SHALL require dedicated scheduler authorization. The memory runner SHALL use only a dedicated synthetic cell bearer and configured synthetic page. Stored proofs SHALL contain only component, attempt identity, timestamps and success. Older attempts SHALL NOT replace newer evidence.

#### Scenario: Anonymous caller requests a synthetic run
- **WHEN** a caller lacks valid scheduler authorization
- **THEN** the scheduled route rejects the request before any database mutation, email send or memory call

#### Scenario: An older run completes late
- **WHEN** a delayed proof has an earlier start time than the stored proof
- **THEN** it cannot replace that newer result

### Requirement: Pod probes remain independent of functional status
Existing direct gateway and cell liveness and readiness probes SHALL retain their semantics. Functional health failure SHALL NOT restart pods, gate admission or change customer settings. Public gateway health SHALL read the memory proof through its separate reader.

#### Scenario: Synthetic memory fails while the gateway responds
- **WHEN** the synthetic memory check fails
- **THEN** public memory health returns 503 while direct gateway liveness continues to return its existing response
