---
title: "How to Restore Windows Apps and Settings After Reinstalling Windows"
slug: restore-windows-apps-and-settings-after-reinstall
description: "How to restore Windows apps and settings after a reinstall with a saved Endstate profile, including what carries over, what does not, and how to choose the changes to apply."
published: 2026-07-30
tags:
  - windows
  - app-restore
  - settings-backup
  - reinstall
author: Hugo Ander Kivi
status: published
---

Windows can remember some app pins and settings when you sign in, but rebuilding a complete desktop-app list and each program's configuration is still fragmented. Endstate can restore Windows apps and supported settings from one portable profile, but that profile must be captured **before** reinstalling Windows.

That condition matters. Endstate cannot recover an old configuration after the fact: if the old machine was erased without a saved profile, it can help you build a new one, but it has nothing to restore from.

## Before reinstalling Windows

On the computer that still has your working setup, open [Endstate](/endstate) and choose **Save this computer**. It scans the installed applications it can identify and captures the settings available through its modules, then lets you save the result as a portable `.endstate` profile.

Save that profile somewhere that will survive the reinstall. An external drive or USB stick is straightforward; a sync folder you can reach again afterwards also works. Do not leave the only copy on the Windows drive you are about to erase. If you use Endstate Cloud, you can also push the profile there, but it is optional; local profiles work without an account.

Capture is not a promise that every program or setting is covered. It records the applications and settings it finds, and the result is inspectable before you use it. The [live Endstate compatibility list](/endstate/apps) is the canonical place to check the current settings-module coverage.

Keep a separate backup of your documents, photos, project folders, browser data, and anything else you would be unhappy to lose. A profile is for rebuilding application state, not for replacing a file backup.

## After reinstalling Windows

First, install Endstate again. On a fresh Windows install, you can use WinGet:

```
winget install --id SubstrateSystems.Endstate -e
```

You can also [download Endstate](/download). Then follow the setup flow:

1. Open Endstate and choose **Set up this computer**.
2. Load the profile you saved before reinstalling Windows, or retrieve it from Endstate Cloud if you deliberately use that service.
3. Review the comparison between the profile and the current computer. It shows what is already present, what can be installed, and which settings are available.
4. Select the applications and supported settings you want to restore, then apply the changes.
5. Read the result and verify the applications you rely on. Sign in where an application needs its own account, and check anything that was marked unavailable or skipped.

The selection happens here, after you can see the proposed changes. You can restore a handful of applications, only selected settings, or the wider profile. It is not a mandatory full-machine clone.

For the package-manager part alone, see [how to reinstall all your apps with WinGet](/blog/reinstall-all-apps-with-winget). That guide is useful when an app list is all you need; this page covers the narrower job of rebuilding a known setup after a reinstall.

## What Endstate restores

Endstate keeps the two jobs separate, because they are different jobs.

- **Applications:** supported applications can be reinstalled through WinGet or Chocolatey, using the package-manager driver and package reference recorded in the profile.
- **Supported settings:** Endstate has settings modules for 300+ apps. Those modules restore the configuration data the module is designed to handle; the [supported-app list](/endstate/apps) stays current as modules are added.
- **Portable profile contents:** the saved profile carries its application declarations and any settings payloads captured into it. You control where that file lives and can use it locally.
- **Selective restoration:** you review and select what to apply, instead of copying the old Windows installation wholesale.

An application can still be reinstalled when Endstate has no settings module for it. In that case, it starts with fresh settings. Installing an application and restoring its configuration are separate capabilities, which is exactly why a package list alone does not recreate a familiar machine.

[Windows Central's look at Endstate](https://www.windowscentral.com/software-apps/i-spoke-with-the-developer-behind-endstate-a-new-app-that-fixes-one-of-the-worst-parts-of-setting-up-a-fresh-windows-pc) covers that distinction from the perspective of setting up a fresh PC.

## What Endstate does not restore

Endstate deliberately has limits. It does not restore:

- personal files, unless you backed them up separately;
- application settings with no supported module;
- applications whose package managers or package sources are unavailable on the target machine;
- credentials, secrets, or other sensitive state that is deliberately excluded; or
- anything that was never captured into the profile.

That is not a defect in the restore step. A reinstall discards the old disk state, and a profile can only apply the state it contains. Treat it as a declared, selective rebuild, then keep your ordinary backups for everything outside that scope.

## Windows Backup, System Restore, and Endstate

These tools overlap at the edges, but they solve different problems.

| Tool           | Best for                                                                                            | What it does not replace                                     |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Windows Backup | Moving selected Windows settings and Microsoft-account-backed app information to another Windows PC | A complete desktop-app configuration restore                 |
| System Restore | Rolling the current Windows installation back to an earlier system-state point                      | Rebuilding a clean machine after a reinstall                 |
| Disk image     | Reproducing the whole old installation, including its problems and bulk                             | A selective, clean app-and-settings rebuild                  |
| Endstate       | Reinstalling selected applications and restoring supported settings from a portable profile         | File backup, disk imaging, Windows Backup, or System Restore |

Windows Backup can bring back supported Windows settings and make it easier to find some apps again. System Restore rolls the current installation back rather than rebuilding a fresh one. Endstate starts from a clean Windows install and applies the applications and supported configuration you selected from a saved profile.

For the wider question of preparing a new machine, including data and the Microsoft Store gap, read [the complete guide to setting up a new Windows PC](/blog/new-windows-pc-setup-guide).

## FAQ

### Can I restore applications after reinstalling Windows?

Yes, if you captured an Endstate profile before the reinstall. Load it on the new Windows install, review what is available, select the applications you want, and apply the setup. Without a profile saved before the reinstall, Endstate cannot reconstruct the old application list retroactively.

### Can Windows restore all my desktop app settings?

No. Windows can restore selected Windows settings and help with some app reinstallation, but desktop applications store settings in different places and formats. Endstate restores settings only for applications with a supported settings module and only when those settings were captured in the profile.

### Does Endstate work without an account?

Yes. Endstate works locally with portable profiles and does not require an account. Endstate Cloud is an optional service for people who want an off-device copy.

### What happens when an app has no settings module?

Endstate can still reinstall the application when it is available through a supported package source. Its settings are not restored, so the application opens with fresh settings.

### Can I use the same Endstate profile on another PC?

Yes. A profile is portable, and the setup flow lets you choose what to apply on another Windows PC. Check the comparison first, especially when the target machine has a different purpose or already has some applications installed.

### Does Endstate restore personal files?

No. Back up personal files separately with the tool and destination you trust. Endstate focuses on application installation and supported application settings.

### Can I choose which apps and settings to restore?

Yes. After loading the profile, Endstate shows the available changes so you can select the applications and supported settings to apply. You do not have to restore everything.

## Rebuild the parts that matter

If you have a profile from before the reinstall, [view the supported apps](/endstate/apps), [download Endstate](/download), and rebuild the applications and settings that matter to you. If you are preparing a machine from scratch rather than recovering after a reinstall, the [broader Windows setup guide](/blog/new-windows-pc-setup-guide) is the right starting point.
