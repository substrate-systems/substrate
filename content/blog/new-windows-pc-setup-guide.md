---
title: "The complete guide to setting up a new Windows PC"
slug: new-windows-pc-setup-guide
description: "A practical guide to setting up a new Windows PC: reinstall your apps, bring your settings, handle the Store gap, and skip the paid migration tools."
published: 2026-07-04
updated: 2026-07-22
tags:
  - windows
  - new-pc-setup
  - winget
  - migration
author: Hugo Ander Kivi
status: published
---

I've set up a lot of new Windows machines, and for years I did it the slow way: a browser, a list in my head, and a whole evening lost to installers and settings. The reliable version is not a faster memory game. It is a small setup kit you make once, keep somewhere you own, and use whenever you start fresh.

## What you are actually moving

A new-PC setup has three separate parts:

1. **Apps** — the programs you need installed again.
2. **Settings** — your editor config, terminal profile, keybindings, presets, and other choices that make those apps yours.
3. **Data** — documents, project folders, browser profiles, and the files the apps work on.

An app list is useful, but it is only the first part. It does not bring settings or personal data along. Treat those as separate jobs and a new machine stops feeling like a strange default install.

## Make a setup kit before you need it

Do this on the machine that already works. The practical sequence is:

1. Export the apps winget can reinstall.
2. Save that manifest with the settings and data backups you actually need.
3. Write down Microsoft Store or manually installed apps that will not be in the manifest.
4. Keep the kit somewhere you own — your own sync folder is fine, but keep an offline copy on a USB stick or external drive too. A fresh PC should not depend on a cloud account being configured first.

Start with the app manifest:

```
winget export -o apps.json
```

That gives you a portable list of winget-source apps. Save `apps.json` beside the configuration exports and data backups you care about, not in a disposable Downloads folder. If you use a password manager, source-control your dotfiles, or sync documents elsewhere, make sure you can reach those before wiping the old machine.

## Restore the apps on the new PC

Once Windows is updated and you have copied your setup kit over, open Terminal and run:

```
winget import -i apps.json --accept-package-agreements --accept-source-agreements
```

That reinstalls the apps in the manifest without walking through installers one at a time. The focused [winget restore guide](/blog/reinstall-all-apps-with-winget) explains useful flags and the command workflow in more detail.

## Fill the gaps deliberately

`winget export` does not capture your settings or data. Restore those from the copies you made: import your editor and terminal preferences, clone or copy project folders, and sign back into the services you use.

It also does not faithfully include every app. Microsoft Store apps and apps installed outside a winget source can be absent, so check your list and reinstall them separately. The dedicated [Store-app guide](/blog/winget-export-microsoft-store-apps) shows how to spot that gap before it surprises you.

If you want one tool to capture apps, settings, and Store-app coverage into a portable setup file, [Endstate](/endstate) is the local-first route I built for that job. It still helps to understand the pieces: the file is yours, settings are opt-in, and no app list replaces your own data backup.

## What about the paid migration tools?

EaseUS Todo PCTrans, Zinstall, and Laplink PCmover all promise a one-click move to a new PC. They work by copying your installed programs byte-for-byte across machines. That's a real capability for legacy software with no installer left, but it's also the risky path: you're transplanting a program's files onto a different Windows install and hoping it runs. They're closed source and cost $50–130.

For most setups, a clean reinstall plus a settings restore is safer, produces a cleaner machine, and costs nothing. I compared them honestly here: [a free, open-source alternative to EaseUS, Zinstall, and Laplink](/blog/free-open-source-pc-migration-alternative).

## The short version

If you want to do this by hand: use winget for the apps, reinstall your Store apps manually, and rebuild your settings. It works, and it's free.

If you'd rather not: I built [Endstate](/endstate) to do all three as one step. It scans your current machine, saves your apps and settings to a single portable file, and restores everything on a fresh Windows install. It runs locally, keeps no account, sends no telemetry, and the engine is open source. [Download it free](/download), or read the [full feature list](/endstate).

Setting up a new machine will never be zero work. But it should be minutes of watching a file restore, not a weekend of remembering what you had.
