---
title: "How to set up a new Windows PC in minutes, not a weekend"
slug: set-up-new-windows-pc-fast
description: "Set up a new Windows PC fast: capture your apps and settings once, then restore them on any fresh install in minutes instead of losing an evening."
published: 2026-07-03
tags:
  - windows
  - new-pc-setup
  - winget
  - backup
author: Hugo Ander Kivi
status: published
---

Every fresh Windows install used to cost me an evening. Hunt for the same apps, click through the same installers, then rebuild the settings I'd forgotten I'd customized, one at a time, from memory. The machine worked by the end of the night. It just wasn't mine yet.

The fix isn't doing that faster. It's not doing it from memory at all. Capture your setup once, then restore it on any fresh install. Here's the repeatable version.

## The principle

A new-PC setup has two halves: the apps, and the settings that make those apps yours. Most tools handle the first and ignore the second, which is why a "restored" machine still feels foreign. Do both, from a file, and setup stops being a chore you dread and becomes a step you run.

## Step 1: capture your current machine

The apps are the easy half. winget, built into Windows, can list what you have:

```
winget export -o apps.json
```

Two things to know before you trust that file. It captures your winget-source apps but skips Microsoft Store apps, and it records the apps but none of their settings. Both gaps are worth understanding: [what winget export misses](/blog/reinstall-all-apps-with-winget).

The settings are the half that actually saves you. Your VS Code config, your Git identity, your terminal profile, your keybindings. These are what take the longest to rebuild by hand, and they're the ones no app list captures.

## Step 2: save it somewhere you own

One file, on a USB stick or your own sync folder. Not a cloud account you have to sign into on a machine that isn't set up yet. The point is that the file is yours and works offline.

## Step 3: restore on the fresh install

On the new machine, reinstall from the file:

```
winget import -i apps.json --accept-package-agreements --accept-source-agreements
```

For the winget-source apps, that's minutes instead of an evening. Then restore your settings, and reinstall the Store apps winget left out. This is the part where doing it by hand starts to add the evening back.

## The version I actually use

I got tired of stitching this together every time, so I built Endstate to do all three steps as one. It scans your current machine for installed apps, including Microsoft Store apps, and the settings for supported tools like VS Code, Git, Neovim, Windows Terminal, and PowerToys. It writes everything to a single portable file. On a fresh install you point it at that file and it reinstalls the apps and, if you opt in, restores your settings. It takes a backup before it changes anything, so nothing is one-way.

It runs locally, uses winget under the hood, keeps no account, and sends no telemetry. The file stays on your disk. Free and open source: [substratesystems.io/endstate](/endstate).

Setting up a new machine will never be zero work. But it should be minutes of watching a file restore, not a weekend of remembering what you had.
