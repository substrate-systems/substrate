---
title: "The complete guide to setting up a new Windows PC"
slug: new-windows-pc-setup-guide
description: "A practical guide to setting up a new Windows PC: reinstall your apps, bring your settings, handle the Store gap, and skip the paid migration tools."
published: 2026-07-04
tags:
  - windows
  - new-pc-setup
  - winget
  - migration
author: Hugo Ander Kivi
status: published
---

I've set up a lot of new Windows machines, and for years I did it the slow way: a browser, a list in my head, and a whole evening lost to installers and settings. This is the guide I wish I'd had. It covers the parts that actually take time, the tools that help, and the ones that overpromise. Each section links to a deeper write-up if you want the detail.

## The two halves of a setup

A new-PC setup is really two jobs, and most guides only talk about the first:

1. **The apps** — getting your programs back.
2. **The settings** — getting *your* version of those programs back.

The apps are the visible half. The settings are the half that decides whether the new machine feels like yours or like a stranger's. Handle both from a file and setup stops being a weekend.

## Getting your apps back

The built-in tool for this is winget, Windows' package manager. It can export a list of your installed apps and reinstall them on a new machine in minutes. It's genuinely good, and it's what I build on. But it has two gaps worth knowing before you rely on it:

- It reinstalls the app but brings none of your configuration.
- It quietly skips your Microsoft Store apps.

I wrote both of these up in detail: [how to reinstall all your apps with winget (and what it misses)](/blog/reinstall-all-apps-with-winget), and [why winget export skips your Microsoft Store apps](/blog/winget-export-microsoft-store-apps).

## Getting your settings back

This is the part nobody automates, and it's the part that costs the most time. Your editor config, your terminal, your keybindings, your creative-tool presets — rebuilding those by hand from memory is the real tax of a new machine.

It's also the hardest thing to copy safely, which is why the settings coverage matters more than the app count. If a tool backs up settings for a handful of apps, it's a demo. Endstate has settings modules for [300+ apps](/endstate/apps), from editors and IDEs to creative suites, media players, and emulators. And because each setup is a portable file, you can even [hand your exact configuration to someone else](/blog/share-your-app-setup).

## Doing it fast, and repeatably

The trick isn't doing the setup faster by hand. It's not doing it from memory at all: capture your machine once, save it to a file you control, and restore it on any fresh install. I walk through that workflow here: [how to set up a new Windows PC in minutes](/blog/set-up-new-windows-pc-fast).

## What about the paid migration tools?

EaseUS Todo PCTrans, Zinstall, and Laplink PCmover all promise a one-click move to a new PC. They work by copying your installed programs byte-for-byte across machines. That's a real capability for legacy software with no installer left, but it's also the risky path: you're transplanting a program's files onto a different Windows install and hoping it runs. They're closed source and cost $50–130.

For most setups, a clean reinstall plus a settings restore is safer, produces a cleaner machine, and costs nothing. I compared them honestly here: [a free, open-source alternative to EaseUS, Zinstall, and Laplink](/blog/free-open-source-pc-migration-alternative).

## The short version

If you want to do this by hand: use winget for the apps, reinstall your Store apps manually, and rebuild your settings. It works, and it's free.

If you'd rather not: I built [Endstate](/endstate) to do all three as one step. It scans your current machine, saves your apps and settings to a single portable file, and restores everything on a fresh Windows install. It runs locally, keeps no account, sends no telemetry, and the engine is open source. [Download it free](/download), or read the [full feature list](/endstate).

Setting up a new machine will never be zero work. But it should be minutes of watching a file restore, not a weekend of remembering what you had.
