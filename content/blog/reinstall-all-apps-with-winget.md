---
title: "How to reinstall all your apps with winget (and what it misses)"
slug: reinstall-all-apps-with-winget
description: "winget can export and reinstall your Windows apps from one file. Here's exactly how, plus the apps and settings it quietly leaves behind."
published: 2026-07-03
updated: 2026-07-22
tags:
  - windows
  - winget
  - backup
  - new-pc-setup
author: Hugo Ander Kivi
status: published
---

Setting up a new Windows machine used to cost me an evening. Open a browser, hunt for the same twenty apps one at a time, click through every installer, and still miss half of them until the moment I needed one. winget fixes most of that, and it's the install engine I built Endstate on top of. But winget on its own leaves gaps, and they're the kind you only notice later.

Here is how to reinstall your apps with winget, and exactly where it stops.

For the complete new-PC sequence — settings, data, offline copies, and the Store-app gap — start with [the complete Windows setup guide](/blog/new-windows-pc-setup-guide).

If you already have a saved Endstate profile and the task is specifically restoring apps and supported settings after reinstalling Windows, read [the focused restore guide](/blog/restore-windows-apps-and-settings-after-reinstall).

## Export what you have

winget can write the apps it knows about to a single JSON file:

```
winget export -o apps.json
```

That walks your installed packages, keeps the ones winget can identify by ID, and records them. Add `--include-versions` if you want to pin exact versions rather than take the latest on restore. Keep `apps.json` somewhere you control — a USB stick, your own sync folder, anywhere.

## Reinstall on the new machine

On the fresh install, point winget at that file:

```
winget import -i apps.json --accept-package-agreements --accept-source-agreements
```

It reads the list and installs each app in turn, no clicking through installers. Two flags worth knowing: `--ignore-unavailable` skips anything winget can't find instead of stopping, and `--ignore-versions` takes the current version when a pinned one is gone.

For apps winget tracks, this is the good part. It genuinely turns a weekend into a few minutes.

## What winget misses

Three things, and each one bites.

**Microsoft Store apps.** `winget export` does not serialize every Store app. See [why winget export skips your Store apps](/blog/winget-export-microsoft-store-apps) for the limitation and how to check it.

**Anything outside a winget source.** Portable apps, tools you installed by hand, anything not registered where winget can see it — none of it is captured.

**Your settings.** This is the one that matters most. winget reinstalls the application; it does not bring your configuration. Your VS Code setup, your Git config, your terminal profile, your keybindings all start from scratch. You get a fresh copy of the app, not your app.

There is also no safety net. `winget import` installs; it doesn't take a restore point first. If something goes sideways there's nothing to roll back to.

## Where Endstate fits

I hit all three of these often enough that I built Endstate around them. It uses winget as the install engine, so you get the same reliable reinstall. On top of that it detects Microsoft Store apps, backs up settings for 300+ apps (editors and IDEs, terminals, creative apps like Blender and DaVinci Resolve, media players, emulators, note apps like Obsidian, and more), and writes the whole thing to one portable file. Before it changes any settings it takes a backup, so a bad restore is one click to undo. It's free, open source, and needs no account: [substratesystems.io/endstate](/endstate).

winget is a good building block. For "reinstall my apps," it gets you most of the way. For "make this new machine mine again," it's the first step, not the whole job.
