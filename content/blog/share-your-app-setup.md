---
title: "Share your whole app setup as one file (yes, even MSI Afterburner)"
slug: share-your-app-setup
description: "Your Endstate setup is a portable file, so you can hand someone your exact app config: OBS scenes, MSI Afterburner profiles, your dev setup. Here's how."
published: 2026-07-04
tags:
  - windows
  - config-sharing
  - settings
  - endstate
author: Hugo Ander Kivi
status: published
---

I built Endstate to move my own setup to a new machine. Somewhere along the way I realized it does something I hadn't set out to build: because a setup is just a file, you can hand it to someone *else*.

That sounds small. It isn't. There's no clean way today to give a friend your exact OBS scene and encoder setup, or your MSI Afterburner fan curve, or the VS Code and terminal config you spent months tuning. You screenshot your settings, or you write a doc, or you tell them "just copy mine" and then walk them through it click by click. Endstate turns that into: send a file.

## How it works

A setup is a portable file. Sharing it doesn't need a special feature, because it's yours the moment it's saved:

1. Capture your machine with Endstate. Your apps and, for the ones you pick, their settings go into one file.
2. Send that file however you send files. A message, a shared drive, a repo.
3. The other person opens it in Endstate. Restore is opt-in per app, so they choose exactly what to pull in.

That last point is what makes it useful rather than invasive. They don't have to take your whole machine. They can restore only your MSI Afterburner profile, or only your OBS setup, and ignore the rest.

## What you can actually share

Anything Endstate has a settings module for, which is [300+ apps](/endstate/apps). A few that people spend real time tuning and would happily take from someone who's already done the work:

- **MSI Afterburner** — fan curves and monitoring layouts you don't want to rebuild by hand.
- **OBS Studio** — scenes, sources, and encoder settings, the thing every new streamer gets wrong for a month.
- **VS Code, Neovim, Windows Terminal** — a teammate's whole editor and shell setup, so a new hire starts from your standard instead of default.
- **DaVinci Resolve, Blender, Ableton** — creative-tool preferences and keymaps that take ages to get right.

This is dotfiles, but for normal apps and normal people. Dotfiles have always been a developer thing, kept in a repo and stitched together by hand. Endstate does the same job for any of 300+ apps, GUI ones included, without asking anyone to learn git.

## What it does not share

Your credentials. Endstate captures configuration, not secrets. The settings modules deliberately leave out tokens, API keys, and account state, and there's a sanitize option on capture. So handing someone your VS Code setup doesn't hand them your sync token, and sharing your setup doesn't leak your logins. Check the file before you send it if you want to be sure, but the design assumption is that a setup is safe to pass around.

## Where this is going

Right now this works because the setup is a plain, portable file and restore is per-app. There's no big "Share" button in the UI yet; you share the file the way you'd share any file. I think that's the honest version worth shipping first: the capability is real today, and it's real *because* your setup isn't locked inside an account or a cloud you don't control.

If you want to try it, [download Endstate](/download), capture your setup, and send the file to someone whose machine could use your good taste. The [product page](/endstate) has the full picture.
