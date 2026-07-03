---
title: "Why winget export skips your Microsoft Store apps"
slug: winget-export-microsoft-store-apps
description: "winget export leaves your Microsoft Store apps out of the file. Here's why it happens, how to see what's missing, and how to capture everything."
published: 2026-07-03
tags:
  - windows
  - winget
  - microsoft-store
  - backup
author: Hugo Ander Kivi
status: published
---

If you back up your apps with `winget export` and restore them on a new machine, some of your apps won't be there. Specifically, your Microsoft Store apps. This trips people up because the file looks complete when you make it, and the gap only shows up on the new machine when something you use every day is missing.

Here is why it happens, and how to catch it before it costs you.

## winget has more than one source

winget installs from sources. The main one is `winget` itself, the community package repository. But Store apps come from a separate source, `msstore`. `winget list` sees both, so when you look at your installed apps it feels like winget knows about everything:

```
winget list
```

Look at the **Source** column. Some rows say `winget`, some say `msstore`, and some are blank. That blank or `msstore` label is the tell.

## Export only serializes the winget source

`winget export` writes out the packages it can round-trip from the winget source. Store apps and anything without a winget-source ID don't get written into the file. This is a documented limitation of export, not a setting you forgot. So the JSON you carry to your new PC is really "my winget-source apps," not "my apps."

The apps most likely to vanish are the ones you installed straight from the Store: things bundled with Windows, Store-only utilities, some games. None of them come along.

## What you can do

**See the damage first.** Run `winget list` and scan the Source column. Every `msstore` or blank row is an app your export won't carry. Write those down.

**Reinstall the Store ones by hand.** winget can install some Store apps directly if you know the ID:

```
winget install --source msstore --id <PackageId>
```

It works, but you're back to doing it one app at a time, which is the thing you were trying to avoid.

**Capture settings too, while you're at it.** Even for the apps that do export, `winget import` reinstalls the program and nothing else. Your configuration doesn't travel. That's a separate gap worth knowing about: [what winget reinstalls, and what it misses](/blog/reinstall-all-apps-with-winget).

## How Endstate handles it

I built Endstate on winget precisely because winget is the right install engine. But I hit the Store-app gap on my own machines, so Endstate detects Microsoft Store apps directly rather than relying on what export happens to serialize, and it brings them across with everything else. It also backs up settings for supported tools and writes the whole setup to one portable file you control. Free, open source, no account: [substratesystems.io/endstate](/endstate).

`winget export` is genuinely useful. Just know what it's handing you: your winget-source apps, not your whole machine. Check the Source column before you trust the file.
