---
title: "How to transfer programs from one computer to another"
slug: transfer-programs-to-another-computer
description: "You cannot copy installed programs between Windows PCs, and the tools that promise it are fragile. Here is what actually moves, what does not, and how to rebuild a machine in minutes without installation disks."
published: 2026-07-24
tags:
  - windows
  - pc-migration
  - new-pc-setup
  - endstate
author: Hugo Ander Kivi
status: published
---

Every thread about this starts the same way. Someone has a new machine, twenty years of accumulated software on the old one, and no installation disks for any of it. They want to move the programs across without reinstalling everything by hand.

The honest answer is that you cannot copy an installed program from one Windows machine to another and expect it to run. Not reliably, and usually not at all.

That sounds like bad news. It isn't, because the thing people actually want — a new machine that works like the old one, without losing an evening — is very achievable. It just isn't done by copying program folders.

## Why copying installed programs doesn't work

A Windows application is not the folder in `Program Files`. Installing it scattered state across the machine.

Registry keys hold file associations, COM registrations, uninstall entries and per-application configuration. Shared runtimes like the Visual C++ redistributables, .NET and various drivers were installed alongside it and live elsewhere. Per-user data sits in `AppData`, and services, scheduled tasks and shell extensions were registered with Windows itself.

Copy the folder to a new machine and you get the files without any of that. Some small, genuinely portable tools survive this. Most applications either fail to start, start and then break on first use, or appear to work until you hit the feature that depends on the missing piece. The last case is the worst, because you find out weeks later.

There is a licensing dimension too. Many applications tie activation to hardware. Even a perfect file copy leaves you reactivating, and some licences do not permit the transfer at all.

## What the paid migration tools actually do

Laplink PCmover, Zinstall and EaseUS Todo PCTrans all sell the promise directly, and they do more than copy folders. They attempt to replay the registry entries and supporting state onto the target machine as well.

It works often enough to sell. It is also structurally fragile: you are transplanting parts of one Windows installation into another, including whatever was already broken. If the old machine had accumulated cruft over six years — and it had, that's usually why you're replacing it — the migration brings it along. You paid €50 to €130 to move your problems onto hardware you bought to escape them.

The other cost is trust. These are closed-source tools running with full access to both machines. That may be an acceptable trade for you. It wasn't for me.

## What actually works: capture, then reinstall clean

The reliable approach inverts the problem. Instead of moving the installed program, you move the **knowledge of what was installed**, then let each application install itself properly on the new machine.

This gives you a clean Windows install with your software on it. Every application registers itself correctly because it went through its own installer. Nothing inherits the old machine's damage. The only thing you need to preserve separately is your configuration, which is the part people actually miss.

Three things have to move:

**The list of applications.** What was installed, and enough identifying detail to fetch it again.

**Your settings.** Editor configuration, keybindings, terminal profiles, colour schemes, the OBS scenes you spent a weekend on. This is the part that makes a machine feel like yours, and it is the part every "transfer your files" guide skips.

**Your data.** Documents, projects, photos. This part is genuinely just a copy, and it's the one thing Windows already handles well through OneDrive, an external drive or a network share.

## Doing it manually with winget

Windows ships with a package manager, and it handles the first of those three. On the old machine:

```
winget export -o apps.json
```

That writes every application winget can identify to a single file. On the new machine:

```
winget import -i apps.json --accept-package-agreements --accept-source-agreements
```

Each application installs from its publisher, current version, no clicking. For software winget knows about, this genuinely turns a weekend into a coffee break. I wrote up the full procedure and its failure modes in [how to reinstall all your apps with winget](/blog/reinstall-all-apps-with-winget).

It stops short in three places. Microsoft Store apps are [not reliably exported](/blog/winget-export-microsoft-store-apps). Anything outside a winget source — portable tools, things you installed by hand — is invisible to it. And it carries none of your settings, so you get a fresh copy of every application rather than your application.

## Closing the gap

I hit those three limits often enough that I built [Endstate](/endstate) around them.

It scans the machine and detects what is installed, including Microsoft Store applications. It backs up settings for over 300 applications — editors and IDEs, terminals, creative tools like Blender and DaVinci Resolve, media players, emulators, note-taking apps. It writes all of it to one portable file you can put on a USB stick, and on the new machine it reinstalls the applications through winget and restores the settings on top.

Settings capture is always opt-in, and every restore takes a backup first, so a bad restore is one click to undo. Applications install through their normal installers with UAC prompts, so nothing goes on silently. It's free, open source and needs no account.

It does not copy installed programs across, because nothing does that reliably. It removes the reason you wanted to.

## What still won't transfer

Being straight about the edges, because this is where the paid tools overpromise.

**Licence keys and activations.** Endstate doesn't touch them, and no tool can honestly promise your licence permits the move. Collect your keys before you wipe the old machine.

**Application data inside proprietary formats.** Quicken files, QuickBooks company files, Outlook PST archives and similar all have their own export routines. Use those. Treat them as documents, not as settings.

**Anything the publisher deliberately locks to hardware.** Some software is licensed per-machine and enforced. Reinstalling is the process; the vendor decides whether your key still works.

## The short version

You can't move installed programs, and you don't need to. Capture what's installed and how it's configured, wipe or unbox the new machine, and let each application reinstall itself cleanly with your settings restored on top. You end up with a machine that works like the old one and behaves like a new one, which is the whole point of getting a new one.

If you're setting up a machine from scratch rather than replacing an existing one, [the complete Windows setup guide](/blog/new-windows-pc-setup-guide) walks the full sequence.
