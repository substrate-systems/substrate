---
title: "We cannot decrypt your data"
slug: we-cannot-decrypt-your-data
subtitle: "How a conversation with Arpan turned into a cryptographic discipline"
description: "Building Endstate's Hosted Backup as a structural commitment, not a policy promise — the Argon2id split-key construction and what follows from it."
published: 2026-05-24
date: 2026-05-24
status: draft
tags:
  - cryptography
  - endstate
  - hosted-backup
  - structural-commitment
  - trust-model
author: Hugo Ander Kivi
---

[Endstate](https://substratesystems.io/endstate) is a tool for capturing and restoring the state of a Windows machine: apps, configs, settings, the lot. The "restore on a new machine" use case is the one users ask about first. The "back up to somewhere safe so you can restore on the same machine after a wipe" use case is the one that takes work to do honestly.

Hosted Backup is the paid tier that handles the second use case. You upload encrypted profile snapshots to infrastructure I operate; you restore from them on any machine.

I wasn't going to build this initially. My colleague [Arpan Dutta](https://www.linkedin.com/in/dutta-arpan/) was the one who pushed me on it; he kept pointing out that "back up to cloud" is the obvious user expectation, and a tool that needs Dropbox or OneDrive to round out its story is doing half the job. He was right, so I built it.

The interesting part wasn't the deciding. It was figuring out what *trustworthy* hosted backups actually means.

## The custody problem

Hosted backups create a custody relationship: the user uploads something valuable, and the operator holds it. That's the standard SaaS shape, and it has a problem. Once you hold the data you can read it, and once you can read it you're a target for everything that wants it read: external attackers, subpoenas, court orders, compelled assistance, insiders with operator access, every classified vulnerability in your storage layer for the rest of time.

The honest response to that isn't *"we promise not to."* Policy promises are breakable, and most of the threat list above doesn't care what you promise. The honest response is to make custody structurally impossible.

## The trust model

Endstate's hosted-backup contract states the commitment plainly:

> Endstate cannot decrypt user data uploaded to Hosted Backup. This is a structural property, not a policy.

The distinction is load-bearing.

**Policy commitments** are statements about future behaviour: *we won't read your data, we won't sell it, we won't hand it over.* They're real but breakable. They depend on the operator's continued cooperation, the operator's continued existence, the operator's resistance to legal pressure, the operator's internal access controls.

**Structural commitments** are statements about capability: *we can't.* They don't depend on cooperation, because nobody at Endstate has the key. They survive subpoenas because there's nothing to compel anyone to hand over. They survive insider compromise because insiders also don't have the key. They survive Endstate going out of business or being acquired by someone with worse intentions.

That's the property worth building, and the architecture is what makes it true.

## How it works

The user picks a passphrase at signup. The client runs it through Argon2id with a per-user salt, producing 64 bytes:

- First 32 bytes → `serverPassword`. Sent to the server. Stored as a normal password hash. Used to authenticate.
- Second 32 bytes → `masterKey`. **Never leaves the device.**

The client also generates a 32-byte Data Encryption Key (DEK) from a CSPRNG. The DEK is what actually encrypts file contents (AES-256-GCM, chunked). The DEK is wrapped (encrypted) with the `masterKey` and the wrapped form is uploaded to the server.

So on the server, here's what's stored:

- The password hash (verifies the user can log in)
- The wrapped DEK (encrypted with a key the server doesn't have)
- The encrypted backup chunks (encrypted with the DEK that the server can't unwrap)

Nothing the server holds can be decrypted without the user's passphrase, which the server never receives. The 64 bytes are derived client-side; only the half that doesn't unlock anything ever leaves the device.

This isn't a clever hack; it's the standard shape for end-to-end encrypted services. What matters is committing to it as a structural property from day one, not as a feature to be added later when the lawsuits start.

## Recovery without escape hatches

The obvious objection: *what about users who lose their passphrase?*

Standard SaaS answers this with an email-reset flow. The reset is possible because the server holds the data; the operator can re-key the account.

That answer doesn't work here. Endstate can't re-key the account because Endstate can't decrypt the wrapped DEK. There is no escape hatch on the server side.

The answer is a **second independent unlock path on the client side.** At signup, the client also generates a recovery key: 32 bytes from a CSPRNG, displayed to the user as a 24-word BIP39 mnemonic. The DEK is wrapped a *second time* with this recovery key, and that second-wrapped form is also stored on the server.

If the user forgets their passphrase, they prove possession of the recovery key, the server hands back the recovery-key-wrapped DEK, the client unwraps with the recovery key, and the user sets a new passphrase. The server never sees the recovery key. It only sees an Argon2id verifier (so it can confirm the user has the right key) and the recovery-wrapped blob (which it can't unwrap).

If the user loses both the passphrase and the recovery key, their data is gone for good; not even Endstate can recover it.

This isn't a bug; it's the same property restated. *"We can recover your data"* and *"we can't decrypt your data"* are contradictions; you can't have both. Endstate picks the second, and is explicit about the cost in the signup UX. The user is required to save the recovery key in at least two formats (file + printable PDF) before signup completes.

## What this enables downstream

The cryptographic commitment compounds into other architectural decisions.

**Subscription state never gates access to your data.** Even after cancellation, even in payment-failed grace, the user can delete their own backups. Delete operations are explicitly exempt from subscription gating: gating them would be hostile, and there's no business reason to gate them when the operator can't read the data anyway.

**Self-hosting becomes a supported pattern.** The Endstate engine talks to its backend via OIDC discovery; the backend URL is environment-configurable. Anyone can run their own substrate-equivalent backend on S3-compatible storage with their own OIDC issuer, and the official engine binary will use it. The trust model doesn't depend on the operator being Endstate; it depends on the cryptographic discipline being honored, which is verifiable from the contract.

**GDPR deletion is hard-delete by default.** No soft-delete grace period. The user requests deletion, all rows go, all R2 objects go, the Paddle subscription cancels. The only thing retained is an audit log entry hashing the user ID: sufficient for "did this user delete?" queries without holding identifying info.

None of these decisions are independent. They all follow from the same source: if you can't decrypt the data, you don't have the levers that would tempt you to add escape hatches later.

## What Arpan's question actually unlocked

Arpan's pitch was *"Endstate needs hosted backups"*: a short sentence with a long answer behind it.

The work was figuring out that *trustworthy hosted backups* isn't a feature you can layer on top of normal SaaS architecture. It's a discipline that has to be in the substrate from the first commit. Once it's there, the rest of the architecture follows from it: subscription doesn't gate data access, self-host is supported by design, deletion is real. Once it's *not* there, you have to retrofit it against your own infrastructure, which is the kind of work most companies never get around to.

Thanks Arpan. The pitch was short, but the discipline that fell out of it is what I'll keep building on.
