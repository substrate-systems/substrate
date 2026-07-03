import type { ReactNode } from "react";

/**
 * Shared FAQ source for the Endstate page. `a` is the rich (JSX-capable) answer
 * rendered in the UI; `aText` is a plain-text equivalent used for FAQPage JSON-LD
 * (schema.org requires plain text). When `aText` is omitted, `a` is already a string.
 */
export type Faq = { q: string; a: ReactNode; aText?: string };

export const faqs: Faq[] = [
  {
    q: "What types of apps does Endstate detect?",
    a: "Endstate detects apps installed via traditional installers (EXE/MSI) and Microsoft Store. It uses winget under the hood to handle installs. Portable apps that aren't registered in Windows are not detected.",
  },
  {
    q: "Does it need admin rights?",
    a: "Scanning your machine doesn't require admin. Restoring apps on a new machine may need admin depending on what's being installed — Endstate will prompt you when needed.",
  },
  {
    q: "Which apps can Endstate install?",
    a: "48 apps are sandbox-validated and passing, including VS Code, Git, OBS Studio, Blender, Obsidian, Discord, KeePassXC, and more.",
  },
  {
    q: "Which app settings does it back up?",
    a: (
      <>
        Endstate has settings modules for 300+ apps — editors and IDEs (VS Code,
        the JetBrains suite, Neovim), terminals, creative tools (Blender, DaVinci
        Resolve, Ableton Live), media players, emulators, note-taking apps, and
        many more.{" "}
        <a
          href="/endstate/apps"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          See the full list of supported apps
        </a>
        . The list is open source and growing, and settings backup is always
        opt-in — never automatic.
      </>
    ),
    aText:
      "Endstate has settings modules for 300+ apps — editors and IDEs (VS Code, the JetBrains suite, Neovim), terminals, creative tools (Blender, DaVinci Resolve, Ableton Live), media players, emulators, note-taking apps, and many more. The list is open source and growing, and settings backup is always opt-in — never automatic.",
  },
  {
    q: "Can I use it across multiple machines?",
    a: "Yes. The local product is free on as many machines as you like. Save your setup from any of them and restore on any other.",
  },
  {
    q: "What if something goes wrong during restore?",
    a: "Endstate creates a backup before changing any settings. You can revert with one click. App installs use standard Windows installers, so they can be uninstalled normally.",
  },
  {
    q: "Is an internet connection required?",
    a: "Scanning and saving your setup works offline. Restoring apps on a new machine needs internet to download installers. The local product never phones home.",
  },
  {
    q: "Where do I download Endstate?",
    a: (
      <>
        Grab the latest installer any time at{" "}
        <a
          href="/download"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          substratesystems.io/download
        </a>
        . No account, no payment — just download and run.
      </>
    ),
    aText:
      "Grab the latest installer any time at substratesystems.io/download. No account, no payment — just download and run.",
  },
  {
    q: "Is this safe to run on my machine?",
    a: (
      <>
        The provisioning engine — the part that actually installs software — is{" "}
        <a
          href="https://github.com/Artexis10/endstate"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          open source under Apache 2.0
        </a>
        . You can read exactly what it does before running anything, and build the
        same binary from source if you want to.{" "}
        <a
          href="https://github.com/Artexis10/endstate"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          View engine on GitHub →
        </a>
      </>
    ),
    aText:
      "The provisioning engine — the part that actually installs software — is open source under Apache 2.0. You can read exactly what it does before running anything, and build the same binary from source if you want to.",
  },
];
