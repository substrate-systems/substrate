---
title: "A free, open-source alternative to EaseUS Todo PCTrans, Zinstall, and Laplink PCmover"
slug: free-open-source-pc-migration-alternative
description: "Endstate is a free, open-source PC migration tool for Windows, compared to EaseUS Todo PCTrans, Zinstall, and Laplink PCmover on price, method, and trust."
published: 2026-07-03
tags:
  - windows
  - pc-migration
  - open-source
  - endstate
author: Hugo Ander Kivi
status: published
---

I built [Endstate](https://substratesystems.io/endstate), so take the framing here for what it is: I have a horse in this race. But I've spent enough time reading how the incumbent PC-migration tools work, and how much they cost, that I think the comparison is worth writing down plainly — including the parts where they're better than what I built.

For the practical setup sequence behind the comparison, see [the complete Windows setup guide](/blog/new-windows-pc-setup-guide).

If you've bought a new Windows PC recently, you've hit the same wall I did: reinstalling twenty-plus apps, re-signing into things, digging up license keys, re-configuring the settings you forgot you'd customized. The tools that exist to solve this — EaseUS Todo PCTrans, Zinstall, Laplink PCmover — are all closed source and all charge $50-130 for what should, in most cases, be a solved problem. Endstate is the free, open-source alternative I wanted and couldn't find.

## What the paid tools actually do

EaseUS Todo PCTrans, Zinstall WinWin, and Laplink PCmover Professional all take the same fundamental approach: they copy your installed programs directly from the old PC to the new one, byte-for-byte, without touching an installer. Laplink is explicit about this — PCmover moves applications so they arrive "installed and ready to use right away," no reinstall, no original media needed ([go.laplink.com](https://go.laplink.com/product/pcmover-professional)). Zinstall does the same for your whole environment — "programs, documents, music, pictures, favorites, emails, accounts, passwords, profiles, settings" — copied wholesale to the new machine ([zinstall.com](https://www.zinstall.com/products/zinstall-winwin)). EaseUS Todo PCTrans migrates "programs, software settings, documents, music, pictures, videos" the same way, including named support for things like Office, AutoCAD, and Dropbox ([easeus.com](https://www.easeus.com/pc-transfer-software/pctrans-pro.html)).

This is a real capability. If you have some ancient, unlicensed-media, install-CD-lost-a-decade-ago piece of software that still runs your business, byte-copying it across is sometimes the only way to keep it alive. That's a legitimate use case, and it's the strongest argument for tools built this way.

It's also the risk. Copying a program's files and registry state onto a different Windows install, possibly a different Windows version, is not the same thing as installing it there. Driver-dependent software, anything tied to hardware IDs, anything with a service that expects a specific system state — these are exactly the categories that break under byte-copy migration, and when they break, you're debugging a copied program with no clean install to fall back to.

And none of them are free in any real sense. Here's what they currently cost:

- **EaseUS Todo PCTrans Pro**: a free tier capped at roughly 500MB and two apps ([easeus.com](https://www.easeus.com/free-pc-transfer-software/)); Pro runs $39.95/month or $59-69 for a lifetime license depending on the current promotion ([easeus.com](https://www.easeus.com/pc-transfer-software/pctrans-pro.html)).
- **Zinstall WinWin**: $129, no free tier for a full migration ([zinstall.com](https://www.zinstall.com/products/zinstall-winwin)).
- **Laplink PCmover Professional**: $69.95 per license ([go.laplink.com](https://go.laplink.com/product/pcmover-professional)).

All three are closed source. You're trusting a binary you can't inspect to touch your entire filesystem and registry, on the promise that it'll leave your new machine in a working state.

## What free-but-limited looks like

Windows itself has two free options, and both are worth knowing about because they're genuinely useful for the right sliver of cases — just not the whole job.

Microsoft's built-in **Restore Apps** (App Restore) re-downloads your Microsoft Store apps and Windows settings on a new PC when you sign in with the same Microsoft account during setup. It's free and it works, but it only covers Store apps and Windows-level settings — anything installed from an EXE or MSI outside the Store, which is most software people actually use, isn't touched ([windowscentral.com](https://www.windowscentral.com/software-apps/windows-11/windows-11-is-finally-getting-a-cloud-powered-backup-and-restore-feature)).

`winget export` — the command-line package manager built into Windows — will dump a list of your installed winget-tracked packages to a JSON file you can `winget import` on a new machine. It's free, scriptable, and it's the closest thing to what Endstate does under the hood. But it skips Microsoft Store apps, captures no settings, and produces no restore point if something goes wrong. It's a building block, not a tool.

## What Endstate does differently

Endstate takes the position that byte-copying installed programs is the wrong default, not because it's technically impossible to do safely, but because a clean reinstall is a better outcome even when the risky copy would have worked. So instead of copying programs, Endstate:

1. Scans your current PC for installed apps — both traditional EXE/MSI installs and Microsoft Store apps — using winget as the detection engine.
2. Captures the settings for 300+ apps (editors and IDEs, terminals, creative apps like Blender and DaVinci Resolve, media players, emulators, note apps like Obsidian, and more).
3. Saves all of it to one portable file that you control — no account, no cloud dependency for this step.
4. On your new machine, reinstalls each app fresh from its real installer and, if you opt in, restores your captured settings.

The result on the new PC is a set of cleanly installed applications, not transplanted files hoping to run in a different context. It's local-first: scanning and saving happen entirely offline, the file is yours, and there's no telemetry and no mandatory account. The core engine is Apache 2.0 licensed and [on GitHub](https://github.com/Artexis10/endstate), so you can read exactly what it does before you run it — something none of the closed-source tools above let you do. The local product itself is free forever, on unlimited machines. The only paid pieces are optional: encrypted hosted backup (€4/mo or €40/yr, if you want your snapshot stored somewhere other than a USB stick) and a one-time €89 supporter license for people who want to fund development.

The honest tradeoff: if you have that one piece of software with no clean installer left anywhere, Endstate can't resurrect it — a byte-copy tool might. For the other 95% of a typical setup, reinstall-plus-settings-restore is safer, produces a cleaner machine, and costs nothing.

## Comparison

| Tool | Price | Open source | Method | Restores settings | Account required | Telemetry |
|---|---|---|---|---|---|---|
| **Endstate** | Free (paid extras optional) | Yes (Apache 2.0) | Reinstalls apps fresh | Yes, opt-in | No | No |
| EaseUS Todo PCTrans Pro | Free tier limited; Pro $39.95/mo–$69 lifetime | No | Byte-copies programs | Partial | No | Unknown |
| Zinstall WinWin | $129, no full free tier | No | Byte-copies entire environment | Yes | No | Unknown |
| Laplink PCmover Professional | $69.95 | No | Byte-copies programs | Yes | No | Unknown |
| Windows Restore Apps | Free | No | Redownloads Store apps only | Windows settings only | Yes (Microsoft account) | N/A (built-in) |
| `winget export` | Free | Yes (winget itself) | Reinstalls winget-tracked apps | No | No | No |

## Where you can get it

Endstate is a free, open-source PC migration tool if what you need is: get everything you had onto a fresh Windows install, cleanly, without paying for closed-source software that touches your entire filesystem. If you're specifically trying to resurrect one piece of legacy software with no installer left, a byte-copy tool like PCmover or Zinstall is the more direct match for that narrow job — you should use the right tool for that case.

You can read the engine's source on [GitHub](https://github.com/Artexis10/endstate), check the [product page](https://substratesystems.io/endstate) for the full feature list, or go straight to [the download](https://substratesystems.io/download) and set up a new Windows PC in the time it takes to make coffee.

## FAQ

**Is there a truly free way to transfer apps to a new computer?**
Yes. Endstate's local product — scanning, saving, and restoring apps and settings — is free forever with no account required. `winget export`/`import` is also free but only covers winget-tracked apps and no settings. Microsoft's Restore Apps is free but Store-apps-only.

**Is EaseUS Todo PCTrans actually free?**
There's a free tier, but it's capped at roughly 500MB and two applications — enough to test the tool, not enough to migrate a real setup. The unrestricted version is a paid Pro license.

**Does Endstate copy my installed programs like PCmover or Zinstall do?**
No, and that's deliberate. Endstate records what's installed and reinstalls it fresh on the new machine from the real installer, rather than copying program files and registry state across. This avoids the class of bugs where a copied program behaves differently on a different Windows install.

**What if I have old software with no installer anymore?**
That's the one case where byte-copy tools have a real edge — they can move software that literally cannot be reinstalled. Endstate won't help there; a tool like PCmover or Zinstall might.

**Does Endstate require an account or send telemetry?**
No. The local product runs without an account and without telemetry. The only feature that touches a server is the optional, encrypted Hosted Backup, and that's opt-in.

**Is Endstate really open source?**
The provisioning engine is Apache 2.0 licensed and [on GitHub](https://github.com/Artexis10/endstate). The paid hosted-backup infrastructure is separate from the local engine, but the core tool that scans, saves, and restores your machine is inspectable code, not a closed binary.
